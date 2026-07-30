'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const test = require('node:test');
const WebSocket = require('ws');
const {
  MediaStream,
  MediaStreamTrack,
  RTCPeerConnection,
} = require('werift');
const { pcm16ToWav } = require('../src/voice-agent/voice-audio');

function loadRealtimeVoice() {
  try {
    return require('../src/voice-agent/realtime-voice-server');
  } catch (error) {
    assert.fail(`realtime voice server is unavailable: ${error.message}`);
  }
}

function createVoiceServer(options = {}) {
  const { createRealtimeVoiceServer } = loadRealtimeVoice();
  return createRealtimeVoiceServer({
    coordinateTranscript: async (transcript) => ({
      action: 'delegate',
      input: transcript,
    }),
    streamSpeech: async function* (text) {
      yield { pcm: Buffer.from(`audio:${text}`), sampleRate: 24000 };
    },
    ...options,
  });
}

async function collectAudioStream(chunks, output = []) {
  for await (const chunk of chunks) output.push(chunk.pcm.toString());
}

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

async function createV3Call(port) {
  const boundary = 'codex-v3-realtime-call-boundary';
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="sdp"',
    'Content-Type: application/sdp',
    '',
    'v=0\r\na=setup:actpass\r\n',
    `--${boundary}`,
    'Content-Disposition: form-data; name="session"',
    'Content-Type: application/json',
    '',
    JSON.stringify({
      instructions: 'Codex V3 voice session',
      audio: { output: { voice: 'ash' } },
      delegation: { type: 'client' },
    }),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return fetch(`http://127.0.0.1:${port}/v1/live`, {
    method: 'POST',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
  });
}

