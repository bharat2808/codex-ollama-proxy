'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function postJsonText(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

function listeningPids(port) {
  const result = spawnSync('lsof', ['-nP', '-tiTCP:' + port, '-sTCP:LISTEN'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0 && !result.stdout) return [];
  return result.stdout.split(/\s+/u).filter(Boolean);
}

function killListeningPort(port) {
  for (const pid of listeningPids(port)) {
    try {
      process.kill(Number(pid), 'SIGTERM');
    } catch {}
  }
}

function waitForHttp(port, path, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function attempt() {
      const req = http.get({ host: '127.0.0.1', port, path, timeout: 500 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) {
          resolve();
          return;
        }
        setTimeout(attempt, 100);
      });
      req.on('timeout', () => {
        req.destroy();
        retryOrFail();
      });
      req.on('error', retryOrFail);
    }
    function retryOrFail() {
      if (Date.now() - start > timeoutMs) {
        reject(new Error('timed out waiting for http://127.0.0.1:' + port + path));
        return;
      }
      setTimeout(attempt, 100);
    }
    attempt();
  });
}

test('completion adaptor preserves every image in a user content chain', () => {
  const { responsesInputToChatMessages } = require('../adaptor/completion-api-adaptor');
  const messages = responsesInputToChatMessages({
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: 'Combine these.' },
        { type: 'input_image', image_url: 'data:image/png;base64,b25l' },
        { type: 'input_image', image_url: 'data:image/jpeg;base64,dHdv' },
      ],
    }],
  });

  assert.deepEqual(messages, [{
    role: 'user',
    content: [
      { type: 'text', text: 'Combine these.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,b25l' } },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,dHdv' } },
    ],
  }]);
});

test('completion API adaptor translates Responses requests to Chat Completions', async () => {
  const received = [];
  const chatServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl_test',
        object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'hello from chat' } }],
      }));
    });
  });
  const chatPort = await listen(chatServer);

  const adaptor = require('../adaptor/completion-api-adaptor');
  const adaptorServer = adaptor.startServer({
    port: 0,
    baseUrl: `http://127.0.0.1:${chatPort}/v1`,
    apiKey: 'test-key',
    defaultModel: 'test-model',
  });
  await new Promise((resolve) => adaptorServer.once('listening', resolve));
  const adaptorPort = adaptorServer.address().port;

  try {
    const response = await postJson(adaptorPort, '/v1/responses', {
      input: 'say hello',
      stream: false,
      reasoning: { effort: 'max' },
      tools: [{
        type: 'function',
        name: 'lookup',
        parameters: { type: 'object', properties: {} },
      }],
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.status, 'completed');
    assert.equal(response.body.output_text, 'hello from chat');
    assert.equal(received.length, 1);
    assert.equal(received[0].url, '/v1/chat/completions');
    assert.equal(received[0].authorization, 'Bearer test-key');
    assert.equal(received[0].body.model, 'test-model');
    assert.equal(received[0].body.reasoning_effort, 'max');
    assert.deepEqual(received[0].body.messages, [{ role: 'user', content: 'say hello' }]);
    assert.equal(received[0].body.tools[0].function.name, 'lookup');
  } finally {
    await close(adaptorServer);
    await close(chatServer);
  }
});

test('completion API adaptor forwards requested output modalities and maps non-streaming images', async () => {
  const received = [];
  const imageUrl = 'data:image/png;base64,aW1hZ2U=';
  const chatServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            images: [{ type: 'image_url', image_url: { url: imageUrl } }],
          },
        }],
      }));
    });
  });
  const chatPort = await listen(chatServer);
  const adaptor = require('../adaptor/completion-api-adaptor');
  const adaptorServer = adaptor.startServer({
    port: 0,
    baseUrl: `http://127.0.0.1:${chatPort}/v1`,
    defaultModel: 'image-model',
  });
  await new Promise((resolve) => adaptorServer.once('listening', resolve));

  try {
    const response = await postJson(adaptorServer.address().port, '/v1/responses', {
      model: 'image-model',
      input: 'draw a giraffe',
      modalities: ['image', 'text'],
      stream: false,
    });
    assert.deepEqual(received[0].modalities, ['image', 'text']);
    assert.deepEqual(response.body.output, [{
      id: response.body.output[0].id,
      type: 'image_generation_call',
      status: 'completed',
      result: imageUrl,
    }]);
  } finally {
    await close(adaptorServer);
    await close(chatServer);
  }
});

