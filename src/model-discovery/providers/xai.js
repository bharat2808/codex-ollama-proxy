'use strict';

const shared = require('./allowlisted-provider-catalog');
const { adapterResult } = require('../adapter-result');

const BASE_URL = 'https://api.x.ai/v1';
const ENDPOINT = `${BASE_URL}/models`;

async function discover(options = {}) {
  const result = await shared.discoverCompatible(options, {
    provider: 'xai',
    staticProvider: 'xai',
    resolveBaseUrl: (value) => shared.exactBaseUrl(value, [BASE_URL], BASE_URL),
  });
  return adapterResult({
    models: result.models.filter((model) => !/(?:^|[-_.])multi-agent(?:$|[-_.])/iu.test(model.id)),
    warnings: result.warnings,
    origin: result.origin,
    complete: result.complete,
    fallback: result.fallback,
  });
}

function endpointFor(baseUrl) {
  return `${shared.exactBaseUrl(baseUrl, [BASE_URL], BASE_URL)}/models`;
}

module.exports = { BASE_URL, CACHE_TTL_MS: shared.CACHE_TTL_MS, ENDPOINT, discover, endpointFor };
