'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildProviderCatalog,
  enrichModelFromSeed,
  loadBundledProviderCatalog,
  openRouterIdFor,
} = require('../src/model-discovery/provider-catalog');
const {
  normalizeOpenAiModelCache,
} = require('../src/model-discovery/openai-model-cache');
const google = require('../src/model-discovery/providers/google');

const metadataFields = [
  'contextWindow',
  'maxOutputTokens',
  'inputModalities',
  'outputModalities',
  'reasoning',
  'reasoningLevels',
  'defaultReasoningLevel',
  'reasoningDefaultEnabled',
  'reasoningSupportsMaxTokens',
  'reasoningMandatory',
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
    defaultReasoningLevel: null,
    reasoningDefaultEnabled: null,
    reasoningSupportsMaxTokens: null,
    reasoningMandatory: null,
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

test('Anthropic and OpenAI catalog generation preserves every provider row without OpenRouter enrichment', () => {
  const providerModels = [
    model('gpt-example', { source: 'openai-catalog' }),
    model('text-embedding-example', { source: 'openai-catalog' }),
    model('gpt-image-example', { source: 'openai-catalog' }),
  ];
  const openrouter = [
    model('gpt-example', {
      contextWindow: 999999,
      source: 'openrouter-catalog',
    }),
  ];

  const openai = buildProviderCatalog('openai', providerModels, openrouter);
  const anthropic = buildProviderCatalog('anthropic', [
    model('claude-example', { source: 'anthropic-catalog' }),
  ], openrouter);

  assert.deepEqual(openai.models.map((entry) => entry.id), [
    'gpt-example',
    'gpt-image-example',
    'text-embedding-example',
  ]);
  assert.equal(openai.models[0].contextWindow, null);
  assert.deepEqual(anthropic.models.map((entry) => entry.id), ['claude-example']);
});

test('Codex model cache normalization preserves every row and useful OpenAI metadata', () => {
  const models = normalizeOpenAiModelCache({
    models: [
      {
        slug: 'gpt-example',
        display_name: 'GPT Example',
        description: 'Example cached model.',
        visibility: 'hide',
        supported_in_api: false,
        context_window: 272000,
        max_context_window: 1000000,
        input_modalities: ['text', 'image'],
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [
          { effort: 'low', description: 'Fast' },
          { effort: 'medium', description: 'Balanced' },
          { effort: 'high', description: 'Deep' },
        ],
        supports_parallel_tool_calls: true,
        additional_speed_tiers: ['fast'],
        service_tiers: [{ id: 'priority', name: 'Fast' }],
      },
      {
        slug: 'gpt-hidden',
        display_name: 'GPT Hidden',
        visibility: 'list',
        supported_in_api: true,
        context_window: 128000,
        input_modalities: ['text'],
        supported_reasoning_levels: [],
      },
      {
        slug: 'gpt-no-default',
        display_name: 'GPT No Default',
        context_window: 128000,
        input_modalities: ['text'],
        supported_reasoning_levels: [{ effort: 'high' }],
      },
    ],
  });

  assert.deepEqual(models.map((entry) => entry.id), [
    'gpt-example',
    'gpt-hidden',
    'gpt-no-default',
  ]);
  assert.deepEqual(models[0], {
    id: 'gpt-example',
    displayName: 'GPT Example',
    contextWindow: 272000,
    maxOutputTokens: null,
    inputModalities: ['text', 'image'],
    outputModalities: null,
    reasoning: true,
    reasoningLevels: ['low', 'medium', 'high'],
    defaultReasoningLevel: 'medium',
    reasoningDefaultEnabled: true,
    reasoningSupportsMaxTokens: null,
    reasoningMandatory: true,
    toolCalling: true,
    metadataSources: {
      contextWindow: 'provider-catalog',
      maxOutputTokens: null,
      inputModalities: 'provider-catalog',
      outputModalities: null,
      reasoning: 'provider-catalog',
      reasoningLevels: 'provider-catalog',
      defaultReasoningLevel: 'provider-catalog',
      reasoningDefaultEnabled: 'provider-catalog',
      reasoningSupportsMaxTokens: null,
      reasoningMandatory: 'provider-catalog',
      toolCalling: 'provider-catalog',
    },
    providerMetadata: {
      description: 'Example cached model.',
      visibility: 'hide',
      supportedInApi: false,
      maximumContextWindow: 1000000,
      additionalSpeedTiers: ['fast'],
      serviceTiers: [{ id: 'priority', name: 'Fast' }],
    },
    source: 'openai-model-cache',
  });
  assert.equal(models[1].reasoning, null);
  assert.equal(models[1].toolCalling, null);
  assert.equal(models[2].reasoning, true);
  assert.equal(models[2].defaultReasoningLevel, null);
  assert.equal(models[2].reasoningDefaultEnabled, null);
});

test('catalog build script emits Anthropic discovery and OpenAI Codex-cache bundles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-catalog-build-'));
  const cache = path.join(root, 'cache');
  const output = path.join(root, 'output');
  const openaiModelCache = path.join(root, 'models_cache.json');
  try {
    for (const [provider, models] of [
      ['anthropic', [model('claude-example', { source: 'anthropic-catalog' })]],
    ]) {
      const directory = path.join(cache, provider);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'cache.json'), JSON.stringify({
        provider,
        fetchedAt: 1,
        models,
      }));
    }
    fs.writeFileSync(openaiModelCache, JSON.stringify({
      models: [
        {
          slug: 'gpt-cache-example',
          display_name: 'GPT Cache Example',
          visibility: 'list',
          supported_in_api: true,
          context_window: 272000,
          max_context_window: 1000000,
          input_modalities: ['text', 'image'],
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }],
          supports_parallel_tool_calls: true,
        },
        {
          slug: 'codex-hidden-example',
          display_name: 'Codex Hidden Example',
          visibility: 'hide',
          supported_in_api: false,
          context_window: 128000,
          input_modalities: ['text'],
        },
      ],
    }));

    childProcess.execFileSync(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'build-provider-catalogs.js'),
      cache,
      output,
      openaiModelCache,
    ]);

    const anthropic = JSON.parse(fs.readFileSync(path.join(output, 'anthropic.json'), 'utf8'));
    const openai = JSON.parse(fs.readFileSync(path.join(output, 'openai.json'), 'utf8'));
    assert.deepEqual(anthropic.models.map((entry) => entry.id), ['claude-example']);
    assert.deepEqual(openai.models.map((entry) => entry.id), [
      'codex-hidden-example',
      'gpt-cache-example',
    ]);
    assert.equal(openai.models[0].providerMetadata.supportedInApi, false);
    assert.equal(openai.models[1].contextWindow, 272000);
    assert.deepEqual(openai.models[1].reasoningLevels, ['medium', 'high']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  assert.equal(
    openRouterIdFor('ollama-cloud', 'gemma4:31b-cloud'),
    'google/gemma-4-31b-it',
  );
  assert.equal(openRouterIdFor('ollama-cloud', 'unknown:cloud'), null);
});

