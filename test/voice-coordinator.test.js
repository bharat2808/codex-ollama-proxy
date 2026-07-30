'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createVoiceCoordinator,
} = require('../src/voice-agent/voice-coordinator');

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

test('voice coordinator preserves legacy delegation when the preset has no voice model', async () => {
  let requests = 0;
  const coordinate = createVoiceCoordinator({
    getModel: () => '',
    requestResponse: async () => {
      requests += 1;
      return {};
    },
  });

  assert.deepEqual(await coordinate('inspect the repository', {}), {
    action: 'delegate',
    input: 'inspect the repository',
  });
  assert.equal(requests, 0);
});

test('voice coordinator delegates safely when its model request fails', async () => {
  const messages = [];
  const coordinate = createVoiceCoordinator({
    getModel: () => 'qwen3:8b',
    requestResponse: async () => {
      throw new Error('model unavailable');
    },
    log: (message) => messages.push(message),
  });

  assert.deepEqual(await coordinate('inspect the repository', {}), {
    action: 'delegate',
    input: 'inspect the repository',
  });
  assert.match(messages[0], /model unavailable/u);
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
