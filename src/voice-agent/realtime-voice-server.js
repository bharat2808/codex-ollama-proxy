'use strict';

const { randomUUID } = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');
const {
  appendVoiceCoordinatorHistory,
  rememberVoiceCoordinatorUpdate,
} = require('./voice-coordinator');

const MAX_CALL_BODY_BYTES = 2 * 1024 * 1024;
const MAX_WS_PAYLOAD_BYTES = 1024 * 1024;
const MAX_CONTEXT_BYTES = 500;
const MAX_DIRECT_RESPONSE_BYTES = 8 * 1024;
const MAX_PENDING_OUTPUTS = 8;
const NON_SPEECH_TRANSCRIPT = /^(?:(?:\[(?:blank[_ ]audio|inaudible|silence|music|applause|laughter|laughing|snoring)\])|(?:\((?:blank[_ ]audio|inaudible|silence|music|applause|audience laughing|laughter|laughing|snoring)\)))[\s.!?]*$/iu;

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
  const boundary = multipartBoundary(contentType);
  if (!boundary) throw new Error('live voice call requires multipart/form-data');
  const parts = buffer.toString('utf8')
    .split(`--${boundary}`)
    .map((part) => part.replace(/^\r\n/u, ''))
    .map(parseMultipartPart)
    .filter(Boolean);
  const sdp = parts.find((part) => part.name === 'sdp');
  const sessionPart = parts.find((part) => part.name === 'session');
  if (!sdp || !sdp.body) throw new Error('live voice call is missing sdp');
  let session = {};
  if (sessionPart && sessionPart.body) {
    try {
      session = JSON.parse(sessionPart.body);
    } catch (error) {
      throw new Error(`live voice session is invalid JSON: ${error.message}`);
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
        reject(new Error('live voice call request is too large'));
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
      .trim()
    : '';
}

function usableTranscript(value) {
  const transcript = String(value || '').trim();
  if (!transcript || NON_SPEECH_TRANSCRIPT.test(transcript)) return '';
  return transcript;
}

function createRealtimeVoiceServer({
  enabled = () => false,
  createPeer,
  transcribePcm = async () => {
    throw new Error('local voice transcription is not configured');
  },
  coordinateTranscript,
  streamSpeech = async function* () {
    throw new Error('local voice synthesis is not configured');
  },
  sidebandJoinTimeoutMs = 30000,
  log = () => {},
} = {}) {
  if (typeof createPeer !== 'function') throw new Error('createPeer is required');
  if (typeof coordinateTranscript !== 'function') {
    throw new Error('coordinateTranscript is required');
  }

  const calls = new Map();
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
  });
  let attachedServer = null;

  function isCurrentTurn(call, generation) {
    return !call.closed && call.generation === generation;
  }

  function stopCallAudio(call) {
    if (!call.peer || typeof call.peer.stopAudio !== 'function') return;
    Promise.resolve(call.peer.stopAudio()).catch((error) => {
      log(`live voice playback interruption failed: ${error.message}`);
    });
  }

  function preserveConcurrentCoordinatorUpdates(call, initialHistory, coordinatorHistory) {
    const concurrentUpdates = call.voiceCoordinatorHistory.slice(initialHistory.length);
    return appendVoiceCoordinatorHistory(coordinatorHistory, ...concurrentUpdates);
  }

  function beginCallTurn(call) {
    if (call.activeController && !call.activeController.signal.aborted) {
      call.activeController.abort();
      log(`live voice coordinator cancelled by verified speech: ${call.id}`);
    }
    call.generation += 1;
    call.activeController = new AbortController();
    const turn = {
      generation: call.generation,
      controller: call.activeController,
    };
    call.activeDelegationId = null;
    call.outputQueue = Promise.resolve();
    return turn;
  }

  function noteSpeechStart(call) {
    if (call.closed) return;
    if (call.finishSpeechCandidate) call.finishSpeechCandidate();
    call.speechCandidateActive = true;
    call.speechCandidateDone = new Promise((resolve) => {
      call.finishSpeechCandidate = resolve;
    });
    log(`live voice speech candidate detected: ${call.id}`);
    stopCallAudio(call);
  }

  async function waitForSpeechCandidate(call) {
    while (!call.closed && call.speechCandidateActive) {
      await call.speechCandidateDone;
    }
  }

  function finishSpeechCandidate(call) {
    call.speechCandidateActive = false;
    if (call.finishSpeechCandidate) call.finishSpeechCandidate();
    call.finishSpeechCandidate = null;
  }

  function closeCall(call) {
    if (call.closing) return call.closing;
    call.closed = true;
    finishSpeechCandidate(call);
    if (call.activeController) call.activeController.abort();
    stopCallAudio(call);
    calls.delete(call.id);
    if (call.sidebandJoinTimer) clearTimeout(call.sidebandJoinTimer);
    call.closing = Promise.resolve()
      .then(() => {
        if (call.sideband && call.sideband.readyState === WebSocket.OPEN) {
          call.sideband.close();
        }
        return call.peer && typeof call.peer.close === 'function'
          ? call.peer.close()
          : undefined;
      })
      .catch((error) => {
        log(`live voice call shutdown failed: ${error.message}`);
      });
    return call.closing;
  }

  function sendCallEvent(call, event) {
    if (call.closed) return;
    const payload = JSON.stringify(event);
    if (call.peer && typeof call.peer.sendDataEvent === 'function') {
      try {
        call.peer.sendDataEvent(event);
      } catch (error) {
        log(`live voice browser event failed: ${error.message}`);
      }
    }
    if (call.sideband && call.sideband.readyState === WebSocket.OPEN) {
      call.sideband.send(payload);
    } else {
      call.pendingEvents.push(payload);
    }
  }

  function sendSpeechEvents(call, text, generation) {
    if (!isCurrentTurn(call, generation)) return;
    sendCallEvent(call, {
      type: 'output_transcript.added',
      item: { id: `output_${randomUUID()}`, type: 'output_transcript', text },
    });
    sendCallEvent(call, {
      type: 'turn.done',
      turn: { id: `turn_${randomUUID()}`, role: 'assistant', transcript: text },
    });
  }

  async function speakText(call, text, { generation, emitEvents = true }) {
    if (!isCurrentTurn(call, generation)) return;
    await waitForSpeechCandidate(call);
    if (!isCurrentTurn(call, generation)) return;
    if (!call.peer || typeof call.peer.playAudioStream !== 'function') {
      throw new Error('local WebRTC peer cannot stream synthesized audio');
    }
    log(`live voice synthesis started: ${Buffer.byteLength(text, 'utf8')} text bytes`);
    await call.peer.playAudioStream(streamSpeech(text, call));
    if (!isCurrentTurn(call, generation)) return;
    log('live voice streaming synthesis playback completed');
    if (emitEvents) sendSpeechEvents(call, text, generation);
  }

  function enqueueSpeech(call, rawText, maxBytes = MAX_CONTEXT_BYTES, {
    generation = call.generation,
    emitEvents = true,
  } = {}) {
    const text = String(rawText || '').trim();
    if (!text || !isCurrentTurn(call, generation)) {
      return Promise.resolve();
    }
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      sendCallEvent(call, {
        type: 'error',
        error: { message: `voice text exceeds ${maxBytes} bytes` },
      });
      return Promise.resolve();
    }
    if (call.pendingOutputs >= MAX_PENDING_OUTPUTS) {
      sendCallEvent(call, {
        type: 'error',
        error: { message: 'voice output queue is full' },
      });
      return Promise.resolve();
    }
    call.pendingOutputs += 1;
    const job = call.outputQueue.then(() => (
      isCurrentTurn(call, generation)
        ? speakText(call, text, { generation, emitEvents })
        : undefined
    ));
    call.outputQueue = job
      .catch((error) => {
        if (!isCurrentTurn(call, generation)) return;
        log(`live voice speech synthesis failed: ${error.message}`);
        sendCallEvent(call, {
          type: 'error',
          error: { message: `local speech synthesis failed: ${error.message}` },
        });
      })
      .finally(() => {
        call.pendingOutputs -= 1;
      });
    return job;
  }

  async function transcribeSpeech(call, pcm) {
    if (call.closed) return;
    let rawTranscript;
    try {
      rawTranscript = String(await transcribePcm(pcm, call) || '').trim();
    } finally {
      finishSpeechCandidate(call);
    }
    if (call.closed) return;
    const transcript = usableTranscript(rawTranscript);
    if (!transcript) {
      log(`live voice non-speech transcript ignored: ${Buffer.byteLength(rawTranscript, 'utf8')} text bytes`);
      return;
    }
    const { generation, controller } = beginCallTurn(call);
    log(`live voice transcription completed: ${Buffer.byteLength(transcript, 'utf8')} text bytes`);
    sendCallEvent(call, {
      type: 'input_transcript.added',
      item: { id: `input_${randomUUID()}`, type: 'input_transcript', text: transcript },
    });
    sendCallEvent(call, {
      type: 'turn.done',
      turn: { id: `turn_${randomUUID()}`, role: 'user', transcript },
    });

    const initialHistory = call.voiceCoordinatorHistory;
    const context = {
      signal: controller.signal,
      voiceCoordinatorHistory: initialHistory,
      onSpeechPhrase: (text) => enqueueSpeech(
        call,
        text,
        MAX_DIRECT_RESPONSE_BYTES,
        { generation, emitEvents: false },
      ),
    };
    log(`live voice coordinator started: generation=${generation}`);
    let decision;
    try {
      decision = await coordinateTranscript(transcript, context);
    } catch (error) {
      if (controller.signal.aborted || !isCurrentTurn(call, generation)) return;
      throw error;
    }
    await waitForSpeechCandidate(call);
    if (!isCurrentTurn(call, generation)) return;
    log(`live voice coordinator completed: generation=${generation} action=${decision.action}`);
    call.voiceCoordinatorHistory = preserveConcurrentCoordinatorUpdates(
      call,
      initialHistory,
      context.voiceCoordinatorHistory,
    );

    if (decision.action === 'speak') {
      if (decision.streamed) {
        await call.outputQueue;
        sendSpeechEvents(call, decision.text, generation);
      } else {
        await enqueueSpeech(call, decision.text, MAX_DIRECT_RESPONSE_BYTES, { generation });
      }
      return;
    }

    if (!isCurrentTurn(call, generation)) return;
    const delegationId = `delegation_${randomUUID()}`;
    call.activeDelegationId = delegationId;
    sendCallEvent(call, {
      type: 'delegation.created',
      item: {
        id: delegationId,
        type: 'delegation',
        target: 'client',
        content: [{ type: 'input_text', text: decision.input }],
      },
    });
    log(
      `live voice delegation created: generation=${generation}`
      + ` sideband=${call.sideband && call.sideband.readyState === WebSocket.OPEN ? 'connected' : 'queued'}`,
    );

    if (decision.preface) {
      if (decision.streamed) {
        sendSpeechEvents(call, decision.preface, generation);
      } else {
        await enqueueSpeech(call, decision.preface, MAX_DIRECT_RESPONSE_BYTES, { generation });
      }
    }
  }

  async function createCall(request, response) {
    if (!enabled()) {
      sendText(response, 503, 'local voice is disabled');
      return;
    }
    try {
      const body = await readRequestBody(request);
      const parsed = parseCallBody(body, request.headers['content-type']);
      const callId = `rtc_${randomUUID()}`;
      const call = {
        id: callId,
        closed: false,
        pendingEvents: [],
        pendingOutputs: 0,
        sideband: null,
        outputQueue: Promise.resolve(),
        generation: 0,
        activeController: null,
        activeDelegationId: null,
        speechCandidateActive: false,
        speechCandidateDone: Promise.resolve(),
        finishSpeechCandidate: null,
        voiceCoordinatorHistory: [],
      };
      call.peer = await createPeer({
        callId,
        offerSdp: parsed.offerSdp,
        session: parsed.session,
        headers: request.headers,
        onClose: () => closeCall(call),
        onSpeechStart: () => noteSpeechStart(call),
        onSpeech(pcm) {
          const job = transcribeSpeech(call, pcm);
          return job
            .catch((error) => {
              if (call.closed || call.activeController?.signal.aborted) return;
              log(`live voice transcription failed: ${error.message}`);
              sendCallEvent(call, {
                type: 'error',
                error: { message: `local speech transcription failed: ${error.message}` },
              });
            });
        },
      });
      if (!call.peer || typeof call.peer.answerSdp !== 'string' || !call.peer.answerSdp) {
        throw new Error('local WebRTC peer did not produce an SDP answer');
      }
      calls.set(callId, call);
      sendCallEvent(call, {
        type: 'session.started',
        session: {
          id: `sess_${callId}`,
          instructions: typeof parsed.session.instructions === 'string'
            ? parsed.session.instructions
            : '',
        },
      });
      log(`live voice WebRTC call created: ${callId}`);
      call.sidebandJoinTimer = setTimeout(() => {
        log(`live voice call ${callId} expired before sideband joined`);
        closeCall(call);
      }, sidebandJoinTimeoutMs);
      if (typeof call.sidebandJoinTimer.unref === 'function') call.sidebandJoinTimer.unref();
      response.writeHead(201, {
        'content-type': 'application/sdp',
        'content-length': String(Buffer.byteLength(call.peer.answerSdp)),
        location: `/v1/live/${callId}`,
      });
      response.end(call.peer.answerSdp);
    } catch (error) {
      log(`live voice call creation failed: ${error.message}`);
      if (!response.headersSent) sendText(response, 400, error.message);
      else response.end();
    }
  }

  function handleRequest(request, response) {
    if (
      request.method !== 'POST'
      || new URL(request.url, 'http://127.0.0.1').pathname !== '/v1/live'
    ) {
      return false;
    }
    createCall(request, response);
    return true;
  }

  function onUpgrade(request, socket, head) {
    let match;
    try {
      match = new URL(request.url, 'http://127.0.0.1').pathname
        .match(/^\/v1\/live\/([^/]+)$/u);
    } catch {
      socket.destroy();
      return;
    }
    if (!match) return;
    const call = calls.get(match[1]);
    if (!call) {
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
      log(`live voice sideband connected: ${call.id}`);
      for (const payload of call.pendingEvents.splice(0)) websocket.send(payload);
      websocket.on('error', (error) => {
        log(`live voice sideband failed: ${error.message}`);
      });
      websocket.on('message', (payload, isBinary) => {
        if (isBinary) return;
        let event;
        try {
          event = JSON.parse(payload.toString('utf8'));
        } catch {
          return;
        }
        const text = contextText(event);
        const textBytes = Buffer.byteLength(text, 'utf8');
        const accepted = text && textBytes <= MAX_CONTEXT_BYTES;
        if (accepted) {
          call.voiceCoordinatorHistory = rememberVoiceCoordinatorUpdate(
            call.voiceCoordinatorHistory,
            text,
          );
        }
        if (
          event.type === 'delegation.context.append'
          && event.delegation_item_id
          && event.delegation_item_id !== call.activeDelegationId
        ) {
          return;
        }
        if (accepted && !call.speechCandidateActive) {
          const generation = call.generation;
          sendCallEvent(call, {
            type: 'output_transcript.added',
            item: { id: `output_${randomUUID()}`, type: 'output_transcript', text },
          });
          enqueueSpeech(call, text, MAX_CONTEXT_BYTES, { generation, emitEvents: false })
            .finally(() => {
              if (!isCurrentTurn(call, generation)) return;
              sendCallEvent(call, {
                type: 'turn.done',
                turn: { id: `turn_${randomUUID()}`, role: 'assistant', transcript: text },
              });
            });
        } else if (text) {
          sendCallEvent(call, {
            type: 'error',
            error: { message: `voice text exceeds ${MAX_CONTEXT_BYTES} bytes` },
          });
        }
      });
      websocket.once('close', () => {
        if (call.sideband === websocket) call.sideband = null;
        log(`live voice sideband closed: ${call.id}`);
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
    await Promise.all([...calls.values()].map(closeCall));
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
};
