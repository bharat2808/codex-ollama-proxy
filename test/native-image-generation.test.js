'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  generateNativeImageResponse,
  nativeImageProvider,
  responsesPrompt,
} = require('../src/native-image-generation');

test('detects only canonical xAI upstreams as requiring an images endpoint bridge', () => {
  assert.equal(nativeImageProvider(new URL('https://api.x.ai/v1')), 'xai');
  assert.equal(nativeImageProvider(new URL('https://api.x.ai/v1/')), 'xai');
  assert.equal(nativeImageProvider(new URL('https://openrouter.ai/api/v1')), null);
  assert.equal(nativeImageProvider(new URL('http://127.0.0.1:11435/v1')), null);
});

test('extracts the active user prompt from Responses input', () => {
  assert.equal(responsesPrompt({ input: 'draw a fox' }), 'draw a fox');
  assert.equal(responsesPrompt({
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'old prompt' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'old answer' }] },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'draw' },
          { type: 'input_text', text: 'a blue fox' },
        ],
      },
    ],
  }), 'draw\na blue fox');
});

test('bridges xAI image generation into a Responses image_generation_call', async () => {
  let request = null;
  const response = await generateNativeImageResponse({
    upstream: {
      baseUrl: new URL('https://api.x.ai/v1'),
      apiKey: 'test-secret',
    },
    body: {
      model: 'grok-imagine-image',
      input: 'draw a blue fox',
      modalities: ['image'],
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        data: [{
          url: 'https://images.example/fox.jpeg',
          mime_type: 'image/jpeg',
          revised_prompt: 'A blue fox',
        }],
        usage: { cost_in_usd_ticks: 200000000 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(request.url, 'https://api.x.ai/v1/images/generations');
  assert.equal(request.options.headers.authorization, 'Bearer test-secret');
  assert.deepEqual(JSON.parse(request.options.body), {
    model: 'grok-imagine-image',
    prompt: 'draw a blue fox',
    n: 1,
    response_format: 'url',
  });
  assert.equal(response.status, 'completed');
  assert.deepEqual(response.output, [{
    id: response.output[0].id,
    type: 'image_generation_call',
    status: 'completed',
    result: 'https://images.example/fox.jpeg',
    revised_prompt: 'A blue fox',
  }]);
  assert.deepEqual(response.usage, { cost_in_usd_ticks: 200000000 });
});

test('reports native image endpoint failures without exposing credentials', async () => {
  await assert.rejects(generateNativeImageResponse({
    upstream: {
      baseUrl: new URL('https://api.x.ai/v1'),
      apiKey: 'must-not-leak',
    },
    body: {
      model: 'grok-imagine-image',
      input: 'draw a fox',
      modalities: ['image'],
    },
    fetchImpl: async () => new Response(JSON.stringify({
      error: { message: 'model unavailable' },
    }), { status: 404 }),
  }), (error) => {
    assert.equal(error.statusCode, 404);
    assert.match(error.message, /model unavailable/u);
    assert.doesNotMatch(error.message, /must-not-leak/u);
    return true;
  });
});
