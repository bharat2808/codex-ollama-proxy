'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  resolveModelInventory,
} = require('../src/model-catalog/resolve-model-inventory');

test('recognized provider discovery is the inventory even when the provider catalog is partial', async () => {
  let fetchCalls = 0;
  const result = await resolveModelInventory({
    discovery: {
      provider: 'nvidia',
      traits: { inventoryComplete: false },
      models: [{ id: 'local-model' }, { id: 'cloud-model:cloud' }],
    },
    suppliedModels: new Set(['configured-model']),
    fetchUpstreamModels: async () => {
      fetchCalls += 1;
      throw new Error('must not fetch');
    },
  });

  assert.equal(fetchCalls, 0);
  assert.deepEqual([...result.allKnownIds], [
    'local-model',
    'cloud-model:cloud',
    'configured-model',
  ]);
  assert.equal(result.inventorySource, 'normalized provider discovery');
  assert.equal(result.upstreamError, null);
});

test('custom provider discovery retains the upstream inventory fallback', async () => {
  let fetchCalls = 0;
  const result = await resolveModelInventory({
    discovery: {
      provider: 'custom',
      traits: { inventoryComplete: false },
      models: [{ id: 'configured-model' }],
    },
    suppliedModels: new Set(['configured-model']),
    fetchUpstreamModels: async () => {
      fetchCalls += 1;
      return {
        models: [
          { id: 'remote-model' },
          { id: 'vendor/embed-model' },
        ],
        error: 'partial warning',
      };
    },
  });

  assert.equal(fetchCalls, 1);
  assert.deepEqual([...result.allKnownIds], ['remote-model', 'configured-model']);
  assert.equal(result.inventorySource, 'GET /v1/models');
  assert.equal(result.upstreamError, 'partial warning');
});
