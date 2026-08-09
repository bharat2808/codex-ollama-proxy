'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertPrivateDirectoryMode, assertPrivateFileMode } = require('./helpers/file-mode');
const {
  applyOutputModalities,
  imageInputOutputCapabilities,
  imageOutputCapabilities,
  imageOutputSupport,
} = require('../src/proxy');
const { VOICE_TURN_INSTRUCTIONS } = require('../src/voice-agent/voice-coordinator');

const LOCAL_UPSTREAM = { baseUrl: new URL('http://127.0.0.1:11434/v1') };
const IMAGE_SIGNATURES = {
  'image/gif': Buffer.from('GIF89a', 'ascii'),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/webp': Buffer.from('RIFF\x04\x00\x00\x00WEBP', 'binary'),
};

function inlineImageBytes(mimeType, suffix = '') {
  return Buffer.concat([IMAGE_SIGNATURES[mimeType], Buffer.from(suffix)]);
}

function inlineImageUrl(mimeType, suffix = '') {
  return `data:${mimeType};base64,${inlineImageBytes(mimeType, suffix).toString('base64')}`;
}

test('adds image output modalities only for models discovered with image output', () => {
  const capable = imageOutputCapabilities([
    { slug: 'image-model', output_modalities: ['image', 'text'] },
    { slug: 'text-model', output_modalities: ['text'] },
  ]);
  const imageBody = { model: 'image-model', input: 'draw a giraffe' };
  const textBody = { model: 'text-model', input: 'say hello' };

  applyOutputModalities(imageBody, capable);
  applyOutputModalities(textBody, capable);

  assert.deepEqual(imageBody.modalities, ['image', 'text']);
  assert.equal(textBody.modalities, undefined);
});

test('distinguishes image-output support from text-only and unknown models by exact id', () => {
  const models = [
    { slug: 'provider/image-model', output_modalities: ['image', 'text'] },
    { slug: 'provider/text-model', output_modalities: ['text'] },
  ];

  assert.equal(imageOutputSupport('provider/image-model', models), true);
  assert.equal(imageOutputSupport('provider/text-model', models), false);
  assert.equal(imageOutputSupport('image-model', models), null);
  assert.equal(imageOutputSupport('provider/unknown', models), null);
});

test('selects only exact models supporting both image input and image output', () => {
  const capable = imageInputOutputCapabilities([
    { slug: 'provider/dual', input_modalities: ['text', 'image'], output_modalities: ['image'] },
    { slug: 'provider/output-only', input_modalities: ['text'], output_modalities: ['image'] },
    { slug: 'provider/input-only', inputModalities: ['text', 'image'], outputModalities: ['text'] },
    { slug: 'provider/camel-dual', inputModalities: ['image'], outputModalities: ['text', 'image'] },
  ]);

  assert.deepEqual([...capable], ['provider/dual', 'provider/camel-dual']);
});

test('native image-output requests do not forward or inject function tools', () => {
  const { translateRequestBody } = require('../src/proxy');
  const body = {
    model: 'provider/image-model',
    input: 'draw a giraffe',
    modalities: ['image', 'text'],
    tool_choice: 'required',
    tools: [{
      type: 'function',
      name: 'lookup',
      parameters: { type: 'object', properties: {} },
    }],
  };

  translateRequestBody(body);

  assert.deepEqual(body.tools, []);
  assert.equal(body.tool_choice, undefined);
});

test('voice handoff requests receive spoken-turn guidance before provider translation', () => {
  const { translateRequestBody } = require('../src/proxy');
  const body = {
    model: 'local-model',
    input: [{
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: '<realtime_delegation>\nPlease inspect the repository.\n</realtime_delegation>',
      }],
    }],
  };

  translateRequestBody(body);

  const guidance = body.input.filter((item) => (
    item
    && item.type === 'message'
    && item.role === 'developer'
    && item.content?.some((part) => part.text === VOICE_TURN_INSTRUCTIONS)
  ));
  assert.equal(guidance.length, 1);
});

test('voice handoffs replace a stale Codex model with the active preset default', () => {
  withRouteConfig([
    'models = ["glm-5.2:cloud", "kimi-k2.7-code:cloud"]',
    'default_model = "glm-5.2:cloud"',
  ], ({ translateRequestBody }) => {
    const body = {
      model: 'gpt-5.6-luna',
      input: [{
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: '<realtime_delegation>\nCheck the current branch.\n</realtime_delegation>',
        }],
      }],
    };

    translateRequestBody(body);

    assert.equal(body.model, 'glm-5.2:cloud');
  });
});

test('active presets replace stale models on internal Codex turns', () => {
  withRouteConfig([
    'models = ["glm-5.2:cloud", "kimi-k2.7-code:cloud"]',
    'default_model = "glm-5.2:cloud"',
  ], ({ translateRequestBody }) => {
    const body = {
      model: 'gpt-5.6-luna',
      input: 'Generate a concise title for the completed voice thread.',
    };

    translateRequestBody(body);

    assert.equal(body.model, 'glm-5.2:cloud');
  });
});

test('request translation records the final routed model for the Codex thread', () => {
  withRouteConfig([
    'models = ["current-model"]',
    'default_model = "current-model"',
  ], ({ activeModelTracker, translateRequestBody }) => {
    const body = {
      model: 'stale-client-model',
      metadata: { thread_id: 'voice-fallback-thread' },
      input: [],
    };

    translateRequestBody(body);

    assert.equal(body.model, 'current-model');
    assert.equal(
      activeModelTracker.resolve({ metadata: { thread_id: 'voice-fallback-thread' } }),
      'current-model',
    );
  });
});

test('replayed voice handoffs with existing guidance still use the preset default', () => {
  withRouteConfig([
    'models = ["glm-5.2:cloud", "kimi-k2.7-code:cloud"]',
    'default_model = "glm-5.2:cloud"',
  ], ({ translateRequestBody }) => {
    const body = {
      model: 'gpt-5.6-luna',
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: VOICE_TURN_INSTRUCTIONS }],
        },
        {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<realtime_delegation>\nCheck the current branch.\n</realtime_delegation>',
          }],
        },
      ],
    };

    translateRequestBody(body);

    assert.equal(body.model, 'glm-5.2:cloud');
    assert.equal(
      body.input.filter((item) => (
        Array.isArray(item.content)
        && item.content.some((part) => part && part.text === VOICE_TURN_INSTRUCTIONS)
      )).length,
      1,
    );
  });
});

test('ordinary Responses requests do not receive voice guidance', () => {
  const { translateRequestBody } = require('../src/proxy');
  const body = {
    model: 'local-model',
    input: 'Please inspect the repository.',
  };

  translateRequestBody(body);

  assert.equal(body.input, 'Please inspect the repository.');
});

test('a typed turn after a historical voice handoff does not receive voice guidance', () => {
  const { translateRequestBody } = require('../src/proxy');
  const body = {
    model: 'local-model',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: '<realtime_delegation><input>old voice turn</input></realtime_delegation>',
        }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Old response.' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'This is a normal typed turn.' }],
      },
    ],
  };

  translateRequestBody(body);

  assert.equal(
    body.input.some((item) => (
      item.role === 'developer'
      && JSON.stringify(item).includes(VOICE_TURN_INSTRUCTIONS)
    )),
    false,
  );
});

test('image generation tools are removed when Imagine is disabled', () => {
  withRouteConfig([
    'default_model = "text-model"',
    'imagine_enabled = false',
  ], ({ translateRequestBody }) => {
    const body = {
      model: 'text-model',
      input: 'draw a giraffe',
      tools: [
        {
          type: 'namespace',
          name: 'image_gen',
          tools: [{
            name: 'imagegen',
            description: 'Generate an image.',
            parameters: { type: 'object', properties: {} },
          }],
        },
        {
          type: 'function',
          name: 'generate_image',
          parameters: { type: 'object', properties: {} },
        },
        {
          type: 'image_generation',
        },
      ],
    };

    translateRequestBody(body);

    assert.equal(body.tools.some((tool) =>
      tool && (tool.name === 'generate_image'
        || tool.name === 'imagegen'
        || tool.name === 'image_gen__imagegen'
        || tool.name === 'image_gen'
        || tool.type === 'image_generation')
    ), false);
  });
});

test('Imagine replaces client image tools with only the proxy generate_image tool', () => {
  withRouteConfig([
    'default_model = "text-model"',
    'imagine_enabled = true',
  ], ({ translateRequestBody }) => {
    const body = {
      model: 'text-model',
      input: 'draw a giraffe',
      tools: [
        {
          type: 'namespace',
          name: 'image_gen',
          tools: [{
            name: 'imagegen',
            parameters: { type: 'object', properties: {} },
          }],
        },
        {
          type: 'function',
          name: 'generate_image',
          description: 'Untrusted client definition.',
          parameters: { type: 'object', properties: {} },
        },
      ],
    };

    translateRequestBody(body);

    const imageTools = body.tools.filter((tool) =>
      tool && (tool.name === 'generate_image'
        || tool.name === 'imagegen'
        || tool.name === 'image_gen__imagegen'
        || tool.name === 'image_gen'
        || tool.type === 'image_generation')
    );
    assert.equal(imageTools.length, 1);
    assert.equal(imageTools[0].name, 'generate_image');
    assert.notEqual(imageTools[0].description, 'Untrusted client definition.');
  });
});

