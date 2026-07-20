'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('Gemini image generation config nests aspect ratio under imageConfig', () => {
  const { buildGeminiGenerationConfig } = require('../src/imagine');

  const config = buildGeminiGenerationConfig({ aspectRatio: '16:9', imageSize: '2K' });

  assert.deepEqual(config, {
    responseModalities: ['IMAGE'],
    imageConfig: {
      aspectRatio: '16:9',
      imageSize: '2K',
    },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'aspectRatio'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'imageSize'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'responseFormat'), false);
});

test('Ollama backend fulfills the existing generate_image tool through /api/generate', async () => {
  const imagine = require('../src/imagine');
  const generated = Buffer.from('native-ollama-image');
  let received = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ image: generated.toString('base64'), done: true }));
    });
  });
  const port = await listen(server);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ollama-image-test-'));
  const inputPath = path.join(tempDir, 'input.png');
  fs.writeFileSync(inputPath, 'reference-image');
  let outputPath = null;

  try {
    const result = await imagine.fulfillGenerateImage({
      call_id: 'call_image',
      arguments: JSON.stringify({
        prompt: 'A cabin beside a lake',
        inputImagePath: inputPath,
        aspectRatio: '16:9',
      }),
    }, null, {
      imagine_service: 'ollama',
      imagine_model: 'x/z-image-turbo',
      imagine_base_url: 'http://127.0.0.1:' + port + '/v1',
      imagine_api_key: 'test-token',
    }, () => {});

    assert.doesNotMatch(result.output, /^\[generate_image error\]/);
    const output = JSON.parse(result.output);
    outputPath = output.path;
    assert.equal(output.mode, 'image-edit');
    assert.equal(output.model, 'x/z-image-turbo');
    assert.equal(fs.readFileSync(output.path).toString('utf8'), generated.toString('utf8'));
    assert.deepEqual(received, {
      method: 'POST',
      url: '/api/generate',
      authorization: 'Bearer test-token',
      body: {
        model: 'x/z-image-turbo',
        prompt: 'A cabin beside a lake',
        width: 1344,
        height: 768,
        stream: false,
        images: [Buffer.from('reference-image').toString('base64')],
      },
    });
  } finally {
    if (outputPath) fs.rmSync(outputPath, { force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
    await close(server);
  }
});

test('Ollama health check verifies the configured image model', async () => {
  const { checkHealth } = require('../src/imagine');
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/api/tags');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'x/z-image-turbo:latest' }] }));
  });
  const port = await listen(server);

  try {
    const result = await checkHealth({
      imagine_service: 'ollama',
      imagine_model: 'x/z-image-turbo',
      imagine_base_url: 'http://127.0.0.1:' + port,
    });
    assert.deepEqual(result, { ollama: { ready: true, models: 1 } });
  } finally {
    await close(server);
  }
});
