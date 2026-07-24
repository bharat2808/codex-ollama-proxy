'use strict';

const { fetchJson } = require('../live-catalog');
const { adapterResult } = require('../adapter-result');
const { loadBundledProviderCatalog } = require('../provider-catalog');
const {
  MAX_CONTEXT_WINDOW,
  MAX_OUTPUT_TOKENS,
  boundedPositiveInteger,
  emptyMetadataSources,
  normalizeModelId,
} = require('../normalize');

const BASE_URL = 'https://api.cohere.ai/compatibility/v1';
const ENDPOINT = 'https://api.cohere.com/v1/models?endpoint=chat&page_size=1000';
const CACHE_TTL_MS = 60000;

function normalizedUrl(value) {
  try {
    const url = new URL(value || BASE_URL);
    const pathname = url.pathname.replace(/\/+$/u, '') || '/';
    return url.origin + (pathname === '/' ? '' : pathname);
  } catch {
    return '';
  }
}

function positiveInteger(maximum, ...values) {
  for (const value of values) {
    const parsed = boundedPositiveInteger(value, maximum);
    if (parsed !== null) return parsed;
  }
  return null;
}

function modalities(value) {
  if (!Array.isArray(value)) return null;
  const lowered = value.filter((entry) => typeof entry === 'string').map((entry) => entry.toLowerCase());
  if (!lowered.length) return null;
  return lowered.includes('image') ? ['text', 'image'] : ['text'];
}

function parseRow(row, seeds = new Map()) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.is_deprecated === true) return null;
  let id;
  try { id = normalizeModelId(row.name); } catch { return null; }
  const seed = seeds.get(id) || null;
  const liveContext = positiveInteger(
    MAX_CONTEXT_WINDOW,
    row.context_window,
    row.context_length,
    row.max_context_length,
  );
  const liveOutput = positiveInteger(
    MAX_OUTPUT_TOKENS,
    row.max_output_tokens,
    row.max_completion_tokens,
    row.output_token_limit,
  );
  const liveInput = modalities(row.input_modalities);
  const liveReasoning = typeof row.reasoning === 'boolean'
    ? row.reasoning
    : typeof row.supports_reasoning === 'boolean' ? row.supports_reasoning : null;
  const liveTools = typeof row.supports_tools === 'boolean'
    ? row.supports_tools
    : typeof row.tool_calling === 'boolean' ? row.tool_calling : null;
  const contextWindow = liveContext ?? seed?.contextWindow ?? null;
  const maxOutputTokens = liveOutput ?? seed?.maxOutputTokens ?? null;
  const inputModalities = liveInput ?? seed?.inputModalities ?? ['text'];
  const outputModalities = seed?.outputModalities ?? ['text'];
  const reasoning = liveReasoning ?? seed?.reasoning ?? null;
  const reasoningLevels = seed?.reasoningLevels ?? null;
  const toolCalling = liveTools ?? seed?.toolCalling ?? null;
  const metadataSources = emptyMetadataSources();
  for (const [field, liveValue] of [
    ['contextWindow', liveContext],
    ['maxOutputTokens', liveOutput],
    ['inputModalities', liveInput],
    ['reasoning', liveReasoning],
    ['toolCalling', liveTools],
  ]) {
    if (liveValue !== null) metadataSources[field] = 'provider-catalog';
    else if (seed && seed[field] !== null) {
      metadataSources[field] = seed.metadataSources?.[field] || 'provider-seed';
    }
  }
  if (!metadataSources.inputModalities) metadataSources.inputModalities = 'provider-catalog';
  metadataSources.outputModalities = seed?.outputModalities
    ? seed.metadataSources?.outputModalities || 'provider-seed'
    : 'provider-catalog';
  if (reasoningLevels !== null) {
    metadataSources.reasoningLevels = seed?.metadataSources?.reasoningLevels || 'provider-seed';
  }
  return {
    id,
    displayName: seed?.displayName || id,
    contextWindow,
    maxOutputTokens,
    inputModalities,
    outputModalities,
    reasoning,
    reasoningLevels,
    toolCalling,
    metadataSources,
    source: 'cohere-catalog',
  };
}

async function discover(options = {}) {
  if (normalizedUrl(options.baseUrl) !== BASE_URL) {
    return adapterResult({
      models: [],
      warnings: ['Skipped Cohere discovery for a noncanonical base URL.'],
      origin: 'supplied',
      complete: false,
    });
  }
  const staticCatalog = loadBundledProviderCatalog('cohere');
  const seeds = new Map(staticCatalog.models.map((model) => [model.id, model]));
  let payload;
  try {
    payload = await fetchJson({
      url: ENDPOINT,
      provider: 'cohere',
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      requireHttps: true,
      allowedHostname: 'api.cohere.com',
    });
  } catch (error) {
    if (options.signal && options.signal.aborted) throw error;
    return adapterResult({
      models: staticCatalog.models,
      warnings: [
        ...staticCatalog.warnings,
        'Cohere live catalog refresh failed; using the bundled provider catalog.',
      ],
      origin: 'bundled',
      complete: false,
      fallback: {
        state: 'bundled',
        warnings: ['Cohere live catalog refresh failed; using the bundled provider catalog.'],
      },
    });
  }
  const rows = payload && typeof payload === 'object' && Array.isArray(payload.models)
    ? payload.models
    : [];
  const unique = new Map();
  for (const row of rows) {
    const model = parseRow(row, seeds);
    if (model && !unique.has(model.id)) unique.set(model.id, model);
  }
  return adapterResult({
    models: [...unique.values()],
    warnings: staticCatalog.warnings,
    origin: 'live',
    complete: true,
  });
}

module.exports = { BASE_URL, CACHE_TTL_MS, ENDPOINT, discover, parseRow };
