'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const upstream = require('../src/upstream');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('streamResponse exposes text deltas before the completed Responses object', async () => {
  let releaseCompleted;
  const completedGate = new Promise((resolve) => {
    releaseCompleted = resolve;
  });
  const provider = http.createServer(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: response.output_text.delta\n');
    response.write('data: {"type":"response.output_text.delta","delta":"Hello. "}\n\n');
    await completedGate;
    response.write('event: response.completed\n');
    response.write('data: {"type":"response.completed","response":{"output_text":"Hello. Done."}}\n\n');
    response.end();
  });
  const port = await listen(provider);
  let sawDelta;
  const deltaSeen = new Promise((resolve) => {
    sawDelta = resolve;
  });

  try {
    const request = upstream.streamResponse(
      upstream.createUpstream(`http://127.0.0.1:${port}/v1`),
      { model: 'test', stream: true },
      {
        onTextDelta(delta) {
          assert.equal(delta, 'Hello. ');
          sawDelta();
        },
      },
    );
    await deltaSeen;
    releaseCompleted();
    assert.deepEqual(await request, { output_text: 'Hello. Done.' });
  } finally {
    releaseCompleted();
    await close(provider);
  }
});

test('streamResponse aborts an in-flight upstream response', async () => {
  let requestClosed;
  const closed = new Promise((resolve) => {
    requestClosed = resolve;
  });
  const provider = http.createServer((request, response) => {
    request.once('close', requestClosed);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: response.in_progress\n');
    response.write('data: {"type":"response.in_progress"}\n\n');
  });
  const port = await listen(provider);
  const controller = new AbortController();
  let streamStarted;
  const started = new Promise((resolve) => {
    streamStarted = resolve;
  });

  try {
    const request = upstream.streamResponse(
      upstream.createUpstream(`http://127.0.0.1:${port}/v1`),
      { model: 'test', stream: true },
      {
        signal: controller.signal,
        onEvent: streamStarted,
      },
    );
    await started;
    controller.abort();
    await assert.rejects(request, { name: 'AbortError' });
    await closed;
  } finally {
    await close(provider);
  }
});

test('streamResponse parses SSE delimiters split across transport chunks', async () => {
  const provider = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(
      'event: response.output_text.delta\r\n'
      + 'data: {"type":"response.output_text.delta","delta":"Hello."}\r\n\r',
    );
    setImmediate(() => {
      response.write(
        '\nevent: response.completed\r\n'
        + 'data: {"type":"response.completed","response":{"output_text":"Hello."}}\r\n\r',
      );
      setImmediate(() => {
        response.end('\n');
      });
    });
  });
  const port = await listen(provider);
  const deltas = [];

  try {
    const response = await upstream.streamResponse(
      upstream.createUpstream(`http://127.0.0.1:${port}/v1`),
      { model: 'test', stream: true },
      { onTextDelta: (delta) => deltas.push(delta) },
    );
    assert.deepEqual(deltas, ['Hello.']);
    assert.deepEqual(response, { output_text: 'Hello.' });
  } finally {
    await close(provider);
  }
});
