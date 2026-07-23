'use strict';

const { fetchJson } = require('../live-catalog');
const { emptyMetadataSources, isObviousNonTextModelId, normalizeModelId } = require('../normalize');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const NATIVE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const ENDPOINT = `${NATIVE_BASE_URL}/models?pageSize=1000`;
const CACHE_TTL_MS = 60000;

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
  return {
    id,
    displayName: typeof row.displayName === 'string' && row.displayName.trim() ? row.displayName.trim() : id,
    contextWindow,
    maxOutputTokens,
    inputModalities: gemmaTextOnly ? ['text'] : ['text', 'image'],
    outputModalities: ['text'],
    reasoning: typeof row.thinking === 'boolean' ? row.thinking : null,
    reasoningLevels: null,
    toolCalling: null,
    metadataSources,
    source: 'google-catalog',
  };
}

async function discover(options = {}) {
  const payload = await fetchJson({
    url: ENDPOINT,
    provider: 'google',
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    headers: options.apiKey ? { 'x-goog-api-key': options.apiKey } : {},
    requireHttps: true,
    allowedHostname: 'generativelanguage.googleapis.com',
  });
  const rows = payload && Array.isArray(payload.models) ? payload.models : [];
  const models = new Map();
  for (const row of rows) {
    const model = parseRow(row);
    if (model && !models.has(model.id)) models.set(model.id, model);
  }
  return { models: [...models.values()], warnings: [] };
}

function endpointFor(baseUrl) {
  const normalized = new URL(baseUrl || BASE_URL).href.replace(/\/+$/u, '');
  if (normalized !== BASE_URL) throw new TypeError('Provider base URL is not canonical.');
  return ENDPOINT;
}

module.exports = { BASE_URL, CACHE_TTL_MS, ENDPOINT, discover, endpointFor, parseRow };
