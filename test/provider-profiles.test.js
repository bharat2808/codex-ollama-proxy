'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  resolveProviderProfile,
} = require('../src/provider-profiles');

test('AI Studio supplies the Google adaptor and canonical URL', () => {
  assert.deepEqual(resolveProviderProfile({ provider: 'aistudio' }), {
    provider: 'aistudio',
    adaptor: 'google',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai',
  });
  assert.equal(resolveProviderProfile({ provider: 'gemini' }).provider, 'aistudio');
});

test('Vertex AI requires explicit project and location and builds its endpoint', () => {
  assert.deepEqual(resolveProviderProfile({
    provider: 'vertexai',
    project: 'sample-project',
    location: 'us-central1',
  }), {
    provider: 'vertexai',
    adaptor: 'google',
    url: 'https://aiplatform.googleapis.com/v1/projects/sample-project/locations/us-central1/endpoints/openapi',
  });
  assert.throws(
    () => resolveProviderProfile({ provider: 'vertexai', location: 'global' }),
    /--project is required/u,
  );
  assert.throws(
    () => resolveProviderProfile({ provider: 'vertexai', project: 'sample-project' }),
    /--location is required/u,
  );
  assert.throws(
    () => resolveProviderProfile({
      provider: 'vertexai',
      url: 'https://aiplatform.googleapis.com/v1/projects/other/locations/global/endpoints/openapi',
    }),
    /--project is required/u,
  );
});

test('known OpenAI-compatible providers supply their default adaptor and URL', () => {
  assert.deepEqual(resolveProviderProfile({ provider: 'nvidia' }), {
    provider: 'nvidia',
    adaptor: 'chat-completion',
    url: 'https://integrate.api.nvidia.com/v1',
  });
  assert.deepEqual(resolveProviderProfile({ provider: 'openrouter' }), {
    provider: 'openrouter',
    adaptor: 'none',
    url: 'https://openrouter.ai/api/v1',
  });
  assert.deepEqual(resolveProviderProfile({ provider: 'xai' }), {
    provider: 'xai',
    adaptor: 'none',
    url: 'https://api.x.ai/v1',
  });
});

test('provider profiles reject unknown providers and incompatible adaptors', () => {
  assert.throws(
    () => resolveProviderProfile({ provider: 'unknown-cloud' }),
    /unknown provider/i,
  );
  assert.throws(
    () => resolveProviderProfile({ provider: 'aistudio', adaptor: 'chat-completion' }),
    /does not support adaptor/i,
  );
  assert.throws(
    () => resolveProviderProfile({ provider: 'nvidia', adaptor: 'google' }),
    /does not support adaptor/i,
  );
});

test('custom presets still require an explicit URL', () => {
  assert.deepEqual(resolveProviderProfile({
    adaptor: 'chat-completion',
    url: 'https://provider.example/v1',
  }), {
    provider: null,
    adaptor: 'chat-completion',
    url: 'https://provider.example/v1',
  });
  assert.throws(
    () => resolveProviderProfile({ adaptor: 'chat-completion' }),
    /requires --url/u,
  );
});
