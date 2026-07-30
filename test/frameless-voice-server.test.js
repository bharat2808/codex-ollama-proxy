'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const test = require('node:test');
const WebSocket = require('ws');

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

async function createServer(options = {}) {
  const { createFramelessVoiceServer } = require('../src/voice-agent/frameless-voice-server');
  const voice = createFramelessVoiceServer({
    enabled: () => true,
    transcribePcm: async () => 'inspect the current repository',
    synthesizeSpeech: async () => float32Wav([0, 0.25, -0.25, 0]),
    ...options,
  });
  const server = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  voice.attach(server);
  return { voice, server, port: await listen(server) };
}

function float32Wav(samples) {
  const pcm = Buffer.alloc(samples.length * 4);
  samples.forEach((sample, index) => pcm.writeFloatLE(sample, index * 4));
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(3, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(32, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

test('Codex frameless live transport transcribes PCM and creates a client delegation', async () => {
  const { voice, server, port } = await createServer();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/live`);

  try {
    await once(socket, 'open');
    socket.send(JSON.stringify({
      type: 'session.update',
      session: {
        instructions: 'Codex voice session',
        audio: { output: { voice: 'ash' } },
        delegation: { type: 'client' },
      },
    }));
    const [startedRaw] = await once(socket, 'message');
    const started = JSON.parse(startedRaw.toString());
    assert.equal(started.type, 'session.started');

    const events = [];
    socket.on('message', (raw) => events.push(JSON.parse(raw.toString())));
    const speech = Buffer.alloc(24000 * 0.3 * 2, 0);
    for (let offset = 0; offset < speech.length; offset += 2) speech.writeInt16LE(4000, offset);
    const silence = Buffer.alloc(24000 * 0.7 * 2, 0);
    socket.send(JSON.stringify({ type: 'input_audio.append', audio: speech.toString('base64') }));
    socket.send(JSON.stringify({ type: 'input_audio.append', audio: silence.toString('base64') }));
    while (!events.some((event) => event.type === 'delegation.created')) {
      await once(socket, 'message');
    }

    assert.equal(
      events.find((event) => event.type === 'input_transcript.added').item.text,
      'inspect the current repository',
    );
    const delegation = events.find((event) => event.type === 'delegation.created');
    assert.equal(delegation.item.type, 'delegation');
    assert.equal(delegation.item.target, 'client');
    assert.equal(delegation.item.content[0].text, 'inspect the current repository');

    socket.send(JSON.stringify({
      type: 'delegation.context.append',
      delegation_item_id: delegation.item.id,
      channel: 'speakable',
      content: [{ type: 'input_text', text: 'The repository is ready.' }],
    }));
    while (!events.some((event) => event.type === 'output_audio.delta')) {
      await once(socket, 'message');
    }
    const audio = Buffer.from(
      events.find((event) => event.type === 'output_audio.delta').audio,
      'base64',
    );
    assert.deepEqual([...audio.values()], [0, 0, 0, 32, 0, 224, 0, 0]);
    assert.equal(
      events.find((event) => event.type === 'output_transcript.added').item.text,
      'The repository is ready.',
    );
  } finally {
    socket.close();
    await once(socket, 'close');
    await voice.close();
    await close(server);
  }
});

test('frameless live transport rejects browser-originated WebSocket upgrades', async () => {
  const { voice, server, port } = await createServer();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/live`, {
    origin: 'https://attacker.example',
  });
  try {
    const [error] = await once(socket, 'error');
    assert.match(error.message, /Unexpected server response: 403/);
  } finally {
    await voice.close();
    await close(server);
  }
});

test('session.close flushes a final speech segment before closing', async () => {
  let transcribedBytes = 0;
  const { voice, server, port } = await createServer({
    transcribePcm: async (pcm) => {
      transcribedBytes = pcm.length;
      return 'final unsilenced request';
    },
  });
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/live`);
  const events = [];
  socket.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  try {
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'session.update', session: {} }));
    while (!events.some((event) => event.type === 'session.started')) await once(socket, 'message');
    const speech = Buffer.alloc(24000 * 0.3 * 2);
    for (let offset = 0; offset < speech.length; offset += 2) speech.writeInt16LE(4000, offset);
    socket.send(JSON.stringify({ type: 'input_audio.append', audio: speech.toString('base64') }));
    socket.send(JSON.stringify({ type: 'session.close' }));
    await once(socket, 'close');

    assert.equal(transcribedBytes, speech.length);
    assert.equal(
      events.find((event) => event.type === 'delegation.created').item.content[0].text,
      'final unsilenced request',
    );
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) socket.close();
    await voice.close();
    await close(server);
  }
});

test('frameless live transport bounds context work before invoking Kokoro', async () => {
  let syntheses = 0;
  const { voice, server, port } = await createServer({
    synthesizeSpeech: async () => {
      syntheses += 1;
      return float32Wav([0]);
    },
  });
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/live`);
  const events = [];
  socket.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  try {
    await once(socket, 'open');
    socket.send(JSON.stringify({
      type: 'session.context.append',
      channel: 'speakable',
      content: [{ type: 'input_text', text: 'x'.repeat(501) }],
    }));
    while (!events.some((event) => event.type === 'error')) await once(socket, 'message');
    assert.equal(syntheses, 0);
    assert.match(events.find((event) => event.type === 'error').error.message, /500 bytes/);
  } finally {
    socket.close();
    await once(socket, 'close');
    await voice.close();
    await close(server);
  }
});

test('frameless live transport closes oversized WebSocket messages', async () => {
  const { voice, server, port } = await createServer();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/live`);
  try {
    await once(socket, 'open');
    socket.send('x'.repeat(1024 * 1024 + 1));
    const [code] = await once(socket, 'close');
    assert.equal(code, 1009);
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) socket.close();
    await voice.close();
    await close(server);
  }
});
