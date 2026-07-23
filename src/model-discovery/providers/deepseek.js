'use strict';

const shared = require('./allowlisted-provider-catalog');

const BASE_URL = 'https://api.deepseek.com';
const V1_BASE_URL = 'https://api.deepseek.com/v1';

module.exports = {
  ...shared.defineCompatibleProvider({
    provider: 'deepseek',
    baseUrls: [BASE_URL, V1_BASE_URL],
    defaultBaseUrl: BASE_URL,
    staticProvider: 'deepseek',
  }),
  V1_BASE_URL,
};
