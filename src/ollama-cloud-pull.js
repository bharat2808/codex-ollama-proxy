'use strict';

const { fetchJson } = require('./model-discovery/live-catalog');
const {
  CATALOG_TTL_MS,
  loadOpenClawCatalog,
} = require('./model-discovery/openclaw-catalog');
const { normalizeModelId } = require('./model-discovery/normalize');

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_PULL_TIMEOUT_MS = 60000;

class OllamaCloudPullError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'OllamaCloudPullError';
    this.code = code;
  }
}

function localApiBase(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('Local Ollama base URL is invalid.'); }
  const pathname = url.pathname.replace(/\/+$/u, '') || '/';
  if (url.protocol !== 'http:' || !LOCAL_HOSTS.has(url.hostname) || (pathname !== '/' && pathname !== '/v1')) {
    throw new TypeError('Cloud auto-pull requires the standard local Ollama HTTP endpoint.');
  }
  return url.origin;
}

function registeredModelIds(payload) {
  const models = payload && Array.isArray(payload.models) ? payload.models : [];
  return new Set(models.map((row) => row && (row.name || row.model)).filter(Boolean));
}

function createOllamaCloudPuller(options = {}) {
  const apiBase = localApiBase(options.baseUrl || 'http://127.0.0.1:11434/v1');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
  const pullTimeoutMs = options.pullTimeoutMs || DEFAULT_PULL_TIMEOUT_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const loadCatalog = options.loadCatalog || (() => loadOpenClawCatalog({
    provider: 'ollama-cloud',
    cacheDir: options.cacheDir,
    fetchImpl,
    timeoutMs: requestTimeoutMs,
  }));
  const ready = new Set();
  const inFlight = new Map();
  let cloudIdsPromise = null;
  let catalogLoadedAt = null;

  async function cloudIds() {
    if (!cloudIdsPromise || (catalogLoadedAt !== null && now() - catalogLoadedAt > CATALOG_TTL_MS)) {
      cloudIdsPromise = Promise.resolve(loadCatalog()).then((result) => new Set(
        (result && Array.isArray(result.models) ? result.models : [])
          .map((model) => model && model.id)
          .filter(Boolean),
      )).then((ids) => {
        catalogLoadedAt = now();
        return ids;
      }).catch((error) => {
        cloudIdsPromise = null;
        catalogLoadedAt = null;
        throw error;
      });
    }
    return cloudIdsPromise;
  }

  async function ensureAllowlistedModel(model) {
    let tags;
    try {
      tags = await fetchJson({
        url: `${apiBase}/api/tags`,
        provider: 'ollama',
        fetchImpl,
        timeoutMs: requestTimeoutMs,
      });
    } catch (error) {
      throw new OllamaCloudPullError(
        'OLLAMA_UNAVAILABLE',
        `Local Ollama could not be reached while preparing cloud model ${model}.`,
        error,
      );
    }
    if (registeredModelIds(tags).has(model)) {
      ready.add(model);
      return { status: 'ready' };
    }

    try {
      const pull = await fetchJson({
        url: `${apiBase}/api/pull`,
        provider: 'ollama',
        fetchImpl,
        timeoutMs: pullTimeoutMs,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: false }),
      });
      if (!pull || pull.status !== 'success') throw new Error('unexpected pull response');
      const shown = await fetchJson({
        url: `${apiBase}/api/show`,
        provider: 'ollama',
        fetchImpl,
        timeoutMs: requestTimeoutMs,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      if (!shown || (!shown.details && !shown.model_info && !Array.isArray(shown.capabilities))) {
        throw new Error('cloud model confirmation failed');
      }
    } catch (error) {
      throw new OllamaCloudPullError(
        'PULL_FAILED',
        `Local Ollama could not register cloud model ${model}. Confirm that Ollama is signed in and the model is available.`,
        error,
      );
    }
    ready.add(model);
    return { status: 'pulled' };
  }

  async function ensureModel(value) {
    const model = normalizeModelId(value);
    if (!model.endsWith(':cloud')) return { status: 'not-cloud' };
    const allowlist = await cloudIds();
    if (!allowlist.has(model)) return { status: 'not-cloud' };
    if (ready.has(model)) return { status: 'ready' };
    if (inFlight.has(model)) return inFlight.get(model);
    const operation = ensureAllowlistedModel(model).finally(() => inFlight.delete(model));
    inFlight.set(model, operation);
    return operation;
  }

  return { ensureModel };
}

module.exports = {
  DEFAULT_PULL_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  OllamaCloudPullError,
  createOllamaCloudPuller,
};