test('models explicitly catalogued without tool support do not receive injected tools', () => {
  withRouteConfig([
    'default_model = "no-tools-model"',
    'auto_route_image = false',
  ], ({ translateRequestBody }) => {
    const body = {
      model: 'no-tools-model',
      input: 'Describe the attached image.',
      tools: [{
        type: 'function',
        name: 'echo',
        parameters: { type: 'object' },
      }],
      tool_choice: 'required',
    };

    translateRequestBody(body);

    assert.deepEqual(body.tools, []);
    assert.equal(body.tool_choice, undefined);
  }, ({ codexHome }) => {
    fs.writeFileSync(path.join(codexHome, 'codex-universal-models.json'), JSON.stringify({
      models: [{
        slug: 'no-tools-model',
        supports_tools: false,
      }],
    }));
  });
});

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

function postJson(port, body) {
  return postBuffer(port, Buffer.from(JSON.stringify(body)), {
    'content-type': 'application/json',
  });
}

function postBuffer(port, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/responses',
      headers: Object.assign({
        'content-length': Buffer.byteLength(payload),
      }, headers),
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

function postStream(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        accept: 'text/event-stream',
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

function writeSse(res, event, data) {
  if (event) res.write('event: ' + event + '\n');
  res.write('data: ' + (typeof data === 'string' ? data : JSON.stringify(data)) + '\n\n');
}

function parseSse(body) {
  return body.split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const lines = block.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith('event:'));
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    return {
      event: event ? event.slice(6).trim() : null,
      data: data === '[DONE]' ? data : JSON.parse(data),
    };
  });
}

function assertSuccessfulTerminal(events) {
  const names = events.map((entry) => entry.event);
  assert.equal(names[0], 'response.created');
  assert.equal(names[1], 'response.in_progress');
  assert.equal(names.filter((name) => name === 'response.completed').length, 1);
  assert.equal(names.some((name) => name === 'response.failed'), false);
  assert.equal(names.at(-1), 'response.completed');
  assert.equal(events.some((entry) => entry.data === '[DONE]'), false);
  const added = names.lastIndexOf('response.output_item.added');
  const done = names.lastIndexOf('response.output_item.done');
  const completed = names.lastIndexOf('response.completed');
  assert.ok(added > names.lastIndexOf('response.in_progress'));
  assert.ok(done > added);
  assert.ok(completed > done);
}

async function withProxy(upstreamHandler, run, config = []) {
  const upstream = http.createServer(upstreamHandler);
  const upstreamPort = await listen(upstream);
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proxy-stream-test-'));
  fs.mkdirSync(path.join(codexHome, 'codex-universal-proxy'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'codex-universal-proxy', 'proxy-models.toml'), [
    'default_model = "test-model"',
    `upstream_url = "http://127.0.0.1:${upstreamPort}/custom"`,
    ...config,
    '',
  ].join('\n'));

  const previousCodexHome = process.env.CODEX_HOME;
  const previousProxyPort = process.env.PROXY_PORT;
  process.env.CODEX_HOME = codexHome;
  process.env.PROXY_PORT = '0';
  delete require.cache[require.resolve('../src/proxy')];
  const proxy = require('../src/proxy');
  const server = proxy.startServer(0);
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    await run(server.address().port, proxy, codexHome);
  } finally {
    await close(server);
    await close(upstream);
    delete require.cache[require.resolve('../src/proxy')];
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousProxyPort === undefined) delete process.env.PROXY_PORT;
    else process.env.PROXY_PORT = previousProxyPort;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
}

async function withLocalOllamaProxy(ollamaHandler, run) {
  const ollama = http.createServer(ollamaHandler);
  const ollamaPort = await listen(ollama);
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proxy-ollama-cloud-test-'));
  fs.mkdirSync(path.join(codexHome, 'codex-universal-proxy'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'codex-universal-proxy', 'proxy-models.toml'), [
    'default_model = "local-default"',
    `upstream_url = "http://127.0.0.1:${ollamaPort}/v1"`,
    '',
  ].join('\n'));

  const previousCodexHome = process.env.CODEX_HOME;
  const previousProxyPort = process.env.PROXY_PORT;
  process.env.CODEX_HOME = codexHome;
  process.env.PROXY_PORT = '0';
  delete require.cache[require.resolve('../src/proxy')];
  const proxy = require('../src/proxy');
  const server = proxy.startServer(0);
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    await run(server.address().port, proxy, codexHome);
  } finally {
    await close(server);
    await close(ollama);
    delete require.cache[require.resolve('../src/proxy')];
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousProxyPort === undefined) delete process.env.PROXY_PORT;
    else process.env.PROXY_PORT = previousProxyPort;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
}

function withRouteConfig(config, run, setup) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proxy-routing-test-'));
  const runtimeDir = path.join(codexHome, 'codex-universal-proxy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'proxy-models.toml'), [...config, ''].join('\n'));
  if (typeof setup === 'function') setup({ codexHome, runtimeDir });

  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  delete require.cache[require.resolve('../src/proxy')];
  try {
    return run(require('../src/proxy'));
  } finally {
    delete require.cache[require.resolve('../src/proxy')];
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
}

function writeReasoningCatalog(codexHome, models) {
  fs.writeFileSync(
    path.join(codexHome, 'codex-universal-models.json'),
    JSON.stringify({ models }),
    'utf8',
  );
}

function textItem(id, text, attachments = []) {
  return {
    type: 'message',
    id,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }, ...attachments],
  };
}

test('proxy module loads when image routing snapshots a populated model catalog', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proxy-startup-test-'));
  const runtimeDir = path.join(codexHome, 'codex-universal-proxy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'proxy-models.toml'), [
    'default_model = "text-model"',
    'image_model = "vision-model"',
    'auto_route_image = true',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(codexHome, 'codex-universal-models-working.json'), JSON.stringify({
    models: [{ slug: 'vision-model', input_modalities: ['text', 'image'] }],
  }));

  try {
    const result = spawnSync(process.execPath, ['-e', "require('./src/proxy')"], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, CODEX_HOME: codexHome },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('proxy pulls an allowlisted cloud model before forwarding its first request', async () => {
  const calls = [];
  let pulled = false;
  await withLocalOllamaProxy((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      calls.push({ path: req.url, body });
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [] }));
        return;
      }
      if (req.url === '/api/pull') {
        pulled = true;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'success' }));
        return;
      }
      if (req.url === '/api/show') {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (body && body.model === 'kimi-k2.7-code:cloud' && pulled) {
          res.end(JSON.stringify({ details: { family: 'cloud' }, capabilities: ['completion', 'tools'] }));
        } else {
          res.end(JSON.stringify({ error: 'model not found' }));
        }
        return;
      }
      assert.equal(req.url, '/v1/responses');
      assert.equal(pulled, true, 'cloud model must be pulled before forwarding');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'resp_cloud', status: 'completed', output: [] }));
    });
  }, async (proxyPort) => {
    const response = await postJson(proxyPort, {
      model: 'kimi-k2.7-code:cloud',
      stream: false,
      input: 'hello',
      tools: [],
    });
    assert.equal(response.statusCode, 200, response.body);
  });

  const relevant = calls.filter((call) =>
    call.path === '/api/pull'
    || (call.path === '/api/show' && call.body && call.body.model === 'kimi-k2.7-code:cloud')
    || call.path === '/v1/responses'
  );
  assert.deepEqual(relevant.map((call) => call.path), [
    '/api/pull',
    '/api/show',
    '/v1/responses',
  ]);
  assert.deepEqual(relevant[0].body, { model: 'kimi-k2.7-code:cloud', stream: false });
});

test('proxy never auto-pulls a missing ordinary local model', async () => {
  const calls = [];
  await withLocalOllamaProxy((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      calls.push({ path: req.url, body });
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [] }));
        return;
      }
      if (req.url === '/api/show') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'model not found' }));
        return;
      }
      assert.equal(req.url, '/v1/responses');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'resp_local', status: 'completed', output: [] }));
    });
  }, async (proxyPort) => {
    const response = await postJson(proxyPort, {
      model: 'missing-local',
      stream: false,
      input: 'hello',
      tools: [],
    });
    assert.equal(response.statusCode, 200, response.body);
  });

  assert.equal(calls.some((call) => call.path === '/api/pull'), false);
  assert.equal(calls.some((call) => call.path === '/v1/responses'), true);
});

test('proxy returns a bounded error when an allowlisted cloud pull fails', async () => {
  const calls = [];
  await withLocalOllamaProxy((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      calls.push(req.url);
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [] }));
        return;
      }
      if (req.url === '/api/pull') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'sensitive upstream detail' }));
        return;
      }
      if (req.url === '/api/show') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'model not found' }));
        return;
      }
      assert.fail(`request must not be forwarded after failed pull: ${req.url}`);
    });
  }, async (proxyPort) => {
    const response = await postJson(proxyPort, {
      model: 'kimi-k2.7-code:cloud',
      stream: false,
      input: 'hello',
      tools: [],
    });
    assert.equal(response.statusCode, 502);
    const payload = JSON.parse(response.body);
    assert.equal(payload.error.type, 'ollama_cloud_pull_error');
    assert.equal(payload.error.code, 'PULL_FAILED');
    assert.doesNotMatch(payload.error.message, /sensitive upstream detail/i);
  });

  assert.equal(calls.includes('/api/pull'), true);
  assert.equal(calls.includes('/v1/responses'), false);
});

