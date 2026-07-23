'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fetchJson } = require('./live-catalog');
const { normalizeModelId } = require('./normalize');

const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const XAI_URL = 'https://raw.githubusercontent.com/openclaw/openclaw/main/extensions/xai/openclaw.plugin.json';
const BUNDLED_FILE = path.join(__dirname, 'catalogs', 'openclaw', 'xai-suppressions.json');

function defaultCacheDir() {
  const codexDir = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexDir, 'ollama-shape-proxy', 'model-discovery-cache');
}

function parseSuppressions(payload) {
  if (!payload || !payload.modelCatalog || !Array.isArray(payload.modelCatalog.suppressions)) {
    throw new TypeError('OpenClaw xAI suppression catalog is missing suppressions[].');
  }
  const rows = payload.modelCatalog.suppressions;
  const ids = [];
  const seen = new Set();
  for (const row of rows.slice(0, 1000)) {
    if (!row || row.provider !== 'xai') continue;
    let id;
    try { id = normalizeModelId(row.model); } catch { continue; }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function cacheFile(cacheDir) {
  return path.join(cacheDir || defaultCacheDir(), 'openclaw-static', 'xai-suppressions.json');
}

function readDocument(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (document.schemaVersion !== 1 || !Number.isFinite(document.fetchedAt)
      || !Array.isArray(document.models) || document.models.some((id) => typeof id !== 'string')) return null;
    return document;
  } catch {
    return null;
  }
}

function writeDocument(file, models, fetchedAt) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, fetchedAt, models }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }
}

async function loadXaiSuppressions(options = {}) {
  const file = cacheFile(options.cacheDir);
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const cached = readDocument(file);
  if (cached && now - cached.fetchedAt <= CATALOG_TTL_MS) {
    return { models: cached.models, cacheStatus: 'fresh', warnings: [] };
  }
  try {
    const payload = await fetchJson({
      url: XAI_URL,
      provider: 'xai',
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      requireHttps: true,
      allowedHostname: 'raw.githubusercontent.com',
    });
    const models = parseSuppressions(payload);
    if (models.length === 0) throw new TypeError('OpenClaw xAI suppression catalog contained no xAI models.');
    writeDocument(file, models, now);
    return { models, cacheStatus: 'refreshed', warnings: [] };
  } catch (error) {
    if (options.signal && options.signal.aborted) throw error;
    if (cached) {
      return {
        models: cached.models,
        cacheStatus: 'stale',
        warnings: ['OpenClaw xAI suppression refresh failed; using the last successful cache file.'],
      };
    }
    const bundled = JSON.parse(fs.readFileSync(BUNDLED_FILE, 'utf8'));
    return {
      models: parseSuppressions(bundled),
      cacheStatus: 'bundled',
      warnings: ['OpenClaw xAI suppression refresh failed; using the bundled snapshot.'],
    };
  }
}

module.exports = { CATALOG_TTL_MS, XAI_URL, loadXaiSuppressions, parseSuppressions };
