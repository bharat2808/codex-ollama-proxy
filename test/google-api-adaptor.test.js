'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function postJson(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/v1/responses',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: res.statusCode,
          contentType: res.headers['content-type'],
          raw,
          body: res.headers['content-type']?.includes('application/json') ? JSON.parse(raw) : null,
        });
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function parseSse(raw) {
  return raw.split(/\r?\n\r?\n/u).filter(Boolean).map((block) => {
    const lines = block.split(/\r?\n/u);
    const event = lines.find((line) => line.startsWith('event:'));
    const data = lines.filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n');
    return {
      event: event ? event.slice(6).trim() : null,
      data: JSON.parse(data),
    };
  });
}

test('Google adaptor translates Responses text, files, tools, reasoning, and image output', () => {
  const adaptor = require('../adaptor/google-api-adaptor');
  const request = adaptor.buildGenerateContentRequest({
    instructions: 'Be concise.',
    reasoning: { effort: 'high' },
    modalities: ['image', 'text'],
    tool_choice: 'required',
    tools: [{
      type: 'function',
      name: 'lookup',
      description: 'Look something up',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
    }],
    input: [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Read these.' },
        { type: 'input_image', image_url: 'data:image/png;base64,aW1n' },
        { type: 'input_image', image_url: 'data:image/jpeg;base64,aW1nMg==' },
        { type: 'input_file', filename: 'paper.pdf', file_data: 'data:application/pdf;base64,cGRm' },
        { type: 'input_file', filename: 'notes.txt', file_url: 'gs://bucket/notes.txt' },
      ],
    }],
  });

  assert.deepEqual(request.systemInstruction, { parts: [{ text: 'Be concise.' }] });
  assert.deepEqual(request.generationConfig.responseModalities, ['IMAGE', 'TEXT']);
  assert.deepEqual(request.generationConfig.thinkingConfig, { thinkingLevel: 'HIGH' });
  assert.deepEqual(request.tools[0].functionDeclarations[0], {
    name: 'lookup',
    description: 'Look something up',
    parametersJsonSchema: {
      type: 'object',
      properties: { q: { type: 'string' } },
    },
  });
  assert.deepEqual(request.toolConfig, { functionCallingConfig: { mode: 'ANY' } });
  assert.deepEqual(request.contents[0], {
    role: 'user',
    parts: [
      { text: 'Read these.' },
      { inlineData: { mimeType: 'image/png', data: 'aW1n' } },
      { inlineData: { mimeType: 'image/jpeg', data: 'aW1nMg==' } },
      { inlineData: { mimeType: 'application/pdf', data: 'cGRm' } },
      { fileData: { mimeType: 'text/plain', fileUri: 'gs://bucket/notes.txt' } },
    ],
  });
});

test('Google adaptor preserves conversation order and groups adjacent parallel tool items', () => {
  const adaptor = require('../adaptor/google-api-adaptor');
  const request = adaptor.buildGenerateContentRequest({
    input: [
      { type: 'message', role: 'user', content: 'Start' },
      { type: 'function_call', call_id: 'call_a', name: 'first', arguments: '{"a":1}', thought_signature: 'signature' },
      { type: 'function_call', call_id: 'call_b', name: 'second', arguments: '{"b":2}' },
      { type: 'function_call_output', call_id: 'call_a', output: '{"value":"a"}' },
      { type: 'function_call_output', call_id: 'call_b', output: '{"value":"b"}' },
      { type: 'message', role: 'user', content: 'Continue' },
    ],
  }, 'gemini-3.1-pro');

  assert.deepEqual(request.contents, [
    { role: 'user', parts: [{ text: 'Start' }] },
    {
      role: 'model',
      parts: [
        { functionCall: { name: 'first', args: { a: 1 } }, thoughtSignature: 'signature' },
        { functionCall: { name: 'second', args: { b: 2 } } },
      ],
    },
    {
      role: 'user',
      parts: [
        { functionResponse: { name: 'first', response: { value: 'a' } } },
        { functionResponse: { name: 'second', response: { value: 'b' } } },
      ],
    },
    { role: 'user', parts: [{ text: 'Continue' }] },
  ]);
});

