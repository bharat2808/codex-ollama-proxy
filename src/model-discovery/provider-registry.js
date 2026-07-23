'use strict';

const cohere = require('./providers/cohere');
const custom = require('./providers/custom');
const deepseek = require('./providers/deepseek');
const google = require('./providers/google');
const moonshot = require('./providers/moonshot');
const nvidia = require('./providers/nvidia');
const ollama = require('./providers/ollama');
const openrouter = require('./providers/openrouter');
const xai = require('./providers/xai');
const zai = require('./providers/zai');

const PROVIDERS = Object.freeze({
  nvidia: definition(nvidia, {
    canonicalUrls: ['https://integrate.api.nvidia.com/v1'],
    cacheEndpoint: () => nvidia.ENDPOINT,
  }),
  openrouter: definition(openrouter, {
    canonicalUrls: ['https://openrouter.ai/api/v1', 'https://openrouter.ai/v1'],
    cacheEndpoint: () => openrouter.ENDPOINT,
  }),
  cohere: definition(cohere, {
    canonicalUrls: ['https://api.cohere.ai/compatibility/v1'],
    cacheEndpoint: ({ baseUrl }) => normalizeUrl(baseUrl || cohere.BASE_URL) === cohere.BASE_URL
      ? cohere.ENDPOINT
      : null,
  }),
  ollama: definition(ollama, {
    traits: { inventoryComplete: true, nativeInspection: true },
    cacheEndpoint: ({ baseUrl }) => `${ollama.resolveApiBase(baseUrl)}/api/tags`,
  }),
  zai: definition(zai, {
    aliases: ['z-ai', 'z.ai'],
    canonicalUrls: ['https://api.z.ai/api/paas/v4'],
  }),
  moonshot: definition(moonshot, {
    canonicalUrls: ['https://api.moonshot.ai/v1', 'https://api.moonshot.cn/v1'],
  }),
  deepseek: definition(deepseek, {
    canonicalUrls: ['https://api.deepseek.com', 'https://api.deepseek.com/v1'],
  }),
  google: definition(google, {
    canonicalUrls: ['https://generativelanguage.googleapis.com/v1beta/openai'],
  }),
  xai: definition(xai, {
    aliases: ['grok'],
    canonicalUrls: ['https://api.x.ai/v1'],
  }),
  custom: definition(custom),
});

function definition(adapter, options = {}) {
  return Object.freeze({
    adapter,
    aliases: Object.freeze([...(options.aliases || [])]),
    canonicalUrls: Object.freeze([...(options.canonicalUrls || [])]),
    cacheEndpoint: options.cacheEndpoint
      || (({ baseUrl }) => typeof adapter.endpointFor === 'function'
        ? adapter.endpointFor(baseUrl)
        : null),
    traits: Object.freeze({
      inventoryComplete: false,
      nativeInspection: false,
      ...(options.traits || {}),
    }),
  });
}

function normalizedEndpoint(url) {
  const pathname = url.pathname.replace(/\/+$/u, '') || '/';
  return url.origin + (pathname === '/' ? '' : pathname);
}

function normalizeUrl(value) {
  try {
    return normalizedEndpoint(new URL(value));
  } catch {
    return '';
  }
}

const ALIASES = new Map();
const CANONICAL_URLS = new Map();
for (const [provider, definitionValue] of Object.entries(PROVIDERS)) {
  for (const alias of definitionValue.aliases) ALIASES.set(alias, provider);
  for (const url of definitionValue.canonicalUrls) CANONICAL_URLS.set(url, provider);
}

function providerForAlias(value) {
  return ALIASES.get(value) || null;
}

function providerForCanonicalUrl(url) {
  if (!(url instanceof URL) || url.search || url.hash) return null;
  return CANONICAL_URLS.get(normalizedEndpoint(url)) || null;
}

function cacheEndpointFor(provider, options = {}) {
  const providerDefinition = PROVIDERS[provider];
  return providerDefinition ? providerDefinition.cacheEndpoint(options) : null;
}

module.exports = {
  ALIASES,
  CANONICAL_URLS,
  PROVIDERS,
  cacheEndpointFor,
  providerForAlias,
  providerForCanonicalUrl,
};