test('dedupeLargeInputBlocks keeps the newest large developer block', () => {
  const { dedupeLargeInputBlocks } = require('../src/proxy');
  const repeated = '<skills_instructions>' + 'x'.repeat(600) + '</skills_instructions>';
  const body = {
    input: [
      { type: 'message', id: 'old', role: 'developer', content: [
        { type: 'input_text', text: repeated },
        { type: 'input_text', text: 'old unique' },
      ] },
      { type: 'message', id: 'user', role: 'user', content: [
        { type: 'input_text', text: repeated },
      ] },
      { type: 'message', id: 'new', role: 'developer', content: [
        { type: 'input_text', text: repeated },
        { type: 'input_text', text: 'new unique' },
      ] },
    ],
  };

  const removed = dedupeLargeInputBlocks(body, 512);

  assert.deepEqual(removed, { blocks: 1, chars: repeated.length });
  assert.deepEqual(body.input.map((item) => item.id), ['old', 'user', 'new']);
  assert.deepEqual(body.input[0].content.map((block) => block.text), ['old unique']);
  assert.equal(body.input[1].content[0].text, repeated);
  assert.deepEqual(body.input[2].content.map((block) => block.text), [repeated, 'new unique']);
});

test('dedupeLargeInputBlocks preserves short, distinct, and non-developer text', () => {
  const { dedupeLargeInputBlocks } = require('../src/proxy');
  const short = 'same short text';
  const long = 'y'.repeat(700);
  const body = { input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: short }] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: short }] },
    { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: long }] },
    { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: long }] },
  ] };

  assert.deepEqual(dedupeLargeInputBlocks(body, 512), { blocks: 0, chars: 0 });
  assert.equal(body.input.length, 4);
});

function writeTextTurn(res, options = {}) {
  const id = options.id || 'resp_text';
  const text = options.text || 'done';
  const item = textItem('msg_' + id, text, options.attachments);
  res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
  writeSse(res, 'response.created', { type: 'response.created', response: { id, status: 'in_progress', output: [] } });
  writeSse(res, 'response.in_progress', { type: 'response.in_progress', response: { id, status: 'in_progress', output: [] } });
  writeSse(res, 'response.output_item.added', {
    type: 'response.output_item.added', output_index: 0, sequence_number: 0,
    item: Object.assign({}, item, { status: 'in_progress', content: [] }),
  });
  writeSse(res, 'response.content_part.added', {
    type: 'response.content_part.added', output_index: 0, content_index: 0, sequence_number: 1,
    part: { type: 'output_text', text: '', annotations: [] },
  });
  writeSse(res, 'response.output_text.delta', {
    type: 'response.output_text.delta', output_index: 0, content_index: 0, sequence_number: 2, delta: text,
  });
  writeSse(res, 'response.output_text.done', {
    type: 'response.output_text.done', output_index: 0, content_index: 0, sequence_number: 3, text,
  });
  writeSse(res, 'response.content_part.done', {
    type: 'response.content_part.done', output_index: 0, content_index: 0, sequence_number: 4,
    part: { type: 'output_text', text, annotations: [] },
  });
  writeSse(res, 'response.output_item.done', {
    type: 'response.output_item.done', output_index: 0, sequence_number: 5, item,
  });
  if (options.ending === 'completed') {
    writeSse(res, 'response.completed', {
      type: 'response.completed',
      response: {
        id,
        status: 'completed',
        output: [item],
        ...(options.usage ? { usage: options.usage } : {}),
      },
    });
  } else if (options.ending === 'done') {
    writeSse(res, null, '[DONE]');
  }
  res.end();
}

function writeFunctionTurn(res, item, ending) {
  const id = 'resp_' + item.call_id;
  res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
  writeSse(res, 'response.created', { type: 'response.created', response: { id, status: 'in_progress', output: [] } });
  writeSse(res, 'response.in_progress', { type: 'response.in_progress', response: { id, status: 'in_progress', output: [] } });
  writeSse(res, 'response.output_item.added', {
    type: 'response.output_item.added', output_index: 0, sequence_number: 0, item,
  });
  writeSse(res, 'response.output_item.done', {
    type: 'response.output_item.done', output_index: 0, sequence_number: 1, item,
  });
  if (ending === 'completed') {
    writeSse(res, 'response.completed', {
      type: 'response.completed', response: { id, status: 'completed', output: [item] },
    });
  } else if (ending === 'done') {
    writeSse(res, null, '[DONE]');
  }
  res.end();
}

function routeModel(body, autoRouteImage = true) {
  return withRouteConfig([
    'default_model = "text-model"',
    'image_model = "vision-model"',
    'auto_route_image = ' + autoRouteImage,
  ], ({ translateRequestBody }) => {
    translateRequestBody(body);
    return body.model;
  });
}

test('request translation converts replayed image_generation_call items for Ollama', () => {
  const { translateRequestBody } = require('../src/proxy');
  const body = {
    model: 'test-model',
    input: [{
      type: 'image_generation_call',
      status: 'completed',
      revised_prompt: 'a blue flower bot',
      saved_path: '/tmp/flower.png',
      result: 'data:image/png;base64,abcdef',
    }],
    tools: [],
  };

  translateRequestBody(body);

  assert.equal(body.input.length, 1);
  assert.equal(body.input[0].type, 'message');
  assert.equal(body.input[0].role, 'assistant');
  assert.equal(body.input[0].content[0].type, 'output_text');
  assert.match(body.input[0].content[0].text, /saved_path=\/tmp\/flower\.png/);
  assert.doesNotMatch(JSON.stringify(body), /"image_generation_call"/);
});

test('request translation exposes Codex custom tools as provider-compatible functions', () => {
  const { translateRequestBody } = require('../src/proxy');
  const body = {
    model: 'test-model',
    input: [],
    tools: [{
      type: 'custom',
      name: 'apply_patch',
      description: 'Apply a patch.',
      format: {
        type: 'grammar',
        syntax: 'lark',
        definition: 'start: "patch"',
      },
    }],
  };

  translateRequestBody(body);

  assert.equal(body.tools.some((tool) => tool && tool.type === 'custom'), false);
  assert.deepEqual(body.tools.find((tool) => tool && tool.name === 'apply_patch'), {
    type: 'function',
    name: 'apply_patch',
    description: 'Apply a patch.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Complete patch in apply_patch format, not unified diff. It must begin with "*** Begin Patch" and end with "*** End Patch". Use "*** Add File: <path>" and prefix every added content line with "+". Use "*** Delete File: <path>" to delete. Use "*** Update File: <path>" with "@@" hunks whose context, added, and removed lines start with " ", "+", and "-". It must conform to this lark grammar:\nstart: "patch"',
        },
      },
      required: ['input'],
      additionalProperties: false,
    },
  });
});

test('request translation preserves arbitrary custom-tool grammar constraints', () => {
  const { translateRequestBody } = require('../src/proxy');
  const body = {
    model: 'test-model',
    input: 'Choose a label.',
    tools: [{
      type: 'custom',
      name: 'emit_label',
      description: 'Emit one permitted label.',
      format: {
        type: 'grammar',
        syntax: 'regex',
        definition: '^(alpha|beta)$',
      },
    }],
  };

  translateRequestBody(body);

  const normalized = body.tools.find((tool) => tool && tool.name === 'emit_label');
  assert.equal(normalized.type, 'function');
  assert.deepEqual(normalized.parameters.required, ['input']);
  assert.equal(normalized.parameters.properties.input.type, 'string');
  assert.match(normalized.parameters.properties.input.description, /regex grammar/);
  assert.match(normalized.parameters.properties.input.description, /\^\(alpha\|beta\)\$/);
});

test('proxy normalizes and restores a custom tool call end to end', async () => {
  let upstreamBody = null;
  const patch = '*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch';
  await withProxy((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      upstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'resp_custom_tool',
        status: 'completed',
        output: [{
          id: 'fc_apply_patch',
          type: 'function_call',
          call_id: 'call_apply_patch',
          name: 'apply_patch',
          arguments: JSON.stringify({ input: patch }),
          status: 'completed',
        }],
      }));
    });
  }, async (proxyPort) => {
    const response = await postJson(proxyPort, {
      model: 'test-model',
      input: 'Create hello.txt.',
      tools: [{
        type: 'custom',
        name: 'apply_patch',
        description: 'Apply a patch.',
        format: {
          type: 'grammar',
          syntax: 'lark',
          definition: 'start: "patch"',
        },
      }],
      stream: false,
    });

    assert.equal(response.statusCode, 200);
    const normalized = upstreamBody.tools.find((tool) => tool && tool.name === 'apply_patch');
    assert.equal(normalized.type, 'function');
    assert.deepEqual(normalized.parameters.required, ['input']);
    assert.equal(normalized.parameters.properties.input.type, 'string');
    assert.match(normalized.parameters.properties.input.description, /lark grammar/);
    assert.match(normalized.parameters.properties.input.description, /start: "patch"/);
    assert.equal(upstreamBody.tools.some((tool) => tool && tool.type === 'custom'), false);

    const body = JSON.parse(response.body);
    assert.deepEqual(body.output[0], {
      id: 'fc_apply_patch',
      type: 'custom_tool_call',
      call_id: 'call_apply_patch',
      name: 'apply_patch',
      input: patch,
      status: 'completed',
    });
  }, [
    'enable_find_skill = false',
    'stream_proxy_loop = false',
    'imagine_enabled = false',
  ]);
});

