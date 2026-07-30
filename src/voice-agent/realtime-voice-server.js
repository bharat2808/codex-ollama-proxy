'use strict';

const { randomUUID } = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');

const MAX_CALL_BODY_BYTES = 2 * 1024 * 1024;
const MAX_WS_PAYLOAD_BYTES = 1024 * 1024;
const MAX_CONTEXT_BYTES = 500;
const MAX_PENDING_OUTPUTS = 8;

function requestPath(request) {
  return new URL(request.url, 'http://127.0.0.1').pathname;
}

function multipartBoundary(contentType) {
  const match = String(contentType || '').match(
    /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/iu,
  );
  return match && (match[1] || match[2]);
}

function parseMultipartPart(part) {
  const separator = part.indexOf('\r\n\r\n');
  if (separator < 0) return null;
  const headerText = part.slice(0, separator);
  const body = part.slice(separator + 4).replace(/\r\n$/u, '');
  const name = headerText.match(
    /content-disposition\s*:\s*form-data\s*;\s*name="([^"]+)"/iu,
  );
  return name ? { name: name[1], body } : null;
}

function parseCallBody(buffer, contentType) {
  if (String(contentType || '').toLowerCase().startsWith('application/sdp')) {
    return { offerSdp: buffer.toString('utf8'), session: {} };
  }
  const boundary = multipartBoundary(contentType);
  if (!boundary) throw new Error('realtime call requires application/sdp or multipart/form-data');
  const parts = buffer.toString('utf8')
    .split(`--${boundary}`)
    .map((part) => part.replace(/^\r\n/u, ''))
    .map(parseMultipartPart)
    .filter(Boolean);
  const sdp = parts.find((part) => part.name === 'sdp');
  const sessionPart = parts.find((part) => part.name === 'session');
  if (!sdp || !sdp.body) throw new Error('multipart realtime call is missing sdp');
  let session = {};
  if (sessionPart && sessionPart.body) {
    try {
      session = JSON.parse(sessionPart.body);
    } catch (error) {
      throw new Error(`multipart realtime session is invalid JSON: ${error.message}`);
    }
  }
  return { offerSdp: sdp.body, session };
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_CALL_BODY_BYTES) {
        reject(new Error('realtime call request is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => resolve(Buffer.concat(chunks)));
    request.once('error', reject);
  });
}

function sendText(response, statusCode, message) {
  const body = String(message);
  response.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
  });
  response.end(body);
}

function speakableHandoffText(event) {
  let text = '';
  if (event.type === 'conversation.handoff.append') {
    text = event.output_text;
  } else if (
    event.type === 'conversation.item.create'
    && event.item
    && event.item.type === 'function_call_output'
  ) {
    text = event.item.output;
  }
  return String(text || '')
    .replace(/^"Agent Final Message":\s*/u, '')
    .trim();
}

function framelessContextText(event) {
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
      .trim()
    : '';
}

