'use strict';

const shared = require('./allowlisted-provider-catalog');

const BASE_URL = 'https://api.moonshot.ai/v1';
const CN_BASE_URL = 'https://api.moonshot.cn/v1';

function resolveBaseUrl(value) {
  return shared.exactBaseUrl(value, [BASE_URL, CN_BASE_URL], BASE_URL);
}

function discover(options = {}) {
  return shared.discoverCompatible(options, {
    provider: 'moonshot',
    staticProvider: 'moonshot',
    resolveBaseUrl,
  });
}

function endpointFor(baseUrl) {
  return `${resolveBaseUrl(baseUrl)}/models`;
}

module.exports = {
  BASE_URL,
  CACHE_TTL_MS: shared.CACHE_TTL_MS,
  CN_BASE_URL,
  ENDPOINT: `${BASE_URL}/models`,
  discover,
  endpointFor,
  resolveBaseUrl,
};
