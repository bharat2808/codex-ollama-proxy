'use strict';

const { fetchJson } = require('../live-catalog');
const { adapterResult } = require('../adapter-result');
const {
  CACHE_TTL_MS,
  parseLiveRow,
} = require('./allowlisted-provider-catalog');

function resolveBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('Custom provider base URL must use HTTP or HTTPS.');
  }
  if (url.search || url.hash) {
    throw new TypeError('Custom provider base URL must not contain a query or fragment.');
  }
  const pathname = url.pathname.replace(/\/+$/u, '') || '/';
  return url.origin + (pathname === '/' ? '' : pathname);
}

function familyId(value) {
  const normalized = value.trim().toLowerCase();
  const tagIndex = normalized.lastIndexOf(':');
  return tagIndex > normalized.lastIndexOf('/') ? normalized.slice(0, tagIndex) : normalized;
}

function isModelFamilyMatch(candidateId, suppliedIds) {
  const candidate = familyId(candidateId);
  return suppliedIds.some((suppliedId) => {
    const supplied = familyId(suppliedId);
    return candidate === supplied
      || candidate.endsWith(`/${supplied}`)
      || supplied.endsWith(`/${candidate}`);
  });
}

function modelRows(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.data)) return payload.data;
  return Array.isArray(payload.models) ? payload.models : null;
}

async function discover(options = {}) {
  const suppliedIds = Array.isArray(options.suppliedModels) ? options.suppliedModels : [];
  if (suppliedIds.length === 0) {
    return adapterResult({
      models: [], warnings: [], origin: 'supplied', complete: false,
    });
  }
  const baseUrl = resolveBaseUrl(options.baseUrl);
  try {
    const payload = await fetchJson({
      url: `${baseUrl}/models`,
      provider: 'custom',
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      allowedHostname: new URL(baseUrl).hostname,
    });
    const rows = modelRows(payload);
    if (!rows) throw new TypeError('Custom provider model catalog response is missing its model list.');
    const unique = new Map();
    for (const row of rows) {
      const rawId = row && typeof row === 'object' ? row.id || row.name : null;
      if (typeof rawId !== 'string' || !isModelFamilyMatch(rawId, suppliedIds)) continue;
      const model = parseLiveRow(row, 'custom-catalog');
      if (model && !unique.has(model.id)) unique.set(model.id, model);
    }
    return adapterResult({
      models: [...unique.values()], warnings: [], origin: 'live', complete: false,
    });
  } catch (error) {
    if (options.signal && options.signal.aborted) throw error;
    const warnings = ['Custom model catalog refresh failed; using supplied model IDs.'];
    return adapterResult({
      models: [],
      warnings,
      origin: 'supplied',
      complete: false,
      fallback: { state: 'supplied', warnings },
    });
  }
}

function endpointFor(baseUrl) {
  return `${resolveBaseUrl(baseUrl)}/models`;
}

module.exports = {
  CACHE_TTL_MS,
  discover,
  endpointFor,
  familyId,
  isModelFamilyMatch,
  resolveBaseUrl,
};
