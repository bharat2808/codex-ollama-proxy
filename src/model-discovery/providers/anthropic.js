'use strict';

const { adapterResult } = require('../adapter-result');
const { fetchJson } = require('../live-catalog');
const { loadBundledProviderCatalog } = require('../provider-catalog');
const {
  boundedPositiveInteger,
  emptyMetadataSources,
  MAX_CONTEXT_WINDOW,
  MAX_OUTPUT_TOKENS,
  normalizeModelId,
  normalizeReasoningLevels,
} = require('../normalize');

const BASE_URL = 'https://api.anthropic.com/v1';
const ENDPOINT = `${BASE_URL}/models`;
const CACHE_TTL_MS = 60000;
const API_VERSION = '2023-06-01';
const PAGE_LIMIT = 1000;
const MAX_PAGES = 100;

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function supported(capability) {
  return record(capability).supported === true;
}

function parseRow(row) {
  const value = record(row);
  let id;
  try { id = normalizeModelId(value.id); } catch { return null; }
  const capabilities = record(value.capabilities);
  const hasImageCapability = Object.prototype.hasOwnProperty.call(capabilities, 'image_input');
  const hasThinkingCapability = Object.prototype.hasOwnProperty.call(capabilities, 'thinking');
  const imageInput = supported(capabilities.image_input);
  const reasoning = hasThinkingCapability ? supported(capabilities.thinking) : null;
  const effort = record(capabilities.effort);
  const reasoningLevels = normalizeReasoningLevels(
    Object.entries(effort)
      .filter(([level, capability]) => level !== 'supported' && supported(capability))
      .map(([level]) => level),
  );
  const hasToolCapability = Object.prototype.hasOwnProperty.call(capabilities, 'tool_use');
  const toolCalling = hasToolCapability ? supported(capabilities.tool_use) : null;
  const contextWindow = boundedPositiveInteger(value.max_input_tokens, MAX_CONTEXT_WINDOW);
  const maxOutputTokens = boundedPositiveInteger(value.max_tokens, MAX_OUTPUT_TOKENS);
  const metadataSources = emptyMetadataSources();
  if (contextWindow !== null) metadataSources.contextWindow = 'provider-catalog';
  if (maxOutputTokens !== null) metadataSources.maxOutputTokens = 'provider-catalog';
  if (hasImageCapability) metadataSources.inputModalities = 'provider-catalog';
  if (reasoning !== null) metadataSources.reasoning = 'provider-catalog';
  if (reasoningLevels !== null) metadataSources.reasoningLevels = 'provider-catalog';
  if (toolCalling !== null) metadataSources.toolCalling = 'provider-catalog';
  const providerMetadata = {};
  if (typeof value.created_at === 'string') providerMetadata.createdAt = value.created_at;
  if (typeof value.type === 'string') providerMetadata.type = value.type;
  return {
    id,
    displayName: typeof value.display_name === 'string' && value.display_name.trim()
      ? value.display_name.trim()
      : id,
    contextWindow,
    maxOutputTokens,
    inputModalities: hasImageCapability ? (imageInput ? ['text', 'image'] : ['text']) : null,
    outputModalities: null,
    reasoning,
    reasoningLevels,
    defaultReasoningLevel: null,
    reasoningDefaultEnabled: null,
    reasoningSupportsMaxTokens: null,
    reasoningMandatory: null,
    toolCalling,
    metadataSources,
    providerMetadata,
    source: 'anthropic-catalog',
  };
}

function resolveBaseUrl(value) {
  const url = new URL(value || BASE_URL);
  const normalized = url.origin + (url.pathname.replace(/\/+$/u, '') || '');
  if (normalized !== BASE_URL || url.search || url.hash) {
    throw new TypeError('Anthropic base URL must be its canonical HTTPS API URL.');
  }
  return normalized;
}

function endpointFor(baseUrl) {
  return `${resolveBaseUrl(baseUrl)}/models`;
}

async function discoverLive(options = {}) {
  const endpoint = endpointFor(options.baseUrl);
  const unique = new Map();
  let afterId = null;
  const cursors = new Set();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(endpoint);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (afterId) url.searchParams.set('after_id', afterId);
    const payload = await fetchJson({
      url: url.href,
      provider: 'anthropic',
      authHeaders: options.apiKey ? {
        'x-api-key': options.apiKey,
        'anthropic-version': API_VERSION,
      } : { 'anthropic-version': API_VERSION },
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      requireHttps: true,
      allowedHostname: 'api.anthropic.com',
    });
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) {
      throw new TypeError('Anthropic model catalog response is missing its model list.');
    }
    for (const row of payload.data) {
      const model = parseRow(row);
      if (model && !unique.has(model.id)) unique.set(model.id, model);
    }
    if (payload.has_more !== true) {
      if (unique.size === 0) {
        throw new TypeError('Anthropic model catalog contained no valid models.');
      }
      return adapterResult({
        models: [...unique.values()],
        warnings: [],
        origin: 'live',
        complete: true,
      });
    }
    const next = typeof payload.last_id === 'string' ? payload.last_id.trim() : '';
    if (!next || cursors.has(next)) {
      throw new TypeError('Anthropic model catalog pagination cursor is missing or repeated.');
    }
    cursors.add(next);
    afterId = next;
  }
  throw new TypeError('Anthropic model catalog exceeded the pagination limit.');
}

async function discover(options = {}) {
  try {
    return await discoverLive(options);
  } catch (error) {
    if (options.signal && options.signal.aborted) throw error;
    const bundled = loadBundledProviderCatalog('anthropic');
    const warnings = ['Anthropic live catalog refresh failed; using the bundled provider catalog.'];
    return adapterResult({
      models: bundled.models,
      warnings,
      origin: 'bundled',
      complete: false,
      fallback: { state: 'bundled', warnings },
    });
  }
}

module.exports = {
  API_VERSION,
  BASE_URL,
  CACHE_TTL_MS,
  ENDPOINT,
  discover,
  discoverLive,
  endpointFor,
  parseRow,
  resolveBaseUrl,
};
