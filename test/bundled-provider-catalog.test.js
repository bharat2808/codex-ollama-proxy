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