test('completion API adaptor maps streamed chat images into image generation calls', async () => {
  const imageUrl = 'data:image/png;base64,c3RyZWFtZWQ=';
  const chatServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({
      choices: [{
        delta: {
          content: '',
          images: [{ type: 'image_url', image_url: { url: imageUrl } }],
        },
      }],
    })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const chatPort = await listen(chatServer);
  const adaptor = require('../adaptor/completion-api-adaptor');
  const adaptorServer = adaptor.startServer({
    port: 0,
    baseUrl: `http://127.0.0.1:${chatPort}/v1`,
    defaultModel: 'image-model',
  });
  await new Promise((resolve) => adaptorServer.once('listening', resolve));

  try {
    const response = await postJsonText(adaptorServer.address().port, '/v1/responses', {
      model: 'image-model',
      input: 'draw a giraffe',
      modalities: ['image', 'text'],
      stream: true,
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /"type":"image_generation_call"/);
    assert.match(response.body, new RegExp(imageUrl));
  } finally {
    await close(adaptorServer);
    await close(chatServer);
  }
});

test('completion API adaptor deduplicates repeated streamed image positions and keeps distinct images', async () => {
  const firstVersion = 'data:image/png;base64,Zmlyc3QtdmVyc2lvbg==';
  const finalVersion = 'data:image/png;base64,ZmluYWwtdmVyc2lvbg==';
  const secondImage = 'data:image/png;base64,c2Vjb25kLWltYWdl';
  const chatServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const images of [
      [{ type: 'image_url', image_url: { url: firstVersion } }],
      [
        { type: 'image_url', image_url: { url: finalVersion } },
        { type: 'image_url', image_url: { url: secondImage } },
      ],
    ]) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { images } }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  const chatPort = await listen(chatServer);
  const adaptor = require('../adaptor/completion-api-adaptor');
  const adaptorServer = adaptor.startServer({
    port: 0,
    baseUrl: `http://127.0.0.1:${chatPort}/v1`,
    defaultModel: 'image-model',
  });
  await new Promise((resolve) => adaptorServer.once('listening', resolve));

  try {
    const response = await postJsonText(adaptorServer.address().port, '/v1/responses', {
      model: 'image-model',
      input: 'draw two images',
      modalities: ['image', 'text'],
      stream: true,
    });
    const completed = response.body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
      .find((event) => event.type === 'response.completed');
    const images = completed.response.output.filter((item) => item.type === 'image_generation_call');

    assert.equal(images.length, 2);
    assert.deepEqual(images.map((item) => item.result), [finalVersion, secondImage]);
    assert.doesNotMatch(response.body, new RegExp(firstVersion));
  } finally {
    await close(adaptorServer);
    await close(chatServer);
  }
});

test('completion API adaptor streams upstream errors without crashing', async () => {
  const chatServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model', object: 'model' }] }));
      return;
    }
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 429, title: 'Too Many Requests' }));
  });
  const chatPort = await listen(chatServer);

  const adaptor = require('../adaptor/completion-api-adaptor');
  const adaptorServer = adaptor.startServer({
    port: 0,
    baseUrl: `http://127.0.0.1:${chatPort}/v1`,
    apiKey: 'test-key',
    defaultModel: 'test-model',
  });
  await new Promise((resolve) => adaptorServer.once('listening', resolve));
  const adaptorPort = adaptorServer.address().port;

  try {
    const response = await postJsonText(adaptorPort, '/v1/responses', {
      input: 'hit rate limit',
      stream: true,
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /event: response\.created/);
    assert.match(response.body, /event: response\.error/);
    assert.match(response.body, /upstream 429/);

    const health = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: adaptorPort, path: '/health' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(health, 200);
  } finally {
    await close(adaptorServer);
    await close(chatServer);
  }
});