test('Ollama Gemma 4 provider controls override its exact OpenRouter enrichment', () => {
  const native = model('gemma4:31b-cloud', {
    reasoning: true,
    metadataSources: {
      ...model('unused').metadataSources,
      reasoning: 'provider-inspection',
    },
    source: 'ollama-show',
  });
  const openrouter = model('google/gemma-4-31b-it', {
    displayName: 'Google: Gemma 4 31B',
    contextWindow: 262144,
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    reasoning: true,
    reasoningLevels: ['low'],
  });

  const catalog = buildProviderCatalog('ollama-cloud', [native], [openrouter]);
  const enriched = catalog.models[0];

  assert.equal(enriched.displayName, 'Google: Gemma 4 31B');
  assert.equal(enriched.contextWindow, 262144);
  assert.deepEqual(enriched.inputModalities, ['text', 'image']);
  assert.deepEqual(enriched.reasoningLevels, ['none', 'low', 'medium', 'high', 'max']);
  assert.equal(enriched.metadataSources.contextWindow, 'openrouter-catalog');
  assert.equal(enriched.metadataSources.reasoningLevels, 'provider-catalog');
});

test('OpenRouter enrichment copies exact reasoning capabilities and tolerates absent optional fields', () => {
  const native = model('deepseek-v4-pro', { reasoning: true });
  const openrouter = model('deepseek/deepseek-v4-pro', {
    reasoning: true,
    reasoningLevels: ['low', 'medium', 'high'],
    defaultReasoningLevel: 'medium',
    reasoningDefaultEnabled: true,
    reasoningSupportsMaxTokens: false,
    reasoningMandatory: false,
  });
  delete openrouter.reasoningSupportsMaxTokens;

  const catalog = buildProviderCatalog('deepseek', [native], [openrouter]);
  const enriched = catalog.models[0];

  assert.deepEqual(enriched.reasoningLevels, ['low', 'medium', 'high']);
  assert.equal(enriched.defaultReasoningLevel, 'medium');
  assert.equal(enriched.reasoningDefaultEnabled, true);
  assert.equal(enriched.reasoningSupportsMaxTokens, null);
  assert.equal(enriched.reasoningMandatory, false);
  assert.equal(enriched.metadataSources.reasoningLevels, 'openrouter-catalog');
  assert.equal(enriched.metadataSources.defaultReasoningLevel, 'openrouter-catalog');
});

