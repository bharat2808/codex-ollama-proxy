'use strict';

const { randomUUID } = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');
const { PcmSpeechSegmenter } = require('./voice-audio');

const MAX_WS_PAYLOAD_BYTES = 1024 * 1024;
const MAX_AUDIO_CHUNK_BYTES = 1024 * 1024;
const MAX_QUEUED_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_CONTEXT_BYTES = 500;
const MAX_PENDING_OUTPUTS = 8;

function wavFormat(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('Kokoro returned an invalid WAV');
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) throw new Error('Kokoro WAV contains a truncated chunk');
    if (id === 'fmt ' && size >= 16) {
      format = {
        audioFormat: wav.readUInt16LE(start),
        channels: wav.readUInt16LE(start + 2),
        sampleRate: wav.readUInt32LE(start + 4),
        bitsPerSample: wav.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      data = wav.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!format || !data) throw new Error('Kokoro WAV is missing format or audio data');
  return { ...format, data };
}

function wavToPcm16(wav) {
  const format = wavFormat(wav);
  if (format.channels !== 1 || format.sampleRate !== 24000) {
    throw new Error('Kokoro WAV must be mono 24 kHz audio');
  }
  if (format.audioFormat === 1 && format.bitsPerSample === 16) {
    return Buffer.from(format.data);
  }
  if (format.audioFormat !== 3 || format.bitsPerSample !== 32) {
    throw new Error('Kokoro WAV must contain PCM16 or float32 audio');
  }
  const pcm = Buffer.alloc(Math.floor(format.data.length / 4) * 2);
  for (let input = 0, output = 0; input + 3 < format.data.length; input += 4, output += 2) {
    const sample = Math.max(-1, Math.min(1, format.data.readFloatLE(input)));
    const value = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
    pcm.writeInt16LE(value, output);
  }
  return pcm;
}

function contextText(event) {
  if (
    event.type !== 'delegation.context.append'
    && event.type !== 'session.context.append'
  ) {
    return '';
  }
  if (event.channel && event.channel !== 'speakable' && event.channel !== 'commentary') {
    return '';
  }
  return Array.isArray(event.content)
    ? event.content
      .filter((item) => item && item.type === 'input_text')
      .map((item) => String(item.text || ''))
      .join('')
    : '';
}