test('completion API adaptor bounds stalled upstream requests', async () => {
  const chatServer = http.createServer(() => {});
  const chatPort = await listen(chatServer);

  const adaptor = require('../adaptor/completion-api-adaptor');
  const adaptorServer = adaptor.startServer({
    port: 0,
    baseUrl: `http://127.0.0.1:${chatPort}/v1`,
    apiKey: 'test-key',
    defaultModel: 'stalled-model',
    requestTimeoutMs: 50,
  });
  await new Promise((resolve) => adaptorServer.once('listening', resolve));
  const adaptorPort = adaptorServer.address().port;

  try {
    const response = await postJson(adaptorPort, '/v1/responses', {
      input: 'do not wait forever',
      stream: false,
    });

    assert.equal(response.statusCode, 504);
    assert.match(response.body.error, /timed out after 50ms/u);
  } finally {
    await close(adaptorServer);
    await close(chatServer);
  }
});

test('CLI serve --adaptor chat-completion starts proxy plus adaptor using upstream config', async () => {
  const received = [];
  const provider = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [
        { id: 'text-model', object: 'model' },
        { id: 'vision-model', object: 'model' },
      ] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected route' }));
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl_integration',
        object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: received.at(-1).body.model + ' ok' } }],
      }));
    });
  });
  const providerPort = await listen(provider);
  const proxyPort = await freePort();
  const adaptorPort = await freePort();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-completion-adaptor-'));
  const runtimeDir = path.join(codexHome, 'codex-universal-proxy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'proxy-models.toml'), [
    'default_model = "text-model"',
    'image_model = "vision-model"',
    `upstream_url = "http://127.0.0.1:${providerPort}/v1"`,
    'upstream_api_key = "provider-secret"',
    'auto_route_image = true',
    'enable_find_skill = false',
    '',
  ].join('\n'), 'utf8');

  const child = spawn(process.execPath, [
    path.join(__dirname, '..', 'bin', 'codex-universal-proxy'),
    'serve',
    '--adaptor',
    'chat-completion',
    '--adaptor-port',
    String(adaptorPort),
    '--no-dedupe-large-input',
    '--dedupe-min-chars',
    '777',
  ], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      CODEX_HOME: codexHome,
      PROXY_PORT: String(proxyPort),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  try {
    await waitForHttp(proxyPort, '/v1/models');
    const response = await postJson(proxyPort, '/v1/responses', {
      model: 'text-model',
      input: 'hello integration',
      stream: false,
      tools: [],
    });

    assert.equal(response.statusCode, 200);
    const imageResponse = await postJson(proxyPort, '/v1/responses', {
      model: 'text-model',
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'inspect image' },
          { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=' },
        ],
      }],
      stream: false,
      tools: [],
    });

    assert.equal(response.body.output_text, 'text-model ok');
    assert.equal(imageResponse.statusCode, 200);
    assert.equal(imageResponse.body.output_text, 'vision-model ok');
    assert.equal(received.length, 2);
    assert.equal(received[0].authorization, 'Bearer provider-secret');
    assert.equal(received[0].body.model, 'text-model');
    assert.deepEqual(received[0].body.messages, [{ role: 'user', content: 'hello integration' }]);
    assert.equal(received[1].body.model, 'vision-model');
    assert.equal(received[1].body.messages[0].content[1].type, 'image_url');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(runtimeDir, 'launcher-state.json'), 'utf8')),
      {
        version: 1,
        adaptor: 'chat-completion',
        proxy_port: proxyPort,
        adaptor_port: adaptorPort,
        dedupe_large_input: false,
        dedupe_min_chars: 777,
      },
    );
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await close(provider);
    fs.rmSync(codexHome, { recursive: true, force: true });
  }

  assert.match(stdout, /completion-api-adaptor/);
  assert.doesNotMatch(stderr, /Error|EADDRINUSE|Unhandled/u);
});

