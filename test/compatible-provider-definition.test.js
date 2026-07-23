'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  defineCompatibleProvider,
} = require('../src/model-discovery/providers/allowlisted-provider-catalog');

test('compatible provider definition supplies canonical endpoint and discovery wiring', async () => {
  const provider = defineCompatibleProvider({
    provider: 'example',
    baseUrls: ['https://api.example/v1', 'https://api.example/v2'],
    defaultBaseUrl: 'https://api.example/v1',
    staticProvider: null,
  });

  assert.equal(provider.BASE_URL, 'https://api.example/v1');
  assert.equal(provider.ENDPOINT, 'https://api.example/v1/models');
  assert.equal(provider.endpointFor('https://api.example/v2/'), 'https://api.example/v2/models');
  assert.throws(
    () => provider.endpointFor('https://gateway.example/v1'),
    /not canonical/i,
  );

  const result = await provider.discover({
    baseUrl: 'https://api.example/v1',
    apiKey: 'secret',
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{ id: 'example-model' }],
    })),
  });
  assert.equal(result.models[0].id, 'example-model');
  assert.equal(result.origin, 'live');
  assert.equal(result.complete, true);
});
