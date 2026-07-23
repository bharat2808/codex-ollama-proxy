'use strict';

const shared = require('./allowlisted-provider-catalog');

const BASE_URL = 'https://api.z.ai/api/paas/v4';
const ENDPOINT = `${BASE_URL}/models`;

function discover(options = {}) {
  return shared.discoverCompatible(options, {
    provider: 'zai',
    staticProvider: 'zai',
    resolveBaseUrl: (value) => shared.exactBaseUrl(value, [BASE_URL], BASE_URL),
  });
}

function endpointFor(baseUrl) {
  return `${shared.exactBaseUrl(baseUrl, [BASE_URL], BASE_URL)}/models`;
}

module.exports = { BASE_URL, CACHE_TTL_MS: shared.CACHE_TTL_MS, ENDPOINT, discover, endpointFor };