test('CLI run PRESET applies preset and starts proxy plus chat-completion adaptor', async () => {
  const received = [];
  const modelRequests = [];
  const provider = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      modelRequests.push({ authorization: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'preset-model', object: 'model' }] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected route' }));
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl_preset',
        object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'preset run ok' } }],
      }));
    });
  });
  const providerPort = await listen(provider);
  const proxyPort = await freePort();
  const adaptorPort = await freePort();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-completion-preset-run-'));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'sandbox_mode = "danger-full-access"\n', 'utf8');

  const add = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'bin', 'codex-universal-proxy'),
    'preset',
    'add',
    'fake-provider',
    '--adaptor',
    'chat-completion',
    '--url',
    `http://127.0.0.1:${providerPort}/v1`,
    '--text-model',
    'preset-model',
    '--api-key',
    'preset-secret',
    '--auto-image',
  ], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
    encoding: 'utf8',
  });
  assert.equal(add.status, 0, add.stderr || add.stdout);

  const child = spawn(process.execPath, [
    path.join(__dirname, '..', 'bin', 'codex-universal-proxy'),
    'run',
    'fake-provider',
    '--no-backup',
    '--foreground',
    '--adaptor-port',
    String(adaptorPort),
    '--dedupe-min-chars',
    '0',
  ], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      CODEX_HOME: codexHome,
      PROXY_PORT: String(proxyPort),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  try {
    await waitForHttp(proxyPort, '/v1/models');
    const response = await postJson(proxyPort, '/v1/responses', {
      model: 'preset-model',
      input: 'hello preset',
      stream: false,
      tools: [],
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.output_text, 'preset run ok');
    assert.equal(received.length, 1);
    assert.equal(received[0].authorization, 'Bearer preset-secret');
    assert.equal(received[0].body.model, 'preset-model');
    assert.deepEqual(received[0].body.messages, [{ role: 'user', content: 'hello preset' }]);
    assert.ok(modelRequests.length >= 1);
    assert.ok(modelRequests.every((request) => request.authorization === 'Bearer preset-secret'));
    const catalog = JSON.parse(fs.readFileSync(
      path.join(codexHome, 'codex-universal-models-working.json'),
      'utf8',
    ));
    assert.deepEqual(catalog.models.map((model) => model.slug), ['preset-model']);
    const storedPreset = fs.readFileSync(path.join(codexHome, 'codex-universal-proxy', 'presets', 'fake-provider.toml'), 'utf8');
    assert.match(storedPreset, /^upstream_api_key\s*=\s*"preset-secret"$/m);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await close(provider);
    fs.rmSync(codexHome, { recursive: true, force: true });
  }

  assert.match(stdout, /preset_applied=fake-provider/);
  assert.match(stdout, /completion-api-adaptor/);
  assert.match(stderr, /duplicate_input_min_chars=0/);
  assert.doesNotMatch(stderr, /Error|EADDRINUSE|Unhandled/u);
});

