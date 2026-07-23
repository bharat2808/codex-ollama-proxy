'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  cacheEndpointFor,
  PROVIDERS,
  providerForAlias,
  providerForCanonicalUrl,
} = require('../src/model-discovery/provider-registry');

test('provider registry is the single adapter and identity inventory', () => {
  assert.deepEqual(Object.keys(PROVIDERS).sort(), [
    'cohere',
    'custom',
    'deepseek',
    'google',
    'moonshot',
    'nvidia',
    'ollama',
    'openrouter',
    'xai',
    'zai',
  ]);
  for (const definition of Object.values(PROVIDERS)) {
    assert.equal(typeof definition.adapter.discover, 'function');
    assert.ok(Array.isArray(definition.aliases));
    assert.ok(Array.isArray(definition.canonicalUrls));
    assert.equal(typeof definition.traits.nativeInspection, 'boolean');
  }
});

test('provider registry resolves aliases and normalized canonical URLs', () => {
  assert.equal(providerForAlias('z-ai'), 'zai');
  assert.equal(providerForAlias('z.ai'), 'zai');
  assert.equal(providerForAlias('grok'), 'xai');
  assert.equal(providerForAlias('unknown'), null);
  assert.equal(
    providerForCanonicalUrl(new URL('https://openrouter.ai/v1/')),
    'openrouter',
  );
  assert.equal(
    providerForCanonicalUrl(new URL('https://api.deepseek.com/v1/')),
    'deepseek',
  );
  assert.equal(
    providerForCanonicalUrl(new URL('https://provider.example/v1')),
    null,
  );
});

test('provider registry owns provider-specific cache endpoints', () => {
  assert.equal(cacheEndpointFor('nvidia'), PROVIDERS.nvidia.adapter.ENDPOINT);
  assert.equal(cacheEndpointFor('ollama', { baseUrl: 'http://localhost:11434/v1' }), 'http://localhost:11434/api/tags');
  assert.equal(cacheEndpointFor('cohere', { baseUrl: 'https://proxy.example/v1' }), null);
});
