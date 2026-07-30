'use strict';

const DELEGATE_TOOL_NAME = 'delegate_to_codex';
const MAX_HISTORY_ITEMS = 12;

const COORDINATOR_INSTRUCTIONS = [
  'You are the conversational voice coordinator for a Codex agent.',
  'Respond directly only when the request is self-contained and requires no tools, files, workspace access, research, or longer-running work.',
  `For every action or task, call ${DELEGATE_TOOL_NAME}.`,
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

function outputItems(response) {
  return Array.isArray(response && response.output) ? response.output : [];
}

function delegationFrom(response, fallback) {
  const call = outputItems(response).find((item) => (
    item
    && item.type === 'function_call'
    && item.name === DELEGATE_TOOL_NAME
  ));
  if (!call) return null;
  try {
    const args = JSON.parse(String(call.arguments || '{}'));
    const request = String(args.request || '').trim();
    return request || fallback;
  } catch {
    return fallback;
  }
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
  log = () => {},
} = {}) {
  if (typeof getModel !== 'function') throw new Error('voice coordinator getModel is required');
  if (typeof requestResponse !== 'function') throw new Error('voice coordinator requestResponse is required');

  return async function coordinateTranscript(transcript, context = {}) {
    const input = String(transcript || '').trim();
    const model = String(getModel() || '').trim();
    if (!model || !input) return { action: 'delegate', input };

    const history = Array.isArray(context.voiceCoordinatorHistory)
      ? context.voiceCoordinatorHistory
      : [];
    const userItem = {
      role: 'user',
      content: [{ type: 'input_text', text: input }],
    };

    try {
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
      if (
        request.stream
        && typeof streamResponse === 'function'
      ) {
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
      const delegated = delegationFrom(response, input);
      if (delegated) {
        const preface = speechFrom(response);
        return {
          action: 'delegate',
          input: delegated,
          ...(preface ? { preface } : {}),
          ...(phraseEmitter && phraseEmitter.emitted ? { streamed: true } : {}),
        };
      }

      const text = speechFrom(response);
      if (!text) return { action: 'delegate', input };
      const assistantItem = {
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      };
      context.voiceCoordinatorHistory = [
        ...history,
        userItem,
        assistantItem,
      ].slice(-MAX_HISTORY_ITEMS);
      return {
        action: 'speak',
        text,
        ...(phraseEmitter && phraseEmitter.emitted ? { streamed: true } : {}),
      };
    } catch (error) {
      if (context.signal && context.signal.aborted) throw error;
      log(`voice coordinator failed; delegating to Codex: ${error.message}`);
      return { action: 'delegate', input };
    }
  };
}

module.exports = {
  COORDINATOR_INSTRUCTIONS,
  DELEGATE_TOOL,
  DELEGATE_TOOL_NAME,
  createPhraseEmitter,
  createVoiceCoordinator,
};
