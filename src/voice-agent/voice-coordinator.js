'use strict';

const DELEGATE_TOOL_NAME = 'delegate_to_codex';
const VOICE_TURN_INSTRUCTIONS = [
  'This is a spoken voice interaction.',
  'Before calling any tool, give one short natural spoken acknowledgement describing what you are about to do. Do not claim the work is complete.',
  'After tool execution, always provide a concise user-facing spoken result.',
  'Never end a turn with only a tool call or tool output.',
  'Avoid markdown, code blocks, raw URLs, and long lists unless the user asks for them.',
].join('\n');

const COORDINATOR_INSTRUCTIONS = [
  'You are the conversational voice coordinator for a Codex agent.',
  'Respond directly only when the request is self-contained and requires no tools, files, workspace access, research, or longer-running work.',
  `For every action or task, call ${DELEGATE_TOOL_NAME}. Before calling that tool inform user that you will work on it now.`,
  `Also call ${DELEGATE_TOOL_NAME} when the user corrects, redirects, or cancels previously delegated work.`,
  'The Codex handoff owns the workspace and thread tools. It will decide whether to start new work or steer an existing worker.',
  'When delegating, first give the user one brief spoken acknowledgement, then call the tool.',
  'Keep direct spoken responses concise and natural.',
  'Never claim that delegated work has already completed.',
].join(' ');

const DELEGATE_TOOL = {
  type: 'function',
  name: DELEGATE_TOOL_NAME,
  description: 'Delegate execution work to Codex, including tool use, workspace access, file changes, research, and longer-running tasks.',
  parameters: {
    type: 'object',
    properties: {
      request: {
        type: 'string',
        description: 'A complete, action-oriented request for the Codex agent.',
      },
    },
    required: ['request'],
    additionalProperties: false,
  },
  strict: true,
};

function appendVoiceCoordinatorHistory(history, ...items) {
  return [
    ...(Array.isArray(history) ? history : []),
    ...items.filter(Boolean),
  ];
}

function rememberVoiceCoordinatorUpdate(history, text) {
  const update = String(text || '').trim();
  if (!update) return Array.isArray(history) ? history : [];
  return appendVoiceCoordinatorHistory(history, {
    role: 'developer',
    content: [{
      type: 'input_text',
      text: `Codex handoff update: ${update}`,
    }],
  });
}

function sessionContextItem(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return {
    role: 'developer',
    content: [{
      type: 'input_text',
      text: `Active Codex voice session context:\n${text}`,
    }],
  };
}

function outputItems(response) {
  return Array.isArray(response && response.output) ? response.output : [];
}

function delegationFrom(response) {
  const call = outputItems(response).find((item) => (
    item
    && item.type === 'function_call'
    && item.name === DELEGATE_TOOL_NAME
  ));
  if (!call) return null;
  if (!call.call_id) throw new Error('voice coordinator delegation is missing call_id');
  let args;
  try {
    args = JSON.parse(String(call.arguments || '{}'));
  } catch (error) {
    throw new Error(`voice coordinator returned invalid delegation arguments: ${error.message}`);
  }
  const request = String(args.request || '').trim();
  if (!request) throw new Error('voice coordinator delegation request is empty');
  return { call, request };
}

function speechFrom(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }
  return outputItems(response)
    .filter((item) => item && item.type === 'message')
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .filter((item) => item && item.type === 'output_text')
    .map((item) => String(item.text || ''))
    .join('')
    .trim();
}

