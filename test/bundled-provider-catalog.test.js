'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildProviderCatalog,
  loadBundledProviderCatalog,
  openRouterIdFor,
} = require('../src/model-discovery/provider-catalog');
const google = require('../src/model-discovery/providers/google');

const metadataFields = [
  'contextWindow',
  'maxOutputTokens',
  'inputModalities',
  'outputModalities',
  'reasoning',
  'reasoningLevels',
  'toolCalling',
];

function model(id, overrides = {}) {
  return {
    id,
    displayName: id,
    contextWindow: null,
    maxOutputTokens: null,
    inputModalities: null,
    outputModalities: null,
    reasoning: null,
    reasoningLevels: null,
    toolCalling: null,
    metadataSources: Object.fromEntries(metadataFields.map((field) => [field, null])),
    source: 'provider-catalog',
    ...overrides,
  };
}

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

test('owned catalog generation drops OpenClaw rows and strips inherited seed fields', () => {
  const native = model('deepseek-v4-pro', {
    contextWindow: 999999,
    maxOutputTokens: 384000,
    inputModalities: ['text'],
    reasoning: true,
    metadataSources: {
      ...model('unused').metadataSources,
      contextWindow: 'provider-seed',
      maxOutputTokens: 'provider-catalog',
      inputModalities: 'provider-seed',
      reasoning: 'provider-seed',
    },
  });
  const inherited = model('copied/model', { source: 'openclaw-static' });
  const openrouter = model('deepseek/deepseek-v4-pro', {
    contextWindow: 1048576,
    inputModalities: ['text'],
    outputModalities: ['text'],
    reasoning: true,
    toolCalling: true,
  });

  const catalog = buildProviderCatalog('deepseek', [native, inherited], [openrouter]);

  assert.deepEqual(catalog.models.map((entry) => entry.id), ['deepseek-v4-pro']);
  assert.equal(catalog.models[0].contextWindow, 1048576);
  assert.equal(catalog.models[0].maxOutputTokens, 384000);
  assert.deepEqual(catalog.models[0].outputModalities, ['text']);
  assert.equal(catalog.models[0].metadataSources.contextWindow, 'openrouter-catalog');
  assert.equal(catalog.models[0].metadataSources.maxOutputTokens, 'provider-catalog');
  assert.equal(catalog.models[0].metadataSources.outputModalities, 'openrouter-catalog');
  assert.equal(catalog.models[0].source, 'bundled-provider-catalog');
});

test('owned catalog generation restores exact provider-documented modalities after stripping seeds', () => {
  const cohere = model('command-a-plus-05-2026', {
    inputModalities: ['text'],
    outputModalities: ['text'],
    metadataSources: {
      ...model('unused').metadataSources,
      inputModalities: 'provider-seed',
      outputModalities: 'provider-catalog',
    },
  });
  const xai = model('grok-imagine-video', {
    contextWindow: 8000,
    metadataSources: {
      ...model('unused').metadataSources,
      contextWindow: 'provider-catalog',
    },
  });
  const grok45 = model('grok-4.5');

  const cohereCatalog = buildProviderCatalog('cohere', [cohere], []);
  const xaiCatalog = buildProviderCatalog('xai', [xai, grok45], []);

  assert.deepEqual(cohereCatalog.models[0].inputModalities, ['text', 'image']);
  assert.deepEqual(cohereCatalog.models[0].outputModalities, ['text']);
  assert.equal(cohereCatalog.models[0].metadataSources.inputModalities, 'provider-catalog');
  const xaiVideo = xaiCatalog.models.find((entry) => entry.id === 'grok-imagine-video');
  const xaiGrok45 = xaiCatalog.models.find((entry) => entry.id === 'grok-4.5');
  assert.deepEqual(xaiVideo.inputModalities, ['text', 'image', 'video']);
  assert.deepEqual(xaiVideo.outputModalities, ['video']);
  assert.equal(xaiVideo.metadataSources.outputModalities, 'provider-catalog');
  assert.deepEqual(xaiGrok45.reasoningLevels, ['low', 'medium', 'high']);
  assert.equal(xaiGrok45.defaultReasoningLevel, 'high');
  assert.equal(xaiGrok45.metadataSources.defaultReasoningLevel, 'provider-catalog');
});

test('owned catalog records provider-documented models that reject tool use', () => {
  const vision = model('command-a-vision-07-2025');

  const catalog = buildProviderCatalog('cohere', [vision], []);

  assert.equal(catalog.models[0].toolCalling, false);
  assert.equal(catalog.models[0].metadataSources.toolCalling, 'provider-catalog');
});