test('proxy converts unified diff hunk coordinates in apply_patch calls', async () => {
  const unifiedPatch = [
    '*** Begin Patch',
    '*** Update File: hello.txt',
    '@@ -1,2 +1,2 @@',
    '-hello',
    '+goodbye',
    '@@ -10 +10,2 @@ function heading',
    ' context',
    '+added',
    '*** End Patch',
  ].join('\n');
  const codexPatch = [
    '*** Begin Patch',
    '*** Update File: hello.txt',
    '@@',
    '-hello',
    '+goodbye',
    '@@ function heading',
    ' context',
    '+added',
    '*** End Patch',
  ].join('\n');

  await withProxy((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'resp_unified_patch',
        status: 'completed',
        output: [{
          id: 'fc_unified_patch',
          type: 'function_call',
          call_id: 'call_unified_patch',
          name: 'apply_patch',
          arguments: JSON.stringify({ input: unifiedPatch }),
          status: 'completed',
        }],
      }));
    });
  }, async (proxyPort) => {
    const response = await postJson(proxyPort, {
      model: 'test-model',
      input: 'Update hello.txt.',
      tools: [{
        type: 'custom',
        name: 'apply_patch',
        description: 'Apply a patch.',
        format: { type: 'text' },
      }],
      stream: false,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.output[0].type, 'custom_tool_call');
    assert.equal(body.output[0].input, codexPatch);
  }, [
    'enable_find_skill = false',
    'stream_proxy_loop = false',
    'imagine_enabled = false',
  ]);
});

test('proxy restores turn-local additional custom tools as custom tool calls', async () => {
  await withProxy((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'resp_turn_local_custom',
        status: 'completed',
        output: [{
          type: 'function_call',
          call_id: 'call_turn_local_patch',
          name: 'apply_patch',
          arguments: JSON.stringify({ input: '*** Begin Patch\n*** End Patch' }),
          status: 'completed',
        }],
      }));
    });
  }, async (proxyPort) => {
    const response = await postJson(proxyPort, {
      model: 'test-model',
      input: [{
        type: 'additional_tools',
        role: 'developer',
        tools: [{
          type: 'custom',
          name: 'apply_patch',
          description: 'Apply a patch.',
          format: { type: 'text' },
        }],
      }],
      tools: [],
      stream: false,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.output[0].type, 'custom_tool_call');
    assert.equal(body.output[0].name, 'apply_patch');
    assert.equal(body.output[0].input, '*** Begin Patch\n*** End Patch');
    assert.equal(Object.hasOwn(body.output[0], 'arguments'), false);
  }, [
    'enable_find_skill = false',
    'stream_proxy_loop = false',
    'imagine_enabled = false',
  ]);
});

test('request translation preserves every custom tool format in its function parameter', () => {
  const { translateRequestBody } = require('../src/proxy');
  const body = {
    model: 'test-model',
    input: 'Use a custom tool.',
    tools: [
      {
        type: 'custom',
        name: 'regex_writer',
        description: 'Write a constrained identifier.',
        format: {
          type: 'grammar',
          syntax: 'regex',
          definition: '[A-Z]{3}-[0-9]{4}',
        },
      },
      {
        type: 'custom',
        name: 'freeform_writer',
        description: 'Write arbitrary text.',
        format: { type: 'text' },
      },
    ],
  };

  translateRequestBody(body);

  const regexTool = body.tools.find((tool) => tool.name === 'regex_writer');
  const textTool = body.tools.find((tool) => tool.name === 'freeform_writer');
  assert.equal(
    regexTool.parameters.properties.input.description,
    'Raw input for the custom tool. It must conform to this regex grammar:\n[A-Z]{3}-[0-9]{4}'
  );
  assert.equal(
    textTool.parameters.properties.input.description,
    'Raw unconstrained text input for the custom tool.'
  );
});

test('xAI fixed-reasoning models omit unsupported reasoning effort but preserve summary', () => {
  withRouteConfig([
    'upstream_url = "https://api.x.ai/v1"',
    'default_model = "grok-4.20-0309-reasoning"',
  ], ({ translateRequestBody }) => {
    const body = {
      model: 'grok-4.20-0309-reasoning',
      input: 'hello',
      reasoning: {
        effort: 'none',
        summary: 'auto',
      },
      tools: [],
    };

    translateRequestBody(body);

    assert.deepEqual(body.reasoning, { summary: 'auto' });
  });
});

test('xAI Grok Build omits unsupported reasoning effort', () => {
  withRouteConfig([
    'upstream_url = "https://api.x.ai/v1"',
    'default_model = "grok-build-0.1"',
  ], ({ translateRequestBody }) => {
    const body = {
      model: 'grok-build-0.1',
      input: 'hello',
      reasoning: { effort: 'high', summary: 'auto' },
      tools: [],
    };

    translateRequestBody(body);

    assert.deepEqual(body.reasoning, { summary: 'auto' });
  });
});

test('xAI request translation removes null fields from replayed reasoning items', () => {
  withRouteConfig([
    'upstream_url = "https://api.x.ai/v1"',
    'default_model = "grok-4.3"',
  ], ({ translateRequestBody }) => {
    const body = {
      model: 'grok-4.3',
      input: [{
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'Used the requested tool.' }],
        content: null,
        encrypted_content: null,
      }],
      tools: [],
    };

    translateRequestBody(body);

    assert.deepEqual(body.input[0], {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Used the requested tool.' }],
    });
  });
});

test('OpenAI request translation removes stale reasoning after switching to a non-reasoning model', () => {
  withRouteConfig([
    'upstream_url = "https://api.openai.com/v1"',
    'default_model = "gpt-4.1-mini"',
  ], ({ translateRequestBody }) => {
    const body = {
      model: 'gpt-4.1-mini',
      input: 'hello',
      reasoning: {
        effort: 'none',
        summary: 'auto',
      },
      tools: [],
    };

    translateRequestBody(body);

    assert.equal(body.reasoning, undefined);
  }, ({ codexHome }) => writeReasoningCatalog(codexHome, [{
    slug: 'gpt-4.1-mini',
    supported_reasoning_levels: [],
    default_reasoning_level: null,
  }]));
});

test('OpenAI request translation replaces a stale effort with the selected model default', () => {
  withRouteConfig([
    'upstream_url = "https://api.openai.com/v1"',
    'default_model = "o3"',
  ], ({ translateRequestBody }) => {
    const body = {
      model: 'o3',
      input: 'hello',
      reasoning: {
        effort: 'none',
        summary: 'auto',
      },
      tools: [],
    };

    translateRequestBody(body);

    assert.deepEqual(body.reasoning, {
      effort: 'medium',
      summary: 'auto',
    });
  }, ({ codexHome }) => writeReasoningCatalog(codexHome, [{
    slug: 'o3',
    supported_reasoning_levels: [
      { effort: 'low' },
      { effort: 'medium' },
      { effort: 'high' },
    ],
    default_reasoning_level: 'medium',
  }]));
});

test('request translation exposes deferred tool_search namespace tools as callable functions', () => {
  const { translateRequestBody } = require('../src/proxy');
  const body = {
    model: 'test-model',
    input: [{
      type: 'tool_search_output',
      call_id: 'call_search',
      status: 'completed',
      execution: 'client',
      tools: [{
        type: 'namespace',
        name: 'mcp__storefront_builder',
        description: 'Storefront Builder tools',
        tools: [{
          type: 'function',
          name: 'list_storefront_build_sessions',
          description: 'List sessions',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        }],
      }],
    }],
    tools: [],
  };

  translateRequestBody(body);

  assert.ok(
    body.tools.some((tool) =>
      tool.type === 'function' &&
      tool.name === 'mcp__storefront_builder__list_storefront_build_sessions'
    ),
    'expected deferred namespace tool to be added to top-level tools'
  );
  assert.equal(body.input[0].type, 'function_call_output');
  assert.match(body.input[0].output, /mcp__storefront_builder__list_storefront_build_sessions/);
});

test('request translation converts native tool_search to callable function tool', () => {
  const { translateRequestBody } = require('../src/proxy');
  const body = {
    model: 'test-model',
    input: 'find the storefront builder tools',
    tools: [{
      type: 'tool_search',
      execution: 'client',
      description: 'Search deferred tool metadata',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    }],
  };

  translateRequestBody(body);

  assert.ok(
    body.tools.some((tool) =>
      tool.type === 'function' &&
      tool.name === 'tool_search' &&
      tool.parameters &&
      tool.parameters.properties &&
      tool.parameters.properties.query
    ),
    'expected native tool_search to be exposed as a function tool'
  );
  assert.equal(body.tools.some((tool) => tool.type === 'tool_search'), false);
});

test('request translation injects tool_search when Codex omits it', () => {
  const { translateRequestBody } = require('../src/proxy');
  const body = {
    model: 'test-model',
    input: 'list available tools',
    tools: [],
  };

  translateRequestBody(body);

  assert.ok(
    body.tools.some((tool) => tool.type === 'function' && tool.name === 'tool_search'),
    'expected tool_search to be injected as a function tool'
  );
});

function duplicateDeveloperBody(repeated) {
  return {
    model: 'test-model',
    input: [
      { type: 'message', id: 'd1', role: 'developer', content: [{ type: 'input_text', text: repeated }] },
      { type: 'message', id: 'd2', role: 'developer', content: [{ type: 'input_text', text: repeated }] },
    ],
    tools: [],
  };
}

function countRepeatedBlocks(body, repeated) {
  let n = 0;
  for (const item of body.input || []) {
    if (Array.isArray(item && item.content)) {
      for (const block of item.content) if (block && block.text === repeated) n += 1;
    }
  }
  return n;
}

test('translateRequestBody does not dedupe large developer blocks by default (protects provider caching)', () => {
  const repeated = '<skills_instructions>' + 'x'.repeat(600) + '</skills_instructions>';
  const retained = withRouteConfig(['default_model = "test-model"'], ({ translateRequestBody }) => {
    const body = duplicateDeveloperBody(repeated);
    translateRequestBody(body);
    return countRepeatedBlocks(body, repeated);
  });
  assert.equal(retained, 2, 'both copies retained when dedupe_large_input is not enabled');
});

