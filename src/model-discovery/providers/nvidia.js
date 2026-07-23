'use strict';

const { fetchJson } = require('../live-catalog');
const { loadOpenClawCatalog } = require('../openclaw-catalog');
const { emptyMetadataSources, normalizeModelId } = require('../normalize');

const ENDPOINT = 'https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ROWS = 32;
const MAX_ID_LENGTH = 200;
const MAX_NAME_LENGTH = 200;
const MAX_CONTEXT_WINDOW = 10000000;
const MAX_OUTPUT_TOKENS = 1000000;

function boundedPositiveInteger(value, maximum) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function safeDisplayName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/u.test(name)) return null;
  return name;
}

function parseRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  if (!boundedPositiveInteger(row.context, MAX_CONTEXT_WINDOW)) return null;
  if (!boundedPositiveInteger(row['max-output'], MAX_OUTPUT_TOKENS)) return null;
  const displayName = safeDisplayName(row['model-name']);
  if (!displayName || typeof row.model !== 'string' || row.model.trim().length > MAX_ID_LENGTH) return null;
  let id;
  try {
    const rawId = normalizeModelId(row.model);
    id = rawId.includes('/') ? rawId : `nvidia/${rawId}`;
  } catch {
    return null;
  }
  const metadataSources = emptyMetadataSources();
  metadataSources.contextWindow = 'provider-catalog';
  metadataSources.maxOutputTokens = 'provider-catalog';
  metadataSources.inputModalities = 'provider-catalog';
  metadataSources.outputModalities = 'provider-catalog';
  return {
    id,
    displayName,
    contextWindow: row.context,
    maxOutputTokens: row['max-output'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    reasoning: null,
    reasoningLevels: null,
    toolCalling: null,
    metadataSources,
    source: 'nvidia-featured',
  };
}

async function discover(options = {}) {
  const staticCatalog = await loadOpenClawCatalog({
    provider: 'nvidia',
    cacheDir: options.cacheDir,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    now: options.now,
  });
  let liveModels = [];
  const warnings = [...staticCatalog.warnings];
  try {
    const payload = await fetchJson({
      url: ENDPOINT,
      provider: 'nvidia',
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      requireHttps: true,
      allowedHostname: 'assets.ngc.nvidia.com',
    });
    const rows = payload && typeof payload === 'object' ? payload['featured-models'] : null;
    if (Array.isArray(rows)) liveModels = rows.slice(0, MAX_ROWS).map(parseRow).filter(Boolean);
  } catch (error) {
    if (options.signal && options.signal.aborted) throw error;
    warnings.push('NVIDIA featured catalog refresh failed; using the OpenClaw static catalog.');
  }
  const seen = new Set(liveModels.map((model) => model.id));
  return {
    models: [...liveModels, ...staticCatalog.models.filter((model) => !seen.has(model.id))],
    warnings,
  };
}

module.exports = { CACHE_TTL_MS, ENDPOINT, discover, parseRow };