test('OpenRouter enrichment uses provider-aware exact ids only', () => {
  assert.equal(openRouterIdFor('deepseek', 'deepseek-v4-pro'), 'deepseek/deepseek-v4-pro');
  assert.equal(openRouterIdFor('moonshot', 'kimi-k2.7-code'), 'moonshotai/kimi-k2.7-code');
  assert.equal(openRouterIdFor('xai', 'grok-4.5'), 'x-ai/grok-4.5');
  assert.equal(openRouterIdFor('google', 'gemini-2.5-pro'), 'google/gemini-2.5-pro');
  assert.equal(openRouterIdFor('nvidia', 'qwen/qwen3.5-397b-a17b'), 'qwen/qwen3.5-397b-a17b');
  assert.equal(openRouterIdFor('ollama-cloud', 'glm-5.2:cloud'), 'z-ai/glm-5.2');
  assert.equal(openRouterIdFor('ollama-cloud', 'unknown:cloud'), null);
});

test('packaged provider catalogs are normalized, enriched, and contain no OpenClaw provenance', () => {
  for (const provider of ['cohere', 'deepseek', 'google', 'moonshot', 'nvidia', 'ollama-cloud', 'openrouter', 'xai']) {
    const result = loadBundledProviderCatalog(provider);
    assert.equal(result.state, 'bundled');
    assert.ok(result.models.length > 0, `${provider} must contain models`);
    assert.equal(JSON.stringify(result).toLowerCase().includes('openclaw'), false);
  }

  const deepseek = loadBundledProviderCatalog('deepseek');
  const v4 = deepseek.models.find((entry) => entry.id === 'deepseek-v4-pro');
  assert.equal(v4.contextWindow, 1048576);
  assert.deepEqual(v4.outputModalities, ['text']);
  assert.equal(v4.metadataSources.contextWindow, 'openrouter-catalog');

  const xai = loadBundledProviderCatalog('xai');
  const grok45 = xai.models.find((entry) => entry.id === 'grok-4.5');
  assert.deepEqual(grok45.reasoningLevels, ['low', 'medium', 'high']);
  assert.equal(grok45.defaultReasoningLevel, 'high');
  assert.equal(grok45.metadataSources.defaultReasoningLevel, 'provider-catalog');

  const expectedModalities = {
    cohere: {
      'command-a-03-2025': [['text'], ['text']],
      'command-a-plus-05-2026': [['text', 'image'], ['text']],
      'command-a-reasoning-08-2025': [['text'], ['text']],
      'command-a-vision-07-2025': [['text', 'image'], ['text']],
      'north-mini-code-1-0': [['text', 'image'], ['text']],
    },
    xai: {
      'grok-4.20-0309-non-reasoning': [['text', 'image'], ['text']],
      'grok-4.20-0309-reasoning': [['text', 'image'], ['text']],
      'grok-imagine-image': [['text', 'image'], ['image']],
      'grok-imagine-image-quality': [['text', 'image'], ['image']],
      'grok-imagine-video': [['text', 'image', 'video'], ['video']],
      'grok-imagine-video-1.5': [['image'], ['video']],
    },
  };
  for (const [provider, expected] of Object.entries(expectedModalities)) {
    const catalog = loadBundledProviderCatalog(provider);
    for (const [id, [input, output]] of Object.entries(expected)) {
      const entry = catalog.models.find((modelEntry) => modelEntry.id === id);
      assert.ok(entry, `${provider}/${id} must be bundled`);
      assert.deepEqual(entry.inputModalities, input, `${provider}/${id} input modalities`);
      assert.deepEqual(entry.outputModalities, output, `${provider}/${id} output modalities`);
    }
  }

  for (const provider of ['cohere', 'deepseek', 'google', 'moonshot', 'nvidia', 'ollama-cloud', 'openrouter', 'xai']) {
    const catalog = loadBundledProviderCatalog(provider);
    for (const entry of catalog.models) {
      assert.ok(entry.inputModalities, `${provider}/${entry.id} must declare input modalities`);
      assert.ok(entry.outputModalities, `${provider}/${entry.id} must declare output modalities`);
    }
  }

  const sourceTree = filesUnder(path.join(__dirname, '..', 'src', 'model-discovery'));
  for (const file of sourceTree) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /openclaw/iu, file);
  }
});

test('Google first-run discovery falls back to the owned catalog without network metadata sync', async () => {
  let calls = 0;
  const result = await google.discover({
    baseUrl: google.BASE_URL,
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      calls += 1;
      assert.equal(url, google.ENDPOINT);
      throw new Error('offline');
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.origin, 'bundled');
  assert.equal(result.fallback.state, 'bundled');
  assert.ok(result.models.some((entry) => entry.id === 'gemini-2.5-pro'));
});