test('Google adaptor obtains a Vertex bearer token from ADC when no token is configured', async () => {
  const adaptor = require('../adaptor/google-api-adaptor');
  let authorization;
  let tokenRequests = 0;
  const server = adaptor.startServer({
    port: 0,
    baseUrl: 'https://aiplatform.googleapis.com/v1/projects/sample-project/locations/global/endpoints/openapi',
    apiKey: '',
    defaultModel: 'gemini-2.5-flash',
    accessTokenProvider: async () => {
      tokenRequests += 1;
      return 'adc-access-token';
    },
    fetchImpl: async (_url, options) => {
      authorization = options.headers.authorization;
      return new Response(JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'adc ok' }] } }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const response = await postJson(server.address().port, {
      model: 'gemini-2.5-flash',
      input: 'hello',
      stream: false,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.output_text, 'adc ok');
    assert.equal(authorization, 'Bearer adc-access-token');
    assert.equal(tokenRequests, 1);
  } finally {
    await close(server);
  }
});

test('Google adaptor prefers an explicit Vertex token over ADC', async () => {
  const adaptor = require('../adaptor/google-api-adaptor');
  let authorization;
  const server = adaptor.startServer({
    port: 0,
    baseUrl: 'https://aiplatform.googleapis.com/v1/projects/sample-project/locations/global/endpoints/openapi',
    apiKey: 'explicit-vertex-token',
    defaultModel: 'gemini-2.5-flash',
    accessTokenProvider: async () => {
      throw new Error('ADC must not be called');
    },
    fetchImpl: async (_url, options) => {
      authorization = options.headers.authorization;
      return new Response(JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'token ok' }] } }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const response = await postJson(server.address().port, {
      model: 'gemini-2.5-flash',
      input: 'hello',
      stream: false,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(authorization, 'Bearer explicit-vertex-token');
  } finally {
    await close(server);
  }
});

test('Google adaptor maps reasoning effort to Gemini 2.5 thinking budgets', () => {
  const adaptor = require('../adaptor/google-api-adaptor');
  const request = adaptor.buildGenerateContentRequest({
    input: 'Think.',
    reasoning: { effort: 'medium' },
  }, 'gemini-2.5-flash');
  assert.deepEqual(request.generationConfig.thinkingConfig, { thinkingBudget: 8192 });
});

test('Google adaptor clamps extended Codex reasoning levels to Gemini levels', () => {
  const adaptor = require('../adaptor/google-api-adaptor');
  for (const effort of ['xhigh', 'max']) {
    const request = adaptor.buildGenerateContentRequest({
      input: 'Think.',
      reasoning: { effort },
    }, 'gemini-3.1-pro');
    assert.deepEqual(request.generationConfig.thinkingConfig, { thinkingLevel: 'HIGH' });
  }
});

test('Google adaptor infers a concrete MIME type from remote media URLs', () => {
  const adaptor = require('../adaptor/google-api-adaptor');
  const request = adaptor.buildGenerateContentRequest({
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: 'gs://bucket/reference.png' }],
    }],
  });
  assert.deepEqual(request.contents[0].parts[0], {
    fileData: { mimeType: 'image/png', fileUri: 'gs://bucket/reference.png' },
  });
});

test('Google adaptor preserves Gemini function-call thought signatures', () => {
  const adaptor = require('../adaptor/google-api-adaptor');
  const response = adaptor.geminiToResponse({
    candidates: [{
      content: {
        parts: [{
          functionCall: { name: 'lookup', args: { q: 'x' } },
          thoughtSignature: 'opaque-signature',
        }],
      },
    }],
  }, 'gemini-3.1-pro');
  const call = response.output[0];
  assert.equal(call.thought_signature, 'opaque-signature');

  const continuation = adaptor.buildGenerateContentRequest({
    input: [
      call,
      { type: 'function_call_output', call_id: call.call_id, output: '{"value":1}' },
    ],
  }, 'gemini-3.1-pro');
  assert.equal(continuation.contents[0].parts[0].thoughtSignature, 'opaque-signature');
  assert.equal(continuation.contents[1].parts[0].functionResponse.name, 'lookup');
});

