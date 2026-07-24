'use strict';

const { fetchJson } = require('./live-catalog');
const ollama = require('./providers/ollama');
const {
  PROVIDERS,
  providerForAlias,
  providerForCanonicalUrl,
} = require('./provider-registry');
const KNOWN_PROVIDERS = new Set(Object.keys(PROVIDERS));
function parsedBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

function isVertexGoogleUrl(url) {
  return url.hostname.endsWith('aiplatform.googleapis.com')
    && /^\/v1\/projects\/[^/]+\/locations\/[^/]+\/endpoints\/openapi\/?$/u.test(url.pathname);
}

async function detectLocalOllama(url, options) {
  if (!ollama.isLocalBaseUrl(url.href)) return null;
  const endpoint = `${ollama.resolveApiBase(url.href)}/api/tags`;
  try {
    const payload = await fetchJson({
      url: endpoint,
      provider: 'ollama',
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    return payload && typeof payload === 'object' && Array.isArray(payload.models) ? payload : null;
  } catch (error) {
    if (options.signal && options.signal.aborted) throw error;
    return null;
  }
}

async function resolveProvider(options = {}) {
  const requested = typeof options.provider === 'string' ? options.provider.trim().toLowerCase() : '';
  const explicit = providerForAlias(requested) || requested;
  if (explicit) {
    if (!KNOWN_PROVIDERS.has(explicit)) throw new TypeError(`Unknown provider: ${options.provider}`);
    return { provider: explicit, providerResolution: 'explicit', detectionPayload: null };
  }

  const url = parsedBaseUrl(options.baseUrl);
  if (url) {
    const canonical = providerForCanonicalUrl(url);
    if (canonical) {
      return { provider: canonical, providerResolution: 'canonical-url', detectionPayload: null };
    }
    if (isVertexGoogleUrl(url)) {
      return { provider: 'google', providerResolution: 'canonical-url', detectionPayload: null };
    }
  }

  if (url && typeof options.fetchImpl === 'function') {
    const payload = await detectLocalOllama(url, options);
    if (payload) {
      return { provider: 'ollama', providerResolution: 'ollama-native', detectionPayload: payload };
    }
  }

  if (url && !url.search && !url.hash) {
    return { provider: 'custom', providerResolution: 'custom-url', detectionPayload: null };
  }

  return { provider: null, providerResolution: 'unknown', detectionPayload: null };
}

module.exports = {
  isVertexGoogleUrl,
  resolveProvider,
};
