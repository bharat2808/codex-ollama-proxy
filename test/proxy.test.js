'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
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

function postJson(port, body) {
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
  fs.mkdirSync(path.join(codexHome, 'ollama-shape-proxy'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'ollama-shape-proxy', 'proxy-models.toml'), [
    'text_model = "test-model"',
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
    await run(server.address().port, proxy);
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

function textItem(id, text, attachments = []) {
  return {
    type: 'message',
    id,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }, ...attachments],
  };
}

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
      type: 'response.completed', response: { id, status: 'completed', output: [item] },
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

test('request translation lifts additional_tools input items into top-level tools', () => {
  const { translateRequestBody } = require('../src/proxy');
  const body = {
    model: 'test-model',
    input: [{
      type: 'additional_tools',
      role: 'developer',
      content: [{ type: 'input_text', text: 'Use node_repl when you need JS.' }],
      tools: [{
        type: 'function',
        name: 'node_repl',
        description: 'Evaluate JavaScript',
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string' },
          },
          required: ['code'],
          additionalProperties: false,
        },
      }],
    }],
    tools: [],
  };

  translateRequestBody(body);

  assert.equal(body.input.length, 1);
  assert.equal(body.input[0].type, 'message');
  assert.equal(body.input[0].role, 'developer');
  assert.ok(body.tools.some((tool) => tool.type === 'function' && tool.name === 'node_repl'));
  assert.doesNotMatch(JSON.stringify(body), /additional_tools/);
});

test('request translation unwraps additional_tools returned by tool_search', () => {
  const { translateRequestBody } = require('../src/proxy');
  const body = {
    model: 'test-model',
    input: [{
      type: 'tool_search_output',
      call_id: 'call_search',
      execution: 'client',
      status: 'completed',
      tools: [{
        type: 'additional_tools',
        tools: [{
          type: 'function',
          name: 'node_repl',
          description: 'Evaluate JavaScript',
          parameters: {
            type: 'object',
            properties: {
              code: { type: 'string' },
            },
            required: ['code'],
            additionalProperties: false,
          },
        }],
      }],
    }],
    tools: [],
  };

  translateRequestBody(body);

  assert.ok(body.tools.some((tool) => tool.type === 'function' && tool.name === 'node_repl'));
  assert.equal(body.input[0].type, 'function_call_output');
  assert.match(body.input[0].output, /Invoke its exact returned name: node_repl/);
  assert.match(body.input[0].output, /computer-use@openai-bundled.*plugin identifier/);
  assert.match(body.input[0].output, /required: code/);
  assert.match(body.input[0].output, /arguments example: \{"code":"<string>"\}/);
});

test('request translation does not expose node_repl before discovery', () => {
  const { translateRequestBody } = require('../src/proxy');
  const body = {
    model: 'test-model',
    input: 'use computer use',
    tools: [],
  };

  translateRequestBody(body);

  assert.equal(body.tools.some((tool) => tool.name === 'node_repl'), false);
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
  const toolSearch = body.tools.find((tool) => tool.name === 'tool_search');
  assert.match(toolSearch.description, /computer-use@openai-bundled.*plugin identifier/);
  assert.match(toolSearch.description, /\{"query":"node_repl"\}/);
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

test('proxy recovers a plugin link call into the registered deferred tool search', async () => {
  await withProxy((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'resp_plugin_recovery',
        output: [{
          type: 'function_call',
          id: 'item_plugin_recovery',
          call_id: 'call_plugin_recovery',
          name: 'plugin://computer-use@openai-bundled/',
          arguments: '{}',
          status: 'completed',
        }],
        status: 'completed',
      }));
    });
  }, async (proxyPort) => {
    const response = await postJson(proxyPort, {
      model: 'test-model', input: 'use Computer Use', tools: [], stream: false,
    });
    const body = JSON.parse(response.body);

    assert.equal(body.output[0].type, 'tool_search_call');
    assert.equal(body.output[0].arguments.query, 'node_repl');
  });
});

test('proxy normalizes tool_search aliases through the compatibility registry', async () => {
  await withProxy((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'resp_search_alias',
        output: [{
          type: 'function_call',
          id: 'item_search_alias',
          call_id: 'call_search_alias',
          name: 'tool_search',
          arguments: '{"query":"computer use"}',
          status: 'completed',
        }],
        status: 'completed',
      }));
    });
  }, async (proxyPort) => {
    const response = await postJson(proxyPort, {
      model: 'test-model', input: 'use Computer Use', tools: [], stream: false,
    });
    const body = JSON.parse(response.body);

    assert.equal(body.output[0].type, 'tool_search_call');
    assert.equal(body.output[0].arguments.query, 'node_repl');
  });
});

