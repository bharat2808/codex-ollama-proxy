'use strict';

const { fetchJson } = require('../live-catalog');
const { adapterResult } = require('../adapter-result');
const {
  enrichModelFromSeed,
  loadBundledProviderCatalog,
} = require('../provider-catalog');
const { emptyMetadataSources, isObviousNonTextModelId, normalizeModelId } = require('../normalize');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const NATIVE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const ENDPOINT = `${NATIVE_BASE_URL}/models?pageSize=1000`;
const CACHE_TTL_MS = 60000;

function isVertexBaseUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname.endsWith('aiplatform.googleapis.com')
      && /^\/v1\/projects\/[^/]+\/locations\/[^/]+\/endpoints\/openapi\/?$/u.test(url.pathname);
  } catch {
    return false;
  }
}

function suppliedVertexModel(rawId) {
  let id;
  try { id = normalizeModelId(rawId); } catch { return null; }
  const metadataSources = emptyMetadataSources();
  metadataSources.inputModalities = 'provider-id';
  metadataSources.outputModalities = 'provider-id';
  const geminiId = id.replace(/^google\//u, '');
  return {
    id,
    displayName: id,
    contextWindow: null,
    maxOutputTokens: null,
    inputModalities: ['text', 'image', 'audio', 'video', 'document'],
    outputModalities: /^gemini-.+-image(?:-|$)/u.test(geminiId) ? ['text', 'image'] : ['text'],
    reasoning: null,
    reasoningLevels: null,
    toolCalling: null,
    metadataSources,
    source: 'google-provider-id',
  };
}

function parseRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  if (!Array.isArray(row.supportedGenerationMethods)
    || !row.supportedGenerationMethods.includes('generateContent')) return null;
  const rawId = typeof row.name === 'string' && row.name.startsWith('models/')
    ? row.name.slice('models/'.length) : null;
  let id;
  try { id = normalizeModelId(rawId); } catch { return null; }
  if (isObviousNonTextModelId(id)) return null;
  const contextWindow = Number.isSafeInteger(row.inputTokenLimit) && row.inputTokenLimit > 0
    ? row.inputTokenLimit : null;
  const maxOutputTokens = Number.isSafeInteger(row.outputTokenLimit) && row.outputTokenLimit > 0
    ? row.outputTokenLimit : null;
  if (contextWindow === null || maxOutputTokens === null) return null;
  const metadataSources = emptyMetadataSources();
  metadataSources.contextWindow = 'provider-catalog';
  metadataSources.maxOutputTokens = 'provider-catalog';
  metadataSources.inputModalities = 'provider-catalog';
  metadataSources.outputModalities = 'provider-catalog';
  const gemmaTextOnly = id.startsWith('gemma-')
    && !/^gemma-3-(?:4b|12b|27b)(?:-|$)/u.test(id)
    && !id.startsWith('gemma-3n-') && !id.startsWith('gemma-4-');
  const geminiImageOutput = /^gemini-.+-image(?:-|$)/u.test(id);
  return {
    id,
    displayName: typeof row.displayName === 'string' && row.displayName.trim() ? row.displayName.trim() : id,
    contextWindow,
    maxOutputTokens,
    inputModalities: gemmaTextOnly
      ? ['text']
      : id.startsWith('gemini-')
        ? ['text', 'image', 'audio', 'video', 'document']
        : ['text', 'image'],
    outputModalities: geminiImageOutput ? ['text', 'image'] : ['text'],
    reasoning: typeof row.thinking === 'boolean' ? row.thinking : null,
    reasoningLevels: null,
    toolCalling: null,
    metadataSources,
    source: 'google-catalog',
  };
}

async function discover(options = {}) {
  if (isVertexBaseUrl(options.baseUrl)) {
    return adapterResult({
      models: (options.suppliedModels || []).map(suppliedVertexModel).filter(Boolean),
      warnings: [],
      origin: 'supplied',
      complete: false,
    });
  }
  let payload;
  try {
    payload = await fetchJson({
      url: ENDPOINT,
      provider: 'google',
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      headers: options.apiKey ? { 'x-goog-api-key': options.apiKey } : {},
      requireHttps: true,
      allowedHostname: 'generativelanguage.googleapis.com',
    });
  } catch (error) {
    if (options.signal && options.signal.aborted) throw error;
    const bundled = loadBundledProviderCatalog('google');
    const warnings = ['Google live catalog refresh failed; using the bundled provider catalog.'];
    return adapterResult({
      models: bundled.models,
      warnings,
      origin: 'bundled',
      complete: false,
      fallback: { state: 'bundled', warnings },
    });
  }
  const rows = payload && Array.isArray(payload.models) ? payload.models : [];
  const bundled = loadBundledProviderCatalog('google');
  const seeds = new Map(bundled.models.map((model) => [model.id, model]));
  const models = new Map();
  for (const row of rows) {
    const parsed = parseRow(row);
    const model = parsed ? enrichModelFromSeed(parsed, seeds.get(parsed.id)) : null;
    if (model && !models.has(model.id)) models.set(model.id, model);
  }
  return adapterResult({
    models: [...models.values()],
    warnings: [],
    origin: 'live',
    complete: true,
  });
}

function endpointFor(baseUrl) {
  if (isVertexBaseUrl(baseUrl)) return null;
  const normalized = new URL(baseUrl || BASE_URL).href.replace(/\/+$/u, '');
  if (normalized !== BASE_URL) throw new TypeError('Provider base URL is not canonical.');
  return ENDPOINT;
}

module.exports = {
  BASE_URL,
  CACHE_TTL_MS,
  ENDPOINT,
  discover,
  endpointFor,
  isVertexBaseUrl,
  parseRow,
  suppliedVertexModel,
};