test('live provider rows retain exact bundled reasoning metadata without overriding live fields', () => {
  const live = model('provider-model', {
    contextWindow: 999,
    reasoning: true,
    metadataSources: {
      ...model('unused').metadataSources,
      contextWindow: 'provider-catalog',
      reasoning: 'provider-catalog',
    },
  });
  const seed = model('provider-model', {
    contextWindow: 123,
    reasoning: true,
    reasoningLevels: ['low', 'high'],
    defaultReasoningLevel: 'high',
    reasoningDefaultEnabled: true,
    reasoningMandatory: true,
    metadataSources: {
      ...model('unused').metadataSources,
      contextWindow: 'openrouter-catalog',
      reasoning: 'openrouter-catalog',
      reasoningLevels: 'openrouter-catalog',
      defaultReasoningLevel: 'openrouter-catalog',
      reasoningDefaultEnabled: 'openrouter-catalog',
      reasoningMandatory: 'openrouter-catalog',
    },
  });

  const enriched = enrichModelFromSeed(live, seed);

  assert.equal(enriched.contextWindow, 999);
  assert.deepEqual(enriched.reasoningLevels, ['low', 'high']);
  assert.equal(enriched.defaultReasoningLevel, 'high');
  assert.equal(enriched.reasoningDefaultEnabled, true);
  assert.equal(enriched.reasoningMandatory, true);
  assert.equal(enriched.metadataSources.reasoningLevels, 'openrouter-catalog');
});

test('OpenRouter enrichment prefers the newest cached duplicate supplied first', () => {
  const native = model('gemini-3.6-flash', { reasoning: true });
  const newest = model('google/gemini-3.6-flash', {
    reasoning: true,
    reasoningLevels: ['minimal', 'low', 'medium', 'high'],
    defaultReasoningLevel: 'medium',
  });
  const older = model('google/gemini-3.6-flash', { reasoning: true });

  const catalog = buildProviderCatalog('google', [native], [newest, older]);

  assert.deepEqual(catalog.models[0].reasoningLevels, ['minimal', 'low', 'medium', 'high']);
  assert.equal(catalog.models[0].defaultReasoningLevel, 'medium');
});