test('CLI run PRESET detaches after proxy starts', async () => {
  const received = [];
  const provider = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'detached-model', object: 'model' }] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected route' }));
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl_detached',
        object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'detached run ok' } }],
      }));
    });
  });
  const providerPort = await listen(provider);
  const proxyPort = await freePort();
  const adaptorPort = await freePort();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-completion-preset-detached-'));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'sandbox_mode = "danger-full-access"\n', 'utf8');

  try {
    const add = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-universal-proxy'),
      'preset',
      'add',
      'fake-provider',
      '--adaptor',
      'chat-completion',
      '--url',
      `http://127.0.0.1:${providerPort}/v1`,
      '--text-model',
      'detached-model',
      '--api-key',
      'detached-secret',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });
    assert.equal(add.status, 0, add.stderr || add.stdout);

    const run = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-universal-proxy'),
      'run',
      'fake-provider',
      '--no-refresh',
      '--no-backup',
      '--adaptor-port',
      String(adaptorPort),
      '--dedupe-min-chars',
      '0',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, {
        CODEX_HOME: codexHome,
        PROXY_PORT: String(proxyPort),
      }),
      encoding: 'utf8',
      timeout: 8000,
    });

    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /started_pid=\d+/);
    assert.match(run.stdout, new RegExp('proxy=http://127\\.0\\.0\\.1:' + proxyPort + ' status=(200|starting)'));

    await waitForHttp(proxyPort, '/v1/models');
    const response = await postJson(proxyPort, '/v1/responses', {
      model: 'detached-model',
      input: 'hello detached',
      stream: false,
      tools: [],
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.output_text, 'detached run ok');
    assert.equal(received[0].authorization, 'Bearer detached-secret');
    const log = fs.readFileSync(path.join(codexHome, 'codex-universal-proxy', 'proxy.log'), 'utf8');
    assert.match(log, /duplicate_input_min_chars=0/);
  } finally {
    killListeningPort(proxyPort);
    killListeningPort(adaptorPort);
    await close(provider);
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('CLI preset use applies preset and starts proxy stack by default', async () => {
  const provider = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'use-model', object: 'model' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl_use',
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: 'preset use ok' } }],
    }));
  });
  const providerPort = await listen(provider);
  const proxyPort = await freePort();
  const adaptorPort = await freePort();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-completion-preset-use-'));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'sandbox_mode = "danger-full-access"\n', 'utf8');

  try {
    const add = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-universal-proxy'),
      'preset',
      'add',
      'fake-provider',
      '--adaptor',
      'chat-completion',
      '--url',
      `http://127.0.0.1:${providerPort}/v1`,
      '--text-model',
      'use-model',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });
    assert.equal(add.status, 0, add.stderr || add.stdout);

    const use = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-universal-proxy'),
      'preset',
      'use',
      'fake-provider',
      '--no-refresh',
      '--no-backup',
      '--adaptor-port',
      String(adaptorPort),
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, {
        CODEX_HOME: codexHome,
        PROXY_PORT: String(proxyPort),
      }),
      encoding: 'utf8',
      timeout: 8000,
    });

    assert.equal(use.status, 0, use.stderr || use.stdout);
    assert.match(use.stdout, /preset_applied=fake-provider/);
    assert.match(use.stdout, /started_pid=\d+/);
    await waitForHttp(proxyPort, '/v1/models');
  } finally {
    killListeningPort(proxyPort);
    killListeningPort(adaptorPort);
    await close(provider);
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('CLI serve --adaptor chat-completion reports occupied unhealthy proxy port before starting adaptor', async () => {
  const occupied = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('occupied');
  });
  const proxyPort = await listen(occupied);
  const adaptorPort = await freePort();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-completion-adaptor-port-'));
  const runtimeDir = path.join(codexHome, 'codex-universal-proxy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'proxy-models.toml'), [
    'default_model = "test-model"',
    'image_model = "test-model"',
    'upstream_url = "http://127.0.0.1:9/v1"',
    'upstream_api_key = "provider-secret"',
    '',
  ].join('\n'), 'utf8');

  const child = spawn(process.execPath, [
    path.join(__dirname, '..', 'bin', 'codex-universal-proxy'),
    'serve',
    '--adaptor',
    'chat-completion',
    '--adaptor-port',
    String(adaptorPort),
  ], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      CODEX_HOME: codexHome,
      PROXY_PORT: String(proxyPort),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  try {
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('timed out waiting for occupied-port serve process to exit'));
      }, 5000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    assert.equal(exit, 0);
    assert.match(stdout, new RegExp('already_running_unhealthy=http://127\\.0\\.0\\.1:' + proxyPort));
    assert.match(stdout, /Run again with --replace/);
    assert.doesNotMatch(stdout, /completion-api-adaptor/u);
    assert.doesNotMatch(stderr, /Unhandled 'error' event|node:events|throw er|EADDRINUSE:/u);
  } finally {
    if (!child.killed) child.kill('SIGTERM');
    await close(occupied);
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('CLI serve --adaptor chat-completion treats an existing healthy proxy as already running', async () => {
  const existingProxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'already-running-model', object: 'model' }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  const proxyPort = await listen(existingProxy);
  const adaptorPort = await freePort();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-completion-adaptor-existing-'));
  const runtimeDir = path.join(codexHome, 'codex-universal-proxy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'proxy-models.toml'), [
    'default_model = "test-model"',
    'image_model = "test-model"',
    'upstream_url = "http://127.0.0.1:9/v1"',
    'upstream_api_key = "provider-secret"',
    '',
  ].join('\n'), 'utf8');

  const child = spawn(process.execPath, [
    path.join(__dirname, '..', 'bin', 'codex-universal-proxy'),
    'serve',
    '--adaptor',
    'chat-completion',
    '--adaptor-port',
    String(adaptorPort),
  ], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      CODEX_HOME: codexHome,
      PROXY_PORT: String(proxyPort),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  try {
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('timed out waiting for already-running serve process to exit'));
      }, 5000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    assert.equal(exit, 0);
    assert.match(stdout, new RegExp('already_running=http://127\\.0\\.0\\.1:' + proxyPort));
    assert.equal(stderr, '');
  } finally {
    if (!child.killed) child.kill('SIGTERM');
    await close(existingProxy);
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});
test('CLI preset add with no --adaptor stores a direct (adaptor "none") preset and run talks straight to the provider', async () => {
  const received = [];
  const provider = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'direct-model', object: 'model' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/responses') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        received.push({
          authorization: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'resp_direct',
          object: 'response',
          status: 'completed',
          model: 'direct-model',
          output: [{ type: 'message', id: 'msg_direct', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'direct ok' }] }],
          output_text: 'direct ok',
        }));
      });
      return;
    }
    // Unknown routes (including the proxy's startup /api/tags probe) 404 so the
    // model-availability check skips silently without an adaptor in the path.
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unexpected route' }));
  });
  const providerPort = await listen(provider);
  const proxyPort = await freePort();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-direct-preset-'));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'sandbox_mode = "danger-full-access"\n', 'utf8');

  try {
    // No --adaptor: defaults to "none" (direct Responses API).
    const add = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-universal-proxy'),
      'preset',
      'add',
      'direct-provider',
      '--url',
      `http://127.0.0.1:${providerPort}/v1`,
      '--text-model',
      'direct-model',
      '--api-key',
      'direct-secret',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });
    assert.equal(add.status, 0, add.stderr || add.stdout);

    const presetPath = path.join(codexHome, 'codex-universal-proxy', 'presets', 'direct-provider.toml');
    const preset = fs.readFileSync(presetPath, 'utf8');
    assert.match(preset, /^adaptor\s*=\s*"none"$/m);
    assert.match(preset, /^upstream_url\s*=\s*"http:\/\/127\.0\.0\.1:\d+\/v1"$/m);
    assert.match(preset, /^upstream_api_key\s*=\s*"direct-secret"$/m);

    const child = spawn(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-universal-proxy'),
      'run',
      'direct-provider',
      '--no-refresh',
      '--no-backup',
      '--foreground',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, {
        CODEX_HOME: codexHome,
        PROXY_PORT: String(proxyPort),
        // Disable the find_skill prewarm so the proxy does not spawn the real
        // Codex app-server (which materializes skills/.system under the temp
        // CODEX_HOME and would race with the test's rmSync cleanup).
        PROXY_FIND_SKILL: '0',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    try {
      await waitForHttp(proxyPort, '/v1/models');
      const response = await postJson(proxyPort, '/v1/responses', {
        model: 'direct-model',
        input: 'hello direct',
        stream: false,
        tools: [],
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.output_text, 'direct ok');
      // The proxy talked straight to the provider (no adaptor process).
      assert.equal(received.length, 1);
      assert.equal(received[0].authorization, 'Bearer direct-secret');
      assert.equal(received[0].body.model, 'direct-model');
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }

    assert.match(stdout, /preset_applied=direct-provider/);
    assert.doesNotMatch(stdout, /completion-api-adaptor/);
    assert.doesNotMatch(stderr, /Error|EADDRINUSE|Unhandled/u);
  } finally {
    killListeningPort(proxyPort);
    await close(provider);
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('CLI preset add rejects an unsupported adaptor value', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-preset-bad-adaptor-'));
  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-universal-proxy'),
      'preset',
      'add',
      'bad',
      '--adaptor',
      'mqtt',
      '--url',
      'https://example.com/v1',
      '--text-model',
      'm',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr || result.stdout, /chat-completion", "google", or "none"/);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});
