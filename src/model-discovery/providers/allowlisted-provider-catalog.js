'use strict';

const { fetchJson } = require('../live-catalog');
const { adapterResult } = require('../adapter-result');
const { loadOpenClawCatalog } = require('../openclaw-catalog');
const {
  MAX_CONTEXT_WINDOW,
  MAX_OUTPUT_TOKENS,
  emptyMetadataSources,
  isObviousNonTextModelId,
  normalizeModelId,
  normalizeReasoningLevels,
} = require('../normalize');
const {
  firstBoundedPositiveInteger,
  isUnavailableModelRow,
  normalizedStrings,
  record,
} = require('../model-row-utils');

const CACHE_TTL_MS = 60000;
const KNOWN_MODALITIES = new Set(['text', 'image', 'audio', 'video', 'document']);

function parseLiveRow(row, source) {
  const value = record(row);
  if (isUnavailableModelRow(value)) return null;
  let id;
  try { id = normalizeModelId(value.id || value.name || value.model); } catch { return null; }
  if (isObviousNonTextModelId(id)) return null;
  const outputModalities = normalizedStrings(value.output_modalities || value.outputModalities);
  if (outputModalities.length && !outputModalities.includes('text')) return null;
  const input = normalizedStrings(value.input_modalities || value.inputModalities)
    .filter((modality) => KNOWN_MODALITIES.has(modality));
  const contextWindow = firstBoundedPositiveInteger(
    MAX_CONTEXT_WINDOW,
    value.context_window,
    value.contextWindow,
    value.context_length,
  );
  const maxOutputTokens = firstBoundedPositiveInteger(
    MAX_OUTPUT_TOKENS,
    value.max_output_tokens,
    value.maxOutputTokens,
    value.max_completion_tokens,
  );
  const reasoning = typeof value.reasoning === 'boolean'
    ? value.reasoning
    : typeof value.supports_reasoning === 'boolean' ? value.supports_reasoning : null;
  const reasoningLevels = normalizeReasoningLevels(
    value.reasoning_levels || value.reasoningLevels || value.supported_reasoning_levels,
  );
  const toolCalling = typeof value.supports_tools === 'boolean'
    ? value.supports_tools
    : typeof value.tool_calling === 'boolean' ? value.tool_calling : null;
  const metadataSources = emptyMetadataSources();
  if (contextWindow !== null) metadataSources.contextWindow = 'provider-catalog';
  if (maxOutputTokens !== null) metadataSources.maxOutputTokens = 'provider-catalog';
  if (input.length) metadataSources.inputModalities = 'provider-catalog';
  if (outputModalities.length) metadataSources.outputModalities = 'provider-catalog';
  if (reasoning !== null) metadataSources.reasoning = 'provider-catalog';
  if (reasoningLevels !== null) metadataSources.reasoningLevels = 'provider-catalog';
  if (toolCalling !== null) metadataSources.toolCalling = 'provider-catalog';
  return {
    id,
    displayName: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id,
    contextWindow,
    maxOutputTokens,
    inputModalities: input.length ? [...new Set(input)] : null,
    outputModalities: outputModalities.length ? [...new Set(outputModalities.filter((modality) => KNOWN_MODALITIES.has(modality)))] : null,
    reasoning,
    reasoningLevels,
    toolCalling,
    metadataSources,
    source,
  };
}

function enrichLiveModel(live, seed) {
  if (!seed) return live;
  const enriched = { ...live, metadataSources: { ...live.metadataSources } };
  for (const field of ['contextWindow', 'maxOutputTokens', 'inputModalities', 'outputModalities', 'reasoning', 'reasoningLevels', 'toolCalling']) {
    if (enriched[field] === null && seed[field] !== null) {
      enriched[field] = seed[field];
      enriched.metadataSources[field] = 'provider-seed';
    }
  }
  if (enriched.displayName === enriched.id && seed.displayName) enriched.displayName = seed.displayName;
  return enriched;
}

function modelRows(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.data)) return payload.data;
  return Array.isArray(payload.models) ? payload.models : null;
}

async function discoverCompatible(options, config) {
  const baseUrl = config.resolveBaseUrl(options.baseUrl);
  const endpoint = `${baseUrl}/models`;
  let staticCatalog = { models: [], warnings: [] };
  if (config.staticProvider) {
    staticCatalog = await loadOpenClawCatalog({
      provider: config.staticProvider,
      cacheDir: options.cacheDir,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      now: options.now,
    });
  }
  const seeds = new Map(staticCatalog.models.map((model) => [model.id, model]));
  try {
    const payload = await fetchJson({
      url: endpoint,
      provider: config.provider,
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      requireHttps: true,
      allowedHostname: new URL(baseUrl).hostname,
    });
    const rows = modelRows(payload);
    if (!rows) throw new TypeError('Provider model catalog response is missing its model list.');
    const unique = new Map();
    for (const row of rows) {
      const live = parseLiveRow(row, `${config.provider}-catalog`);
      if (live && !unique.has(live.id)) unique.set(live.id, enrichLiveModel(live, seeds.get(live.id)));
    }
    return adapterResult({
      models: [...unique.values()],
      warnings: staticCatalog.warnings,
      origin: 'live',
      complete: true,
    });
  } catch (error) {
    if (options.signal && options.signal.aborted) throw error;
    if (!staticCatalog.models.length) throw error;
    return adapterResult({
      models: staticCatalog.models,
      warnings: [...staticCatalog.warnings, `${config.provider} live catalog refresh failed; using its OpenClaw static catalog.`],
      origin: staticCatalog.cacheStatus === 'bundled' ? 'bundled' : 'static',
      complete: false,
      fallback: {
        cacheStatus: staticCatalog.cacheStatus === 'bundled' ? 'bundled' : 'static',
        warnings: [...staticCatalog.warnings, `${config.provider} live catalog refresh failed; using its OpenClaw static catalog.`],
      },
    });
  }
}

function exactBaseUrl(value, allowed, fallback) {
  let normalized;
  try {
    const url = new URL(value || fallback);
    const pathname = url.pathname.replace(/\/+$/u, '') || '/';
    normalized = url.origin + (pathname === '/' ? '' : pathname);
  } catch {
    throw new TypeError('Provider base URL is invalid.');
  }
  if (!allowed.includes(normalized)) throw new TypeError('Provider base URL is not canonical.');
  return normalized;
}

function defineCompatibleProvider(config) {
  const baseUrls = [...config.baseUrls];
  const defaultBaseUrl = config.defaultBaseUrl || baseUrls[0];
  const resolveBaseUrl = (value) => exactBaseUrl(value, baseUrls, defaultBaseUrl);
  return {
    BASE_URL: defaultBaseUrl,
    CACHE_TTL_MS,
    ENDPOINT: `${defaultBaseUrl}/models`,
    discover: (options = {}) => discoverCompatible(options, {
      provider: config.provider,
      staticProvider: config.staticProvider,
      resolveBaseUrl,
    }),
    endpointFor: (baseUrl) => `${resolveBaseUrl(baseUrl)}/models`,
    resolveBaseUrl,
  };
}

module.exports = {
  CACHE_TTL_MS,
  defineCompatibleProvider,
  discoverCompatible,
  exactBaseUrl,
  parseLiveRow,
};