test('Google adaptor restores the preceding user turn for tool continuations', async () => {
  const received = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      if (received.length === 1) {
        res.end(JSON.stringify({
          candidates: [{
            content: {
              role: 'model',
              parts: [{
                functionCall: { name: 'lookup', args: { q: 'test' } },
                thoughtSignature: 'opaque-signature',
              }],
            },
          }],
        }));
      } else {
        res.end(JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'complete' }] } }],
        }));
      }
    });
  });
  const upstreamPort = await listen(upstream);
  const adaptor = require('../adaptor/google-api-adaptor');
  const server = adaptor.startServer({
    port: 0,
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1beta/openai`,
    defaultModel: 'gemini-test',
  });
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    const first = await postJson(server.address().port, {
      input: 'Look up test.',
      tools: [{
        type: 'function',
        name: 'lookup',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      }],
    });
    const call = first.body.output.find((item) => item.type === 'function_call');
    const second = await postJson(server.address().port, {
      input: [
        call,
        { type: 'function_call_output', call_id: call.call_id, output: '{"value":"success"}' },
      ],
      tools: [{
        type: 'function',
        name: 'lookup',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      }],
    });

    assert.equal(second.statusCode, 200);
    assert.equal(second.body.output_text, 'complete');
    assert.deepEqual(received[1].contents, [
      { role: 'user', parts: [{ text: 'Look up test.' }] },
      {
        role: 'model',
        parts: [{
          functionCall: { name: 'lookup', args: { q: 'test' } },
          thoughtSignature: 'opaque-signature',
        }],
      },
      {
        role: 'user',
        parts: [{
          functionResponse: { name: 'lookup', response: { value: 'success' } },
        }],
      },
    ]);
  } finally {
    await close(server);
    await close(upstream);
  }
});

test('Google adaptor maps native Gemini text, tool calls, and inline images to Responses output', async () => {
  let received;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received = {
        url: req.url,
        apiKey: req.headers['x-goog-api-key'],
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts: [
              { text: 'done' },
              { functionCall: { name: 'lookup', args: { q: 'x' } } },
              { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
            ],
          },
        }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  const adaptor = require('../adaptor/google-api-adaptor');
  const server = adaptor.startServer({
    port: 0,
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1beta/openai`,
    apiKey: 'gemini-secret',
    defaultModel: 'gemini-image',
  });
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    const response = await postJson(server.address().port, {
      input: 'make it',
      stream: false,
      modalities: ['image', 'text'],
    });
    assert.equal(response.statusCode, 200);
    assert.equal(received.url, '/v1beta/models/gemini-image:generateContent');
    assert.equal(received.apiKey, 'gemini-secret');
    assert.equal(received.authorization, undefined);
    assert.deepEqual(response.body.output.map((item) => item.type), [
      'message',
      'function_call',
      'image_generation_call',
    ]);
    assert.equal(response.body.output_text, 'done');
    assert.equal(response.body.output[2].result, 'data:image/png;base64,aW1hZ2U=');
  } finally {
    await close(server);
    await close(upstream);
  }
});

test('Google adaptor builds Vertex generateContent targets and uses bearer authentication', () => {
  const adaptor = require('../adaptor/google-api-adaptor');
  const target = adaptor.googleTarget({
    baseUrl: 'https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/endpoints/openapi',
    apiKey: 'access-token',
  }, 'google/gemini-2.5-flash', false);

  assert.equal(
    target.url.href,
    'https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/google/models/gemini-2.5-flash:generateContent',
  );
  assert.deepEqual(target.headers, {
    'content-type': 'application/json',
    authorization: 'Bearer access-token',
  });
});