test('streaming proxy recovers a plugin identifier call into tool_search', async () => {
  await withProxy((_req, res) => {
    writeFunctionTurn(res, {
      type: 'function_call',
      id: 'item_plugin_stream_recovery',
      call_id: 'call_plugin_stream_recovery',
      name: 'computer-use@openai-bundled',
      arguments: '{}',
      status: 'completed',
    }, 'completed');
  }, async (proxyPort) => {
    const response = await postStream(proxyPort, {
      model: 'test-model', input: 'use Computer Use', tools: [], stream: true,
    });
    const events = parseSse(response.body);
    const output = events.at(-1).data.response.output[0];

    assertSuccessfulTerminal(events);
    assert.equal(output.type, 'tool_search_call');
    assert.equal(output.arguments.query, 'node_repl');
  });
});

test('proxy recovers dotted namespace calls to the exact discovered callable', async () => {
  await withProxy((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'resp_dotted_recovery',
        output: [{
          type: 'function_call',
          id: 'item_dotted_recovery',
          call_id: 'call_dotted_recovery',
          name: 'mcp__node_repl.js',
          arguments: '{"code":"1 + 1"}',
          status: 'completed',
        }],
        status: 'completed',
      }));
    });
  }, async (proxyPort) => {
    const response = await postJson(proxyPort, {
      model: 'test-model',
      input: 'run JavaScript',
      tools: [{
        type: 'namespace',
        name: 'mcp__node_repl',
        tools: [{
          type: 'function',
          name: 'js',
          parameters: {
            type: 'object',
            properties: { code: { type: 'string' } },
            required: ['code'],
          },
        }],
      }],
      stream: false,
    });
    const body = JSON.parse(response.body);

    assert.equal(body.output[0].namespace, 'mcp__node_repl');
    assert.equal(body.output[0].name, 'js');
    assert.equal(body.output[0].arguments, '{"code":"1 + 1"}');
  });
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
  fs.mkdirSync(path.join(codexHome, 'ollama-shape-proxy'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'ollama-shape-proxy', 'proxy-models.toml'), [
    'text_model = "test-model"',
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

test('proxy preserves tool_search and node_repl response shapes across turns', async () => {
  const received = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push(body);
      if (received.length === 1) {
        assert.ok(body.tools.some((tool) => tool.type === 'function' && tool.name === 'tool_search'));
        assert.equal(body.tools.some((tool) => tool.type === 'function' && tool.name === 'node_repl'), false);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'resp_search',
          output: [{
            type: 'function_call',
            id: 'item_search',
            call_id: 'call_search',
            name: 'tool_search',
            arguments: '{"query":"node_repl","limit":1}',
            status: 'completed',
          }],
          status: 'completed',
        }));
        return;
      }
      assert.ok(body.tools.some((tool) => tool.type === 'function' && tool.name === 'node_repl'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'resp_node',
        output: [{
          type: 'function_call',
          id: 'item_node',
          call_id: 'call_node',
          name: 'node_repl',
          arguments: '{"code":"1 + 1"}',
          status: 'completed',
        }],
        status: 'completed',
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proxy-test-'));
  fs.mkdirSync(path.join(codexHome, 'ollama-shape-proxy'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'ollama-shape-proxy', 'proxy-models.toml'), [
    'text_model = "test-model"',
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
    const first = await postJson(proxyPort, {
      model: 'test-model',
      input: 'use computer use',
      tools: [],
      stream: false,
    });
    const firstBody = JSON.parse(first.body);
    assert.equal(first.statusCode, 200);
    assert.equal(firstBody.output[0].type, 'tool_search_call');
    assert.equal(firstBody.output[0].call_id, 'call_search');
    assert.equal(firstBody.output[0].arguments.query, 'node_repl');

    const second = await postJson(proxyPort, {
      model: 'test-model',
      input: [{
        type: 'tool_search_output',
        call_id: 'call_search',
        status: 'completed',
        execution: 'client',
        tools: [{
          type: 'additional_tools',
          tools: [{
            type: 'function',
            name: 'node_repl',
            description: 'Evaluate JavaScript',
            parameters: {
              type: 'object',
              properties: {
                code: { type: 'string' },
              },
              required: ['code'],
              additionalProperties: false,
            },
          }],
        }],
      }],
      tools: [],
      stream: false,
    });
    const secondBody = JSON.parse(second.body);
    assert.equal(second.statusCode, 200);
    assert.equal(secondBody.output[0].type, 'function_call');
    assert.equal(secondBody.output[0].name, 'node_repl');
    assert.equal(secondBody.output[0].arguments, '{"code":"1 + 1"}');
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
  fs.mkdirSync(path.join(codexHome, 'ollama-shape-proxy'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'ollama-shape-proxy', 'proxy-models.toml'), [
    'text_model = "test-model"',
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
          assert.equal(body.input[0].name, 'ollama_proxy_status');
          assert.equal(body.input[1].type, 'function_call_output');
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
      assert.equal(body.input[0].name, 'ollama_proxy_status');
      assert.equal(body.input[1].type, 'function_call_output');
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

test('Computer Use tool_search and node_repl turns preserve screenshot and file output', async () => {
  const received = [];
  const screenshotOutput = JSON.stringify({
    app_state: { app: 'Safari', window: 'Example' },
    screenshot: { path: '/tmp/computer-use-shot.png', file_id: 'file_screenshot' },
  });
  await withProxy((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push(body);
      if (received.length === 1) {
        writeFunctionTurn(res, {
          type: 'function_call', id: 'item_search', call_id: 'call_search', name: 'tool_search',
          arguments: '{"query":"node_repl"}', status: 'completed',
        }, 'done');
        return;
      }
      if (received.length === 2) {
        assert.ok(body.tools.some((tool) => tool.name === 'mcp__node_repl__js'));
        const searchOutput = body.input.find((item) => item.call_id === 'call_search');
        assert.match(searchOutput.output, /Invoke its exact returned name: mcp__node_repl__js/);
        writeFunctionTurn(res, {
          type: 'function_call', id: 'item_node', call_id: 'call_node', name: 'mcp__node_repl__js',
          arguments: '{"code":"await computer.getAppState()"}', status: 'completed',
        }, 'eof');
        return;
      }
      const result = body.input.find((item) => item.type === 'function_call_output');
      assert.equal(result.output, screenshotOutput);
      writeTextTurn(res, {
        id: 'resp_computer_final',
        text: 'Screenshot captured.',
        ending: 'completed',
        attachments: [
          { type: 'output_image', image_url: 'file:///tmp/computer-use-shot.png' },
          { type: 'output_file', file_id: 'file_screenshot', filename: 'computer-use-shot.png' },
        ],
      });
    });
  }, async (proxyPort) => {
    const first = parseSse((await postStream(proxyPort, {
      model: 'test-model', input: 'use Computer Use', tools: [], stream: true,
    })).body);
    assertSuccessfulTerminal(first);
    assert.equal(first.at(-1).data.response.output[0].type, 'tool_search_call');

    const second = parseSse((await postStream(proxyPort, {
      model: 'test-model',
      input: [{
        type: 'tool_search_output', call_id: 'call_search', execution: 'client', status: 'completed',
        tools: [{
          type: 'additional_tools',
          tools: [{
            type: 'namespace', name: 'mcp__node_repl',
            tools: [{
              type: 'function', name: 'js', description: 'Run JavaScript',
              parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
            }],
          }],
        }],
      }],
      tools: [], stream: true,
    })).body);
    assertSuccessfulTerminal(second);
    assert.equal(second.at(-1).data.response.output[0].namespace, 'mcp__node_repl');
    assert.equal(second.at(-1).data.response.output[0].name, 'js');

    const third = parseSse((await postStream(proxyPort, {
      model: 'test-model',
      input: [
        {
          type: 'function_call', namespace: 'mcp__node_repl', name: 'js', call_id: 'call_node',
          arguments: '{"code":"await computer.getAppState()"}', status: 'completed',
        },
        { type: 'function_call_output', call_id: 'call_node', output: screenshotOutput },
      ],
      tools: [], stream: true,
    })).body);
    assertSuccessfulTerminal(third);
    const content = third.at(-1).data.response.output[0].content;
    assert.equal(content[1].type, 'output_image');
    assert.equal(content[1].image_url, 'file:///tmp/computer-use-shot.png');
    assert.equal(content[2].type, 'output_file');
    assert.equal(content[2].file_id, 'file_screenshot');
    assert.equal(received.length, 3);
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

test('automatic image generation uses /images/generations and returns to text routing', async () => {
  const received = [];
  const imageOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proxy-images-'));
  await withProxy((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push({
        url: req.url,
        authorization: req.headers.authorization,
        body,
      });
      if (req.url === '/custom/images/generations') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: [{ b64_json: Buffer.from('fake-png-data').toString('base64') }],
        }));
        return;
      }
      assert.equal(req.url, '/custom/responses');
      assert.equal(body.model, 'ornith:9b');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'resp_text_after_image',
        status: 'completed',
        model: body.model,
        output: [textItem('msg_after_image', 'Back on text.')],
      }));
    });
  }, async (proxyPort, proxy) => {
    const generation = await postStream(proxyPort, {
      model: 'ornith:9b',
      input: 'Generate an image of a lake.',
      tools: [],
      stream: true,
    });
    const events = parseSse(generation.body);
    assertSuccessfulTerminal(events);
    const generated = events.at(-1).data.response;
    assert.equal(generated.model, 'x/z-image-turbo:fp8');
    assert.equal(generated.output[0].type, 'image_generation_call');
    assert.match(generated.output[0].result, /^data:image\/png;base64,/);
    assert.equal(path.dirname(generated.output[0].saved_path), imageOutputDir);
    assert.equal(fs.readFileSync(generated.output[0].saved_path, 'utf8'), 'fake-png-data');
    fs.rmSync(generated.output[0].saved_path, { force: true });

    const normal = await postJson(proxyPort, {
      model: 'x/z-image-turbo:fp8',
      input: [
        { type: 'image_generation_call', status: 'completed', revised_prompt: 'lake' },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'What time is it?' }],
        },
      ],
      tools: [],
      stream: false,
    });
    assert.equal(JSON.parse(normal.body).model, 'ornith:9b');

    const attachment = await postJson(proxyPort, {
      model: 'x/z-image-turbo:fp8',
      input: [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
          { type: 'input_text', text: 'Describe this.' },
        ],
      }],
      tools: [],
      stream: false,
    });
    assert.equal(JSON.parse(attachment.body).model, 'ornith:9b');

    const body = {
      model: 'ornith:9b',
      input: 'Draw a robot.',
      tools: [],
    };
    proxy.translateRequestBody(body);
    assert.strictEqual(proxy.getRoutingDecision(body), proxy.getRoutingDecision(body));
  }, [
    'text_model = "ornith:9b"',
    'image_model = "x/z-image-turbo:fp8"',
    `image_output_dir = "${imageOutputDir}"`,
    'auto_route_image = true',
    'upstream_api_key = "secret-token"',
  ]);

  assert.deepEqual(received[0], {
    url: '/custom/images/generations',
    authorization: 'Bearer secret-token',
    body: {
      model: 'x/z-image-turbo:fp8',
      prompt: 'Generate an image of a lake.',
      size: '1024x1024',
      response_format: 'b64_json',
      n: 1,
    },
  });
  assert.equal(received[1].authorization, 'Bearer secret-token');
  assert.equal(received[2].authorization, 'Bearer secret-token');
  assert.equal(received.some((request) =>
    request.url.endsWith('/responses') && request.body.model === 'x/z-image-turbo:fp8'
  ), false);
  fs.rmSync(imageOutputDir, { recursive: true, force: true });
});

