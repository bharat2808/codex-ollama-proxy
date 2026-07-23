'use strict';

const { fetchJson } = require('../live-catalog');
const { loadOpenClawCatalog } = require('../openclaw-catalog');
const {
  MAX_CONTEXT_WINDOW,
  MAX_OUTPUT_TOKENS,
  boundedPositiveInteger,
  emptyMetadataSources,
  isObviousNonTextModelId,
  normalizeModelId,
} = require('../normalize');

const CACHE_TTL_MS = 60000;

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function positiveInteger(maximum, ...values) {
  for (const value of values) {
    const parsed = boundedPositiveInteger(value, maximum);
    if (parsed !== null) return parsed;
  }
  return null;
}

function strings(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string').map((entry) => entry.trim().toLowerCase())
    : [];
}

function parseLiveRow(row, source) {
  const value = record(row);
  if (!value || value.active === false || value.enabled === false || value.available === false) return null;
  if (value.archived === true || value.deprecated === true) return null;
  let id;
  try { id = normalizeModelId(value.id || value.name || value.model); } catch { return null; }
  if (isObviousNonTextModelId(id)) return null;
  const outputModalities = strings(value.output_modalities || value.outputModalities);
  if (outputModalities.length && !outputModalities.includes('text')) return null;
  const input = strings(value.input_modalities || value.inputModalities);
  const contextWindow = positiveInteger(
    MAX_CONTEXT_WINDOW,
    value.context_window,
    value.contextWindow,
    value.context_length,
  );
  const maxOutputTokens = positiveInteger(
    MAX_OUTPUT_TOKENS,
    value.max_output_tokens,
    value.maxOutputTokens,
    value.max_completion_tokens,
  );
  const reasoning = typeof value.reasoning === 'boolean'
    ? value.reasoning
    : typeof value.supports_reasoning === 'boolean' ? value.supports_reasoning : null;
  const toolCalling = typeof value.supports_tools === 'boolean'
    ? value.supports_tools
    : typeof value.tool_calling === 'boolean' ? value.tool_calling : null;
  const metadataSources = emptyMetadataSources();
  if (contextWindow !== null) metadataSources.contextWindow = 'provider-catalog';
  if (maxOutputTokens !== null) metadataSources.maxOutputTokens = 'provider-catalog';
  if (input.length) metadataSources.inputModalities = 'provider-catalog';
  if (reasoning !== null) metadataSources.reasoning = 'provider-catalog';
  if (toolCalling !== null) metadataSources.toolCalling = 'provider-catalog';
  return {
    id,
    displayName: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id,
    contextWindow,
    maxOutputTokens,
    inputModalities: input.length ? (input.includes('image') ? ['text', 'image'] : ['text']) : null,
    reasoning,
    toolCalling,
    metadataSources,
    source,
  };
}

function enrichLiveModel(live, seed) {
  if (!seed) return live;
  const enriched = { ...live, metadataSources: { ...live.metadataSources } };
  for (const field of ['contextWindow', 'maxOutputTokens', 'inputModalities', 'reasoning', 'toolCalling']) {
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
    return { models: [...unique.values()], warnings: staticCatalog.warnings };
  } catch (error) {
    if (options.signal && options.signal.aborted) throw error;
    if (!staticCatalog.models.length) throw error;
    return {
      models: staticCatalog.models,
      warnings: [...staticCatalog.warnings, `${config.provider} live catalog refresh failed; using its OpenClaw static catalog.`],
    };
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

module.exports = {
  CACHE_TTL_MS,
  discoverCompatible,
  exactBaseUrl,
  parseLiveRow,
};