test('Google adaptor converts streamed Gemini parts into Responses SSE events', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [
      { text: 'hello ' },
      { functionCall: { name: 'first', args: { q: 'one' } }, thoughtSignature: 'sig' },
    ] } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [
      { text: 'world' },
      { inlineData: { mimeType: 'image/png', data: 'cG5n' } },
      { functionCall: { name: 'second', args: { q: 'two' } } },
    ] }, finishReason: 'STOP' }] })}\n\n`);
    res.end();
  });
  const upstreamPort = await listen(upstream);
  const adaptor = require('../adaptor/google-api-adaptor');
  const server = adaptor.startServer({
    port: 0,
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1beta/openai`,
    apiKey: 'gemini-secret',
    defaultModel: 'gemini-image',
  });
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    const response = await postJson(server.address().port, {
      input: 'make it',
      stream: true,
      modalities: ['image', 'text'],
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.contentType, /text\/event-stream/u);
    assert.match(response.raw, /response\.output_text\.delta/u);
    assert.match(response.raw, /hello /u);
    assert.match(response.raw, /world/u);
    assert.match(response.raw, /image_generation_call/u);
    assert.match(response.raw, /data:image\/png;base64,cG5n/u);
    assert.match(response.raw, /response\.completed/u);

    const events = parseSse(response.raw);
    const added = events.filter((entry) => entry.event === 'response.output_item.added');
    const done = events.filter((entry) => entry.event === 'response.output_item.done');
    assert.deepEqual(added.map((entry) => entry.data.output_index), [0, 1, 2, 3]);
    assert.deepEqual(done.map((entry) => entry.data.output_index).sort((a, b) => a - b), [0, 1, 2, 3]);
    assert.equal(events.filter((entry) => entry.event === 'response.function_call_arguments.delta').length, 2);
    assert.equal(events.filter((entry) => entry.event === 'response.function_call_arguments.done').length, 2);
    assert.equal(events.filter((entry) => entry.event === 'response.content_part.done').length, 1);
    const completed = events.find((entry) => entry.event === 'response.completed');
    assert.deepEqual(completed.data.response.output.map((item) => item.type), [
      'message',
      'function_call',
      'image_generation_call',
      'function_call',
    ]);
  } finally {
    await close(server);
    await close(upstream);
  }
});

test('Google adaptor returns an upstream streaming error before starting SSE', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":"invalid tool schema"}');
  });
  const upstreamPort = await listen(upstream);
  const adaptor = require('../adaptor/google-api-adaptor');
  const server = adaptor.startServer({
    port: 0,
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1beta/openai`,
    defaultModel: 'gemini-test',
  });
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    const response = await postJson(server.address().port, { input: 'test', stream: true });
    assert.equal(response.statusCode, 400);
    assert.match(response.contentType, /application\/json/u);
    assert.match(response.body.error, /invalid tool schema/u);
  } finally {
    await close(server);
    await close(upstream);
  }
});

test('Google adaptor is a supported preset and launcher adaptor', () => {
  const presets = require('../src/presets');
  const launcherState = require('../src/launcher-state');
  const preset = presets.normalizePreset('gemini', [
    'adaptor = "google"',
    'upstream_url = "https://generativelanguage.googleapis.com/v1beta/openai"',
    'models = ["gemini-2.5-flash"]',
    'default_model = "gemini-2.5-flash"',
  ].join('\n'));

  assert.equal(preset.adaptor, 'google');
  const state = launcherState.fromPreset(preset, { adaptor_port: 9123 });
  assert.deepEqual(state, {
    version: launcherState.VERSION,
    adaptor: 'google',
    proxy_port: launcherState.DEFAULT_PROXY_PORT,
    adaptor_port: 9123,
  });
  assert.deepEqual(launcherState.serveArgs(state), [
    'serve', '--adaptor', 'google', '--adaptor-port', '9123',
  ]);
});

test('Google presets containing API keys are written with private permissions', () => {
  const presets = require('../src/presets');
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'google-preset-permissions-'));
  const runtimeDir = path.join(codexHome, 'ollama-shape-proxy');
  try {
    presets.addPreset(runtimeDir, 'gemini', {
      adaptor: 'google',
      url: 'https://generativelanguage.googleapis.com/v1beta/openai',
      models: 'gemini-2.5-flash',
      defaultModel: 'gemini-2.5-flash',
      apiKey: 'secret',
    }, () => {});
    const mode = fs.statSync(path.join(runtimeDir, 'presets', 'gemini.toml')).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});