test('translateRequestBody dedupes large developer blocks when enabled via route config', () => {
  const repeated = '<skills_instructions>' + 'x'.repeat(600) + '</skills_instructions>';
  const retained = withRouteConfig(['default_model = "test-model"', 'dedupe_large_input = true'], ({ translateRequestBody }) => {
    const body = duplicateDeveloperBody(repeated);
    translateRequestBody(body);
    return countRepeatedBlocks(body, repeated);
  });
  assert.equal(retained, 1, 'newest copy retained when dedupe_large_input = true');
});

test('PROXY_DEDUPE_LARGE_INPUT=1 opts in to large-input dedupe at proxy start (CLI flag path)', () => {
  const repeated = '<skills_instructions>' + 'x'.repeat(600) + '</skills_instructions>';
  const previous = process.env.PROXY_DEDUPE_LARGE_INPUT;
  process.env.PROXY_DEDUPE_LARGE_INPUT = '1';
  try {
    const retained = withRouteConfig(['default_model = "test-model"'], ({ translateRequestBody }) => {
      const body = duplicateDeveloperBody(repeated);
      translateRequestBody(body);
      return countRepeatedBlocks(body, repeated);
    });
    assert.equal(retained, 1, 'env opt-in enables dedupe even without a toml key');
  } finally {
    if (previous === undefined) delete process.env.PROXY_DEDUPE_LARGE_INPUT;
    else process.env.PROXY_DEDUPE_LARGE_INPUT = previous;
  }
});

test('request translation removes duplicate function definitions', () => {
  const { translateRequestBody } = require('../src/proxy');
  const duplicate = {
    type: 'function',
    name: 'duplicate_tool',
    parameters: { type: 'object', properties: {} },
  };
  const body = {
    model: 'test-model',
    input: 'use a tool',
    tools: [duplicate, JSON.parse(JSON.stringify(duplicate))],
  };

  translateRequestBody(body);

  assert.equal(body.tools.filter((tool) => tool.name === 'duplicate_tool').length, 1);
});

test('turn-local additional_tools override stale same-name top-level schemas', () => {
  const { translateRequestBody } = require('../src/proxy');
  const stale = {
    type: 'function',
    name: 'changing_tool',
    description: 'stale definition',
    parameters: { type: 'object', properties: { oldArgument: { type: 'string' } } },
  };
  const current = {
    type: 'function',
    name: 'changing_tool',
    description: 'current turn definition',
    parameters: { type: 'object', properties: { currentArgument: { type: 'number' } } },
  };
  const body = {
    model: 'test-model',
    input: [{ type: 'additional_tools', role: 'developer', tools: [current] }],
    tools: [stale],
  };

  translateRequestBody(body);

  const definitions = body.tools.filter((tool) => tool.name === 'changing_tool');
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].description, 'current turn definition');
  assert.deepEqual(definitions[0].parameters, current.parameters);
});

test('image auto-routing sends a current user attachment to the vision model', () => {
  const model = routeModel({
    model: 'text-model',
    input: [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Describe this image.' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      ],
    }],
    tools: [],
  });

  assert.equal(model, 'vision-model');
});

test('image auto-routing sends a current Computer Use screenshot to the vision model', () => {
  const model = routeModel({
    model: 'text-model',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'What is visible in the current window?' }],
      },
      { type: 'function_call', name: 'ComputerUse', call_id: 'call_computer', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'call_computer',
        output: [{ type: 'input_image', file_id: 'file_screenshot' }],
      },
    ],
    tools: [],
  });

  assert.equal(model, 'vision-model');
});

test('image auto-routing ignores historical screenshots and preserves the incoming model', () => {
  const model = routeModel({
    model: 'vision-model',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Describe this screenshot.' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'It shows the settings window.' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Now explain the keyboard shortcut.' }],
      },
    ],
    tools: [],
  });

  assert.equal(model, 'vision-model');
});

test('disabled image auto-routing preserves the selected model', () => {
  const model = routeModel({
    model: 'manually-selected-model',
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }],
    }],
    tools: [],
  }, false);

  assert.equal(model, 'manually-selected-model');
});

test('inline image parsing validates signatures and enforces the decoded byte limit', () => {
  const { parseInlineImage } = require('../src/inline-image-cache');

  for (const mimeType of Object.keys(IMAGE_SIGNATURES)) {
    const parsed = parseInlineImage({ type: 'input_image', image_url: inlineImageUrl(mimeType, 'valid') });
    assert.ok(parsed, mimeType);
    assert.equal(parsed.mimeType, mimeType);
    assert.deepEqual(parsed.bytes, inlineImageBytes(mimeType, 'valid'));
  }

  const mismatched = {
    type: 'input_image',
    image_url: `data:image/png;base64,${inlineImageBytes('image/jpeg').toString('base64')}`,
  };
  assert.equal(parseInlineImage(mismatched), null);
  assert.equal(parseInlineImage({ type: 'input_image', image_url: 'data:image/png;base64,%%%%' }), null);
  assert.equal(parseInlineImage({ type: 'input_image', image_url: inlineImageUrl('image/png').replace('image/png', 'image/bmp') }), null);

  const oversized = {
    type: 'input_image',
    image_url: inlineImageUrl('image/png', 'x'),
  };
  assert.equal(parseInlineImage(oversized, { maxBytes: IMAGE_SIGNATURES['image/png'].length }), null);
  assert.equal(parseInlineImage({ type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(16) }, { maxBytes: 8 }), null);
});

test('inline image session identity prefers an explicit conversation over prompt cache bucketing', () => {
  const { stableSessionSeed } = require('../src/inline-image-cache');
  assert.equal(stableSessionSeed({
    prompt_cache_key: 'shared-cache-bucket',
    conversation: { id: 'conversation-123' },
  }), 'conversation:conversation-123');
});

test('inline image persistence leaves remote-upstream requests and storage unchanged', () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-inline-cache-test-'));
  const imageUrl = inlineImageUrl('image/png', 'remote');
  const body = {
    prompt_cache_key: 'remote-upstream-test',
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: imageUrl }],
    }],
  };

  try {
    const { rewriteInlineImages } = require('../src/inline-image-cache');
    rewriteInlineImages(body, {
      cacheRoot,
      upstream: { baseUrl: new URL('https://api.example.com/v1') },
      imageModelTurn: false,
      retentionDays: 30,
    });
    assert.equal(body.input[0].content[0].image_url, imageUrl);
    assert.deepEqual(fs.readdirSync(cacheRoot), []);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('inline image persistence recognizes only loopback upstream hosts', () => {
  const { isLoopbackUpstream } = require('../src/inline-image-cache');
  assert.equal(isLoopbackUpstream({ baseUrl: new URL('http://127.0.0.1:11434/v1') }), true);
  assert.equal(isLoopbackUpstream({ baseUrl: new URL('http://127.22.33.44:11434/v1') }), true);
  assert.equal(isLoopbackUpstream({ baseUrl: new URL('http://localhost:11434/v1') }), true);
  assert.equal(isLoopbackUpstream({ baseUrl: new URL('http://[::1]:11434/v1') }), true);
  assert.equal(isLoopbackUpstream({ baseUrl: new URL('https://api.example.com/v1') }), false);
  assert.equal(isLoopbackUpstream(null), false);
});

test('HTTP persistence stays in the proxy-owned cache and preserves active image pixels', async () => {
  const received = [];
  await withProxy((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'resp_inline_e2e', output: [], status: 'completed' }));
    });
  }, async (proxyPort, _proxy, codexHome) => {
    const unrelatedDir = path.join(codexHome, 'attachments', 'unrelated-codex-attachment');
    fs.mkdirSync(unrelatedDir, { recursive: true });
    fs.writeFileSync(path.join(unrelatedDir, 'pasted-text.txt'), 'keep');
    const expiredAt = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    fs.utimesSync(unrelatedDir, expiredAt, expiredAt);

    const historicalUrl = inlineImageUrl('image/png', 'historical-http');
    const activeUrl = inlineImageUrl('image/jpeg', 'active-http');
    const requestBody = () => ({
      model: 'text-model',
      prompt_cache_key: 'inline-http-e2e',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: historicalUrl }] },
        { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: { url: activeUrl } }] },
      ],
      tools: [],
      stream: false,
    });
    const response = await postJson(proxyPort, requestBody());
    const replay = await postJson(proxyPort, requestBody());

    assert.equal(response.statusCode, 200);
    assert.equal(replay.statusCode, 200);
    assert.equal(received.length, 2);
    assert.equal(received[0].model, 'vision-model');
    assert.equal(received[0].input[0].content[0].type, 'input_text');
    assert.equal(received[0].input[1].content[0].image_url.url, activeUrl);
    const historicalPath = received[0].input[0].content[0].text.match(/^\[image saved: (.+)]$/)[1];
    const replayPath = received[1].input[0].content[0].text.match(/^\[image saved: (.+)]$/)[1];
    assert.equal(replayPath, historicalPath);
    assert.equal(path.dirname(path.dirname(historicalPath)), path.join(codexHome, 'attachments', 'codex-universal-proxy-inline-images'));
    assert.equal(fs.existsSync(path.join(unrelatedDir, 'pasted-text.txt')), true);
  }, [
    'default_model = "text-model"',
    'image_model = "vision-model"',
    'auto_route_image = true',
    'persist_inline_images = true',
    'inline_image_retention_days = 30',
  ]);
});