test('manual image model selection still uses the image generation endpoint', async () => {
  let request = null;
  await withProxy((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      request = {
        url: req.url,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: [{ b64_json: Buffer.from('manual-image').toString('base64') }],
      }));
    });
  }, async (proxyPort) => {
    const response = await postJson(proxyPort, {
      model: 'x/z-image-turbo:fp8',
      input: 'Generate an image of a manual route.',
      tools: [],
      stream: false,
    });
    const body = JSON.parse(response.body);
    assert.equal(body.output[0].type, 'image_generation_call');
    fs.rmSync(body.output[0].saved_path, { force: true });
  }, [
    'text_model = "ornith:9b"',
    'image_model = "x/z-image-turbo:fp8"',
    'auto_route_image = false',
  ]);
  assert.equal(request.url, '/custom/images/generations');
  assert.equal(request.body.model, 'x/z-image-turbo:fp8');
});

test('skill matches stay on local SKILL.md paths', () => {
  const skillIndex = require('../src/skill-index');
  const text = skillIndex.formatSkillMatches([{
    entry: {
      skill_name: 'computer-use',
      plugin_name: '',
      description: 'Read local app state',
      path: '/Users/user/.codex/skills/computer-use/SKILL.md',
      scope: 'user',
    },
    score: 42,
  }]);

  assert.match(text, /path: \/Users\/user\/\.codex\/skills\/computer-use\/SKILL\.md/);
  assert.doesNotMatch(text, /file:\/\//);
});