function createRealtimeVoiceServer({
  enabled = () => false,
  createPeer,
  transcribePcm = async () => {
    throw new Error('local voice transcription is not configured');
  },
  synthesizeSpeech = async () => {
    throw new Error('local voice synthesis is not configured');
  },
  sidebandJoinTimeoutMs = 30000,
  log = () => {},
} = {}) {
  if (typeof createPeer !== 'function') throw new Error('createPeer is required');
  const calls = new Map();
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
  });
  let attachedServer = null;

  function closeCall(call) {
    if (call.closing) return call.closing;
    call.accepting = false;
    call.closed = true;
    calls.delete(call.id);
    if (call.sidebandJoinTimer) {
      clearTimeout(call.sidebandJoinTimer);
      call.sidebandJoinTimer = null;
    }
    call.closing = Promise.resolve()
      .then(() => {
        if (call.sideband && call.sideband.readyState === WebSocket.OPEN) {
          call.sideband.close();
        }
        if (call.peer && typeof call.peer.close === 'function') {
          return call.peer.close();
        }
        return undefined;
      })
      .catch((error) => {
        log(`realtime call shutdown failed: ${error.message}`);
      });
    return call.closing;
  }

  function sendCallEvent(call, event) {
    if (call.closed) return;
    const payload = JSON.stringify(event);
    if (call.sideband && call.sideband.readyState === WebSocket.OPEN) {
      call.sideband.send(payload);
    } else {
      call.pendingEvents.push(payload);
    }
  }

  async function transcribeCallSpeech(call, pcm) {
    if (call.closed) return;
    const transcript = String(await transcribePcm(pcm, call) || '').trim();
    if (!transcript || call.closed) return;
    log(`realtime ${call.protocol} transcription completed: ${Buffer.byteLength(transcript, 'utf8')} text bytes`);
    if (call.protocol === 'frameless') {
      const inputId = `input_${randomUUID()}`;
      const delegationId = `delegation_${randomUUID()}`;
      sendCallEvent(call, {
        type: 'input_transcript.added',
        item: { id: inputId, type: 'input_transcript', text: transcript },
      });
      sendCallEvent(call, {
        type: 'turn.done',
        turn: { id: `turn_${randomUUID()}`, role: 'user', transcript },
      });
      sendCallEvent(call, {
        type: 'delegation.created',
        item: {
          id: delegationId,
          type: 'delegation',
          target: 'client',
          content: [{ type: 'input_text', text: transcript }],
        },
      });
      return;
    }
    const handoffId = `handoff_${randomUUID()}`;
    const itemId = `item_${randomUUID()}`;
    sendCallEvent(call, {
      type: 'conversation.input_transcript.delta',
      delta: transcript,
    });
    sendCallEvent(call, {
      type: 'conversation.item.input_audio_transcription.completed',
      transcript,
      item_id: itemId,
    });
    sendCallEvent(call, {
      type: 'conversation.handoff.requested',
      handoff_id: handoffId,
      item_id: itemId,
      input_transcript: transcript,
    });
  }

  async function speakCallText(call, text) {
    if (call.closed) return;
    log(`realtime ${call.protocol} synthesis started: ${Buffer.byteLength(text, 'utf8')} text bytes`);
    const audio = await synthesizeSpeech(text, call);
    if (call.closed) return;
    if (!call.peer || typeof call.peer.playAudio !== 'function') {
      throw new Error('local WebRTC peer cannot play synthesized audio');
    }
    await call.peer.playAudio(audio);
    if (call.closed) return;
    log(`realtime ${call.protocol} synthesis playback completed`);
    if (call.protocol === 'frameless') {
      sendCallEvent(call, {
        type: 'output_transcript.added',
        item: { id: `output_${randomUUID()}`, type: 'output_transcript', text },
      });
      sendCallEvent(call, {
        type: 'turn.done',
        turn: { id: `turn_${randomUUID()}`, role: 'assistant', transcript: text },
      });
      return;
    }
    sendCallEvent(call, {
      type: 'conversation.output_transcript.delta',
      delta: text,
    });
    sendCallEvent(call, {
      type: 'response.output_audio_transcript.done',
      transcript: text,
    });
  }

  function enqueueCallSpeech(call, text) {
    if (!call.accepting || call.closed) return Promise.resolve();
    if (
      call.protocol === 'frameless'
      && Buffer.byteLength(text, 'utf8') > MAX_CONTEXT_BYTES
    ) {
      sendCallEvent(call, {
        type: 'error',
        error: { message: `voice context exceeds ${MAX_CONTEXT_BYTES} bytes` },
      });
      return Promise.resolve();
    }
    if (call.protocol === 'frameless' && call.pendingOutputs >= MAX_PENDING_OUTPUTS) {
      sendCallEvent(call, {
        type: 'error',
        error: { message: 'voice output queue is full' },
      });
      return Promise.resolve();
    }
    call.pendingOutputs += 1;
    const job = call.outputQueue.then(async () => {
      if (!call.closed) await speakCallText(call, text);
    });
    call.outputQueue = job
      .catch((error) => {
        log(`realtime speech synthesis failed: ${error.message}`);
        sendCallEvent(call, {
          type: 'error',
          error: {
            message: `local speech synthesis failed: ${error.message}`,
          },
        });
      })
      .finally(() => {
        call.pendingOutputs -= 1;
      });
    return job;
  }

  async function createCall(request, response, protocol = 'legacy') {
    if (!enabled()) {
      sendText(response, 503, 'local voice is disabled');
      return;
    }
    try {
      const body = await readRequestBody(request);
      const parsed = parseCallBody(body, request.headers['content-type']);
      const callId = protocol === 'frameless'
        ? `rtc_${randomUUID()}`
        : `call_${randomUUID()}`;
      const call = {
        id: callId,
        protocol,
        accepting: true,
        closed: false,
        pendingEvents: [],
        pendingOutputs: 0,
        session: parsed.session,
        sideband: null,
        outputQueue: Promise.resolve(),
        speechQueue: Promise.resolve(),
      };
      const peer = await createPeer({
        callId,
        offerSdp: parsed.offerSdp,
        session: parsed.session,
        protocol,
        headers: request.headers,
        onClose() {
          closeCall(call);
        },
        onSpeech(pcm) {
          const job = call.speechQueue.then(() => transcribeCallSpeech(call, pcm));
          call.speechQueue = job.catch((error) => {
            log(`realtime speech transcription failed: ${error.message}`);
            sendCallEvent(call, {
              type: 'error',
              error: {
                message: `local speech transcription failed: ${error.message}`,
              },
            });
          });
          return job;
        },
      });
      if (!peer || typeof peer.answerSdp !== 'string' || !peer.answerSdp) {
        throw new Error('local WebRTC peer did not produce an SDP answer');
      }
      call.peer = peer;
      calls.set(callId, call);
      log(`realtime ${protocol} WebRTC call created: ${callId}`);
      call.sidebandJoinTimer = setTimeout(() => {
        log(`realtime call ${callId} expired before sideband joined`);
        closeCall(call);
      }, sidebandJoinTimeoutMs);
      if (typeof call.sidebandJoinTimer.unref === 'function') call.sidebandJoinTimer.unref();
      response.writeHead(201, {
        'content-type': 'application/sdp',
        'content-length': String(Buffer.byteLength(peer.answerSdp)),
        location: protocol === 'frameless'
          ? `/v1/live/${callId}`
          : `/v1/realtime/calls/${callId}`,
      });
      response.end(peer.answerSdp);
    } catch (error) {
      log(`realtime call creation failed: ${error.message}`);
      if (!response.headersSent) sendText(response, 400, error.message);
      else response.end();
    }
  }

  function handleRequest(request, response) {
    if (request.method !== 'POST') return false;
    const path = requestPath(request);
    if (path === '/v1/realtime/calls') {
      createCall(request, response, 'legacy');
      return true;
    }
    if (path === '/v1/live') {
      createCall(request, response, 'frameless');
      return true;
    }
    return false;
  }

  function onUpgrade(request, socket, head) {
    let url;
    try {
      url = new URL(request.url, 'http://127.0.0.1');
    } catch {
      socket.destroy();
      return;
    }
    let callId = null;
    let protocol = null;
    if (url.pathname === '/v1/realtime') {
      callId = url.searchParams.get('call_id');
      protocol = 'legacy';
    } else {
      const live = url.pathname.match(/^\/v1\/live\/([^/]+)$/u);
      if (!live) return;
      [, callId] = live;
      protocol = 'frameless';
    }
    const call = callId && calls.get(callId);
    if (!call || call.protocol !== protocol) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      if (call.sidebandJoinTimer) {
        clearTimeout(call.sidebandJoinTimer);
        call.sidebandJoinTimer = null;
      }
      call.sideband = websocket;
      log(`realtime ${call.protocol} sideband connected: ${call.id}`);
      for (const payload of call.pendingEvents.splice(0)) websocket.send(payload);
      websocket.on('error', (error) => {
        log(`realtime ${call.protocol} sideband failed: ${error.message}`);
      });
      websocket.on('message', (payload, isBinary) => {
        if (isBinary) return;
        let event;
        try {
          event = JSON.parse(payload.toString('utf8'));
        } catch {
          return;
        }
        if (call.protocol === 'legacy' && event.type === 'session.update') {
          const instructions = event.session && typeof event.session.instructions === 'string'
            ? event.session.instructions
            : call.session.instructions;
          const updated = {
            type: 'session.updated',
            session: {
              id: `sess_${call.id}`,
              instructions: instructions || '',
            },
          };
          websocket.send(JSON.stringify(updated));
          if (call.peer && typeof call.peer.sendDataEvent === 'function') {
            call.peer.sendDataEvent(updated);
          }
          return;
        }
        const text = call.protocol === 'frameless'
          ? framelessContextText(event)
          : speakableHandoffText(event);
        if (text) enqueueCallSpeech(call, text);
      });
      websocket.once('close', () => {
        if (call.sideband === websocket) call.sideband = null;
        log(`realtime ${call.protocol} sideband closed: ${call.id}`);
        closeCall(call);
      });
      websocketServer.emit('connection', websocket, request);
    });
  }

  function attach(server) {
    if (attachedServer === server) return;
    if (attachedServer) throw new Error('realtime voice server is already attached');
    attachedServer = server;
    attachedServer.on('upgrade', onUpgrade);
  }

  async function close() {
    if (attachedServer) {
      attachedServer.off('upgrade', onUpgrade);
      attachedServer = null;
    }
    const closing = [];
    for (const call of calls.values()) {
      closing.push(closeCall(call));
    }
    await Promise.allSettled(closing);
    websocketServer.close();
  }

  return {
    attach,
    calls,
    close,
    handleRequest,
  };
}

module.exports = {
  createRealtimeVoiceServer,
  parseCallBody,
};
