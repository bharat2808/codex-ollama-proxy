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
  `For every action or task, call ${DELEGATE_TOOL_NAME}.`,
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
  minimumCharacters = 16,
  maximumCharacters = 120,
} = {}) {
  let pending = '';
  let emitted = 0;

  async function emit(text) {
    const phrase = text.trim();
    if (!phrase) return;
    emitted += 1;
    await onPhrase(phrase);
  }

  async function push(delta) {
    pending += String(delta || '');
    for (;;) {
      const punctuation = pending.match(/^([\s\S]*?[.!?](?:["')\]]+)?)(?=\s|$)/u);
      if (punctuation && punctuation[1].trim().length >= minimumCharacters) {
        await emit(punctuation[1]);
        pending = pending.slice(punctuation[1].length).trimStart();
        continue;
      }
      if (pending.length >= maximumCharacters) {
        const breakAt = pending.lastIndexOf(' ', maximumCharacters);
        const length = breakAt > minimumCharacters ? breakAt : maximumCharacters;
        await emit(pending.slice(0, length));
        pending = pending.slice(length).trimStart();
        continue;
      }
      break;
    }
  }

  async function flush() {
    await emit(pending);
    pending = '';
  }

  return {
    push,
    flush,
    get emitted() {
      return emitted;
    },
  };
}

function createVoiceCoordinator({
  getModel,
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

    const request = {
      model,
      instructions: COORDINATOR_INSTRUCTIONS,
      input: [...history, userItem],
      tools: [DELEGATE_TOOL],
      tool_choice: 'auto',
      reasoning: { effort: 'none' },
      stream: typeof context.onSpeechPhrase === 'function',
    };
    let phraseEmitter = null;
    let response;
    if (request.stream && typeof streamResponse === 'function') {
      phraseEmitter = createPhraseEmitter(context.onSpeechPhrase);
      response = await streamResponse(request, {
        signal: context.signal,
        onTextDelta: phraseEmitter.push,
      });
      await phraseEmitter.flush();
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
        history,
        userItem,
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
      history,
      userItem,
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
  createVoiceCoordinator,
  rememberVoiceCoordinatorUpdate,
};
