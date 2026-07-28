'use strict';

const os = require('node:os');
const path = require('node:path');
const { withProviderCache } = require('./file-cache');
const {
  mergeDiscoveredWithSupplied,
  normalizeSuppliedModels,
} = require('./normalize');
const { createDiscoveryResult } = require('./discovery-result');

function adapterModels(adapter, models) {
  return typeof adapter.filterModels === 'function' ? adapter.filterModels(models) : models;
}
const { resolveProvider } = require('./provider-resolution');
const ollama = require('./providers/ollama');
const { cacheEndpointFor, PROVIDERS } = require('./provider-registry');

const ADAPTERS = Object.fromEntries(
  Object.entries(PROVIDERS).map(([provider, definition]) => [provider, definition.adapter]),
);

function defaultCacheDir() {
  const codexDir = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexDir, 'ollama-shape-proxy', 'model-discovery-cache');
}

function providerTraits(provider, baseUrl) {
  const localOllama = provider === 'ollama' && ollama.isLocalBaseUrl(baseUrl);
  const staticTraits = provider && PROVIDERS[provider] ? PROVIDERS[provider].traits : {};
  return {
    inventoryComplete: Boolean(staticTraits.inventoryComplete),
    local: localOllama,
    nativeInspection: Boolean(staticTraits.nativeInspection),
    supportsCloudPull: localOllama,
  };
}

async function discoverModels(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const supplied = normalizeSuppliedModels(options.suppliedModels || []);
  const resolution = await resolveProvider({
    provider: options.provider,
    baseUrl: options.baseUrl,
    fetchImpl,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });

  if (!resolution.provider) {
    return createDiscoveryResult({
      provider: null,
      providerResolution: resolution.providerResolution,
      traits: providerTraits(null, options.baseUrl),
      source: supplied.length ? 'supplied' : 'none',
      dataOrigin: supplied.length ? 'supplied' : 'none',
      state: 'none',
      discoverySkipped: true,
      models: supplied,
      warnings: [],
    });
  }

  const adapter = ADAPTERS[resolution.provider];
  const traits = providerTraits(resolution.provider, options.baseUrl);
  const adapterOptions = {
    baseUrl: options.baseUrl,
    apiKey: resolution.provider === 'ollama' ? null : options.apiKey,
    fetchImpl,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    detectionPayload: resolution.detectionPayload,
    suppliedModels: supplied.map((model) => model.id),
    cacheDir: options.cacheDir || defaultCacheDir(),
    now: options.now,
  };
  const endpoint = cacheEndpointFor(resolution.provider, options);
  if (resolution.provider === 'custom' && supplied.length === 0) {
    return createDiscoveryResult({
      provider: 'custom',
      providerResolution: resolution.providerResolution,
      traits,
      source: 'custom',
      dataOrigin: 'supplied',
      state: 'none',
      discoverySkipped: true,
      models: [],
      warnings: [],
    });
  }
  if (!endpoint) {
    const result = await adapter.discover(adapterOptions);
    return createDiscoveryResult({
      provider: resolution.provider,
      providerResolution: resolution.providerResolution,
      traits: { ...traits, inventoryComplete: result.complete },
      source: resolution.provider,
      dataOrigin: result.origin,
      state: 'none',
      discoverySkipped: true,
      models: mergeDiscoveredWithSupplied(adapterModels(adapter, result.models), supplied),
      warnings: result.warnings,
    });
  }

  let adapterWarnings = [];
  const cached = await withProviderCache({
    provider: resolution.provider,
    endpoint,
    apiKey: resolution.provider === 'ollama' ? null : options.apiKey,
    cacheDir: options.cacheDir || defaultCacheDir(),
    ttlMs: adapter.CACHE_TTL_MS,
    now: options.now,
    signal: options.signal,
  }, async () => {
    const result = await adapter.discover(adapterOptions);
    adapterWarnings = result.warnings;
    return {
      models: result.models,
      fallback: result.fallback,
      origin: result.origin,
      complete: result.complete,
    };
  });

  return createDiscoveryResult({
    provider: resolution.provider,
    providerResolution: resolution.providerResolution,
    traits: { ...traits, inventoryComplete: cached.complete },
    source: resolution.provider,
    dataOrigin: cached.origin,
    state: cached.state,
    discoverySkipped: false,
    models: mergeDiscoveredWithSupplied(adapterModels(adapter, cached.models), supplied),
    warnings: [...new Set([...cached.warnings, ...adapterWarnings])],
  });
}

module.exports = { ADAPTERS, discoverModels };
