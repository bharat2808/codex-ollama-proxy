'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createActiveModelTracker,
  lowestReasoningEffort,
  resolveVoiceModel,
} = require('../src/voice-agent/voice-model-selection');

test('active completion models are isolated by Codex thread', () => {
  const tracker = createActiveModelTracker();
  tracker.record({ model: 'model-a', metadata: { thread_id: 'thread-a' } });
  tracker.record({ model: 'model-b', metadata: { thread_id: 'thread-b' } });

  assert.equal(tracker.resolve({ metadata: { thread_id: 'thread-a' } }), 'model-a');
  assert.equal(tracker.resolve({ metadata: { thread_id: 'thread-b' } }), 'model-b');
  assert.equal(tracker.resolve({ metadata: { thread_id: 'thread-c' } }), '');
});

test('a Codex prompt cache key can correlate with the same voice thread id', () => {
  const tracker = createActiveModelTracker();
  tracker.record({ model: 'active-model', prompt_cache_key: 'thread-123' });

  assert.equal(
    tracker.resolve({ metadata: { thread_id: 'thread-123' } }),
    'active-model',
  );
});

test('voice model falls back from configured model to task model to preset default', () => {
  const tracker = createActiveModelTracker();
  tracker.record({ model: 'active-model', metadata: { thread_id: 'thread-1' } });

  assert.equal(resolveVoiceModel({
    configuredModel: 'voice-model',
    defaultModel: 'default-model',
    tracker,
    session: { metadata: { thread_id: 'thread-1' } },
  }), 'voice-model');
  assert.equal(resolveVoiceModel({
    configuredModel: '',
    defaultModel: 'default-model',
    tracker,
    session: { metadata: { thread_id: 'thread-1' } },
  }), 'active-model');
  assert.equal(resolveVoiceModel({
    configuredModel: '',
    defaultModel: 'default-model',
    tracker,
    session: { metadata: { thread_id: 'unseen' } },
  }), 'default-model');
});

test('lowest reasoning effort follows the model catalog and otherwise omits reasoning', () => {
  const catalog = [
    {
      slug: 'supports-none',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'none' }],
    },
    {
      slug: 'requires-reasoning',
      supported_reasoning_levels: [{ effort: 'high' }, { effort: 'minimal' }, { effort: 'low' }],
    },
    { slug: 'no-reasoning', supported_reasoning_levels: [] },
  ];

  assert.equal(lowestReasoningEffort('supports-none', catalog), 'none');
  assert.equal(lowestReasoningEffort('requires-reasoning', catalog), 'minimal');
  assert.equal(lowestReasoningEffort('no-reasoning', catalog), null);
  assert.equal(lowestReasoningEffort('unknown', catalog), null);
});
