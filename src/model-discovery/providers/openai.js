'use strict';

const { adapterResult } = require('../adapter-result');
const { fetchJson } = require('../live-catalog');
const { loadBundledProviderCatalog } = require('../provider-catalog');
const { emptyMetadataSources, normalizeModelId } = require('../normalize');

const BASE_URL = 'https://api.openai.com/v1';
const ENDPOINT = `${BASE_URL}/models`;
const CACHE_TTL_MS = 60000;

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function parseRow(row) {
  const value = record(row);
  let id;
  try { id = normalizeModelId(value.id); } catch { return null; }
  const providerMetadata = {};
  if (Number.isSafeInteger(value.created)) providerMetadata.created = value.created;
  if (typeof value.object === 'string') providerMetadata.object = value.object;
  if (typeof value.owned_by === 'string') providerMetadata.ownedBy = value.owned_by;
  return {
    id,
    displayName: id,
    contextWindow: null,
    maxOutputTokens: null,
    inputModalities: null,
    outputModalities: null,
    reasoning: null,
    reasoningLevels: null,
    defaultReasoningLevel: null,
    reasoningDefaultEnabled: null,
    reasoningSupportsMaxTokens: null,
    reasoningMandatory: null,
    toolCalling: null,
    metadataSources: emptyMetadataSources(),
    providerMetadata,
    source: 'openai-catalog',
  };
}

function resolveBaseUrl(value) {
  const url = new URL(value || BASE_URL);
  const normalized = url.origin + (url.pathname.replace(/\/+$/u, '') || '');
  if (normalized !== BASE_URL || url.search || url.hash) {
    throw new TypeError('OpenAI base URL must be its canonical HTTPS API URL.');
  }
  return normalized;
}

function endpointFor(baseUrl) {
  return `${resolveBaseUrl(baseUrl)}/models`;
}

async function discoverLive(options = {}) {
  const payload = await fetchJson({
    url: endpointFor(options.baseUrl),
    provider: 'openai',
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    requireHttps: true,
    allowedHostname: 'api.openai.com',
  });
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) {
    throw new TypeError('OpenAI model catalog response is missing its model list.');
  }
  const unique = new Map();
  for (const row of payload.data) {
    const model = parseRow(row);
    if (model && !unique.has(model.id)) unique.set(model.id, model);
  }
  if (unique.size === 0) {
    throw new TypeError('OpenAI model catalog contained no valid models.');
  }
  return adapterResult({
    models: [...unique.values()],
    warnings: [],
    origin: 'live',
    complete: true,
  });
}

async function discover(options = {}) {
  try {
    return await discoverLive(options);
  } catch (error) {
    if (options.signal && options.signal.aborted) throw error;
    const bundled = loadBundledProviderCatalog('openai');
    const warnings = ['OpenAI live catalog refresh failed; using the bundled provider catalog.'];
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
  BASE_URL,
  CACHE_TTL_MS,
  ENDPOINT,
  discover,
  discoverLive,
  endpointFor,
  parseRow,
  resolveBaseUrl,
};
