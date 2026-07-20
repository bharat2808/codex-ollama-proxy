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
    assert.deepEqual(received[0].body.messages, [{ role: 'user', content: 'say hello' }]);
    assert.equal(received[0].body.tools[0].function.name, 'lookup');
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
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model', object: 'model' }] }));
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
        choices: [{ message: { role: 'assistant', content: 'integration ok' } }],
      }));
    });
  });
  const providerPort = await listen(provider);
  const proxyPort = await freePort();
  const adaptorPort = await freePort();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-completion-adaptor-'));
  const runtimeDir = path.join(codexHome, 'ollama-shape-proxy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'proxy-models.toml'), [
    'text_model = "test-model"',
    'image_model = "test-model"',
    `upstream_url = "http://127.0.0.1:${providerPort}/v1"`,
    'upstream_api_key = "provider-secret"',
    'auto_route_image = true',
    'enable_find_skill = false',
    '',
  ].join('\n'), 'utf8');

  const child = spawn(process.execPath, [
    path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
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
    await waitForHttp(proxyPort, '/v1/models');
    const response = await postJson(proxyPort, '/v1/responses', {
      model: 'test-model',
      input: 'hello integration',
      stream: false,
      tools: [],
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.output_text, 'integration ok');
    assert.equal(received.length, 1);
    assert.equal(received[0].authorization, 'Bearer provider-secret');
    assert.equal(received[0].body.model, 'test-model');
    assert.deepEqual(received[0].body.messages, [{ role: 'user', content: 'hello integration' }]);
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
  const provider = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
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
    path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
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
    path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
    'run',
    'fake-provider',
    '--no-refresh',
    '--no-backup',
    '--foreground',
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
    const storedPreset = fs.readFileSync(path.join(codexHome, 'ollama-shape-proxy', 'presets', 'fake-provider.toml'), 'utf8');
    assert.match(storedPreset, /^upstream_api_key\s*=\s*"preset-secret"$/m);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await close(provider);
    fs.rmSync(codexHome, { recursive: true, force: true });
  }

  assert.match(stdout, /preset_applied=fake-provider/);
  assert.match(stdout, /completion-api-adaptor/);
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
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
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
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'run',
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
  const runtimeDir = path.join(codexHome, 'ollama-shape-proxy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'proxy-models.toml'), [
    'text_model = "test-model"',
    'image_model = "test-model"',
    'upstream_url = "http://127.0.0.1:9/v1"',
    'upstream_api_key = "provider-secret"',
    '',
  ].join('\n'), 'utf8');

  const child = spawn(process.execPath, [
    path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
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
  const runtimeDir = path.join(codexHome, 'ollama-shape-proxy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'proxy-models.toml'), [
    'text_model = "test-model"',
    'image_model = "test-model"',
    'upstream_url = "http://127.0.0.1:9/v1"',
    'upstream_api_key = "provider-secret"',
    '',
  ].join('\n'), 'utf8');

  const child = spawn(process.execPath, [
    path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
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
