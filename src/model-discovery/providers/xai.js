'use strict';

const shared = require('./allowlisted-provider-catalog');
const { adapterResult } = require('../adapter-result');
const { loadXaiSuppressions } = require('../openclaw-suppressions');

const BASE_URL = 'https://api.x.ai/v1';
const ENDPOINT = `${BASE_URL}/models`;

async function discover(options = {}) {
  const suppressions = await loadXaiSuppressions(options);
  const result = await shared.discoverCompatible(options, {
    provider: 'xai',
    resolveBaseUrl: (value) => shared.exactBaseUrl(value, [BASE_URL], BASE_URL),
  });
  const suppressed = new Set(suppressions.models);
  return adapterResult({
    models: result.models.filter((model) => !suppressed.has(model.id)),
    warnings: [...suppressions.warnings, ...result.warnings],
    origin: result.origin,
    complete: result.complete,
    fallback: result.fallback,
  });
}

function endpointFor(baseUrl) {
  return `${shared.exactBaseUrl(baseUrl, [BASE_URL], BASE_URL)}/models`;
}

module.exports = { BASE_URL, CACHE_TTL_MS: shared.CACHE_TTL_MS, ENDPOINT, discover, endpointFor };
