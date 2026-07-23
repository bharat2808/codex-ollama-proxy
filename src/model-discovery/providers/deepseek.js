'use strict';

const shared = require('./openai-compatible-catalog');

const BASE_URL = 'https://api.deepseek.com';
const V1_BASE_URL = 'https://api.deepseek.com/v1';

function resolveBaseUrl(value) {
  return shared.exactBaseUrl(value, [BASE_URL, V1_BASE_URL], BASE_URL);
}

function discover(options = {}) {
  return shared.discoverCompatible(options, {
    provider: 'deepseek',
    staticProvider: 'deepseek',
    resolveBaseUrl,
  });
}

function endpointFor(baseUrl) {
  return `${resolveBaseUrl(baseUrl)}/models`;
}

module.exports = {
  BASE_URL,
  CACHE_TTL_MS: shared.CACHE_TTL_MS,
  ENDPOINT: `${BASE_URL}/models`,
  V1_BASE_URL,
  discover,
  endpointFor,
  resolveBaseUrl,
};
