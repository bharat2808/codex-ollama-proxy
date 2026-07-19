'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const modelDiscovery = require('../src/model-discovery');
const upstreamLib = require('../src/upstream');
const imagine = require('../src/imagine');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('Ollama metadata discovers one image model and its native transport', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      requests.push({ url: req.url, body });
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'coder:latest' }, { name: 'image:latest' }] }));
      } else if (req.url === '/api/show') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          capabilities: body.model === 'image:latest' ? ['image'] : ['completion', 'tools'],
        }));
      } else if (req.url === '/api/generate') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ image: Buffer.from('native-image').toString('base64'), done: true }));
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
  });
  const port = await listen(server);
  const upstream = upstreamLib.createUpstream('http://127.0.0.1:' + port + '/v1');

  try {
    const state = await modelDiscovery.discover(upstream);
    assert.equal(state.source, 'ollama');
    assert.equal(modelDiscovery.findModel('coder', state).textGeneration, true);
    const selected = modelDiscovery.chooseImageModel('coder:latest', '', state);
    assert.equal(selected.name, 'image:latest');
    assert.equal(selected.transport, 'ollama_native');

    const result = await imagine.generateCompatibleImage(upstream, 'draw a lake', {
      model: selected.name,
      transport: selected.transport,
      aspectRatio: '16:9',
    }, () => {});
    assert.equal(result.imageData.toString('utf8'), 'native-image');
    const generation = requests.find((request) => request.url === '/api/generate');
    assert.deepEqual(generation.body, {
      model: 'image:latest',
      prompt: 'draw a lake',
      width: 1344,
      height: 768,
      stream: false,
    });

    const fallback = await imagine.generateCompatibleImage(upstream, 'draw a tree', {
      model: selected.name,
      transport: 'openai_images',
      aspectRatio: '4:3',
    }, () => {});
    assert.equal(fallback.imageData.toString('utf8'), 'native-image');
    assert.equal(requests.some((request) => request.url === '/v1/images/generations'), true);
  } finally {
    await close(server);
  }
});

test('automatic image selection refuses to guess when multiple models qualify', () => {
  const state = {
    complete: true,
    models: [
      modelDiscovery.recordFor('image-a', { capabilities: ['image'] }, 'ollama'),
      modelDiscovery.recordFor('image-b', { capabilities: ['image'] }, 'ollama'),
    ],
  };
  assert.equal(modelDiscovery.chooseImageModel('text-model', '', state), null);
  assert.equal(modelDiscovery.chooseImageModel('text-model', 'image-b', state).name, 'image-b');
});

test('generic image input metadata is not confused with image generation', () => {
  const vision = modelDiscovery.recordFor('vision-model', {
    capabilities: ['completion', 'vision', 'image'],
  }, 'openai');
  const embedding = modelDiscovery.recordFor('embedding-model', {
    capabilities: ['embedding'],
  }, 'ollama');
  assert.equal(vision.imageGeneration, false);
  assert.equal(vision.textGeneration, true);
  assert.equal(embedding.textGeneration, false);
});

test('metadata refresh is deduplicated and preserves stale capabilities on failure', async () => {
  let fail = false;
  let advertiseImage = true;
  let tagsRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      tagsRequests += 1;
      res.writeHead(fail ? 503 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(fail ? { error: 'temporarily unavailable' } : {
        models: [{ name: 'cached-image', capabilities: advertiseImage ? ['image'] : ['completion'] }],
      }));
      return;
    }
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'temporarily unavailable' }));
  });
  const port = await listen(server);
  const upstream = upstreamLib.createUpstream('http://127.0.0.1:' + port + '/v1');

  try {
    modelDiscovery.replaceSnapshot({ complete: false, models: [], fetchedAt: 0, checkedAt: 0, upstream: '' });
    const [first, second] = await Promise.all([
      modelDiscovery.prewarm(upstream),
      modelDiscovery.prewarm(upstream),
    ]);
    assert.strictEqual(first, second);
    assert.equal(tagsRequests, 1);
    assert.equal(first.models[0].imageGeneration, true);

    fail = true;
    modelDiscovery.replaceSnapshot(Object.assign({}, first, {
      checkedAt: 0,
      fetchedAt: Date.now() - modelDiscovery.CACHE_TTL_MS - 1,
    }));
    const stale = await modelDiscovery.prewarm(upstream);
    assert.equal(tagsRequests, 2);
    assert.equal(stale.models[0].name, 'cached-image');

    await modelDiscovery.prewarm(upstream);
    assert.equal(tagsRequests, 2);

    fail = false;
    advertiseImage = false;
    modelDiscovery.markImageModel('cached-image', 'ollama_native', upstream);
    modelDiscovery.replaceSnapshot(Object.assign({}, modelDiscovery.snapshot(), { checkedAt: 0 }));
    const learned = await modelDiscovery.prewarm(upstream);
    assert.equal(tagsRequests, 3);
    assert.equal(learned.models[0].imageGeneration, true);
    assert.equal(learned.models[0].inferredImageGeneration, true);
  } finally {
    await close(server);
  }
});
