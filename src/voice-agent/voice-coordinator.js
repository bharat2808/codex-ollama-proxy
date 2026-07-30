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

function createVoiceCoordinator({
  getModel,
  requestResponse,
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
      const response = await requestResponse({
        model,
        instructions: COORDINATOR_INSTRUCTIONS,
        input: [...history, userItem],
        tools: [DELEGATE_TOOL],
        tool_choice: 'auto',
        stream: false,
      });
      const delegated = delegationFrom(response, input);
      if (delegated) {
        const preface = speechFrom(response);
        return {
          action: 'delegate',
          input: delegated,
          ...(preface ? { preface } : {}),
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
      return { action: 'speak', text };
    } catch (error) {
      log(`voice coordinator failed; delegating to Codex: ${error.message}`);
      return { action: 'delegate', input };
    }
  };
}

module.exports = {
  COORDINATOR_INSTRUCTIONS,
  DELEGATE_TOOL,
  DELEGATE_TOOL_NAME,
  createVoiceCoordinator,
};
