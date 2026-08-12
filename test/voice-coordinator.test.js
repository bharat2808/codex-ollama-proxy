'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  appendVoiceCoordinatorHistory,
  createPhraseEmitter,
  createVoiceCoordinator,
} = require('../src/voice-agent/voice-coordinator');

function createManualScheduler() {
  let now = 0;
  let nextId = 1;
  const jobs = new Map();
  return {
    schedule(callback, delay) {
      const id = nextId;
      nextId += 1;
      jobs.set(id, { callback, due: now + delay });
      return id;
    },
    cancel(id) {
      jobs.delete(id);
    },
    async advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const next = [...jobs.entries()]
          .filter(([, job]) => job.due <= target)
          .sort((left, right) => left[1].due - right[1].due)[0];
        if (!next) break;
        const [id, job] = next;
        jobs.delete(id);
        now = job.due;
        await job.callback();
      }
      now = target;
      await Promise.resolve();
    },
  };
}

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

test('voice coordinator resolves the model from the live session and omits unsupported reasoning', async () => {
  const requests = [];
  const context = { modelSession: { metadata: { thread_id: 'thread-123' } } };
  const coordinate = createVoiceCoordinator({
    getModel: (receivedContext) => {
      assert.equal(receivedContext, context);
      return 'current-completion-model';
    },
    getReasoningEffort: () => null,
    requestResponse: async (body) => {
      requests.push(body);
      return {
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Ready.' }],
        }],
      };
    },
  });

  await coordinate('hello', context);

  assert.equal(requests[0].model, 'current-completion-model');
  assert.equal(Object.hasOwn(requests[0], 'reasoning'), false);
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

test('phrase emitter batches every complete sentence received during the initial 500 ms', async () => {
  const scheduler = createManualScheduler();
  const phrases = [];
  const emitter = createPhraseEmitter(async (text) => phrases.push(text), {
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancel,
  });

  await emitter.push('Hello! ');
  await scheduler.advance(300);
  await emitter.push('I am good. How are');
  await scheduler.advance(199);
  assert.deepEqual(phrases, []);

  await scheduler.advance(1);
  assert.deepEqual(phrases, ['Hello! I am good.']);

  await emitter.push(' you?');
  await scheduler.advance(499);
  assert.deepEqual(phrases, ['Hello! I am good.']);
  await scheduler.advance(1);
  assert.deepEqual(phrases, ['Hello! I am good.', 'How are you?']);
  await emitter.flush();
});

test('phrase emitter waits past 500 ms for a complete sentence then starts a new window', async () => {
  const scheduler = createManualScheduler();
  const phrases = [];
  const emitter = createPhraseEmitter(async (text) => phrases.push(text), {
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancel,
  });

  await emitter.push('Hello, I am currently');
  await scheduler.advance(500);
  assert.deepEqual(phrases, []);

  await emitter.push(' doing well.');
  await Promise.resolve();
  assert.deepEqual(phrases, ['Hello, I am currently doing well.']);

  await emitter.push(' Next one. ');
  await scheduler.advance(300);
  await emitter.push('And another.');
  await scheduler.advance(199);
  assert.deepEqual(phrases, ['Hello, I am currently doing well.']);
  await scheduler.advance(1);
  assert.deepEqual(phrases, [
    'Hello, I am currently doing well.',
    'Next one. And another.',
  ]);
  await emitter.flush();
});

test('phrase emitter does not treat a markdown newline as a standalone sentence', async () => {
  const scheduler = createManualScheduler();
  const phrases = [];
  const emitter = createPhraseEmitter(async (text) => phrases.push(text), {
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancel,
  });

  await emitter.push('# Summary\n');
  await scheduler.advance(500);
  assert.deepEqual(phrases, []);

  await emitter.push('Everything is working.');
  await Promise.resolve();
  assert.deepEqual(phrases, ['# Summary\nEverything is working.']);
  await emitter.flush();
});

test('phrase emitter coalesces released windows while the previous batch is playing', async () => {
  const scheduler = createManualScheduler();
  const started = [];
  let releaseFirst;
  const firstPlayback = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const emitter = createPhraseEmitter(async (text) => {
    started.push(text);
    if (started.length === 1) await firstPlayback;
  }, {
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancel,
  });

  await emitter.push('First sentence.');
  await scheduler.advance(500);
  assert.deepEqual(started, ['First sentence.']);

  await emitter.push('Second sentence.');
  await scheduler.advance(500);
  await emitter.push('Third sentence.');
  await scheduler.advance(500);
  assert.deepEqual(started, ['First sentence.']);

  releaseFirst();
  await emitter.flush();
  assert.deepEqual(started, [
    'First sentence.',
    'Second sentence. Third sentence.',
  ]);
});

test('phrase emitter folds stream completion into the mutable next batch', async () => {
  const scheduler = createManualScheduler();
  const started = [];
  let releaseFirst;
  const firstPlayback = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const emitter = createPhraseEmitter(async (text) => {
    started.push(text);
    if (started.length === 1) await firstPlayback;
  }, {
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancel,
  });

  await emitter.push('First sentence.');
  await scheduler.advance(500);
  await emitter.push('Second sentence. Final partial response');
  await scheduler.advance(500);
  const finished = emitter.flush();
  await Promise.resolve();
  assert.deepEqual(started, ['First sentence.']);

  releaseFirst();
  await finished;
  assert.deepEqual(started, [
    'First sentence.',
    'Second sentence. Final partial response',
  ]);
});