function createPhraseEmitter(onPhrase, {
  initialBufferMs = 500,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
} = {}) {
  let pending = '';
  let emitted = 0;
  let windowTimer = null;
  let windowExpired = false;
  let queuedPhrase = '';
  let drainRunning = false;
  let closed = false;
  let emissionFailure = null;
  const idleWaiters = new Set();

  function cancelWindow() {
    if (windowTimer !== null) cancelSchedule(windowTimer);
    windowTimer = null;
  }

  function resolveIdleWaiters() {
    if (drainRunning || queuedPhrase) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function waitForIdle() {
    if (!drainRunning && !queuedPhrase) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.add(resolve));
  }

  function appendQueuedPhrase(text) {
    const phrase = text.trim();
    if (!phrase || closed) return;
    queuedPhrase = queuedPhrase
      ? `${queuedPhrase.trimEnd()} ${phrase}`
      : phrase;
    startDrain();
  }

  async function drainPhrases() {
    try {
      while (queuedPhrase && !closed) {
        const phrase = queuedPhrase;
        queuedPhrase = '';
        emitted += 1;
        await onPhrase(phrase);
      }
    } catch (error) {
      if (!emissionFailure) emissionFailure = error;
      queuedPhrase = '';
    } finally {
      drainRunning = false;
      if (queuedPhrase && !closed && !emissionFailure) startDrain();
      else resolveIdleWaiters();
    }
  }

  function startDrain() {
    if (drainRunning || closed || emissionFailure) return;
    drainRunning = true;
    Promise.resolve().then(drainPhrases);
  }

  function completePrefixEnd(text) {
    const endings = /[.!?](?:["')\]]+)?(?=\s|$)/gu;
    let end = 0;
    for (const match of text.matchAll(endings)) {
      end = match.index + match[0].length;
    }
    return end;
  }

  function emitPrefix(end) {
    if (end <= 0) return false;
    appendQueuedPhrase(pending.slice(0, end));
    pending = pending.slice(end).trimStart();
    windowExpired = false;
    startWindow();
    return true;
  }

  function emitCompletePrefix() {
    return emitPrefix(completePrefixEnd(pending));
  }

  function startWindow() {
    if (closed || windowTimer !== null || windowExpired || !pending.trim()) return;
    windowTimer = schedule(() => {
      windowTimer = null;
      windowExpired = true;
      emitCompletePrefix();
    }, initialBufferMs);
  }

  async function push(delta) {
    if (closed) return;
    pending += String(delta || '');
    if (!pending.trim()) return;
    if (windowExpired) emitCompletePrefix();
    startWindow();
  }

  async function flush() {
    cancelWindow();
    appendQueuedPhrase(pending);
    pending = '';
    await waitForIdle();
    if (emissionFailure) throw emissionFailure;
    closed = true;
  }

  function cancel() {
    cancelWindow();
    closed = true;
    pending = '';
    queuedPhrase = '';
    resolveIdleWaiters();
  }

  return {
    cancel,
    push,
    flush,
    get emitted() {
      return emitted;
    },
  };
}

function createVoiceCoordinator({
  getModel,
  phraseEmitterOptions,
  requestResponse,
  streamResponse,
} = {}) {
  if (typeof getModel !== 'function') throw new Error('voice coordinator getModel is required');
  if (typeof requestResponse !== 'function') throw new Error('voice coordinator requestResponse is required');

  return async function coordinateTranscript(transcript, context = {}) {
    const input = String(transcript || '').trim();
    const model = String(getModel() || '').trim();
    if (!model) throw new Error('voice model is not configured in the active preset');
    if (!input) throw new Error('voice transcript is empty');

    const history = Array.isArray(context.voiceCoordinatorHistory)
      ? context.voiceCoordinatorHistory
      : [];
    const userItem = {
      role: 'user',
      content: [{ type: 'input_text', text: input }],
    };
    const inputHistory = context.inputAlreadyInHistory
      ? history
      : appendVoiceCoordinatorHistory(history, userItem);
    // Publish the accepted user turn before inference starts so an abort cannot
    // erase it from the next coordinator request.
    context.voiceCoordinatorHistory = inputHistory;

    const sessionItem = sessionContextItem(context.sessionContext);
    const request = {
      model,
      instructions: COORDINATOR_INSTRUCTIONS,
      input: sessionItem ? [sessionItem, ...inputHistory] : inputHistory,
      tools: [DELEGATE_TOOL],
      tool_choice: 'auto',
      reasoning: { effort: 'none' },
      stream: typeof context.onSpeechPhrase === 'function',
    };
    let phraseEmitter = null;
    let response;
    if (request.stream && typeof streamResponse === 'function') {
      phraseEmitter = createPhraseEmitter(context.onSpeechPhrase, phraseEmitterOptions);
      try {
        response = await streamResponse(request, {
          signal: context.signal,
          onTextDelta: phraseEmitter.push,
        });
        await phraseEmitter.flush();
      } catch (error) {
        phraseEmitter.cancel();
        throw error;
      }
    } else {
      request.stream = false;
      response = await requestResponse(request, { signal: context.signal });
    }
    const delegation = delegationFrom(response);
    if (delegation) {
      const preface = speechFrom(response);
      const accepted = {
        type: 'function_call_output',
        call_id: delegation.call.call_id,
        output: JSON.stringify({
          status: 'accepted',
          request: delegation.request,
        }),
      };
      context.voiceCoordinatorHistory = appendVoiceCoordinatorHistory(
        inputHistory,
        ...outputItems(response),
        accepted,
      );
      return {
        action: 'delegate',
        input: delegation.request,
        ...(preface ? { preface } : {}),
        ...(phraseEmitter && phraseEmitter.emitted ? { streamed: true } : {}),
      };
    }

    const text = speechFrom(response);
    if (!text) {
      throw new Error('voice coordinator returned neither speech nor delegation');
    }
    const assistantItem = {
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    };
    context.voiceCoordinatorHistory = appendVoiceCoordinatorHistory(
      inputHistory,
      assistantItem,
    );
    return {
      action: 'speak',
      text,
      ...(phraseEmitter && phraseEmitter.emitted ? { streamed: true } : {}),
    };
  };
}

module.exports = {
  VOICE_TURN_INSTRUCTIONS,
  appendVoiceCoordinatorHistory,
  createPhraseEmitter,
  createVoiceCoordinator,
  rememberVoiceCoordinatorUpdate,
};
