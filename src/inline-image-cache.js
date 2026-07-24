'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIME_EXTENSIONS = new Map([
  ['image/gif', '.gif'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

let lastCleanupAt = 0;

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hasImageSignature(mimeType, bytes) {
  if (mimeType === 'image/gif') {
    return bytes.length >= 6 && (bytes.subarray(0, 6).equals(Buffer.from('GIF87a')) || bytes.subarray(0, 6).equals(Buffer.from('GIF89a')));
  }
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === 'image/webp') {
    return bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from('RIFF')) && bytes.subarray(8, 12).equals(Buffer.from('WEBP'));
  }
  return false;
}

function parseInlineImage(block, options = {}) {
  if (!block || typeof block !== 'object') return null;
  const imageUrl = typeof block.image_url === 'string'
    ? block.image_url
    : block.image_url && typeof block.image_url.url === 'string'
      ? block.image_url.url
      : null;
  if (!imageUrl) return null;
  const match = imageUrl.match(/^data:(image\/(?:gif|jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return null;
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes >= 0
    ? options.maxBytes
    : MAX_INLINE_IMAGE_BYTES;
  const maxEncodedChars = Math.ceil(maxBytes / 3) * 4;
  if (match[2].length > maxEncodedChars) return null;
  const encoded = match[2].replace(/\s/g, '');
  if (!encoded) return null;
  const bytes = Buffer.from(encoded, 'base64');
  const normalized = encoded.replace(/=+$/, '');
  const mimeType = match[1].toLowerCase();
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64').replace(/=+$/, '') !== normalized) return null;
  if (!hasImageSignature(mimeType, bytes)) return null;
  return {
    bytes,
    mimeType,
  };
}

function isLoopbackUpstream(upstream) {
  const value = upstream && upstream.baseUrl ? upstream.baseUrl : upstream;
  let url;
  try {
    url = value instanceof URL ? value : new URL(String(value || ''));
  } catch {
    return false;
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function activeTurnStartIndex(body) {
  if (!body || !Array.isArray(body.input)) return 0;
  for (let i = body.input.length - 1; i >= 0; i -= 1) {
    const item = body.input[i];
    if (item && item.type === 'message' && item.role === 'user') return i;
  }
  return 0;
}

function stableSessionSeed(body) {
  const metadata = body && body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
  const conversation = body && body.conversation;
  const candidates = [
    ['session_id', metadata.session_id],
    ['thread_id', metadata.thread_id],
    ['conversation_id', metadata.conversation_id],
    ['conversation', conversation && typeof conversation === 'object' ? conversation.id : conversation],
    ['prompt_cache_key', body && body.prompt_cache_key],
  ];
  for (const [kind, value] of candidates) {
    if (typeof value === 'string' && value.trim()) return kind + ':' + value;
  }
  return null;
}

function cleanupExpiredSessions(cacheRoot, options = {}) {
  const retentionDays = Number(options.retentionDays);
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const intervalMs = Number.isFinite(options.cleanupIntervalMs)
    ? Math.max(0, options.cleanupIntervalMs)
    : DEFAULT_CLEANUP_INTERVAL_MS;
  if (intervalMs > 0 && now - lastCleanupAt < intervalMs) return;
  lastCleanupAt = now;

  let entries;
  try {
    entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  const expiresBefore = now - retentionDays * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionDir = path.join(cacheRoot, entry.name);
    try {
      if (fs.statSync(sessionDir).mtimeMs < expiresBefore) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
}

function touchSession(cacheRoot, sessionKey, now) {
  const sessionDir = path.join(cacheRoot, sessionKey);
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const touchedAt = new Date(Number.isFinite(now) ? now : Date.now());
  fs.utimesSync(sessionDir, touchedAt, touchedAt);
  return sessionDir;
}

function sessionDirectory(body, options = {}) {
  if (!options.cacheRoot) return null;
  const sessionSeed = stableSessionSeed(body);
  if (!sessionSeed) {
    if (typeof options.log === 'function') {
      options.log('inline-image-cache: stable session identifier unavailable; using temporary image storage');
    }
    return null;
  }
  try {
    cleanupExpiredSessions(options.cacheRoot, options);
    return touchSession(options.cacheRoot, hash(sessionSeed).slice(0, 24), options.now);
  } catch (error) {
    if (typeof options.log === 'function') options.log('inline-image-cache: ' + error.message);
    return null;
  }
}

function persistImageBytes(sessionDir, bytes, mimeType) {
  if (!Buffer.isBuffer(bytes) || !MIME_EXTENSIONS.has(mimeType)) {
    throw new Error('unsupported generated image data');
  }
  const image = { bytes, mimeType };
  const imageHash = hash(image.bytes);
  const imagePath = path.join(sessionDir, imageHash + MIME_EXTENSIONS.get(image.mimeType));
  try {
    fs.writeFileSync(imagePath, image.bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    const existing = fs.readFileSync(imagePath);
    if (existing.equals(image.bytes)) {
      fs.chmodSync(imagePath, 0o600);
      return imagePath;
    }
    const temporaryPath = imagePath + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(temporaryPath, image.bytes, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporaryPath, imagePath);
      fs.chmodSync(imagePath, 0o600);
    } finally {
      try {
        fs.unlinkSync(temporaryPath);
      } catch (cleanupError) {
        if (!cleanupError || cleanupError.code !== 'ENOENT') throw cleanupError;
      }
    }
  }
  return imagePath;
}

function pathReference(block, imagePath) {
  return {
    type: block.type === 'output_image' ? 'output_text' : 'input_text',
    text: '[image saved: ' + imagePath + ']',
  };
}

function rewriteInlineImages(body, options = {}) {
  if (!body || !Array.isArray(body.input) || !options.cacheRoot) return body;
  if (!isLoopbackUpstream(options.upstream)) {
    if (typeof options.log === 'function') {
      options.log('inline-image-cache: upstream is not loopback; leaving images inline');
    }
    return body;
  }
  const activeStart = activeTurnStartIndex(body);
  const sessionDir = sessionDirectory(body, options);
  if (!sessionDir) return body;

  body.input.forEach((item, itemIndex) => {
    if (!item || typeof item !== 'object') return;
    for (const field of ['content', 'output']) {
      if (!Array.isArray(item[field])) continue;
      item[field] = item[field].map((block) => {
        const image = parseInlineImage(block);
        if (!image) return block;
        let imagePath;
        try {
          imagePath = persistImageBytes(sessionDir, image.bytes, image.mimeType);
        } catch (error) {
          if (typeof options.log === 'function') options.log('inline-image-cache: ' + error.message);
          return block;
        }
        const isActiveImage = itemIndex >= activeStart;
        return options.imageModelTurn && isActiveImage ? block : pathReference(block, imagePath);
      });
    }
  });
  return body;
}

module.exports = {
  MAX_INLINE_IMAGE_BYTES,
  activeTurnStartIndex,
  cleanupExpiredSessions,
  isLoopbackUpstream,
  parseInlineImage,
  persistImageBytes,
  rewriteInlineImages,
  sessionDirectory,
  stableSessionSeed,
};
