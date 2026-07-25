'use strict';

const dns = require('node:dns');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const inlineImageCache = require('./inline-image-cache');

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 3;

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function isPrivateAddress(address) {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version !== 6) return true;
  const normalized = address.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (/^f[cd]/u.test(normalized) || /^fe[89ab]/u.test(normalized)) return true;
  const mappedDecimal = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u);
  if (mappedDecimal) return isPrivateIpv4(mappedDecimal[1]);
  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16);
    const low = parseInt(mappedHex[2], 16);
    return isPrivateIpv4([
      high >>> 8,
      high & 0xff,
      low >>> 8,
      low & 0xff,
    ].join('.'));
  }
  return false;
}

async function validateRemoteUrl(url, resolveHostname) {
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('generated image URL must be credential-free HTTPS');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (hostname === 'localhost') throw new Error('generated image URL cannot target a local address');
  const literalVersion = net.isIP(hostname);
  const addresses = literalVersion
    ? [{ address: hostname, family: literalVersion }]
    : await resolveHostname(hostname, { all: true, verbatim: true });
  if (!Array.isArray(addresses) || !addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('generated image URL resolved to a local or private address');
  }
}

async function readBoundedBody(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`generated image exceeds the ${maxBytes}-byte limit`);
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`generated image exceeds the ${maxBytes}-byte limit`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`generated image exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

async function downloadImage(result, options) {
  const fetchImpl = options.fetchImpl || fetch;
  const resolveHostname = options.resolveHostname || dns.promises.lookup;
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes >= 0
    ? options.maxBytes
    : inlineImageCache.MAX_INLINE_IMAGE_BYTES;
  let url;
  try {
    url = new URL(result);
  } catch {
    throw new Error('generated image result is not a valid URL');
  }
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await validateRemoteUrl(url, resolveHostname);
    const response = await fetchImpl(url.href, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_DOWNLOAD_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirects === MAX_REDIRECTS) throw new Error('generated image URL exceeded the redirect limit');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw new Error(`generated image download returned HTTP ${response.status}`);
    const bytes = await readBoundedBody(response, maxBytes);
    const mimeType = inlineImageCache.imageMimeType(bytes, response.headers.get('content-type'));
    if (!mimeType) throw new Error('generated image download returned an unsupported or invalid image');
    return { bytes, mimeType };
  }
  throw new Error('generated image URL exceeded the redirect limit');
}

async function imageFromResult(result, options) {
  const inline = inlineImageCache.parseInlineImage({ image_url: result }, {
    maxBytes: options.maxBytes,
  });
  if (inline) return inline;
  return downloadImage(result, options);
}

async function cacheGeneratedImages(response, requestBody, options = {}) {
  if (!response || !Array.isArray(response.output) || !options.cacheRoot) return response;
  if (!inlineImageCache.stableSessionSeed(requestBody)) return response;
  for (const item of response.output) {
    if (!item || item.type !== 'image_generation_call' || typeof item.result !== 'string' || item.saved_path) continue;
    try {
      const image = await imageFromResult(item.result, options);
      item.saved_path = inlineImageCache.persistSessionImage(requestBody, image, options);
    } catch (error) {
      if (typeof options.log === 'function') {
        options.log('generated-image-cache: ' + error.message);
      }
    }
  }
  return response;
}

function visibleImageMessages(response) {
  if (!response || !Array.isArray(response.output)) return [];
  return response.output.flatMap((item, index) => {
    if (
      !item
      || item.type !== 'image_generation_call'
      || typeof item.saved_path !== 'string'
      || !path.isAbsolute(item.saved_path)
    ) {
      return [];
    }
    const suffix = typeof item.id === 'string' && item.id
      ? item.id.replace(/[^A-Za-z0-9_-]/gu, '_')
      : String(index);
    return [{
      id: `msg_proxy_generated_image_${suffix}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{
        type: 'output_text',
        text: `![Generated image](<${item.saved_path}>)`,
        annotations: [],
      }],
    }];
  });
}

function cachedImageDataUrl(savedPath, options) {
  if (typeof savedPath !== 'string' || !savedPath || !options.cacheRoot) return null;
  const cacheRoot = path.resolve(options.cacheRoot);
  const candidate = path.resolve(savedPath);
  if (candidate !== cacheRoot && !candidate.startsWith(cacheRoot + path.sep)) return null;
  let realRoot;
  let realCandidate;
  try {
    realRoot = fs.realpathSync(cacheRoot);
    realCandidate = fs.realpathSync(candidate);
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + path.sep)) return null;
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes >= 0
    ? options.maxBytes
    : inlineImageCache.MAX_INLINE_IMAGE_BYTES;
  const stat = fs.statSync(realCandidate);
  if (stat.size <= 0 || stat.size > maxBytes) return null;
  const bytes = fs.readFileSync(realCandidate);
  const mimeType = inlineImageCache.imageMimeType(bytes);
  return mimeType ? `data:${mimeType};base64,${bytes.toString('base64')}` : null;
}

function generatedImageSource(item, options) {
  const cached = cachedImageDataUrl(item && item.saved_path, options);
  if (cached) return cached;
  if (!item || typeof item.result !== 'string') return null;
  const inline = inlineImageCache.parseInlineImage({ image_url: item.result }, {
    maxBytes: options.maxBytes,
  });
  return inline ? item.result : null;
}

function rehydrateGeneratedImageChain(body, options = {}) {
  if (!body || !Array.isArray(body.input)) return 0;
  const sources = body.input
    .filter((item) => item && item.type === 'image_generation_call')
    .map((item) => generatedImageSource(item, options))
    .filter(Boolean);
  if (!sources.length) return 0;
  let userMessage = null;
  for (let index = body.input.length - 1; index >= 0; index -= 1) {
    const item = body.input[index];
    if (item && item.role === 'user') {
      userMessage = item;
      break;
    }
  }
  if (!userMessage) return 0;
  const content = Array.isArray(userMessage.content)
    ? userMessage.content
    : [{ type: 'input_text', text: String(userMessage.content || '') }];
  const existingSources = new Set(content
    .filter((part) => part && part.type === 'input_image')
    .map((part) => typeof part.image_url === 'string'
      ? part.image_url
      : part.image_url && part.image_url.url)
    .filter(Boolean));
  const historicalImages = sources
    .filter((imageUrl) => !existingSources.has(imageUrl))
    .map((imageUrl) => ({ type: 'input_image', image_url: imageUrl }));
  if (!historicalImages.length) return 0;
  const activeImageIndex = content.findIndex((part) => part && part.type === 'input_image');
  const insertionIndex = activeImageIndex === -1 ? content.length : activeImageIndex;
  userMessage.content = [
    ...content.slice(0, insertionIndex),
    ...historicalImages,
    ...content.slice(insertionIndex),
  ];
  return historicalImages.length;
}

module.exports = {
  cacheGeneratedImages,
  isPrivateAddress,
  rehydrateGeneratedImageChain,
  visibleImageMessages,
};