test('packaged provider catalogs are normalized, enriched, and contain no OpenClaw provenance', () => {
  for (const provider of ['anthropic', 'cohere', 'deepseek', 'google', 'moonshot', 'nvidia', 'ollama-cloud', 'openai', 'openrouter', 'xai']) {
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
  const grok43 = xai.models.find((entry) => entry.id === 'grok-4.3');
  const grokBuild = xai.models.find((entry) => entry.id === 'grok-build-0.1');
  const grok420 = xai.models.find((entry) => entry.id === 'grok-4.20-0309-reasoning');
  assert.deepEqual(grok45.reasoningLevels, ['low', 'medium', 'high']);
  assert.equal(grok45.defaultReasoningLevel, 'high');
  assert.equal(grok45.metadataSources.defaultReasoningLevel, 'provider-catalog');
  assert.deepEqual(grok43.reasoningLevels, ['none', 'low', 'medium', 'high']);
  assert.equal(grok43.defaultReasoningLevel, 'low');
  assert.equal(grok43.metadataSources.reasoningLevels, 'openrouter-catalog');
  assert.equal(grokBuild.reasoning, true);
  assert.equal(grokBuild.reasoningMandatory, true);
  assert.equal(grokBuild.reasoningLevels, null);
  assert.equal(grok420.reasoning, true);
  assert.equal(grok420.reasoningMandatory, true);
  assert.equal(grok420.reasoningLevels, null);

  const openrouter = loadBundledProviderCatalog('openrouter');
  const gpt54 = openrouter.models.find((entry) => entry.id === 'openai/gpt-5.4');
  assert.deepEqual(gpt54.reasoningLevels, ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(gpt54.defaultReasoningLevel, 'medium');
  assert.equal(gpt54.reasoningDefaultEnabled, false);
  assert.equal(gpt54.reasoningMandatory, false);

  const google = loadBundledProviderCatalog('google');
  const gemini36 = google.models.find((entry) => entry.id === 'gemini-3.6-flash');
  const gemini25Flash = google.models.find((entry) => entry.id === 'gemini-2.5-flash');
  const gemini3Pro = google.models.find((entry) => entry.id === 'gemini-3-pro-preview');
  const geminiProLatest = google.models.find((entry) => entry.id === 'gemini-pro-latest');
  const gemma426b = google.models.find((entry) => entry.id === 'gemma-4-26b-a4b-it');
  const gemma431b = google.models.find((entry) => entry.id === 'gemma-4-31b-it');
  assert.deepEqual(gemini36.reasoningLevels, ['minimal', 'low', 'medium', 'high']);
  assert.equal(gemini36.defaultReasoningLevel, 'medium');
  assert.equal(gemini36.metadataSources.reasoningLevels, 'openrouter-catalog');
  assert.deepEqual(gemini25Flash.reasoningLevels, ['none', 'minimal', 'low', 'medium', 'high']);
  assert.equal(gemini25Flash.defaultReasoningLevel, null);
  assert.equal(gemini25Flash.metadataSources.reasoningLevels, 'provider-catalog');
  assert.deepEqual(gemini3Pro.reasoningLevels, ['low', 'high']);
  assert.equal(gemini3Pro.defaultReasoningLevel, 'high');
  assert.deepEqual(geminiProLatest.reasoningLevels, ['low', 'medium', 'high']);
  assert.equal(geminiProLatest.defaultReasoningLevel, 'high');
  assert.equal(geminiProLatest.metadataSources.reasoningLevels, 'provider-catalog');
  for (const gemma4 of [gemma426b, gemma431b]) {
    assert.deepEqual(gemma4.reasoningLevels, ['minimal', 'high']);
    assert.equal(gemma4.reasoningDefaultEnabled, false);
    assert.equal(gemma4.reasoningMandatory, false);
    assert.equal(gemma4.metadataSources.reasoningLevels, 'provider-catalog');
  }

  const nvidia = loadBundledProviderCatalog('nvidia');
  const nemotronSuper = nvidia.models.find(
    (entry) => entry.id === 'nvidia/nemotron-3-super-120b-a12b',
  );
  const deepseekV4 = nvidia.models.find(
    (entry) => entry.id === 'deepseek-ai/deepseek-v4-pro',
  );
  assert.deepEqual(nemotronSuper.reasoningLevels, ['low', 'medium']);
  assert.equal(nemotronSuper.defaultReasoningLevel, 'medium');
  assert.deepEqual(deepseekV4.reasoningLevels, ['none', 'high', 'max']);
  assert.equal(deepseekV4.defaultReasoningLevel, 'high');

  const ollamaCloud = loadBundledProviderCatalog('ollama-cloud');
  const gemma4 = ollamaCloud.models.find((entry) => entry.id === 'gemma4:31b-cloud');
  assert.ok(gemma4, 'Ollama Cloud Gemma 4 must be bundled');
  assert.equal(gemma4.displayName, 'Google: Gemma 4 31B');
  assert.equal(gemma4.contextWindow, 262144);
  assert.deepEqual(gemma4.inputModalities, ['text', 'image']);
  for (const entry of ollamaCloud.models) {
    assert.deepEqual(entry.reasoningLevels, ['none', 'low', 'medium', 'high', 'max']);
    assert.equal(entry.metadataSources.reasoningLevels, 'provider-catalog');
  }

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
      if (entry.defaultReasoningLevel !== null && entry.defaultReasoningLevel !== undefined) {
        assert.ok(
          entry.reasoningLevels.includes(entry.defaultReasoningLevel),
          `${provider}/${entry.id} default reasoning level must be supported`,
        );
      }
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
