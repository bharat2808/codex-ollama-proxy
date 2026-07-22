'use strict';

const { fetchJson } = require('./live-catalog');

const KNOWN_PROVIDERS = new Set(['nvidia', 'openrouter', 'cohere', 'ollama']);
const CANONICAL_URLS = new Map([
  ['https://integrate.api.nvidia.com/v1', 'nvidia'],
  ['https://openrouter.ai/api/v1', 'openrouter'],
  ['https://openrouter.ai/v1', 'openrouter'],
  ['https://api.cohere.ai/compatibility/v1', 'cohere'],
]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

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

function normalizedEndpoint(url) {
  const pathname = url.pathname.replace(/\/+$/u, '') || '/';
  return url.origin + (pathname === '/' ? '' : pathname);
}

async function detectLocalOllama(url, options) {
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) return null;
  const pathname = url.pathname.replace(/\/+$/u, '') || '/';
  if (pathname !== '/' && pathname !== '/v1') return null;
  const root = new URL(url.origin + '/');
  const endpoint = new URL('api/tags', root).href;
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
  const explicit = typeof options.provider === 'string' ? options.provider.trim().toLowerCase() : '';
  if (explicit) {
    if (!KNOWN_PROVIDERS.has(explicit)) throw new TypeError(`Unknown provider: ${options.provider}`);
    return { provider: explicit, providerResolution: 'explicit', detectionPayload: null };
  }

  const url = parsedBaseUrl(options.baseUrl);
  if (url && !url.search && !url.hash) {
    const canonical = CANONICAL_URLS.get(normalizedEndpoint(url));
    if (canonical) {
      return { provider: canonical, providerResolution: 'canonical-url', detectionPayload: null };
    }
  }

  if (url && typeof options.fetchImpl === 'function') {
    const payload = await detectLocalOllama(url, options);
    if (payload) {
      return { provider: 'ollama', providerResolution: 'ollama-native', detectionPayload: payload };
    }
  }

  return { provider: null, providerResolution: 'unknown', detectionPayload: null };
}

module.exports = {
  CANONICAL_URLS,
  KNOWN_PROVIDERS,
  resolveProvider,
};