test('inline image persistence deduplicates historical images and preserves the incoming model on text turns', () => {
  withRouteConfig([
    'default_model = "text-model"',
    'image_model = "vision-model"',
    'auto_route_image = true',
    'persist_inline_images = true',
  ], ({ translateRequestBody }) => {
    const imageUrl = inlineImageUrl('image/png', 'cached-image');
    const makeBody = () => ({
      model: 'vision-model',
      prompt_cache_key: 'thread-deduplication-test',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Describe this image.' },
            { type: 'input_image', image_url: imageUrl },
          ],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Now answer a text-only question.' }],
        },
      ],
      tools: [],
    });

    const first = makeBody();
    translateRequestBody(first);
    assert.equal(first.model, 'vision-model');
    assert.equal(first.input[0].content[1].type, 'input_text');
    const firstPath = first.input[0].content[1].text.match(/^\[image saved: (.+)]$/)[1];
    assert.deepEqual(fs.readFileSync(firstPath), inlineImageBytes('image/png', 'cached-image'));

    translateRequestBody(first);
    assert.equal(first.input[0].content[1].text, '[image saved: ' + firstPath + ']');

    const replay = makeBody();
    translateRequestBody(replay);
    const replayPath = replay.input[0].content[1].text.match(/^\[image saved: (.+)]$/)[1];
    assert.equal(replayPath, firstPath);
    assert.equal(fs.readdirSync(path.dirname(firstPath)).length, 1);
  });
});

test('dual-modal image generation turns rehydrate the complete cached image chain without auto-routing', () => {
  let cachedPaths;
  withRouteConfig([
    'default_model = "dual-image-model"',
    'image_model = "dual-image-model"',
    'auto_route_image = false',
    'persist_inline_images = true',
  ], ({ translateRequestBody }) => {
    const body = {
      model: 'dual-image-model',
      prompt_cache_key: 'generated-image-chain-proxy-test',
      modalities: ['image', 'text'],
      input: [
        {
          type: 'image_generation_call',
          id: 'image-one',
          result: 'https://expired.example/one.png',
          saved_path: cachedPaths[0],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Make it warmer.' }],
        },
        {
          type: 'image_generation_call',
          id: 'image-two',
          result: 'https://expired.example/two.png',
          saved_path: cachedPaths[1],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Now change the background.' }],
        },
      ],
      tools: [],
    };

    translateRequestBody(body);

    const latestContent = body.input.at(-1).content;
    assert.equal(latestContent[0].text, 'Now change the background.');
    assert.deepEqual(
      latestContent.slice(1).map((part) => part.type),
      ['input_image', 'input_image'],
    );
    assert.deepEqual(
      latestContent.slice(1).map((part) => part.image_url),
      [inlineImageUrl('image/png', 'one'), inlineImageUrl('image/png', 'two')],
    );
  }, ({ codexHome }) => {
    fs.writeFileSync(path.join(codexHome, 'codex-universal-models.json'), JSON.stringify({
      models: [{
        slug: 'dual-image-model',
        input_modalities: ['text', 'image'],
        output_modalities: ['text', 'image'],
      }],
    }));
    const cacheDir = path.join(
      codexHome,
      'attachments',
      'codex-universal-proxy-inline-images',
      'generated-image-chain-proxy-test',
    );
    fs.mkdirSync(cacheDir, { recursive: true });
    cachedPaths = [
      path.join(cacheDir, 'one.png'),
      path.join(cacheDir, 'two.png'),
    ];
    fs.writeFileSync(cachedPaths[0], inlineImageBytes('image/png', 'one'));
    fs.writeFileSync(cachedPaths[1], inlineImageBytes('image/png', 'two'));
  });
});

test('inline image persistence repairs a corrupt existing hash file', () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-inline-cache-test-'));
  const makeBody = () => ({
    prompt_cache_key: 'corrupt-image-file-test',
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: inlineImageUrl('image/png', 'repair-me') }],
    }],
  });

  try {
    const { rewriteInlineImages } = require('../src/inline-image-cache');
    const first = makeBody();
    rewriteInlineImages(first, {
      cacheRoot,
      upstream: LOCAL_UPSTREAM,
      imageModelTurn: false,
      retentionDays: 30,
    });
    const imagePath = first.input[0].content[0].text.match(/^\[image saved: (.+)]$/)[1];
    fs.writeFileSync(imagePath, 'corrupt');

    const replay = makeBody();
    rewriteInlineImages(replay, {
      cacheRoot,
      upstream: LOCAL_UPSTREAM,
      imageModelTurn: false,
      retentionDays: 30,
    });

    assert.deepEqual(fs.readFileSync(imagePath), inlineImageBytes('image/png', 'repair-me'));
    assertPrivateFileMode(imagePath);
    assertPrivateDirectoryMode(path.dirname(imagePath));
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('inline image persistence keeps active image-turn pixels and dereferences history', () => {
  withRouteConfig([
    'default_model = "text-model"',
    'image_model = "vision-model"',
    'auto_route_image = true',
    'persist_inline_images = true',
  ], ({ translateRequestBody }) => {
    const historicalUrl = inlineImageUrl('image/png', 'historical-image');
    const activeUrl = inlineImageUrl('image/jpeg', 'active-image');
    const body = {
      model: 'text-model',
      prompt_cache_key: 'thread-active-image-test',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: historicalUrl }],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: { url: activeUrl } }],
        },
      ],
      tools: [],
    };

    translateRequestBody(body);
    assert.equal(body.model, 'vision-model');
    assert.equal(body.input[0].content[0].type, 'input_text');
    assert.equal(body.input[1].content[0].image_url.url, activeUrl);

    const historicalPath = body.input[0].content[0].text.match(/^\[image saved: (.+)]$/)[1];
    const cachedFiles = fs.readdirSync(path.dirname(historicalPath));
    assert.equal(cachedFiles.length, 2);
    assert.ok(cachedFiles.some((name) => name.endsWith('.png')));
    assert.ok(cachedFiles.some((name) => name.endsWith('.jpg')));
  });
});

test('inline image persistence is bypassed when image auto-routing is disabled', () => {
  withRouteConfig([
    'default_model = "text-model"',
    'image_model = "vision-model"',
    'auto_route_image = false',
    'persist_inline_images = true',
  ], ({ translateRequestBody }) => {
    const imageUrl = inlineImageUrl('image/png', 'historical-image');
    const body = {
      model: 'vision-model',
      prompt_cache_key: 'manual-vision-text-turn',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: imageUrl }],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Text-only follow-up.' }],
        },
      ],
      tools: [],
    };

    translateRequestBody(body);

    assert.equal(body.model, 'vision-model');
    assert.equal(body.input[0].content[0].type, 'input_image');
    assert.equal(body.input[0].content[0].image_url, imageUrl);
  });
});

test('inline image persistence requires a stable session identifier', () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-inline-cache-test-'));
  const imageUrl = inlineImageUrl('image/png', 'unscoped-image');
  const body = {
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: imageUrl }],
    }],
  };

  try {
    const { rewriteInlineImages } = require('../src/inline-image-cache');
    rewriteInlineImages(body, { cacheRoot, upstream: LOCAL_UPSTREAM, imageModelTurn: false, retentionDays: 30 });
    assert.equal(body.input[0].content[0].image_url, imageUrl);
    assert.deepEqual(fs.readdirSync(cacheRoot), []);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('inline image persistence isolates identical content by stable session identifier', () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-inline-cache-test-'));
  const imageUrl = inlineImageUrl('image/png', 'shared-image');
  const makeBody = (promptCacheKey) => ({
    prompt_cache_key: promptCacheKey,
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: imageUrl }],
    }],
  });

  try {
    const { rewriteInlineImages } = require('../src/inline-image-cache');
    const first = makeBody('thread-one');
    const second = makeBody('thread-two');
    rewriteInlineImages(first, { cacheRoot, upstream: LOCAL_UPSTREAM, imageModelTurn: false, retentionDays: 30 });
    rewriteInlineImages(second, { cacheRoot, upstream: LOCAL_UPSTREAM, imageModelTurn: false, retentionDays: 30 });
    const firstPath = first.input[0].content[0].text.match(/^\[image saved: (.+)]$/)[1];
    const secondPath = second.input[0].content[0].text.match(/^\[image saved: (.+)]$/)[1];
    assert.notEqual(path.dirname(firstPath), path.dirname(secondPath));
    assert.deepEqual(fs.readFileSync(firstPath), inlineImageBytes('image/png', 'shared-image'));
    assert.deepEqual(fs.readFileSync(secondPath), inlineImageBytes('image/png', 'shared-image'));
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('inline image persistence removes expired inactive session caches', () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-inline-cache-test-'));
  const expiredDir = path.join(cacheRoot, 'expired-session');
  const now = Date.UTC(2026, 6, 20);
  const expiredAt = new Date(now - 31 * 24 * 60 * 60 * 1000);
  fs.mkdirSync(expiredDir);
  fs.writeFileSync(path.join(expiredDir, 'old.png'), 'old-image');
  fs.utimesSync(expiredDir, expiredAt, expiredAt);
  const body = {
    prompt_cache_key: 'active-thread',
    input: [{
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_image',
        image_url: inlineImageUrl('image/png', 'current-image'),
      }],
    }],
  };

  try {
    const { rewriteInlineImages } = require('../src/inline-image-cache');
    rewriteInlineImages(body, {
      cacheRoot,
      upstream: LOCAL_UPSTREAM,
      imageModelTurn: false,
      retentionDays: 30,
      cleanupIntervalMs: 0,
      now,
    });
    assert.equal(fs.existsSync(expiredDir), false);
    assert.match(body.input[0].content[0].text, /^\[image saved: .+]$/);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('historical inline images remain unchanged without a stable session and preserve the incoming model', () => {
  const imageUrl = inlineImageUrl('image/png', 'not-cached');
  const body = {
    model: 'vision-model',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: imageUrl }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Text follow-up.' }],
      },
    ],
    tools: [],
  };

  assert.equal(routeModel(body), 'vision-model');
  assert.equal(body.input[0].content[0].image_url, imageUrl);
});