function createFramelessVoiceServer({
  enabled = () => false,
  transcribePcm,
  synthesizeSpeech,
  log = () => {},
} = {}) {
  if (typeof transcribePcm !== 'function') throw new Error('transcribePcm is required');
  if (typeof synthesizeSpeech !== 'function') throw new Error('synthesizeSpeech is required');
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
  });
  const sockets = new Set();
  let attachedServer = null;

  function send(socket, event) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  }

  function attach(server) {
    if (attachedServer === server) return;
    if (attachedServer) throw new Error('frameless voice server is already attached');
    attachedServer = server;
    attachedServer.on('upgrade', onUpgrade);
  }

  function onUpgrade(request, socket, head) {
    let url;
    try {
      url = new URL(request.url, 'http://127.0.0.1');
    } catch {
      return;
    }
    if (url.pathname !== '/v1/live') return;
    if (request.headers.origin) {
      log('frameless voice upgrade rejected: browser Origin header is not allowed');
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!enabled()) {
      log('frameless voice upgrade rejected: local voice is disabled');
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      log('frameless voice websocket connected');
      sockets.add(websocket);
      const session = {
        id: `sess_${randomUUID()}`,
        instructions: '',
        sampleRate: 24000,
        accepting: true,
        closed: false,
        queuedAudioBytes: 0,
        pendingOutputs: 0,
      };
      const segmenter = new PcmSpeechSegmenter({
        sampleRate: session.sampleRate,
        onSpeech(pcm) {
          log(`frameless voice speech segment queued: ${pcm.length} PCM bytes`);
          const job = session.speechQueue.then(async () => {
            if (session.closed) return;
            const transcript = String(await transcribePcm(pcm, session) || '').trim();
            if (!transcript || session.closed) return;
            log(`frameless voice transcription completed: ${Buffer.byteLength(transcript, 'utf8')} text bytes`);
            const inputId = `input_${randomUUID()}`;
            const delegationId = `delegation_${randomUUID()}`;
            send(websocket, {
              type: 'input_transcript.added',
              item: { id: inputId, type: 'input_transcript', text: transcript },
            });
            send(websocket, {
              type: 'turn.done',
              turn: { id: `turn_${randomUUID()}`, role: 'user', transcript },
            });
            send(websocket, {
              type: 'delegation.created',
              item: {
                id: delegationId,
                type: 'delegation',
                target: 'client',
                content: [{ type: 'input_text', text: transcript }],
              },
            });
          });
          session.speechQueue = job.catch((error) => {
            log(`frameless voice transcription failed: ${error.message}`);
            send(websocket, { type: 'error', error: { message: error.message } });
          });
          return job;
        },
      });
      session.inputQueue = Promise.resolve();
      session.speechQueue = Promise.resolve();
      session.outputQueue = Promise.resolve();

      function sendError(message) {
        log(`frameless voice request rejected: ${message}`);
        send(websocket, { type: 'error', error: { message } });
      }

      async function finishSession() {
        if (!session.accepting) return;
        session.accepting = false;
        try {
          await session.inputQueue;
          await segmenter.flush();
          await session.speechQueue;
          await session.outputQueue;
        } catch (error) {
          log(`frameless voice session close failed: ${error.message}`);
        }
        if (!session.closed) websocket.close();
      }

      websocket.on('message', (payload, isBinary) => {
        if (isBinary || !session.accepting) return;
        let event;
        try {
          event = JSON.parse(payload.toString('utf8'));
        } catch {
          return;
        }
        if (event.type === 'session.update') {
          session.instructions = String(event.session && event.session.instructions || '');
          log(`frameless voice session started: ${session.id}`);
          send(websocket, {
            type: 'session.started',
            session: {
              id: session.id,
              instructions: session.instructions,
            },
          });
          return;
        }
        if (event.type === 'input_audio.append' && typeof event.audio === 'string') {
          const pcm = Buffer.from(event.audio, 'base64');
          if (pcm.length > MAX_AUDIO_CHUNK_BYTES) {
            sendError(`input audio chunk exceeds ${MAX_AUDIO_CHUNK_BYTES} bytes`);
            return;
          }
          if (session.queuedAudioBytes + pcm.length > MAX_QUEUED_AUDIO_BYTES) {
            sendError('input audio queue is full');
            return;
          }
          session.queuedAudioBytes += pcm.length;
          const inputJob = session.inputQueue.then(async () => {
            session.queuedAudioBytes -= pcm.length;
            if (!session.closed) await segmenter.push(pcm);
          });
          session.inputQueue = inputJob.catch((error) => {
            log(`frameless voice audio processing failed: ${error.message}`);
            send(websocket, { type: 'error', error: { message: error.message } });
          });
          return;
        }
        if (event.type === 'session.close') {
          finishSession();
          return;
        }
        const text = contextText(event).trim();
        if (!text) return;
        if (Buffer.byteLength(text, 'utf8') > MAX_CONTEXT_BYTES) {
          sendError(`voice context exceeds ${MAX_CONTEXT_BYTES} bytes`);
          return;
        }
        if (session.pendingOutputs >= MAX_PENDING_OUTPUTS) {
          sendError('voice output queue is full');
          return;
        }
        session.pendingOutputs += 1;
        const job = session.outputQueue.then(async () => {
          if (session.closed) return;
          log(`frameless voice synthesis started: ${Buffer.byteLength(text, 'utf8')} text bytes`);
          const audio = wavToPcm16(await synthesizeSpeech(text, session));
          if (session.closed) return;
          log(`frameless voice synthesis completed: ${audio.length} PCM bytes`);
          send(websocket, {
            type: 'output_transcript.added',
            item: { id: `output_${randomUUID()}`, type: 'output_transcript', text },
          });
          send(websocket, {
            type: 'output_audio.delta',
            audio: audio.toString('base64'),
            start_ms: 0,
            end_ms: Math.round(audio.length / 2 / 24000 * 1000),
          });
          send(websocket, {
            type: 'turn.done',
            turn: { id: `turn_${randomUUID()}`, role: 'assistant', transcript: text },
          });
        });
        session.outputQueue = job
          .catch((error) => {
            log(`frameless voice synthesis failed: ${error.message}`);
            send(websocket, { type: 'error', error: { message: error.message } });
          })
          .finally(() => {
            session.pendingOutputs -= 1;
          });
      });
      websocket.on('error', (error) => {
        log(`frameless voice websocket failed: ${error.message}`);
      });
      websocket.once('close', () => {
        session.accepting = false;
        session.closed = true;
        sockets.delete(websocket);
        log(`frameless voice websocket closed: ${session.id}`);
      });
      websocketServer.emit('connection', websocket, request);
    });
  }

  async function close() {
    if (attachedServer) {
      attachedServer.off('upgrade', onUpgrade);
      attachedServer = null;
    }
    for (const socket of sockets) socket.close();
    sockets.clear();
    websocketServer.close();
  }

  return {
    attach,
    close,
  };
}

module.exports = {
  createFramelessVoiceServer,
  wavToPcm16,
};
