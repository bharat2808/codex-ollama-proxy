'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  projectCodexCatalog,
} = require('../src/model-catalog/project-codex-catalog');

const canonical = {
  apply_patch_tool_type: 'freeform',
  supports_parallel_tool_calls: true,
  supports_search_tool: true,
  shell_type: 'shell_command',
  web_search_tool_type: 'text_and_image',
  use_responses_lite: false,
};

test('projects normalized Ollama discovery into the Codex catalog without I/O', () => {
  const result = projectCodexCatalog({
    existingModels: [
      { slug: 'vision-tools', display_name: 'vision-tools' },
      { slug: 'removed-model', display_name: 'removed-model' },
    ],
    knownIds: new Set(['vision-tools', 'text-only', 'forced-image']),
    discovery: {
      provider: 'ollama',
      models: [
        {
          id: 'vision-tools',
          displayName: 'Vision Tools',
          contextWindow: 131072,
          inputModalities: ['text', 'image'],
          reasoningLevels: ['low', 'high'],
          toolCalling: true,
          source: 'ollama-show',
        },
        {
          id: 'text-only',
          displayName: 'Text Only',
          contextWindow: null,
          inputModalities: ['text'],
          reasoningLevels: null,
          toolCalling: false,
          source: 'ollama-show',
        },
      ],
    },
    imageModel: 'forced-image',
    canonical,
  });

  assert.deepEqual(result.models.map((model) => model.slug), [
    'vision-tools',
    'text-only',
    'forced-image',
  ]);
  assert.equal(result.pruned, 1);
  assert.deepEqual(result.added, ['text-only', 'forced-image']);
  assert.deepEqual([...result.visionCapable], ['vision-tools', 'forced-image']);
  assert.equal(result.models[0].supports_parallel_tool_calls, true);
  assert.deepEqual(result.models[0].input_modalities, ['text', 'image']);
  assert.equal(result.models[0].context_window, 131072);
  assert.deepEqual(result.models[0].supported_reasoning_levels, ['low', 'high']);
  assert.equal(result.models[1].supports_parallel_tool_calls, false);
  assert.deepEqual(result.models[1].input_modalities, ['text']);
  assert.equal(result.models[2].supports_image_detail_original, true);
  assert.deepEqual(result.localModelIds, ['text-only', 'vision-tools']);
});

test('projects explicit non-Ollama vision support without guessing unknown capabilities', () => {
  const result = projectCodexCatalog({
    existingModels: [],
    knownIds: new Set(['remote-unknown', 'remote-vision', 'remote-image']),
    discovery: {
      provider: 'custom',
      models: [
        {
          id: 'remote-unknown',
          inputModalities: null,
          reasoningLevels: null,
          toolCalling: null,
          source: 'supplied',
        },
        {
          id: 'remote-vision',
          inputModalities: ['text', 'image'],
          reasoningLevels: null,
          toolCalling: null,
          source: 'provider-catalog',
        },
      ],
    },
    imageModel: 'remote-image',
    canonical,
  });

  assert.equal(result.isOllama, false);
  assert.deepEqual(result.models[0].input_modalities, ['text']);
  assert.deepEqual(result.models[1].input_modalities, ['text', 'image']);
  assert.equal(result.models[1].supports_image_detail_original, true);
  assert.deepEqual(result.models[2].input_modalities, ['text', 'image']);
  assert.equal(result.models[0].supports_parallel_tool_calls, true);
  assert.deepEqual([...result.visionCapable], ['remote-vision', 'remote-image']);
});