test('proxy forwards responses requests to configured upstream URL with bearer auth', async () => {
  const received = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'resp_test', output: [], status: 'completed' }));
    });
  });
  const upstreamPort = await listen(upstream);
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proxy-test-'));
  fs.mkdirSync(path.join(codexHome, 'codex-universal-proxy'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'codex-universal-proxy', 'proxy-models.toml'), [
    'default_model = "test-model"',
    `upstream_url = "http://127.0.0.1:${upstreamPort}/custom"`,
    'upstream_api_key = "secret-token"',
    '',
  ].join('\n'));

  const previousCodexHome = process.env.CODEX_HOME;
  const previousProxyPort = process.env.PROXY_PORT;
  process.env.CODEX_HOME = codexHome;
  process.env.PROXY_PORT = '0';
  delete require.cache[require.resolve('../src/proxy')];
  const proxy = require('../src/proxy');
  const server = proxy.startServer(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const proxyPort = server.address().port;

  try {
    const response = await postJson(proxyPort, {
      model: 'test-model',
      input: 'hello',
      tools: [],
      stream: false,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].url, '/custom/responses');
    assert.equal(received[0].authorization, 'Bearer secret-token');
    assert.equal(received[0].body.model, 'test-model');
    assert.equal(received[0].body._originalModel, undefined);
  } finally {
    await close(server);
    await close(upstream);
    delete require.cache[require.resolve('../src/proxy')];
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousProxyPort === undefined) delete process.env.PROXY_PORT;
    else process.env.PROXY_PORT = previousProxyPort;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('proxy decodes compressed responses request bodies before translating and forwarding them', async () => {
  const received = [];
  await withProxy((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      try {
        received.push({
          contentEncoding: req.headers['content-encoding'],
          contentLength: req.headers['content-length'],
          raw,
          body: JSON.parse(raw.toString('utf8')),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'resp_test', output: [], status: 'completed' }));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream received a non-JSON body' }));
      }
    });
  }, async (proxyPort) => {
    const body = {
      model: 'test-model',
      input: 'compressed request',
      tools: [],
      stream: false,
    };
    const json = Buffer.from(JSON.stringify(body));
    const encodings = [
      ['zstd', zlib.zstdCompressSync],
      ['gzip', zlib.gzipSync],
      ['deflate', zlib.deflateSync],
      ['br', zlib.brotliCompressSync],
    ];

    for (const [contentEncoding, compress] of encodings) {
      const response = await postBuffer(proxyPort, compress(json), {
        'content-type': 'application/json',
        'content-encoding': contentEncoding,
      });
      assert.equal(response.statusCode, 200, contentEncoding);
    }

    assert.equal(received.length, encodings.length);
    for (const request of received) {
      assert.equal(request.contentEncoding, undefined);
      assert.equal(request.contentLength, String(request.raw.length));
      assert.equal(request.body.model, 'test-model');
      assert.equal(request.body.input, 'compressed request');
    }
  });
});

test('proxy rejects malformed compressed responses request bodies without contacting upstream', async () => {
  let upstreamRequests = 0;
  await withProxy((_req, res) => {
    upstreamRequests += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'unexpected', output: [], status: 'completed' }));
  }, async (proxyPort) => {
    const response = await postBuffer(proxyPort, Buffer.from('not gzip data'), {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.body, /invalid gzip request body/i);
    assert.equal(upstreamRequests, 0);
  });
});

test('proxy rejects unsupported request content encodings without contacting upstream', async () => {
  let upstreamRequests = 0;
  await withProxy((_req, res) => {
    upstreamRequests += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'unexpected', output: [], status: 'completed' }));
  }, async (proxyPort) => {
    const response = await postBuffer(proxyPort, Buffer.from('encoded elsewhere'), {
      'content-type': 'application/json',
      'content-encoding': 'compress',
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.body, /unsupported content-encoding/i);
    assert.equal(upstreamRequests, 0);
  });
});

test('proxy caches non-streaming native image results and returns their saved path', async () => {
  const imageUrl = inlineImageUrl('image/png', 'provider-generated');
  await withProxy((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'resp_generated_image',
      status: 'completed',
      output: [{
        id: 'ig_generated',
        type: 'image_generation_call',
        status: 'completed',
        result: imageUrl,
      }],
    }));
  }, async (proxyPort, proxy, codexHome) => {
    const response = await postJson(proxyPort, {
      model: 'test-model',
      input: 'draw a circle',
      prompt_cache_key: 'generated-image-proxy-test',
      modalities: ['image', 'text'],
      tools: [],
      stream: false,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    const savedPath = body.output[0].saved_path;
    assert.ok(savedPath.startsWith(path.join(codexHome, 'attachments', 'codex-universal-proxy-inline-images') + path.sep));
    assert.deepEqual(fs.readFileSync(savedPath), inlineImageBytes('image/png', 'provider-generated'));
    assert.equal(body.output[1].type, 'message');
    assert.equal(body.output[1].role, 'assistant');
    assert.equal(body.output[1].content[0].text, `![Generated image](<${savedPath}>)`);
  }, [
    'auto_route_image = false',
    'persist_inline_images = true',
    'stream_proxy_loop = false',
    'imagine_enabled = false',
  ]);
});

test('proxy caches streamed native image results before the terminal response', async () => {
  const imageUrl = inlineImageUrl('image/png', 'streamed-provider-generated');
  await withProxy((req, res) => {
    req.resume();
    const item = {
      id: 'ig_streamed_generated',
      type: 'image_generation_call',
      status: 'completed',
      result: imageUrl,
    };
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
    writeSse(res, 'response.created', {
      type: 'response.created',
      response: { id: 'resp_streamed_generated', status: 'in_progress', output: [] },
    });
    writeSse(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      sequence_number: 0,
      item: { id: item.id, type: item.type, status: 'in_progress' },
    });
    writeSse(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      sequence_number: 1,
      item,
    });
    writeSse(res, 'response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp_streamed_generated',
        status: 'completed',
        output: [item],
      },
    });
    res.end();
  }, async (proxyPort, proxy, codexHome) => {
    const response = await postStream(proxyPort, {
      model: 'test-model',
      input: 'draw a square',
      prompt_cache_key: 'streamed-generated-image-proxy-test',
      modalities: ['image', 'text'],
      tools: [],
      stream: true,
    });

    assert.equal(response.statusCode, 200);
    const events = parseSse(response.body);
    assertSuccessfulTerminal(events);
    const savedPath = events.at(-1).data.response.output[0].saved_path;
    assert.ok(savedPath.startsWith(path.join(codexHome, 'attachments', 'codex-universal-proxy-inline-images') + path.sep));
    assert.deepEqual(fs.readFileSync(savedPath), inlineImageBytes('image/png', 'streamed-provider-generated'));
    const visibleMessage = events
      .filter((event) => event.event === 'response.output_item.done')
      .map((event) => event.data.item)
      .find((item) => item && item.type === 'message');
    assert.equal(visibleMessage.role, 'assistant');
    assert.equal(visibleMessage.content[0].text, `![Generated image](<${savedPath}>)`);
    assert.deepEqual(events.at(-1).data.response.output, [
      events.at(-1).data.response.output[0],
      visibleMessage,
    ]);
  }, [
    'auto_route_image = false',
    'persist_inline_images = true',
    'stream_proxy_loop = false',
    'imagine_enabled = false',
  ]);
});

test('proxy preserves thought signatures when restoring namespaced function calls', async () => {
  await withProxy((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'resp_signature',
      status: 'completed',
      output: [{
        id: 'fc_signature',
        type: 'function_call',
        call_id: 'call_signature',
        name: 'mcp__example__lookup',
        arguments: '{"q":"test"}',
        thought_signature: 'opaque-signature',
        status: 'completed',
      }],
    }));
  }, async (proxyPort) => {
    const response = await postJson(proxyPort, {
      model: 'test-model',
      input: 'look it up',
      tools: [{
        type: 'namespace',
        name: 'mcp__example',
        tools: [{
          type: 'function',
          name: 'lookup',
          parameters: {
            type: 'object',
            properties: { q: { type: 'string' } },
          },
        }],
      }],
      stream: false,
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.output[0].namespace, 'mcp__example');
    assert.equal(body.output[0].name, 'lookup');
    assert.equal(body.output[0].thought_signature, 'opaque-signature');
  }, [
    'enable_find_skill = false',
    'stream_proxy_loop = false',
  ]);
});

