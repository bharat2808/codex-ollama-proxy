'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createDiscoveryResult,
} = require('../src/model-discovery/discovery-result');

test('discovery result constructor supplies one stable public shape', () => {
  const models = [{ id: 'model-a' }];
  const result = createDiscoveryResult({
    provider: 'ollama',
    providerResolution: 'ollama-native',
    traits: { inventoryComplete: true },
    source: 'ollama',
    dataOrigin: 'live',
    models,
  });

  assert.deepEqual(result, {
    provider: 'ollama',
    providerResolution: 'ollama-native',
    traits: { inventoryComplete: true },
    source: 'ollama',
    cache: { state: 'none' },
    dataOrigin: 'live',
    discoverySkipped: false,
    models,
    warnings: [],
  });
});

test('discovery result constructor rejects malformed collections', () => {
  assert.throws(
    () => createDiscoveryResult({ models: {}, warnings: [] }),
    /models must be an array/i,
  );
  assert.throws(
    () => createDiscoveryResult({ models: [], warnings: 'warning' }),
    /warnings must be an array/i,
  );
});
