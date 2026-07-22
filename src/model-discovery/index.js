'use strict';

const os = require('node:os');
const path = require('node:path');
const { withProviderCache } = require('./file-cache');
const {
  mergeDiscoveredWithSupplied,
  normalizeSuppliedModels,
} = require('./normalize');
const { resolveProvider } = require('./provider-resolution');
const nvidia = require('./providers/nvidia');
const openrouter = require('./providers/openrouter');
const cohere = require('./providers/cohere');
const ollama = require('./providers/ollama');

const ADAPTERS = { nvidia, openrouter, cohere, ollama };

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

function cacheEndpoint(provider, options) {
  if (provider === 'nvidia') return nvidia.ENDPOINT;
  if (provider === 'openrouter') return openrouter.ENDPOINT;
  if (provider === 'cohere') {
    const baseUrl = options.baseUrl || cohere.BASE_URL;
    return normalizedUrl(baseUrl) === cohere.BASE_URL ? cohere.ENDPOINT : null;
  }
  if (provider === 'ollama') return `${ollama.resolveApiBase(options.baseUrl)}/api/tags`;
  return null;
}

async function discoverModels(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const supplied = normalizeSuppliedModels(options.suppliedModels || []);
  const resolution = await resolveProvider({
    provider: options.provider,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    fetchImpl,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });

  if (!resolution.provider) {
    return {
      provider: null,
      providerResolution: resolution.providerResolution,
      source: supplied.length ? 'supplied' : 'none',
      cacheStatus: 'none',
      discoverySkipped: true,
      models: supplied,
      warnings: [],
    };
  }

  const adapter = ADAPTERS[resolution.provider];
  const adapterOptions = {
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    fetchImpl,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    detectionPayload: resolution.detectionPayload,
    suppliedModels: supplied.map((model) => model.id),
  };
  const endpoint = cacheEndpoint(resolution.provider, options);
  if (!endpoint) {
    const result = await adapter.discover(adapterOptions);
    return {
      provider: resolution.provider,
      providerResolution: resolution.providerResolution,
      source: resolution.provider,
      cacheStatus: 'none',
      discoverySkipped: true,
      models: mergeDiscoveredWithSupplied(result.models, supplied),
      warnings: result.warnings,
    };
  }

  let adapterWarnings = [];
  const cached = await withProviderCache({
    provider: resolution.provider,
    endpoint,
    apiKey: options.apiKey,
    cacheDir: options.cacheDir || defaultCacheDir(),
    ttlMs: adapter.CACHE_TTL_MS,
    now: options.now,
  }, async () => {
    const result = await adapter.discover(adapterOptions);
    adapterWarnings = result.warnings;
    return result.models;
  });

  return {
    provider: resolution.provider,
    providerResolution: resolution.providerResolution,
    source: resolution.provider,
    cacheStatus: cached.cacheStatus,
    discoverySkipped: false,
    models: mergeDiscoveredWithSupplied(cached.models, supplied),
    warnings: [...cached.warnings, ...adapterWarnings],
  };
}

module.exports = { ADAPTERS, discoverModels };
