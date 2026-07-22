'use strict';

const os = require('node:os');
const path = require('node:path');
const { discoveryError } = require('./errors');
const { withProviderCache } = require('./file-cache');
const { fetchJson } = require('./live-catalog');
const {
  MAX_CONTEXT_WINDOW,
  MAX_OUTPUT_TOKENS,
  boundedPositiveInteger,
  emptyMetadataSources,
  normalizeModelId,
} = require('./normalize');

const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ROWS = 1000;
const MODALITIES = new Set(['text', 'image', 'audio', 'video', 'document']);
const OPENCLAW_CATALOGS = Object.freeze({
  nvidia: Object.freeze({
    url: 'https://raw.githubusercontent.com/openclaw/openclaw/main/extensions/nvidia/openclaw.plugin.json',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    bundledFile: path.join(__dirname, 'catalogs', 'openclaw', 'nvidia.json'),
  }),
  cohere: Object.freeze({
    url: 'https://raw.githubusercontent.com/openclaw/openclaw/main/extensions/cohere/openclaw.plugin.json',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    bundledFile: path.join(__dirname, 'catalogs', 'openclaw', 'cohere.json'),
  }),
});

function defaultCacheDir() {
  const codexDir = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexDir, 'ollama-shape-proxy', 'model-discovery-cache');
}

function normalizedUrl(value) {
  try {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\/+$/u, '') || '/';
    return url.origin + (pathname === '/' ? '' : pathname);
  } catch {
    return '';
  }
}

function displayName(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const name = value.trim();
  if (!name || name.length > 512 || /[\u0000-\u001f\u007f]/u.test(name)) return fallback;
  return name;
}

function inputModalities(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const normalized = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    const modality = entry.toLowerCase();
    if (!MODALITIES.has(modality)) return null;
    if (!normalized.includes(modality)) normalized.push(modality);
  }
  return normalized.length ? normalized : null;
}

function parseRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.status === 'deprecated') return null;
  let id;
  try { id = normalizeModelId(row.id); } catch { return null; }
  const contextWindow = boundedPositiveInteger(row.contextWindow, MAX_CONTEXT_WINDOW);
  const maxOutputTokens = boundedPositiveInteger(row.maxTokens, MAX_OUTPUT_TOKENS);
  const modalities = inputModalities(row.input);
  const reasoning = typeof row.reasoning === 'boolean' ? row.reasoning : null;
  const toolCalling = row.compat && typeof row.compat.supportsTools === 'boolean'
    ? row.compat.supportsTools
    : null;
  const metadataSources = emptyMetadataSources();
  for (const [field, value] of [
    ['contextWindow', contextWindow],
    ['maxOutputTokens', maxOutputTokens],
    ['inputModalities', modalities],
    ['reasoning', reasoning],
    ['toolCalling', toolCalling],
  ]) {
    if (value !== null) metadataSources[field] = 'provider-seed';
  }
  return {
    id,
    displayName: displayName(row.name, id),
    contextWindow,
    maxOutputTokens,
    inputModalities: modalities,
    reasoning,
    toolCalling,
    metadataSources,
    source: 'openclaw-static',
  };
}

function parseOpenClawCatalog(provider, payload) {
  const catalog = OPENCLAW_CATALOGS[provider];
  if (!catalog) throw new TypeError(`Unsupported OpenClaw catalog provider: ${provider}`);
  const providerCatalog = payload && payload.modelCatalog && payload.modelCatalog.providers
    ? payload.modelCatalog.providers[provider]
    : null;
  if (!providerCatalog || typeof providerCatalog !== 'object' || Array.isArray(providerCatalog)) {
    throw discoveryError('INVALID_SCHEMA', provider, 'OpenClaw catalog is missing the expected provider.');
  }
  if (normalizedUrl(providerCatalog.baseUrl) !== catalog.baseUrl) {
    throw discoveryError('INVALID_SCHEMA', provider, 'OpenClaw catalog provider base URL did not match the allowlist.');
  }
  if (!Array.isArray(providerCatalog.models)) {
    throw discoveryError('INVALID_SCHEMA', provider, 'OpenClaw catalog is missing its model list.');
  }
  const models = [];
  const seen = new Set();
  for (const row of providerCatalog.models.slice(0, MAX_ROWS)) {
    const model = parseRow(row);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  if (models.length === 0) {
    throw discoveryError('INVALID_SCHEMA', provider, 'OpenClaw catalog contained no valid models.');
  }
  return models;
}

async function loadOpenClawCatalog(options = {}) {
  const provider = options.provider;
  const catalog = OPENCLAW_CATALOGS[provider];
  if (!catalog) throw new TypeError(`Unsupported OpenClaw catalog provider: ${provider}`);
  try {
    return await withProviderCache({
      provider: `openclaw-${provider}`,
      endpoint: catalog.url,
      apiKey: null,
      cacheDir: path.join(options.cacheDir || defaultCacheDir(), 'openclaw-static'),
      ttlMs: CATALOG_TTL_MS,
      now: options.now,
    }, async () => {
      const payload = await fetchJson({
        url: catalog.url,
        provider,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        requireHttps: true,
        allowedHostname: 'raw.githubusercontent.com',
      });
      return parseOpenClawCatalog(provider, payload);
    });
  } catch (error) {
    if (options.signal && options.signal.aborted) throw error;
    const bundledPayload = require(catalog.bundledFile);
    return {
      models: parseOpenClawCatalog(provider, bundledPayload),
      cacheStatus: 'bundled',
      warnings: ['OpenClaw catalog sync failed; using the bundled OpenClaw catalog snapshot.'],
    };
  }
}

module.exports = {
  CATALOG_TTL_MS,
  OPENCLAW_CATALOGS,
  loadOpenClawCatalog,
  parseOpenClawCatalog,
};