async function waitFor(check, message) {
  const deadline = Date.now() + 1000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('Codex V3 WebRTC live route uses frameless delegation and Kokoro playback', async () => {
  let peerOptions;
  const spoken = [];
  const played = [];
  const browserEvents = [];
  const voice = createVoiceServer({
    enabled: () => true,
    transcribePcm: async () => 'inspect the repository',
    coordinateTranscript: async (transcript) => ({
      action: 'delegate',
      input: transcript,
      preface: 'I’ll ask Codex to inspect it.',
    }),
    streamSpeech: async function* (text) {
      spoken.push(text);
      yield { pcm: Buffer.from(`audio:${text}`), sampleRate: 24000 };
    },
    createPeer: async (options) => {
      peerOptions = options;
      return {
        answerSdp: 'v=0\r\na=setup:active\r\n',
        async playAudioStream(chunks) {
          await collectAudioStream(chunks, played);
        },
        sendDataEvent(event) {
          browserEvents.push(event);
        },
        close() {},
      };
    },
  });
  const server = http.createServer((request, response) => {
    if (!voice.handleRequest(request, response)) {
      response.writeHead(404);
      response.end('not found');
    }
  });
  voice.attach(server);
  const port = await listen(server);

  try {
    const offer = await createV3Call(port);

    assert.equal(offer.status, 201);
    assert.equal(await offer.text(), 'v=0\r\na=setup:active\r\n');
    const location = offer.headers.get('location');
    assert.match(location, /^\/v1\/live\/rtc_[a-f0-9-]+$/u);
    const sideband = new WebSocket(`ws://127.0.0.1:${port}${location}`);
    const events = [];
    sideband.on('message', (payload) => events.push(JSON.parse(payload.toString('utf8'))));
    await once(sideband, 'open');

    await peerOptions.onSpeech(Buffer.from([1, 2, 3, 4]));
    while (!events.some((event) => event.type === 'delegation.created')) {
      await once(sideband, 'message');
    }
    const delegation = events.find((event) => event.type === 'delegation.created');
    assert.equal(delegation.item.target, 'client');
    assert.equal(delegation.item.content[0].text, 'inspect the repository');
    assert.deepEqual(spoken, ['I’ll ask Codex to inspect it.']);
    assert.deepEqual(played, ['audio:I’ll ask Codex to inspect it.']);
    assert.ok(
      events.findIndex((event) => event.type === 'output_transcript.added')
      < events.findIndex((event) => event.type === 'delegation.created'),
    );

    sideband.send(JSON.stringify({
      type: 'delegation.context.append',
      delegation_item_id: delegation.item.id,
      channel: 'speakable',
      content: [{ type: 'input_text', text: 'I inspected it.' }],
    }));
    while (events.filter((event) => (
      event.type === 'turn.done' && event.turn.role === 'assistant'
    )).length < 2) {
      await once(sideband, 'message');
    }
    assert.deepEqual(spoken, ['I’ll ask Codex to inspect it.', 'I inspected it.']);
    assert.deepEqual(played, ['audio:I’ll ask Codex to inspect it.', 'audio:I inspected it.']);
    assert.equal(
      events.filter((event) => event.type === 'output_transcript.added').at(-1).item.text,
      'I inspected it.',
    );
    assert.deepEqual(browserEvents, events);
    sideband.close();
    await once(sideband, 'close');
  } finally {
    await voice.close();
    await close(server);
  }
});

test('Codex V3 WebRTC speaks a direct coordinator response without delegating', async () => {
  let peerOptions;
  const played = [];
  const directResponse = `Hello from the preset voice model. ${'x'.repeat(501)}`;
  const voice = createVoiceServer({
    enabled: () => true,
    transcribePcm: async () => 'hello there',
    coordinateTranscript: async () => ({
      action: 'speak',
      text: directResponse,
    }),
    createPeer: async (options) => {
      peerOptions = options;
      return {
        answerSdp: 'v=0\r\na=setup:active\r\n',
        async playAudioStream(chunks) {
          await collectAudioStream(chunks, played);
        },
        sendDataEvent() {},
        close() {},
      };
    },
  });
  const server = http.createServer((request, response) => {
    if (!voice.handleRequest(request, response)) {
      response.writeHead(404);
      response.end('not found');
    }
  });
  voice.attach(server);
  const port = await listen(server);

  try {
    const offer = await createV3Call(port);
    const sideband = new WebSocket(
      `ws://127.0.0.1:${port}${offer.headers.get('location')}`,
    );
    const events = [];
    sideband.on('message', (payload) => events.push(JSON.parse(payload.toString('utf8'))));
    await once(sideband, 'open');

    await peerOptions.onSpeech(Buffer.from([1, 2, 3, 4]));
    await waitFor(
      () => events.some((event) => (
        event.type === 'turn.done' && event.turn.role === 'assistant'
      )),
      'expected a direct coordinator response',
    );

    assert.deepEqual(played, [`audio:${directResponse}`]);
    assert.equal(events.some((event) => event.type === 'delegation.created'), false);
    sideband.close();
    await once(sideband, 'close');
  } finally {
    await voice.close();
    await close(server);
  }
});

test('Codex V3 WebRTC publishes the transcript before coordinator inference completes', async () => {
  let peerOptions;
  let resolveDecision;
  const decision = new Promise((resolve) => {
    resolveDecision = resolve;
  });
  const voice = createVoiceServer({
    enabled: () => true,
    transcribePcm: async () => 'inspect the repository',
    coordinateTranscript: async () => decision,
    createPeer: async (options) => {
      peerOptions = options;
      return {
        answerSdp: 'v=0\r\na=setup:active\r\n',
        sendDataEvent() {},
        close() {},
      };
    },
  });
  const server = http.createServer((request, response) => {
    if (!voice.handleRequest(request, response)) {
      response.writeHead(404);
      response.end('not found');
    }
  });
  voice.attach(server);
  const port = await listen(server);

  try {
    const offer = await createV3Call(port);
    const sideband = new WebSocket(
      `ws://127.0.0.1:${port}${offer.headers.get('location')}`,
    );
    const events = [];
    sideband.on('message', (payload) => events.push(JSON.parse(payload.toString('utf8'))));
    await once(sideband, 'open');

    const speech = peerOptions.onSpeech(Buffer.from([1, 2, 3, 4]));
    await waitFor(
      () => events.some((event) => event.type === 'input_transcript.added'),
      'expected input transcript before coordinator response',
    );
    assert.equal(events.some((event) => event.type === 'delegation.created'), false);

    resolveDecision({ action: 'delegate', input: 'inspect the repository' });
    await speech;
    await waitFor(
      () => events.some((event) => event.type === 'delegation.created'),
      'expected delegation after coordinator response',
    );
    sideband.close();
    await once(sideband, 'close');
  } finally {
    await voice.close();
    await close(server);
  }
});

test('Codex V3 WebRTC barge-in aborts the stale turn and lets the new turn overtake it', async () => {
  let peerOptions;
  let firstSignal;
  let releaseFirst;
  let stopCount = 0;
  const firstDecision = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const voice = createVoiceServer({
    enabled: () => true,
    transcribePcm: async (pcm) => pcm.toString(),
    coordinateTranscript: async (transcript, context) => {
      if (transcript === 'first') {
        firstSignal = context.signal;
        return firstDecision;
      }
      return { action: 'delegate', input: transcript };
    },
    createPeer: async (options) => {
      peerOptions = options;
      return {
        answerSdp: 'v=0\r\na=setup:active\r\n',
        async stopAudio() {
          stopCount += 1;
        },
        sendDataEvent() {},
        close() {},
      };
    },
  });
  const server = http.createServer((request, response) => {
    if (!voice.handleRequest(request, response)) {
      response.writeHead(404);
      response.end('not found');
    }
  });
  voice.attach(server);
  const port = await listen(server);

  try {
    const offer = await createV3Call(port);
    const sideband = new WebSocket(
      `ws://127.0.0.1:${port}${offer.headers.get('location')}`,
    );
    const events = [];
    sideband.on('message', (payload) => events.push(JSON.parse(payload.toString('utf8'))));
    await once(sideband, 'open');

    peerOptions.onSpeechStart();
    const first = peerOptions.onSpeech(Buffer.from('first'));
    await waitFor(() => Boolean(firstSignal), 'expected the first coordinator request');
    peerOptions.onSpeechStart();
    const second = peerOptions.onSpeech(Buffer.from('second'));
    await waitFor(
      () => events.some((event) => (
        event.type === 'delegation.created'
        && event.item.content[0].text === 'second'
      )),
      'expected the second turn to overtake the stale turn',
    );

    assert.equal(firstSignal.aborted, true);
    assert.equal(stopCount, 2);
    releaseFirst({ action: 'delegate', input: 'first' });
    await Promise.all([first, second]);
    assert.equal(
      events.some((event) => (
        event.type === 'delegation.created'
        && event.item.content[0].text === 'first'
      )),
      false,
    );

    sideband.close();
    await once(sideband, 'close');
  } finally {
    releaseFirst({ action: 'delegate', input: 'first' });
    await voice.close();
    await close(server);
  }
});

test('Codex V3 retains muted stale delegation results for the next voice decision', async () => {
  let peerOptions;
  const histories = [];
  const spoken = [];
  const voice = createVoiceServer({
    enabled: () => true,
    transcribePcm: async (pcm) => pcm.toString(),
    coordinateTranscript: async (transcript, context) => {
      histories.push(structuredClone(context.voiceCoordinatorHistory));
      return { action: 'delegate', input: transcript };
    },
    streamSpeech: async function* (text) {
      spoken.push(text);
      yield { pcm: Buffer.from(`audio:${text}`), sampleRate: 24000 };
    },
    createPeer: async (options) => {
      peerOptions = options;
      return {
        answerSdp: 'v=0\r\na=setup:active\r\n',
        async playAudioStream(chunks) {
          await collectAudioStream(chunks);
        },
        async stopAudio() {},
        sendDataEvent() {},
        close() {},
      };
    },
  });
  const server = http.createServer((request, response) => {
    if (!voice.handleRequest(request, response)) {
      response.writeHead(404);
      response.end('not found');
    }
  });
  voice.attach(server);
  const port = await listen(server);

  try {
    const offer = await createV3Call(port);
    const sideband = new WebSocket(
      `ws://127.0.0.1:${port}${offer.headers.get('location')}`,
    );
    const events = [];
    sideband.on('message', (payload) => events.push(JSON.parse(payload.toString('utf8'))));
    await once(sideband, 'open');

    await peerOptions.onSpeech(Buffer.from('inspect the repository'));
    await waitFor(
      () => events.some((event) => event.type === 'delegation.created'),
      'expected the initial delegation',
    );
    const delegationId = events.find(
      (event) => event.type === 'delegation.created',
    ).item.id;

    peerOptions.onSpeechStart();
    sideband.send(JSON.stringify({
      type: 'delegation.context.append',
      delegation_item_id: delegationId,
      channel: 'speakable',
      content: [{ type: 'input_text', text: 'The repository has three failing tests.' }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(spoken, []);

    await peerOptions.onSpeech(Buffer.from('what did it find'));

    assert.deepEqual(histories.at(-1), [{
      role: 'developer',
      content: [{
        type: 'input_text',
        text: 'Codex handoff update: The repository has three failing tests.',
      }],
    }]);
    sideband.close();
    await once(sideband, 'close');
  } finally {
    await voice.close();
    await close(server);
  }
});

test('Codex V3 does not lose a handoff update that arrives during coordinator inference', async () => {
  let peerOptions;
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const histories = [];
  const spoken = [];
  const voice = createVoiceServer({
    enabled: () => true,
    transcribePcm: async (pcm) => pcm.toString(),
    coordinateTranscript: async (transcript, context) => {
      if (transcript === 'first request') {
        markFirstStarted();
        await firstGate;
        return { action: 'delegate', input: transcript };
      }
      histories.push(structuredClone(context.voiceCoordinatorHistory));
      return { action: 'delegate', input: transcript };
    },
    streamSpeech: async function* (text) {
      spoken.push(text);
      yield { pcm: Buffer.from(`audio:${text}`), sampleRate: 24000 };
    },
    createPeer: async (options) => {
      peerOptions = options;
      return {
        answerSdp: 'v=0\r\na=setup:active\r\n',
        async playAudioStream(chunks) {
          await collectAudioStream(chunks);
        },
        sendDataEvent() {},
        close() {},
      };
    },
  });
  const server = http.createServer((request, response) => {
    if (!voice.handleRequest(request, response)) {
      response.writeHead(404);
      response.end('not found');
    }
  });
  voice.attach(server);
  const port = await listen(server);

  try {
    const offer = await createV3Call(port);
    const sideband = new WebSocket(
      `ws://127.0.0.1:${port}${offer.headers.get('location')}`,
    );
    await once(sideband, 'open');

    const first = peerOptions.onSpeech(Buffer.from('first request'));
    await firstStarted;
    sideband.send(JSON.stringify({
      type: 'session.context.append',
      channel: 'commentary',
      content: [{ type: 'input_text', text: 'Codex is halfway through the task.' }],
    }));
    await waitFor(
      () => spoken.includes('Codex is halfway through the task.'),
      'expected the concurrent handoff update',
    );
    releaseFirst();
    await first;
    await peerOptions.onSpeech(Buffer.from('second request'));

    assert.deepEqual(histories[0], [{
      role: 'developer',
      content: [{
        type: 'input_text',
        text: 'Codex handoff update: Codex is halfway through the task.',
      }],
    }]);
    sideband.close();
    await once(sideband, 'close');
  } finally {
    releaseFirst();
    await voice.close();
    await close(server);
  }
});

test('Codex V3 WebRTC plays streamed coordinator phrases before inference completes', async () => {
  let peerOptions;
  let releaseDecision;
  const decisionGate = new Promise((resolve) => {
    releaseDecision = resolve;
  });
  const played = [];
  const voice = createVoiceServer({
    enabled: () => true,
    transcribePcm: async () => 'hello',
    coordinateTranscript: async (_transcript, context) => {
      await context.onSpeechPhrase('First phrase.');
      await decisionGate;
      await context.onSpeechPhrase('Second phrase.');
      return {
        action: 'speak',
        text: 'First phrase. Second phrase.',
        streamed: true,
      };
    },
    streamSpeech: async function* (text) {
      yield { pcm: Buffer.from(text), sampleRate: 24000 };
    },
    createPeer: async (options) => {
      peerOptions = options;
      return {
        answerSdp: 'v=0\r\na=setup:active\r\n',
        async playAudioStream(chunks) {
          await collectAudioStream(chunks, played);
        },
        async stopAudio() {},
        sendDataEvent() {},
        close() {},
      };
    },
  });
  const server = http.createServer((request, response) => {
    if (!voice.handleRequest(request, response)) {
      response.writeHead(404);
      response.end('not found');
    }
  });
  voice.attach(server);
  const port = await listen(server);

  try {
    const offer = await createV3Call(port);
    const sideband = new WebSocket(
      `ws://127.0.0.1:${port}${offer.headers.get('location')}`,
    );
    const events = [];
    sideband.on('message', (payload) => events.push(JSON.parse(payload.toString('utf8'))));
    await once(sideband, 'open');

    peerOptions.onSpeechStart();
    const speech = peerOptions.onSpeech(Buffer.from('voice'));
    await waitFor(() => played.length === 1, 'expected first model phrase playback');
    assert.deepEqual(played, ['First phrase.']);
    assert.equal(
      events.some((event) => event.type === 'turn.done' && event.turn.role === 'assistant'),
      false,
    );

    releaseDecision();
    await speech;
    await waitFor(
      () => events.some((event) => (
        event.type === 'turn.done' && event.turn.role === 'assistant'
      )),
      'expected one completed assistant turn',
    );
    assert.deepEqual(played, ['First phrase.', 'Second phrase.']);
    assert.equal(
      events.filter((event) => event.type === 'output_transcript.added').length,
      1,
    );

    sideband.close();
    await once(sideband, 'close');
  } finally {
    releaseDecision();
    await voice.close();
    await close(server);
  }
});

test('Codex V3 plays the first Kokoro sentence before later synthesis completes', async () => {
  const played = [];
  let releaseSecond;
  const secondReady = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  const voice = createVoiceServer({
    enabled: () => true,
    streamSpeech: async function* (text) {
      assert.equal(text, 'First sentence. Second sentence.');
      yield { text: 'First sentence.', pcm: Buffer.from('first'), sampleRate: 24000 };
      await secondReady;
      yield { text: 'Second sentence.', pcm: Buffer.from('second'), sampleRate: 24000 };
    },
    createPeer: async () => ({
      answerSdp: 'v=0\r\na=setup:active\r\n',
      async playAudioStream(chunks) {
        for await (const chunk of chunks) played.push(chunk.pcm.toString());
      },
      sendDataEvent() {},
      close() {},
    }),
  });
  const server = http.createServer((request, response) => {
    if (!voice.handleRequest(request, response)) {
      response.writeHead(404);
      response.end('not found');
    }
  });
  voice.attach(server);
  const port = await listen(server);

  try {
    const offer = await createV3Call(port);
    const sideband = new WebSocket(
      `ws://127.0.0.1:${port}${offer.headers.get('location')}`,
    );
    const events = [];
    sideband.on('message', (payload) => events.push(JSON.parse(payload.toString('utf8'))));
    await once(sideband, 'open');

    sideband.send(JSON.stringify({
      type: 'delegation.context.append',
      channel: 'speakable',
      content: [{
        type: 'input_text',
        text: 'First sentence. Second sentence.',
      }],
    }));
    await waitFor(() => played.length === 1, 'expected the first sentence to start playing');
    assert.deepEqual(played, ['first']);
    assert.equal(
      events.some((event) => event.type === 'turn.done' && event.turn.role === 'assistant'),
      false,
    );

    releaseSecond();
    await waitFor(
      () => events.some((event) => (
        event.type === 'turn.done' && event.turn.role === 'assistant'
      )),
      'expected assistant completion after streamed playback',
    );
    assert.deepEqual(played, ['first', 'second']);

    sideband.close();
    await once(sideband, 'close');
  } finally {
    releaseSecond();
    await voice.close();
    await close(server);
  }
});

test('Codex V3 announces the live session to the browser and sideband', async () => {
  const browserEvents = [];
  const voice = createVoiceServer({
    enabled: () => true,
    createPeer: async () => ({
      answerSdp: 'v=0\r\na=setup:active\r\n',
      sendDataEvent(event) {
        browserEvents.push(event);
      },
      close() {},
    }),
  });
  const server = http.createServer((request, response) => {
    if (!voice.handleRequest(request, response)) {
      response.writeHead(404);
      response.end('not found');
    }
  });
  voice.attach(server);
  const port = await listen(server);

  try {
    const offer = await createV3Call(port);
    assert.equal(offer.status, 201);
    const location = offer.headers.get('location');
    const callId = location.split('/').at(-1);

    assert.deepEqual(browserEvents, [{
      type: 'session.started',
      session: {
        id: `sess_${callId}`,
        instructions: 'Codex V3 voice session',
      },
    }]);

    const sideband = new WebSocket(`ws://127.0.0.1:${port}${location}`);
    const sidebandEvents = [];
    sideband.on('message', (payload) => {
      sidebandEvents.push(JSON.parse(payload.toString('utf8')));
    });
    await once(sideband, 'open');
    await waitFor(
      () => sidebandEvents.length === 1,
      'expected session.started on the Codex sideband',
    );
    assert.deepEqual(sidebandEvents, browserEvents);
    sideband.close();
    await once(sideband, 'close');
  } finally {
    await voice.close();
    await close(server);
  }
});

test('Codex V3 sideband startup survives a browser event delivery failure', async () => {
  const voice = createVoiceServer({
    enabled: () => true,
    createPeer: async () => ({
      answerSdp: 'v=0\r\na=setup:active\r\n',
      sendDataEvent() {
        throw new Error('browser data channel unavailable');
      },
      close() {},
    }),
  });
  const server = http.createServer((request, response) => {
    if (!voice.handleRequest(request, response)) {
      response.writeHead(404);
      response.end('not found');
    }
  });
  voice.attach(server);
  const port = await listen(server);

  try {
    const offer = await createV3Call(port);
    assert.equal(offer.status, 201);
    const sideband = new WebSocket(
      `ws://127.0.0.1:${port}${offer.headers.get('location')}`,
    );
    const events = [];
    sideband.on('message', (payload) => {
      events.push(JSON.parse(payload.toString('utf8')));
    });
    await once(sideband, 'open');
    await waitFor(
      () => events.some((event) => event.type === 'session.started'),
      'expected sideband startup after browser delivery failed',
    );
    sideband.close();
    await once(sideband, 'close');
  } finally {
    await voice.close();
    await close(server);
  }
});

test('Codex V3 WebRTC bounds context and queued Kokoro output', async () => {
  let finishSynthesis;
  const synthesisStarted = new Promise((resolve) => {
    finishSynthesis = resolve;
  });
  let synthesisCount = 0;
  const voice = createVoiceServer({
    enabled: () => true,
    transcribePcm: async () => '',
    streamSpeech: async function* () {
      synthesisCount += 1;
      await synthesisStarted;
      yield { pcm: Buffer.from('audio'), sampleRate: 24000 };
    },
    createPeer: async () => ({
      answerSdp: 'v=0\r\na=setup:active\r\n',
      async playAudioStream(chunks) {
        await collectAudioStream(chunks);
      },
      close() {},
    }),
  });
  const server = http.createServer((request, response) => {
    if (!voice.handleRequest(request, response)) {
      response.writeHead(404);
      response.end('not found');
    }
  });
  voice.attach(server);
  const port = await listen(server);

  try {
    const offer = await createV3Call(port);
    const location = offer.headers.get('location');
    const sideband = new WebSocket(`ws://127.0.0.1:${port}${location}`);
    await once(sideband, 'open');
    const events = [];
    sideband.on('message', (payload) => events.push(JSON.parse(payload.toString('utf8'))));
    const append = (text) => sideband.send(JSON.stringify({
      type: 'delegation.context.append',
      channel: 'speakable',
      content: [{ type: 'input_text', text }],
    }));

    append('x'.repeat(501));
    await waitFor(
      () => events.some((event) => event.type === 'error'),
      'expected oversized context rejection',
    );
    assert.match(events.at(-1).error.message, /exceeds 500 bytes/u);

    for (let index = 0; index < 9; index += 1) append(`output ${index}`);
    await waitFor(
      () => events.some((event) => (
        event.type === 'error' && /queue is full/u.test(event.error.message)
      )),
      'expected full output queue rejection',
    );
    assert.equal(synthesisCount, 1);
    finishSynthesis();
    sideband.close();
    await once(sideband, 'close');
  } finally {
    finishSynthesis();
    await voice.close();
    await close(server);
  }
});

test('Codex V3 WebRTC cancels queued Kokoro output when sideband disconnects', async () => {
  let releaseSynthesis;
  const synthesisGate = new Promise((resolve) => {
    releaseSynthesis = resolve;
  });
  let synthesisCount = 0;
  let playbackCount = 0;
  let stopped = false;
  const voice = createVoiceServer({
    enabled: () => true,
    transcribePcm: async () => '',
    streamSpeech: async function* () {
      synthesisCount += 1;
      await synthesisGate;
      yield { pcm: Buffer.from('audio'), sampleRate: 24000 };
    },
    createPeer: async () => ({
      answerSdp: 'v=0\r\na=setup:active\r\n',
      async playAudioStream(chunks) {
        await collectAudioStream(chunks);
        if (!stopped) playbackCount += 1;
      },
      stopAudio() {
        stopped = true;
      },
      close() {},
    }),
  });
  const server = http.createServer((request, response) => {
    if (!voice.handleRequest(request, response)) {
      response.writeHead(404);
      response.end('not found');
    }
  });
  voice.attach(server);
  const port = await listen(server);

  try {
    const offer = await createV3Call(port);
    const sideband = new WebSocket(
      `ws://127.0.0.1:${port}${offer.headers.get('location')}`,
    );
    await once(sideband, 'open');
    const append = (text) => sideband.send(JSON.stringify({
      type: 'delegation.context.append',
      channel: 'speakable',
      content: [{ type: 'input_text', text }],
    }));
    append('first');
    append('second');
    while (synthesisCount === 0) await new Promise((resolve) => setImmediate(resolve));

    sideband.close();
    await once(sideband, 'close');
    await waitFor(() => voice.calls.size === 0, 'expected disconnected call cleanup');
    releaseSynthesis();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(synthesisCount, 1);
    assert.equal(playbackCount, 0);
  } finally {
    releaseSynthesis();
    await voice.close();
    await close(server);
  }
});

test('Codex V3 WebRTC closes oversized sideband messages without crashing', async () => {
  const voice = createVoiceServer({
    enabled: () => true,
    transcribePcm: async () => '',
    createPeer: async () => ({
      answerSdp: 'v=0\r\na=setup:active\r\n',
      async playAudioStream(chunks) {
        await collectAudioStream(chunks);
      },
      close() {},
    }),
  });
  const server = http.createServer((request, response) => {
    if (!voice.handleRequest(request, response)) {
      response.writeHead(404);
      response.end('not found');
    }
  });
  voice.attach(server);
  const port = await listen(server);

  try {
    const offer = await createV3Call(port);
    const sideband = new WebSocket(
      `ws://127.0.0.1:${port}${offer.headers.get('location')}`,
    );
    await once(sideband, 'open');
    sideband.send('x'.repeat(1024 * 1024 + 1));
    const [code] = await once(sideband, 'close');
    assert.equal(code, 1009);
    await waitFor(() => voice.calls.size === 0, 'expected oversized call cleanup');
  } finally {
    await voice.close();
    await close(server);
  }
});

test('abandoned realtime calls expire when their sideband never connects', async () => {
  let peerCloseCount = 0;
  const voice = createVoiceServer({
    enabled: () => true,
    sidebandJoinTimeoutMs: 20,
    createPeer: async () => ({
      answerSdp: 'v=0\r\na=setup:active\r\n',
      close() {
        peerCloseCount += 1;
      },
    }),
  });
  const server = http.createServer((request, response) => {
    if (!voice.handleRequest(request, response)) response.end();
  });
  voice.attach(server);
  const port = await listen(server);

  try {
    const offer = await createV3Call(port);
    assert.equal(offer.status, 201);
    assert.equal(voice.calls.size, 1);
    while (voice.calls.size !== 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(peerCloseCount, 1);
  } finally {
    await voice.close();
    await close(server);
  }
});

test('Werift peer accepts a Codex-style offer and streams Kokoro PCM over WebRTC', async () => {
  let createWeriftVoicePeer;
  try {
    ({ createWeriftVoicePeer } = require('../src/voice-agent/werift-voice-peer'));
  } catch (error) {
    assert.fail(`Werift voice peer is unavailable: ${error.message}`);
  }

  const client = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
  const microphone = new MediaStreamTrack({ kind: 'audio' });
  const microphoneStream = new MediaStream([microphone]);
  client.addTrack(microphone, microphoneStream);
  const dataChannel = client.createDataChannel('oai-events');
  const clientMessages = [];
  dataChannel.onmessage = (event) => clientMessages.push(JSON.parse(event.data));
  const remoteTracks = [];
  const receivedAudio = [];
  client.ontrack = (event) => {
    remoteTracks.push(event.track);
    event.track.onReceiveRtp.subscribe((packet) => receivedAudio.push(packet));
  };
  const offer = await client.createOffer();
  await client.setLocalDescription(offer);

  const peer = await createWeriftVoicePeer({
    offerSdp: client.localDescription.sdp,
    onSpeech: async () => {},
  });
  await client.setRemoteDescription({ type: 'answer', sdp: peer.answerSdp });
  if (dataChannel.readyState !== 'open') await once(dataChannel, 'open');

  peer.sendDataEvent({
    type: 'session.updated',
    session: { id: 'sess_local' },
  });
  while (clientMessages.length === 0) await once(dataChannel, 'message');
  const expectedOpusPayloadType = Number(
    client.localDescription.sdp.match(/^a=rtpmap:(\d+) opus\/48000\/2$/mi)[1],
  );
  const pcm = Buffer.alloc(24000 / 5 * 4);
  for (let offset = 0; offset < pcm.length; offset += 4) {
    pcm.writeFloatLE(offset % 800 < 400 ? 0.5 : -0.5, offset);
  }
  await peer.playAudioStream((async function* () {
    yield { pcm, sampleRate: 24000 };
  })());
  while (receivedAudio.length === 0) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(remoteTracks.length, 1);
  assert.equal(remoteTracks[0].kind, 'audio');
  assert.equal(receivedAudio[0].header.payloadType, expectedOpusPayloadType);
  assert.deepEqual(clientMessages, [{
    type: 'session.updated',
    session: { id: 'sess_local' },
  }]);

  await peer.close();
  await client.close();
});
