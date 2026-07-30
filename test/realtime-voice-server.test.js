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

test('Codex multipart realtime call creation returns the local WebRTC answer and call location', async () => {
  const { createRealtimeVoiceServer } = loadRealtimeVoice();
  const offers = [];
  const voice = createRealtimeVoiceServer({
    enabled: () => true,
    createPeer: async (offer) => {
      offers.push(offer);
      return {
        answerSdp: 'v=0\r\na=setup:active\r\n',
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
    const boundary = 'codex-realtime-call-boundary';
    const offerSdp = 'v=0\r\na=setup:actpass\r\n';
    const session = {
      type: 'realtime',
      instructions: 'Speak naturally.',
      output_modalities: ['audio'],
    };
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="sdp"',
      'Content-Type: application/sdp',
      '',
      offerSdp,
      `--${boundary}`,
      'Content-Disposition: form-data; name="session"',
      'Content-Type: application/json',
      '',
      JSON.stringify(session),
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const response = await fetch(
      `http://127.0.0.1:${port}/v1/realtime/calls?intent=quicksilver&architecture=avas`,
      {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(Buffer.byteLength(body)),
        },
        body,
      },
    );

    assert.equal(response.status, 201);
    assert.equal(response.headers.get('content-type'), 'application/sdp');
    assert.match(response.headers.get('location'), /^\/v1\/realtime\/calls\/call_[a-f0-9-]+$/u);
    assert.equal(await response.text(), 'v=0\r\na=setup:active\r\n');
    assert.equal(offers.length, 1);
    assert.equal(offers[0].offerSdp, offerSdp);
    assert.deepEqual(offers[0].session, session);
  } finally {
    await voice.close();
    await close(server);
  }
});

test('Codex V3 WebRTC live route uses frameless delegation and Kokoro playback', async () => {
  const { createRealtimeVoiceServer } = loadRealtimeVoice();
  let peerOptions;
  const spoken = [];
  const played = [];
  const browserEvents = [];
  const voice = createRealtimeVoiceServer({
    enabled: () => true,
    transcribePcm: async () => 'inspect the repository',
    synthesizeSpeech: async (text) => {
      spoken.push(text);
      return Buffer.from(`audio:${text}`);
    },
    createPeer: async (options) => {
      peerOptions = options;
      return {
        answerSdp: 'v=0\r\na=setup:active\r\n',
        async playAudio(audio) {
          played.push(audio.toString('utf8'));
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
    assert.deepEqual(
      events.slice(0, 4).map((event) => event.type),
      ['session.started', 'input_transcript.added', 'turn.done', 'delegation.created'],
    );

    sideband.send(JSON.stringify({
      type: 'delegation.context.append',
      delegation_item_id: delegation.item.id,
      channel: 'speakable',
      content: [{ type: 'input_text', text: 'I inspected it.' }],
    }));
    while (!events.some((event) => (
      event.type === 'turn.done' && event.turn.role === 'assistant'
    ))) {
      await once(sideband, 'message');
    }
    assert.deepEqual(spoken, ['I inspected it.']);
    assert.deepEqual(played, ['audio:I inspected it.']);
    assert.equal(
      events.find((event) => event.type === 'output_transcript.added').item.text,
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

test('Codex V3 announces the live session to the browser and sideband', async () => {
  const { createRealtimeVoiceServer } = loadRealtimeVoice();
  const browserEvents = [];
  const voice = createRealtimeVoiceServer({
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
  const { createRealtimeVoiceServer } = loadRealtimeVoice();
  const voice = createRealtimeVoiceServer({
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
  const { createRealtimeVoiceServer } = loadRealtimeVoice();
  let finishSynthesis;
  const synthesisStarted = new Promise((resolve) => {
    finishSynthesis = resolve;
  });
  let synthesisCount = 0;
  const voice = createRealtimeVoiceServer({
    enabled: () => true,
    transcribePcm: async () => '',
    synthesizeSpeech: async () => {
      synthesisCount += 1;
      await synthesisStarted;
      return Buffer.from('audio');
    },
    createPeer: async () => ({
      answerSdp: 'v=0\r\na=setup:active\r\n',
      async playAudio() {},
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
  const { createRealtimeVoiceServer } = loadRealtimeVoice();
  let releaseSynthesis;
  const synthesisGate = new Promise((resolve) => {
    releaseSynthesis = resolve;
  });
  let synthesisCount = 0;
  let playbackCount = 0;
  const voice = createRealtimeVoiceServer({
    enabled: () => true,
    transcribePcm: async () => '',
    synthesizeSpeech: async () => {
      synthesisCount += 1;
      await synthesisGate;
      return Buffer.from('audio');
    },
    createPeer: async () => ({
      answerSdp: 'v=0\r\na=setup:active\r\n',
      async playAudio() {
        playbackCount += 1;
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
  const { createRealtimeVoiceServer } = loadRealtimeVoice();
  const voice = createRealtimeVoiceServer({
    enabled: () => true,
    transcribePcm: async () => '',
    synthesizeSpeech: async () => Buffer.from('audio'),
    createPeer: async () => ({
      answerSdp: 'v=0\r\na=setup:active\r\n',
      async playAudio() {},
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

test('Codex sideband joins the returned call id and initializes the realtime session', async () => {
  const { createRealtimeVoiceServer } = loadRealtimeVoice();
  let peerCloseCount = 0;
  const voice = createRealtimeVoiceServer({
    enabled: () => true,
    createPeer: async () => ({
      answerSdp: 'v=0\r\na=setup:active\r\n',
      close() {
        peerCloseCount += 1;
      },
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
    const offer = await fetch(`http://127.0.0.1:${port}/v1/realtime/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/sdp' },
      body: 'v=0\r\na=setup:actpass\r\n',
    });
    assert.equal(offer.status, 201);
    const callId = offer.headers.get('location').split('/').at(-1);
    const sideband = new WebSocket(
      `ws://127.0.0.1:${port}/v1/realtime?intent=quicksilver&call_id=${callId}`,
    );
    await once(sideband, 'open');
    sideband.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'quicksilver',
        instructions: 'Codex voice session',
      },
    }));
    const [payload] = await once(sideband, 'message');
    const event = JSON.parse(payload.toString('utf8'));

    assert.equal(event.type, 'session.updated');
    assert.equal(event.session.id, `sess_${callId}`);
    assert.equal(event.session.instructions, 'Codex voice session');
    sideband.close();
    await once(sideband, 'close');
    while (voice.calls.size !== 0) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(peerCloseCount, 1);
  } finally {
    await voice.close();
    await close(server);
  }
});

test('abandoned realtime calls expire when their sideband never connects', async () => {
  const { createRealtimeVoiceServer } = loadRealtimeVoice();
  let peerCloseCount = 0;
  const voice = createRealtimeVoiceServer({
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
    const offer = await fetch(`http://127.0.0.1:${port}/v1/realtime/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/sdp' },
      body: 'v=0\r\na=setup:actpass\r\n',
    });
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

test('a completed local speech segment is transcribed and handed off to the normal Codex turn', async () => {
  const { createRealtimeVoiceServer } = loadRealtimeVoice();
  let peerOptions;
  const voice = createRealtimeVoiceServer({
    enabled: () => true,
    transcribePcm: async (pcm) => {
      assert.deepEqual(pcm, Buffer.from([1, 2, 3, 4]));
      return 'list the files in this project';
    },
    createPeer: async (options) => {
      peerOptions = options;
      return {
        answerSdp: 'v=0\r\na=setup:active\r\n',
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
    const offer = await fetch(`http://127.0.0.1:${port}/v1/realtime/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/sdp' },
      body: 'v=0\r\na=setup:actpass\r\n',
    });
    const callId = offer.headers.get('location').split('/').at(-1);
    const sideband = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime?call_id=${callId}`);
    await once(sideband, 'open');
    sideband.send(JSON.stringify({
      type: 'session.update',
      session: { type: 'quicksilver', instructions: 'Codex voice session' },
    }));
    await once(sideband, 'message');

    const events = [];
    sideband.on('message', (payload) => events.push(JSON.parse(payload.toString('utf8'))));
    await peerOptions.onSpeech(Buffer.from([1, 2, 3, 4]));
    while (events.length < 3) await once(sideband, 'message');

    assert.deepEqual(events.map((event) => event.type), [
      'conversation.input_transcript.delta',
      'conversation.item.input_audio_transcription.completed',
      'conversation.handoff.requested',
    ]);
    assert.equal(events[0].delta, 'list the files in this project');
    assert.equal(events[1].transcript, 'list the files in this project');
    assert.equal(events[2].input_transcript, 'list the files in this project');
    assert.match(events[2].handoff_id, /^handoff_[a-f0-9-]+$/u);
    assert.match(events[2].item_id, /^item_[a-f0-9-]+$/u);
    sideband.close();
    await once(sideband, 'close');
  } finally {
    await voice.close();
    await close(server);
  }
});

test('Codex handoff commentary and final output are synthesized and played over WebRTC', async () => {
  const { createRealtimeVoiceServer } = loadRealtimeVoice();
  const spoken = [];
  const played = [];
  const voice = createRealtimeVoiceServer({
    enabled: () => true,
    synthesizeSpeech: async (text) => {
      spoken.push(text);
      return Buffer.from(`audio:${text}`);
    },
    createPeer: async () => ({
      answerSdp: 'v=0\r\na=setup:active\r\n',
      async playAudio(audio) {
        played.push(audio.toString('utf8'));
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
    const offer = await fetch(`http://127.0.0.1:${port}/v1/realtime/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/sdp' },
      body: 'v=0\r\na=setup:actpass\r\n',
    });
    const callId = offer.headers.get('location').split('/').at(-1);
    const sideband = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime?call_id=${callId}`);
    await once(sideband, 'open');
    sideband.send(JSON.stringify({
      type: 'session.update',
      session: { type: 'quicksilver', instructions: 'Codex voice session' },
    }));
    await once(sideband, 'message');

    sideband.send(JSON.stringify({
      type: 'conversation.handoff.append',
      handoff_id: 'handoff_test',
      output_text: 'I will inspect the files now.',
    }));
    sideband.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: 'handoff_test',
        output: '"Agent Final Message":\n\nThere are twelve files.',
      },
    }));

    const outputEvents = [];
    sideband.on('message', (payload) => {
      outputEvents.push(JSON.parse(payload.toString('utf8')));
    });
    while (outputEvents.filter((event) => (
      event.type === 'response.output_audio_transcript.done'
    )).length < 2) {
      await once(sideband, 'message');
    }

    assert.deepEqual(spoken, [
      'I will inspect the files now.',
      'There are twelve files.',
    ]);
    assert.deepEqual(played, [
      'audio:I will inspect the files now.',
      'audio:There are twelve files.',
    ]);
    assert.deepEqual(
      outputEvents.filter((event) => event.type === 'response.output_audio_transcript.done')
        .map((event) => event.transcript),
      spoken,
    );
    sideband.close();
    await once(sideband, 'close');
  } finally {
    await voice.close();
    await close(server);
  }
});

test('Werift peer accepts a Codex-style audio and oai-events WebRTC offer', async () => {
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
  const pcm = Buffer.alloc(16000 / 5 * 2);
  for (let offset = 0; offset < pcm.length; offset += 2) {
    pcm.writeInt16LE(offset % 400 < 200 ? 4000 : -4000, offset);
  }
  await peer.playAudio(pcm16ToWav(pcm));
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
