'use strict';

const shared = require('./allowlisted-provider-catalog');

const BASE_URL = 'https://api.z.ai/api/paas/v4';

module.exports = shared.defineCompatibleProvider({
  provider: 'zai',
  baseUrls: [BASE_URL],
  defaultBaseUrl: BASE_URL,
  staticProvider: 'zai',
});
