'use strict';

const shared = require('./allowlisted-provider-catalog');

const BASE_URL = 'https://api.moonshot.ai/v1';
const CN_BASE_URL = 'https://api.moonshot.cn/v1';

module.exports = {
  ...shared.defineCompatibleProvider({
    provider: 'moonshot',
    baseUrls: [BASE_URL, CN_BASE_URL],
    defaultBaseUrl: BASE_URL,
    staticProvider: 'moonshot',
  }),
  CN_BASE_URL,
};
