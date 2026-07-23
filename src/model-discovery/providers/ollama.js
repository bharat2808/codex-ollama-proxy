'use strict';

const { fetchJson } = require('../live-catalog');
const { loadOpenClawCatalog } = require('../openclaw-catalog');
const { emptyMetadataSources, normalizeModelId } = require('../normalize');

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const CACHE_TTL_MS = 60000;
const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 16;
const MAX_CONTEXT_WINDOW = 10000000;

function resolveApiBase(value) {
  const url = new URL(value || DEFAULT_BASE_URL);
  let pathname = url.pathname.replace(/\/+$/u, '');
  if (pathname.toLowerCase().endsWith('/v1')) pathname = pathname.slice(0, -3);
  url.pathname = (pathname || '') + '/';
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/+$/u, '');
}

function positiveContext(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const integer = Math.floor(value);
  return integer > 0 && integer <= MAX_CONTEXT_WINDOW ? integer : null;
}

function parseNumCtx(parameters) {
  if (typeof parameters !== 'string') return null;
  let last = null;
  for (const line of parameters.split(/\r?\n/u)) {
    const match = line.trim().match(/^num_ctx\s+(-?\d+)\b/u);
    if (!match) continue;
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_CONTEXT_WINDOW) last = parsed;
  }
  return last;
}

function parseShow(payload, fallbackCapabilities) {
  let nativeContext = null;
  if (payload && payload.model_info && typeof payload.model_info === 'object') {
    for (const [key, value] of Object.entries(payload.model_info)) {
      if (!key.endsWith('.context_length')) continue;
      nativeContext = positiveContext(value);
      if (nativeContext !== null) break;
    }
  }
  const configuredContext = parseNumCtx(payload && payload.parameters);
  const contextWindow = nativeContext === null
    ? configuredContext
    : configuredContext === null ? nativeContext : Math.max(nativeContext, configuredContext);
  const rawCapabilities = payload && Array.isArray(payload.capabilities)
    ? payload.capabilities
    : fallbackCapabilities;
  const capabilities = Array.isArray(rawCapabilities)
    ? rawCapabilities.filter((value) => typeof value === 'string').map((value) => value.toLowerCase())
    : null;
  return { contextWindow, capabilities };
}

function modelFromInspection(id, inspection, capabilitySource) {
  const metadataSources = emptyMetadataSources();
  if (inspection.contextWindow !== null) metadataSources.contextWindow = 'provider-inspection';
  let inputModalities = null;
  let reasoning = null;
  let toolCalling = null;
  if (inspection.capabilities !== null) {
    inputModalities = inspection.capabilities.includes('vision') ? ['text', 'image'] : ['text'];
    reasoning = inspection.capabilities.includes('thinking');
    toolCalling = inspection.capabilities.includes('tools');
    metadataSources.inputModalities = capabilitySource;
    metadataSources.reasoning = capabilitySource;
    metadataSources.toolCalling = capabilitySource;
  }
  return {
    id,
    displayName: id,
    contextWindow: inspection.contextWindow,
    maxOutputTokens: null,
    inputModalities,
    reasoning,
    toolCalling,
    metadataSources,
    source: inspection.contextWindow !== null || inspection.capabilities !== null
      ? 'ollama-show'
      : 'ollama-tags',
  };
}

async function mapLimit(values, limit, mapper) {
  const output = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output;
}

async function discover(options = {}) {
  const apiBase = resolveApiBase(options.baseUrl);
  const cloudCatalog = await loadOpenClawCatalog({
    provider: 'ollama-cloud',
    cacheDir: options.cacheDir,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    now: options.now,
  });
  const tagsPayload = options.detectionPayload || await fetchJson({
    url: `${apiBase}/api/tags`,
    provider: 'ollama',
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  const tagRows = tagsPayload && Array.isArray(tagsPayload.models) ? tagsPayload.models : [];
  const ids = [];
  const seen = new Set();
  const tagCapabilities = new Map();
  for (const row of tagRows) {
    const rawId = row && (row.name || row.model);
    let id;
    try { id = normalizeModelId(rawId); } catch { continue; }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
    if (Array.isArray(row.capabilities)) tagCapabilities.set(id, row.capabilities);
  }
  for (const rawId of options.suppliedModels || []) {
    const id = normalizeModelId(rawId);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  const warnings = [...cloudCatalog.warnings];
  const requestedConcurrency = Number.isInteger(options.concurrency) ? options.concurrency : DEFAULT_CONCURRENCY;
  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, requestedConcurrency));
  const models = await mapLimit(ids, concurrency, async (id) => {
    try {
      const payload = await fetchJson({
        url: `${apiBase}/api/show`,
        provider: 'ollama',
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs || 8000,
        signal: options.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: id }),
      });
      const hasShowCapabilities = Boolean(payload && Array.isArray(payload.capabilities));
      const inspection = parseShow(payload, tagCapabilities.get(id));
      return modelFromInspection(
        id,
        inspection,
        hasShowCapabilities ? 'provider-inspection' : 'provider-catalog',
      );
    } catch {
      warnings.push(`Ollama model inspection failed for ${id}.`);
      const capabilities = tagCapabilities.has(id)
        ? tagCapabilities.get(id).filter((value) => typeof value === 'string').map((value) => value.toLowerCase())
        : null;
      return modelFromInspection(id, { contextWindow: null, capabilities }, 'provider-catalog');
    }
  });
  const discoveredIds = new Set(models.map((model) => model.id));
  return {
    models: [...models, ...cloudCatalog.models.filter((model) => !discoveredIds.has(model.id))],
    warnings,
  };
}

module.exports = {
  CACHE_TTL_MS,
  DEFAULT_BASE_URL,
  discover,
  parseNumCtx,
  parseShow,
  resolveApiBase,
};
