'use strict';

const { fetchJson } = require('./live-catalog');
const ollama = require('./providers/ollama');

const KNOWN_PROVIDERS = new Set([
  'nvidia', 'openrouter', 'cohere', 'ollama',
  'zai', 'moonshot', 'deepseek', 'google', 'xai', 'custom',
]);
const PROVIDER_ALIASES = new Map([
  ['z-ai', 'zai'],
  ['z.ai', 'zai'],
  ['grok', 'xai'],
]);
const CANONICAL_URLS = new Map([
  ['https://integrate.api.nvidia.com/v1', 'nvidia'],
  ['https://openrouter.ai/api/v1', 'openrouter'],
  ['https://openrouter.ai/v1', 'openrouter'],
  ['https://api.cohere.ai/compatibility/v1', 'cohere'],
  ['https://api.z.ai/api/paas/v4', 'zai'],
  ['https://api.moonshot.ai/v1', 'moonshot'],
  ['https://api.moonshot.cn/v1', 'moonshot'],
  ['https://api.deepseek.com', 'deepseek'],
  ['https://api.deepseek.com/v1', 'deepseek'],
  ['https://generativelanguage.googleapis.com/v1beta/openai', 'google'],
  ['https://api.x.ai/v1', 'xai'],
]);
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
  const explicit = PROVIDER_ALIASES.get(requested) || requested;
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

  if (url && !url.search && !url.hash) {
    return { provider: 'custom', providerResolution: 'custom-url', detectionPayload: null };
  }

  return { provider: null, providerResolution: 'unknown', detectionPayload: null };
}

module.exports = {
  CANONICAL_URLS,
  KNOWN_PROVIDERS,
  PROVIDER_ALIASES,
  resolveProvider,
};
