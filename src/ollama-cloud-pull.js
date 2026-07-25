'use strict';

const { fetchJson } = require('./model-discovery/live-catalog');
const { loadBundledProviderCatalog } = require('./model-discovery/provider-catalog');
const { normalizeModelId } = require('./model-discovery/normalize');
const { resolveLocalApiBase } = require('./model-discovery/providers/ollama');

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_PULL_TIMEOUT_MS = 60000;

class OllamaCloudPullError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'OllamaCloudPullError';
    this.code = code;
  }
}

function registeredModelIds(payload) {
  const models = payload && Array.isArray(payload.models) ? payload.models : [];
  return new Set(models.map((row) => row && (row.name || row.model)).filter(Boolean));
}

function createOllamaCloudPuller(options = {}) {
  const apiBase = resolveLocalApiBase(options.baseUrl || 'http://127.0.0.1:11434/v1');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
  const pullTimeoutMs = options.pullTimeoutMs || DEFAULT_PULL_TIMEOUT_MS;
  const loadCatalog = options.loadCatalog || (() => loadBundledProviderCatalog('ollama-cloud'));
  const ready = new Set();
  const inFlight = new Map();
  let cloudIdsPromise = null;

  async function cloudIds() {
    if (!cloudIdsPromise) {
      cloudIdsPromise = Promise.resolve(loadCatalog()).then((result) => new Set(
        (result && Array.isArray(result.models) ? result.models : [])
          .map((model) => model && model.id)
          .filter(Boolean),
      )).catch((error) => {
        cloudIdsPromise = null;
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