test('streaming SSE preserves ordering and translates tool_search_call', async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
    res.write('event: response.created\n');
    res.write('data: ' + JSON.stringify({ type: 'response.created', response: { id: 'resp_sse' } }) + '\n\n');
    res.write('event: response.output_item.added\n');
    res.write('data: ' + JSON.stringify({
      type: 'response.output_item.added',
      output_index: 0,
      sequence_number: 0,
      item: {
        type: 'function_call',
        id: 'item_search',
        call_id: 'call_search',
        name: 'tool_search',
        arguments: '{"query":"node_repl"}',
        status: 'completed',
      },
    }) + '\n\n');
    res.write('event: response.output_item.done\n');
    res.write('data: ' + JSON.stringify({
      type: 'response.output_item.done',
      output_index: 0,
      sequence_number: 1,
      item: {
        type: 'function_call',
        id: 'item_search',
        call_id: 'call_search',
        name: 'tool_search',
        arguments: '{"query":"node_repl"}',
        status: 'completed',
      },
    }) + '\n\n');
    res.write('event: response.completed\n');
    res.write('data: ' + JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_sse',
        output: [{
          type: 'function_call',
          id: 'item_search',
          call_id: 'call_search',
          name: 'tool_search',
          arguments: '{"query":"node_repl"}',
          status: 'completed',
        }],
      },
    }) + '\n\n');
    res.end();
  });
  const upstreamPort = await listen(upstream);
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proxy-test-'));
  fs.mkdirSync(path.join(codexHome, 'codex-universal-proxy'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'codex-universal-proxy', 'proxy-models.toml'), [
    'default_model = "test-model"',
    `upstream_url = "http://127.0.0.1:${upstreamPort}/custom"`,
    '',
  ].join('\n'));

  const previousCodexHome = process.env.CODEX_HOME;
  const previousProxyPort = process.env.PROXY_PORT;
  process.env.CODEX_HOME = codexHome;
  process.env.PROXY_PORT = '0';
  delete require.cache[require.resolve('../src/proxy')];
  const proxy = require('../src/proxy');
  const server = proxy.startServer(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const proxyPort = server.address().port;

  try {
    const response = await postStream(proxyPort, {
      model: 'test-model',
      input: 'search tools',
      tools: [],
      stream: true,
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.indexOf('event: response.output_item.added') < response.body.indexOf('event: response.output_item.done'));
    assert.ok(response.body.indexOf('event: response.output_item.done') < response.body.indexOf('event: response.completed'));
    assert.match(response.body, /"type":"tool_search_call"/);
  } finally {
    await close(server);
    await close(upstream);
    delete require.cache[require.resolve('../src/proxy')];
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousProxyPort === undefined) delete process.env.PROXY_PORT;
    else process.env.PROXY_PORT = previousProxyPort;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('normal streamed text ending with [DONE] gets one ordered response.completed', async () => {
  await withProxy((req, res) => {
    req.resume();
    writeTextTurn(res, { id: 'resp_done', text: 'hello from DONE', ending: 'done' });
  }, async (proxyPort) => {
    const response = await postStream(proxyPort, {
      model: 'test-model', input: 'hello', tools: [], stream: true,
    });
    const events = parseSse(response.body);
    assert.equal(response.statusCode, 200);
    assertSuccessfulTerminal(events);
    assert.equal(events.filter((entry) => entry.event === 'response.output_text.delta').length, 1);
    assert.equal(events.at(-1).data.response.output[0].content[0].text, 'hello from DONE');
  });
});

test('normal streamed text ending by EOF gets response.completed before closure', async () => {
  await withProxy((req, res) => {
    req.resume();
    writeTextTurn(res, { id: 'resp_eof', text: 'hello from EOF', ending: 'eof' });
  }, async (proxyPort) => {
    const response = await postStream(proxyPort, {
      model: 'test-model', input: 'hello', tools: [], stream: true,
    });
    const events = parseSse(response.body);
    assertSuccessfulTerminal(events);
    assert.equal(events.at(-1).data.response.id, 'resp_eof');
    assert.equal(events.at(-1).data.response.output[0].content[0].text, 'hello from EOF');
  });
});

test('completed responses fill required token counters for image-only provider usage', async () => {
  await withProxy((req, res) => {
    req.resume();
    writeTextTurn(res, {
      id: 'resp_usage',
      text: 'image generated',
      ending: 'completed',
      usage: { num_images: 1 },
    });
  }, async (proxyPort) => {
    const response = await postStream(proxyPort, {
      model: 'test-model', input: 'generate an image', tools: [], stream: true,
    });
    const completed = parseSse(response.body).at(-1).data.response;

    assert.deepEqual(completed.usage, {
      num_images: 1,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    });
  });
});

test('non-streamed proxy-fulfilled web search preserves the original input for continuation', async () => {
  const received = [];
  await withProxy((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (received.length === 1) {
        res.end(JSON.stringify({
          id: 'resp_web_call',
          status: 'completed',
          output: [{
            type: 'function_call',
            id: 'item_web_call',
            call_id: 'call_web',
            name: 'web_search',
            arguments: '{}',
            status: 'completed',
          }],
        }));
        return;
      }

      const originalInput = body.input.find((item) => (
        item.type === 'message'
        && item.role === 'user'
        && item.content?.[0]?.text === 'search, then explain'
      ));
      res.end(JSON.stringify({
        id: 'resp_web_final',
        status: 'completed',
        output: [textItem(
          'msg_web_final',
          originalInput ? 'Search result explained.' : '',
        )],
      }));
    });
  }, async (proxyPort) => {
    const response = await postJson(proxyPort, {
      model: 'test-model',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'search, then explain' }],
      }],
      tools: [{ type: 'web_search' }],
      stream: false,
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(received.length, 2);
    const body = JSON.parse(response.body);
    assert.equal(body.output[0].content[0].text, 'Search result explained.');
  }, [
    'enable_find_skill = false',
    'stream_proxy_loop = false',
    'imagine_enabled = false',
  ]);
});

test('multiple proxy-fulfilled model turns finish only after the final assistant response', async () => {
  const received = [];
  await withProxy((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push(body);
      if (received.length <= 2) {
        if (received.length === 2) {
          assert.equal(body.input[0].type, 'message');
          assert.equal(body.input[0].role, 'user');
          assert.equal(body.input[0].content[0].text, 'inspect app state');
          assert.equal(body.input[1].name, 'ollama_proxy_status');
          assert.equal(body.input[2].type, 'function_call_output');
        }
        writeFunctionTurn(res, {
          type: 'function_call',
          id: 'item_status_' + received.length,
          call_id: 'call_status_' + received.length,
          name: 'ollama_proxy_status',
          arguments: '{}',
          status: 'completed',
        }, received.length === 1 ? 'done' : 'eof');
        return;
      }
      assert.equal(body.input[0].type, 'message');
      assert.equal(body.input[0].role, 'user');
      assert.equal(body.input[0].content[0].text, 'inspect app state');
      assert.equal(body.input[1].name, 'ollama_proxy_status');
      assert.equal(body.input[2].type, 'function_call_output');
      assert.equal(body.input[3].name, 'ollama_proxy_status');
      assert.equal(body.input[4].type, 'function_call_output');
      writeTextTurn(res, { id: 'resp_internal_final', text: 'Computer Use is ready.', ending: 'done' });
    });
  }, async (proxyPort) => {
    const response = await postStream(proxyPort, {
      model: 'test-model', input: 'inspect app state', tools: [], stream: true,
    });
    const events = parseSse(response.body);
    assert.equal(received.length, 3);
    assertSuccessfulTerminal(events);
    assert.equal(events.filter((entry) => entry.event === 'response.created').length, 1);
    assert.equal(events.filter((entry) => entry.event === 'response.in_progress').length, 1);
    assert.equal(events.at(-1).data.response.output.at(-1).content[0].text, 'Computer Use is ready.');
  });
});

test('upstream errors emit response.failed instead of closing silently', async () => {
  await withProxy((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    writeSse(res, 'response.created', {
      type: 'response.created', response: { id: 'resp_broken', status: 'in_progress', output: [] },
    });
    writeSse(res, 'response.in_progress', {
      type: 'response.in_progress', response: { id: 'resp_broken', status: 'in_progress', output: [] },
    });
    writeSse(res, 'response.output_item.added', {
      type: 'response.output_item.added', output_index: 0, sequence_number: 0,
      item: { type: 'message', id: 'msg_broken', role: 'assistant', status: 'in_progress', content: [] },
    });
    setImmediate(() => res.destroy());
  }, async (proxyPort) => {
    const response = await postStream(proxyPort, {
      model: 'test-model', input: 'break', tools: [], stream: true,
    });
    const events = parseSse(response.body);
    assert.equal(events.at(-1).event, 'response.failed');
    assert.equal(events.filter((entry) => entry.event === 'response.failed').length, 1);
    assert.equal(events.some((entry) => entry.event === 'response.completed'), false);
    assert.equal(events.at(-1).data.response.status, 'failed');
  });
});

test('upstream HTTP errors emit a complete failed lifecycle', async () => {
  await withProxy((req, res) => {
    req.resume();
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'temporarily unavailable' }));
  }, async (proxyPort) => {
    const response = await postStream(proxyPort, {
      model: 'test-model', input: 'fail before streaming', tools: [], stream: true,
    });
    const events = parseSse(response.body);
    assert.deepEqual(events.map((entry) => entry.event), [
      'response.created',
      'response.in_progress',
      'response.failed',
    ]);
    assert.equal(events.at(-1).data.response.status, 'failed');
    assert.match(events.at(-1).data.response.error.message, /upstream 503/);
  });
});

test('client disconnect aborts the active upstream stream', async () => {
  let resolveUpstreamClosed;
  const upstreamClosed = new Promise((resolve) => { resolveUpstreamClosed = resolve; });
  await withProxy((req, res) => {
    req.resume();
    res.on('close', resolveUpstreamClosed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    writeSse(res, 'response.created', {
      type: 'response.created', response: { id: 'resp_disconnect', status: 'in_progress', output: [] },
    });
  }, async (proxyPort) => {
    await new Promise((resolve, reject) => {
      const payload = JSON.stringify({ model: 'test-model', input: 'disconnect', tools: [], stream: true });
      const req = http.request({
        host: '127.0.0.1', port: proxyPort, method: 'POST', path: '/v1/responses',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      }, (res) => {
        res.once('data', () => {
          res.destroy();
          req.destroy();
          resolve();
        });
      });
      req.on('error', (error) => {
        if (error.code === 'ECONNRESET') resolve();
        else reject(error);
      });
      req.end(payload);
    });
    await upstreamClosed;
  });
});
