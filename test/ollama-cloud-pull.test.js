'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  OllamaCloudPullError,
  createOllamaCloudPuller,
} = require('../src/ollama-cloud-pull');

function catalog(...ids) {
  return async () => ({ models: ids.map((id) => ({ id })), warnings: [] });
}

test('cloud puller ignores local models and unknown cloud-like names', async () => {
  let calls = 0;
  const puller = createOllamaCloudPuller({
    baseUrl: 'http://localhost:11434/v1',
    loadCatalog: catalog('known:cloud'),
    fetchImpl: async () => {
      calls += 1;
      throw new Error('must not fetch');
    },
  });

  assert.deepEqual(await puller.ensureModel('local-model'), { status: 'not-cloud' });
  assert.deepEqual(await puller.ensureModel('unknown:cloud'), { status: 'not-cloud' });
  assert.equal(calls, 0);
});

test('cloud puller accepts an already registered cloud model without pulling it', async () => {
  const calls = [];
  const puller = createOllamaCloudPuller({
    baseUrl: 'http://localhost:11434/v1',
    loadCatalog: catalog('known:cloud'),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), authorization: options.headers.Authorization });
      return new Response(JSON.stringify({ models: [{ name: 'known:cloud' }] }));
    },
  });

  assert.deepEqual(await puller.ensureModel('known:cloud'), { status: 'ready' });
  assert.deepEqual(calls, [{
    url: 'http://localhost:11434/api/tags',
    authorization: undefined,
  }]);
});

test('cloud puller recognizes allowlisted cloud models without the colon-cloud suffix', async () => {
  const calls = [];
  const puller = createOllamaCloudPuller({
    baseUrl: 'http://localhost:11434/v1',
    loadCatalog: catalog('gemma4:31b-cloud'),
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ models: [{ name: 'gemma4:31b-cloud' }] }));
    },
  });

  assert.deepEqual(await puller.ensureModel('gemma4:31b-cloud'), { status: 'ready' });
  assert.deepEqual(calls, ['http://localhost:11434/api/tags']);
});

test('cloud puller registers and confirms an allowlisted model through local Ollama', async () => {
  const calls = [];
  const puller = createOllamaCloudPuller({
    baseUrl: 'http://127.0.0.1:11434/v1',
    loadCatalog: catalog('known:cloud'),
    fetchImpl: async (url, options) => {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({
        url: String(url),
        authorization: options.headers.Authorization,
        body,
      });
      if (String(url).endsWith('/api/tags')) return new Response('{"models":[]}');
      if (String(url).endsWith('/api/pull')) return new Response('{"status":"success"}');
      return new Response('{"details":{"family":"cloud"},"capabilities":["completion","tools"]}');
    },
  });

  assert.deepEqual(await puller.ensureModel('known:cloud'), { status: 'pulled' });
  assert.deepEqual(calls.map((call) => call.url), [
    'http://127.0.0.1:11434/api/tags',
    'http://127.0.0.1:11434/api/pull',
    'http://127.0.0.1:11434/api/show',
  ]);
  assert.deepEqual(calls[1].body, { model: 'known:cloud', stream: false });
  assert.deepEqual(calls[2].body, { model: 'known:cloud' });
  assert.equal(calls.every((call) => call.authorization === undefined), true);
});

test('cloud puller deduplicates concurrent pulls for the same model', async () => {
  let pulls = 0;
  let releasePull;
  const gate = new Promise((resolve) => { releasePull = resolve; });
  const puller = createOllamaCloudPuller({
    baseUrl: 'http://localhost:11434/v1',
    loadCatalog: catalog('known:cloud'),
    fetchImpl: async (url) => {
      if (String(url).endsWith('/api/tags')) return new Response('{"models":[]}');
      if (String(url).endsWith('/api/pull')) {
        pulls += 1;
        await gate;
        return new Response('{"status":"success"}');
      }
      return new Response('{"details":{}}');
    },
  });

  const first = puller.ensureModel('known:cloud');
  const second = puller.ensureModel('known:cloud');
  await new Promise((resolve) => setImmediate(resolve));
  releasePull();
  assert.deepEqual(await Promise.all([first, second]), [
    { status: 'pulled' },
    { status: 'pulled' },
  ]);
  assert.equal(pulls, 1);
});

test('cloud puller returns a safe typed failure when local Ollama rejects the pull', async () => {
  const puller = createOllamaCloudPuller({
    baseUrl: 'http://localhost:11434/v1',
    loadCatalog: catalog('known:cloud'),
    fetchImpl: async (url) => {
      if (String(url).endsWith('/api/tags')) return new Response('{"models":[]}');
      return new Response('{"error":"private secret details"}', { status: 401 });
    },
  });

  await assert.rejects(puller.ensureModel('known:cloud'), (error) => {
    assert.ok(error instanceof OllamaCloudPullError);
    assert.equal(error.code, 'PULL_FAILED');
    assert.match(error.message, /could not register cloud model/i);
    assert.doesNotMatch(error.message, /private secret details/i);
    return true;
  });
});

test('cloud puller loads the immutable bundled allowlist once per process', async () => {
  let loads = 0;
  const puller = createOllamaCloudPuller({
    baseUrl: 'http://localhost:11434/v1',
    loadCatalog: async () => {
      loads += 1;
      return { models: [{ id: loads === 1 ? 'first:cloud' : 'second:cloud' }] };
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'second:cloud' }] }));
      }
      throw new Error('unexpected fetch');
    },
  });

  assert.deepEqual(await puller.ensureModel('second:cloud'), { status: 'not-cloud' });
  assert.deepEqual(await puller.ensureModel('second:cloud'), { status: 'not-cloud' });
  assert.equal(loads, 1);
});