test('voice coordinator streams complete phrases before the model response finishes', async () => {
  const scheduler = createManualScheduler();
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
    phraseEmitterOptions: {
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    },
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
  assert.deepEqual(phrases, []);

  await scheduler.advance(500);
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

test('voice coordinator keeps consuming model deltas while earlier speech is playing', async () => {
  const scheduler = createManualScheduler();
  let releasePlayback;
  const playbackGate = new Promise((resolve) => {
    releasePlayback = resolve;
  });
  let modelContinued;
  const continued = new Promise((resolve) => {
    modelContinued = resolve;
  });
  const coordinate = createVoiceCoordinator({
    getModel: () => 'qwen3:8b',
    phraseEmitterOptions: {
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    },
    requestResponse: async () => {
      throw new Error('non-streaming request must not run');
    },
    streamResponse: async (_body, { onTextDelta }) => {
      await onTextDelta('This is the first sentence. ');
      await scheduler.advance(500);
      await onTextDelta('This is the second sentence.');
      modelContinued();
      return {
        output_text: 'This is the first sentence. This is the second sentence.',
      };
    },
  });

  const resultPromise = coordinate('hello', {
    onSpeechPhrase: async () => playbackGate,
  });
  await Promise.race([
    continued,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('model stream waited for speech playback')), 100);
    }),
  ]);
  releasePlayback();

  assert.deepEqual(await resultPromise, {
    action: 'speak',
    text: 'This is the first sentence. This is the second sentence.',
    streamed: true,
  });
});

test('voice coordinator cancels buffered speech when the model stream fails', async () => {
  const scheduler = createManualScheduler();
  const phrases = [];
  const coordinate = createVoiceCoordinator({
    getModel: () => 'qwen3:8b',
    phraseEmitterOptions: {
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    },
    requestResponse: async () => {
      throw new Error('non-streaming request must not run');
    },
    streamResponse: async (_body, { onTextDelta }) => {
      await onTextDelta('This response never finishes');
      throw new Error('stream disconnected');
    },
  });

  await assert.rejects(
    coordinate('hello', {
      onSpeechPhrase: async (text) => phrases.push(text),
    }),
    /stream disconnected/u,
  );
  await scheduler.advance(1200);

  assert.deepEqual(phrases, []);
});

test('voice coordinator does not force incomplete long deltas into speech', async () => {
  const phrases = [];
  let inspectBufferedDelta;
  const bufferedDelta = new Promise((resolve) => {
    inspectBufferedDelta = resolve;
  });
  let releaseRemainder;
  const remainderGate = new Promise((resolve) => {
    releaseRemainder = resolve;
  });
  const incomplete = `This is one continuous thought ${'without a safe boundary '.repeat(3)}`;
  const complete = `${incomplete}until this full line is completed.`;
  const coordinate = createVoiceCoordinator({
    getModel: () => 'qwen3:8b',
    requestResponse: async () => {
      throw new Error('non-streaming request must not run');
    },
    streamResponse: async (_body, { onTextDelta }) => {
      await onTextDelta(incomplete);
      inspectBufferedDelta();
      await remainderGate;
      await onTextDelta('until this full line is completed.\n');
      return {
        output_text: complete,
      };
    },
  });

  const resultPromise = coordinate('hello', {
    onSpeechPhrase: async (text) => phrases.push(text),
  });
  await bufferedDelta;
  assert.deepEqual(phrases, []);

  releaseRemainder();
  const result = await resultPromise;
  assert.equal(result.text, complete);
  assert.deepEqual(phrases, [complete]);
});

test('voice coordinator does not duplicate an input already committed by the voice server', async () => {
  let providerInput;
  const committedUser = {
    role: 'user',
    content: [{ type: 'input_text', text: 'keep this turn' }],
  };
  const coordinate = createVoiceCoordinator({
    getModel: () => 'qwen3:8b',
    requestResponse: async (body) => {
      providerInput = body.input;
      return { output_text: 'Kept.' };
    },
  });
  const context = {
    inputAlreadyInHistory: true,
    voiceCoordinatorHistory: [committedUser],
  };

  await coordinate('keep this turn', context);

  assert.deepEqual(providerInput, [committedUser]);
  assert.equal(
    context.voiceCoordinatorHistory.filter((item) => item.role === 'user').length,
    1,
  );
});

test('voice coordinator receives session context without persisting it as chat history', async () => {
  let providerInput;
  const coordinate = createVoiceCoordinator({
    getModel: () => 'qwen3:8b',
    requestResponse: async (body) => {
      providerInput = body.input;
      return { output_text: 'Ready.' };
    },
  });
  const context = {
    sessionContext: [
      'Thread ID: thread_123',
      'Working directory: /workspace/project',
    ].join('\n'),
    voiceCoordinatorHistory: [],
  };

  await coordinate('where are we working?', context);

  assert.deepEqual(providerInput[0], {
    role: 'developer',
    content: [{
      type: 'input_text',
      text: [
        'Active Codex voice session context:',
        'Thread ID: thread_123',
        'Working directory: /workspace/project',
      ].join('\n'),
    }],
  });
  assert.deepEqual(context.voiceCoordinatorHistory, [
    {
      role: 'user',
      content: [{ type: 'input_text', text: 'where are we working?' }],
    },
    {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Ready.' }],
    },
  ]);
});
