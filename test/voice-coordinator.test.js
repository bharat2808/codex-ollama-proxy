'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  appendVoiceCoordinatorHistory,
  createVoiceCoordinator,
} = require('../src/voice-agent/voice-coordinator');

test('voice coordinator retains the complete in-session history', () => {
  const history = Array.from({ length: 20 }, (_, index) => ({
    role: 'user',
    content: [{ type: 'input_text', text: `turn ${index + 1}` }],
  }));

  assert.deepEqual(
    appendVoiceCoordinatorHistory(history.slice(0, 19), history[19]),
    history,
  );
});

test('voice coordinator returns direct speech from the preset voice model', async () => {
  const requests = [];
  const coordinate = createVoiceCoordinator({
    getModel: () => 'qwen3:8b',
    requestResponse: async (body) => {
      requests.push(body);
      return {
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hey! What are we building?' }],
        }],
      };
    },
  });

  const result = await coordinate('hello there', {});

  assert.deepEqual(result, {
    action: 'speak',
    text: 'Hey! What are we building?',
  });
  assert.equal(requests[0].model, 'qwen3:8b');
  assert.equal(requests[0].stream, false);
  assert.deepEqual(requests[0].reasoning, { effort: 'none' });
  assert.equal(requests[0].tools.length, 1);
  assert.equal(requests[0].tools[0].name, 'delegate_to_codex');
});

test('voice coordinator returns delegation from its only tool call', async () => {
  const coordinate = createVoiceCoordinator({
    getModel: () => 'qwen3:8b',
    requestResponse: async () => ({
      output: [{
        type: 'function_call',
        call_id: 'call-delegate',
        name: 'delegate_to_codex',
        arguments: JSON.stringify({
          request: 'Inspect the repository and fix the failing tests.',
        }),
      }],
    }),
  });

  assert.deepEqual(await coordinate('can you fix the tests', {}), {
    action: 'delegate',
    input: 'Inspect the repository and fix the failing tests.',
  });
});

test('voice coordinator preserves spoken text that accompanies a delegation tool call', async () => {
  const coordinate = createVoiceCoordinator({
    getModel: () => 'qwen3:8b',
    requestResponse: async () => ({
      output: [
        {
          type: 'function_call',
          call_id: 'call-delegate',
          name: 'delegate_to_codex',
          arguments: JSON.stringify({
            request: 'Inspect the repository and report the test failures.',
          }),
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: 'I’ll hand that to Codex now.',
          }],
        },
      ],
    }),
  });

  assert.deepEqual(await coordinate('what is failing', {}), {
    action: 'delegate',
    input: 'Inspect the repository and report the test failures.',
    preface: 'I’ll hand that to Codex now.',
  });
});

test('voice coordinator retains delegated work so the model can classify later follow-ups', async () => {
  const requests = [];
  let responseNumber = 0;
  const coordinate = createVoiceCoordinator({
    getModel: () => 'qwen3:8b',
    requestResponse: async (body) => {
      requests.push(body);
      responseNumber += 1;
      if (responseNumber === 1) {
        return {
          output: [{
            type: 'function_call',
            call_id: 'call-delegate-1',
            name: 'delegate_to_codex',
            arguments: JSON.stringify({
              request: 'Inspect the repository and fix the failing tests.',
            }),
          }],
        };
      }
      return {
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I’ll redirect that work.' }],
        }],
      };
    },
  });
  const context = {};

  await coordinate('fix the failing tests', context);
  await coordinate('actually start with the proxy tests', context);

  assert.deepEqual(requests[1].input.slice(0, 3), [
    {
      role: 'user',
      content: [{ type: 'input_text', text: 'fix the failing tests' }],
    },
    {
      type: 'function_call',
      call_id: 'call-delegate-1',
      name: 'delegate_to_codex',
      arguments: JSON.stringify({
        request: 'Inspect the repository and fix the failing tests.',
      }),
    },
    {
      type: 'function_call_output',
      call_id: 'call-delegate-1',
      output: JSON.stringify({
        status: 'accepted',
        request: 'Inspect the repository and fix the failing tests.',
      }),
    },
  ]);
  assert.equal(
    requests[1].input.at(-1).content[0].text,
    'actually start with the proxy tests',
  );
});

test('voice coordinator rejects a turn when the preset has no voice model', async () => {
  let requests = 0;
  const coordinate = createVoiceCoordinator({
    getModel: () => '',
    requestResponse: async () => {
      requests += 1;
      return {};
    },
  });

  await assert.rejects(
    coordinate('inspect the repository', {}),
    /voice model is not configured/u,
  );
  assert.equal(requests, 0);
});

test('voice coordinator surfaces model request failures instead of guessing delegation', async () => {
  const coordinate = createVoiceCoordinator({
    getModel: () => 'qwen3:8b',
    requestResponse: async () => {
      throw new Error('model unavailable');
    },
  });

  await assert.rejects(
    coordinate('inspect the repository', {}),
    /model unavailable/u,
  );
});

test('voice coordinator rejects a model response that neither speaks nor delegates', async () => {
  const coordinate = createVoiceCoordinator({
    getModel: () => 'qwen3:8b',
    requestResponse: async () => ({ output: [] }),
  });

  await assert.rejects(
    coordinate('inspect the repository', {}),
    /neither speech nor delegation/u,
  );
});

test('voice coordinator streams complete phrases before the model response finishes', async () => {
  const phrases = [];
  let releaseResponse;
  let deltaDelivered;
  const firstDelta = new Promise((resolve) => {
    deltaDelivered = resolve;
  });
  const responseGate = new Promise((resolve) => {
    releaseResponse = resolve;
  });
  const coordinate = createVoiceCoordinator({
    getModel: () => 'qwen3:8b',
    requestResponse: async () => {
      throw new Error('non-streaming request must not run');
    },
    streamResponse: async (_body, { onTextDelta }) => {
      await onTextDelta('I can help with that. ');
      deltaDelivered();
      await responseGate;
      await onTextDelta('What would you like next?');
      return {
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: 'I can help with that. What would you like next?',
          }],
        }],
      };
    },
  });

  const resultPromise = coordinate('hello', {
    onSpeechPhrase: async (text) => phrases.push(text),
  });
  await firstDelta;
  assert.deepEqual(phrases, ['I can help with that.']);

  releaseResponse();
  assert.deepEqual(await resultPromise, {
    action: 'speak',
    text: 'I can help with that. What would you like next?',
    streamed: true,
  });
  assert.deepEqual(phrases, [
    'I can help with that.',
    'What would you like next?',
  ]);
});
