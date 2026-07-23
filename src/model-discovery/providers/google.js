'use strict';

const shared = require('./openai-compatible-catalog');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const ENDPOINT = `${BASE_URL}/models`;

function discover(options = {}) {
  return shared.discoverCompatible(options, {
    provider: 'google',
    resolveBaseUrl: (value) => shared.exactBaseUrl(value, [BASE_URL], BASE_URL),
  });
}

function endpointFor(baseUrl) {
  return `${shared.exactBaseUrl(baseUrl, [BASE_URL], BASE_URL)}/models`;
}

module.exports = { BASE_URL, CACHE_TTL_MS: shared.CACHE_TTL_MS, ENDPOINT, discover, endpointFor };
