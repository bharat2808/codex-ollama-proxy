'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  mergeDiscoveredWithSupplied,
  normalizeReasoningLevels,
  normalizeSuppliedModels,
} = require('../src/model-discovery/normalize');
const { resolveProvider } = require('../src/model-discovery/provider-resolution');
const { fetchJson } = require('../src/model-discovery/live-catalog');
const { cacheIdentity, withProviderCache } = require('../src/model-discovery/file-cache');
const nvidia = require('../src/model-discovery/providers/nvidia');
const openrouter = require('../src/model-discovery/providers/openrouter');
const cohere = require('../src/model-discovery/providers/cohere');
const ollama = require('../src/model-discovery/providers/ollama');
const zai = require('../src/model-discovery/providers/zai');
const moonshot = require('../src/model-discovery/providers/moonshot');
const deepseek = require('../src/model-discovery/providers/deepseek');
const google = require('../src/model-discovery/providers/google');
const xai = require('../src/model-discovery/providers/xai');
const { discoverModels } = require('../src/model-discovery');

test('reasoning normalization preserves every effort accepted by the Codex model cache', () => {
  assert.deepEqual(
    normalizeReasoningLevels(['ultra', 'max', 'xhigh', 'high', 'medium', 'low']),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );
});

test('supplied model ids are validated, deduplicated, and retain unknown metadata', () => {
  const models = normalizeSuppliedModels([' first/model ', 'second:model', 'first/model']);

  assert.deepEqual(models.map((model) => model.id), ['first/model', 'second:model']);
  assert.deepEqual(models[0], {
    id: 'first/model',
    displayName: 'first/model',
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
    metadataSources: {
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
    },
    source: 'supplied',
  });
  assert.throws(() => normalizeSuppliedModels(['bad model']), /unsafe model id/i);
  assert.throws(() => normalizeSuppliedModels(['']), /unsafe model id/i);
});

test('exact discovered rows enrich supplied ids and unmatched supplied ids append in CLI order', () => {
  const supplied = normalizeSuppliedModels(['extra/z', 'known/a', 'extra/b']);
  const discovered = [
    {
      ...supplied[1],
      displayName: 'Known A',
      contextWindow: 131072,
      metadataSources: { ...supplied[1].metadataSources, contextWindow: 'provider-catalog' },
      source: 'https://provider.example/catalog',
    },
  ];

  const models = mergeDiscoveredWithSupplied(discovered, supplied);

  assert.deepEqual(models.map((model) => model.id), ['known/a', 'extra/z', 'extra/b']);
  assert.equal(models[0].contextWindow, 131072);
  assert.equal(models[0].metadataSources.contextWindow, 'provider-catalog');
});

test('explicit and canonical provider resolution are deterministic and do not fetch', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error('unexpected fetch');
  };

  assert.deepEqual(await resolveProvider({ provider: 'nvidia', fetchImpl }), {
    provider: 'nvidia',
    providerResolution: 'explicit',
    detectionPayload: null,
  });
  assert.deepEqual(await resolveProvider({
    baseUrl: 'https://openrouter.ai/v1/',
    fetchImpl,
  }), {
    provider: 'openrouter',
    providerResolution: 'canonical-url',
    detectionPayload: null,
  });
  assert.deepEqual(await resolveProvider({
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    fetchImpl,
  }), {
    provider: 'cohere',
    providerResolution: 'canonical-url',
    detectionPayload: null,
  });
  assert.equal(fetchCalls, 0);
  await assert.rejects(resolveProvider({ provider: 'nvidai', fetchImpl }), /unknown provider/i);
});

test('five extended providers resolve from canonical URLs and explicit aliases without fetching', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error('unexpected fetch');
  };
  const canonical = [
    ['https://api.z.ai/api/paas/v4/', 'zai'],
    ['https://api.moonshot.ai/v1', 'moonshot'],
    ['https://api.moonshot.cn/v1/', 'moonshot'],
    ['https://api.deepseek.com', 'deepseek'],
    ['https://api.deepseek.com/v1/', 'deepseek'],
    ['https://generativelanguage.googleapis.com/v1beta/openai', 'google'],
    ['https://api.x.ai/v1/', 'xai'],
  ];
  for (const [baseUrl, provider] of canonical) {
    const result = await resolveProvider({ baseUrl, fetchImpl });
    assert.equal(result.provider, provider);
    assert.equal(result.providerResolution, 'canonical-url');
  }
  for (const [alias, provider] of [['z-ai', 'zai'], ['z.ai', 'zai'], ['grok', 'xai']]) {
    const result = await resolveProvider({ provider: alias, fetchImpl });
    assert.equal(result.provider, provider);
    assert.equal(result.providerResolution, 'explicit');
  }
  assert.equal(fetchCalls, 0);
});

test('Vertex AI OpenAI endpoints resolve as Google without probing', async () => {
  let fetchCalls = 0;
  const result = await resolveProvider({
    baseUrl: 'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/endpoints/openapi',
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('unexpected fetch');
    },
  });
  assert.equal(result.provider, 'google');
  assert.equal(result.providerResolution, 'canonical-url');
  assert.equal(fetchCalls, 0);
});

test('Google provider aliases resolve explicitly without probing', async () => {
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    throw new Error('must not fetch');
  };

  for (const provider of ['aistudio', 'gemini', 'vertexai', 'vertex-ai']) {
    const result = await resolveProvider({ provider, fetchImpl });
    assert.equal(result.provider, 'google');
    assert.equal(result.providerResolution, 'explicit');
  }
  assert.equal(fetches, 0);
});

test('Vertex Google discovery classifies only explicitly supplied Gemini models', async () => {
  const result = await google.discover({
    baseUrl: 'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/endpoints/openapi',
    suppliedModels: ['google/gemini-2.5-flash', 'google/gemini-3.1-flash-image'],
    fetchImpl: async () => {
      throw new Error('Vertex discovery must not call the Developer API catalog');
    },
  });
  assert.deepEqual(result.models.map((model) => model.id), [
    'google/gemini-2.5-flash',
    'google/gemini-3.1-flash-image',
  ]);
  assert.deepEqual(result.models[0].outputModalities, ['text']);
  assert.deepEqual(result.models[1].outputModalities, ['text', 'image']);
  assert.equal(result.complete, false);
});

test('local Ollama auto-detection reuses tags while remote endpoints resolve as custom without probing', async () => {
  const calls = [];
  const payload = { models: [{ name: 'qwen3:8b' }] };
  const fetchImpl = async (url, options) => {
    calls.push(String(url));
    assert.equal(options.headers.Authorization, undefined);
    return new Response(JSON.stringify(payload));
  };

  const local = await resolveProvider({
    baseUrl: 'http://localhost:11434/v1/',
    apiKey: 'must-not-reach-local-ollama',
    fetchImpl,
  });
  assert.deepEqual(local, {
    provider: 'ollama',
    providerResolution: 'ollama-native',
    detectionPayload: payload,
  });
  assert.deepEqual(calls, ['http://localhost:11434/api/tags']);

  const remote = await resolveProvider({
    baseUrl: 'https://gateway.example.com/v1',
    suppliedModels: ['custom/model'],
    fetchImpl,
  });
  assert.deepEqual(remote, {
    provider: 'custom',
    providerResolution: 'custom-url',
    detectionPayload: null,
  });
  assert.equal(calls.length, 1);
});

test('bounded JSON fetching rejects oversized responses without exposing credentials', async () => {
  const apiKey = 'super-secret-provider-key';
  await assert.rejects(
    fetchJson({
      url: 'https://catalog.example/models',
      provider: 'test',
      apiKey,
      maxBytes: 8,
      fetchImpl: async () => new Response('{"models":[1,2,3]}'),
    }),
    (error) => {
      assert.equal(error.code, 'RESPONSE_TOO_LARGE');
      assert.equal(error.provider, 'test');
      assert.doesNotMatch(error.message, new RegExp(apiKey));
      return true;
    },
  );
});

test('bounded JSON fetching strips authorization on a cross-origin redirect', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), authorization: options.headers.Authorization });
    if (calls.length === 1) {
      return new Response('', {
        status: 302,
        headers: { Location: 'https://cdn.example/catalog.json' },
      });
    }
    return new Response('{"models":[]}');
  };

  const result = await fetchJson({
    url: 'https://provider.example/models',
    provider: 'test',
    apiKey: 'redirect-secret',
    fetchImpl,
  });

  assert.deepEqual(result, { models: [] });
  assert.deepEqual(calls, [
    { url: 'https://provider.example/models', authorization: 'Bearer redirect-secret' },
    { url: 'https://cdn.example/catalog.json', authorization: undefined },
  ]);
});

test('bounded JSON fetching reports timeout, caller cancellation, and invalid JSON distinctly', async () => {
  const waitForAbort = async (_url, options) => new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(options.signal.reason || new Error('aborted'));
      return;
    }
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  await assert.rejects(fetchJson({
    url: 'https://catalog.example/models',
    provider: 'test',
    timeoutMs: 5,
    fetchImpl: waitForAbort,
  }), (error) => error.code === 'TIMEOUT');

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchJson({
    url: 'https://catalog.example/models',
    provider: 'test',
    signal: controller.signal,
    fetchImpl: waitForAbort,
  }), (error) => error.code === 'CANCELLED');

  await assert.rejects(fetchJson({
    url: 'https://catalog.example/models',
    provider: 'test',
    fetchImpl: async () => new Response('{not-json'),
  }), (error) => error.code === 'INVALID_JSON');
});

test('provider cache returns fresh data then the last successful stale data on refresh failure', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-discovery-cache-'));
  const model = normalizeSuppliedModels(['provider/model'])[0];
  model.source = 'https://catalog.example/models';
  try {
    let refreshes = 0;
    const common = {
      provider: 'nvidia',
      endpoint: 'https://catalog.example/models',
      apiKey: 'cache-secret',
      cacheDir,
      ttlMs: 1000,
    };
    const first = await withProviderCache({ ...common, now: () => 1000 }, async () => {
      refreshes += 1;
      return { models: [model], origin: 'live', complete: true };
    });
    assert.equal(first.state, 'refreshed');
    assert.equal(first.origin, 'live');
    assert.equal(first.complete, true);

    const fresh = await withProviderCache({ ...common, now: () => 1500 }, async () => {
      refreshes += 1;
      throw new Error('must not refresh');
    });
    assert.equal(fresh.state, 'fresh');
    assert.equal(fresh.origin, 'live');
    assert.equal(fresh.complete, true);
    assert.equal(refreshes, 1);

    const stale = await withProviderCache({ ...common, now: () => 3000 }, async () => {
      refreshes += 1;
      throw new Error('provider offline');
    });
    assert.equal(stale.state, 'stale');
    assert.equal(stale.origin, 'live');
    assert.equal(stale.complete, true);
    assert.deepEqual(stale.models.map((entry) => entry.id), ['provider/model']);
    assert.match(stale.warnings[0], /refresh failed/i);

    const files = fs.readdirSync(path.join(cacheDir, 'nvidia'));
    assert.equal(files.length, 1);
    const cacheText = fs.readFileSync(path.join(cacheDir, 'nvidia', files[0]), 'utf8');
    assert.doesNotMatch(cacheText, /cache-secret|catalog\.example/u);
    assert.equal(fs.statSync(path.join(cacheDir, 'nvidia')).mode & 0o077, 0);
    assert.equal(fs.statSync(path.join(cacheDir, 'nvidia', files[0])).mode & 0o077, 0);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('provider cache propagates caller cancellation instead of returning stale data', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-discovery-cache-cancel-'));
  const controller = new AbortController();
  const common = {
    provider: 'nvidia',
    endpoint: 'https://catalog.example/models',
    apiKey: 'cache-secret',
    cacheDir,
    ttlMs: 1000,
  };
  try {
    await withProviderCache({ ...common, now: () => 1000 }, async () => normalizeSuppliedModels(['provider/model']));
    controller.abort();
    await assert.rejects(
      withProviderCache({ ...common, now: () => 3000, signal: controller.signal }, async () => {
        const error = new Error('cancelled');
        error.code = 'CANCELLED';
        throw error;
      }),
      (error) => error.code === 'CANCELLED',
    );
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('provider cache round-trips output capabilities and reasoning levels', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-discovery-rich-cache-'));
  const model = normalizeSuppliedModels(['provider/model'])[0];
  model.outputModalities = ['text'];
  model.reasoning = true;
  model.reasoningLevels = ['low', 'high', 'max'];
  model.metadataSources.outputModalities = 'provider-catalog';
  model.metadataSources.reasoning = 'provider-catalog';
  model.metadataSources.reasoningLevels = 'provider-catalog';
  try {
    const options = {
      provider: 'zai', endpoint: 'https://catalog.example/models', apiKey: 'secret',
      cacheDir, ttlMs: 60000, now: () => 1000,
    };
    await withProviderCache(options, async () => [model]);
    const fresh = await withProviderCache({ ...options, now: () => 1500 }, async () => {
      throw new Error('must not refresh');
    });
    assert.deepEqual(fresh.models[0].outputModalities, ['text']);
    assert.deepEqual(fresh.models[0].reasoningLevels, ['low', 'high', 'max']);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('provider cache rejects schema version 2 models missing rich capability fields', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-discovery-invalid-v2-cache-'));
  const options = {
    provider: 'zai', endpoint: 'https://catalog.example/models', apiKey: 'secret',
    cacheDir, ttlMs: 60000, now: () => 1500,
  };
  try {
    const identity = cacheIdentity(options);
    fs.mkdirSync(identity.directory, { recursive: true });
    const malformed = normalizeSuppliedModels(['provider/model'])[0];
    delete malformed.outputModalities;
    delete malformed.reasoningLevels;
    fs.writeFileSync(identity.file, JSON.stringify({
      schemaVersion: 2, provider: options.provider,
      endpointDigest: identity.endpointDigest, authScopeDigest: identity.authScopeDigest,
      fetchedAt: 1000, models: [malformed],
    }));
    const result = await withProviderCache(options, async () => normalizeSuppliedModels(['provider/refreshed']));
    assert.equal(result.state, 'refreshed');
    assert.match(result.warnings[0], /invalid provider discovery cache/i);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('provider cache isolates endpoint and authentication scopes', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-discovery-scope-'));
  try {
    const refresh = async () => normalizeSuppliedModels(['scope/model']);
    const base = { provider: 'openrouter', cacheDir, ttlMs: 60000, now: () => 1000 };
    await withProviderCache({ ...base, endpoint: 'https://one.example/models', apiKey: 'one' }, refresh);
    await withProviderCache({ ...base, endpoint: 'https://two.example/models', apiKey: 'one' }, refresh);
    await withProviderCache({ ...base, endpoint: 'https://one.example/models', apiKey: 'two' }, refresh);

    assert.equal(fs.readdirSync(path.join(cacheDir, 'openrouter')).length, 3);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('provider cache ignores a corrupt matching file and replaces it after a successful refresh', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-discovery-corrupt-'));
  const options = {
    provider: 'nvidia',
    endpoint: 'https://catalog.example/models',
    apiKey: 'scope',
    cacheDir,
    ttlMs: 60000,
    now: () => 1000,
  };
  try {
    const identity = cacheIdentity(options);
    fs.mkdirSync(identity.directory, { recursive: true });
    fs.writeFileSync(identity.file, '{broken', 'utf8');
    const result = await withProviderCache(options, async () => normalizeSuppliedModels(['new/model']));
    assert.equal(result.state, 'refreshed');
    assert.match(result.warnings[0], /invalid provider discovery cache/i);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(identity.file, 'utf8')));
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('NVIDIA discovery maps bounded featured rows and preserves feed order', async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-featured-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const calls = [];
  const payload = {
    'featured-models': [
      { model: 'nemotron-test', 'model-name': 'Nemotron Test', context: 131072, 'max-output': 8192 },
      { model: 'meta/llama-test', 'model-name': 'Llama Test', context: 65536, 'max-output': 4096 },
      { model: 'bad model', 'model-name': 'Bad', context: 1, 'max-output': 1 },
      { model: 'missing-context', 'model-name': 'Missing', 'max-output': 1 },
    ],
  };
  const result = await nvidia.discover({
    cacheDir,
    fetchImpl: async (url) => {
      calls.push(String(url));
      assert.equal(url, nvidia.ENDPOINT);
      return new Response(JSON.stringify(payload));
    },
  });
  const models = result.models;

  assert.deepEqual(calls, ['https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json']);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(models.slice(0, 2).map((model) => model.id), ['nvidia/nemotron-test', 'meta/llama-test']);
  assert.deepEqual(models[0], {
    id: 'nvidia/nemotron-test',
    displayName: 'Nemotron Test',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    inputModalities: ['text'],
    outputModalities: ['text'],
    reasoning: null,
    reasoningLevels: null,
    toolCalling: null,
    metadataSources: {
      contextWindow: 'provider-catalog',
      maxOutputTokens: 'provider-catalog',
      inputModalities: 'provider-catalog',
      outputModalities: 'provider-catalog',
      reasoning: null,
      reasoningLevels: null,
      defaultReasoningLevel: null,
      reasoningDefaultEnabled: null,
      reasoningSupportsMaxTokens: null,
      reasoningMandatory: null,
      toolCalling: null,
    },
    source: 'nvidia-featured',
  });
});

test('OpenRouter discovery preserves authoritative metadata and rejects non-text output models', async () => {
  const payload = {
    data: [
      {
        id: 'vendor/z-model',
        name: 'Z Model',
        context_length: 128000,
        max_output_tokens: 4096,
        architecture: {
          input_modalities: ['text', 'image'],
          output_modalities: ['text'],
        },
        supported_parameters: ['reasoning', 'tools', 'tool_choice'],
        reasoning: {
          supported_efforts: ['xhigh', 'high', 'medium', 'low', 'none'],
          default_effort: 'medium',
          default_enabled: false,
          supports_max_tokens: true,
          mandatory: false,
        },
        top_provider: { context_length: 200000, max_completion_tokens: 16384 },
      },
      {
        id: 'vendor/image-only',
        architecture: { input_modalities: ['text'], output_modalities: ['image'] },
      },
      {
        id: 'vendor/a-model',
        architecture: { modality: 'text->text' },
      },
      { id: 'vendor/a-model', context_length: 999 },
      {
        id: 'vendor/huge-model',
        context_length: 20000000,
        max_output_tokens: 2000000,
        architecture: { modality: 'text->text' },
      },
      { id: 'vendor/text-embedding-3-small' },
      { id: 'vendor/deprecated-chat', deprecated: true },
    ],
  };
  const result = await openrouter.discover({
    apiKey: 'openrouter-key',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://openrouter.ai/api/v1/models');
      assert.equal(options.headers.Authorization, 'Bearer openrouter-key');
      return new Response(JSON.stringify(payload));
    },
  });
  const models = result.models;

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(models.map((model) => model.id), [
    'vendor/a-model',
    'vendor/huge-model',
    'vendor/z-model',
  ]);
  const rich = models[2];
  assert.equal(rich.contextWindow, 200000);
  assert.equal(rich.maxOutputTokens, 16384);
  assert.deepEqual(rich.inputModalities, ['text', 'image']);
  assert.deepEqual(rich.outputModalities, ['text']);
  assert.deepEqual(rich.reasoningLevels, ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(rich.defaultReasoningLevel, 'medium');
  assert.equal(rich.reasoningDefaultEnabled, false);
  assert.equal(rich.reasoningSupportsMaxTokens, true);
  assert.equal(rich.reasoningMandatory, false);
  assert.equal(rich.reasoning, true);
  assert.equal(rich.toolCalling, true);
  assert.deepEqual(rich.metadataSources, {
    contextWindow: 'provider-catalog',
    maxOutputTokens: 'provider-catalog',
    inputModalities: 'provider-catalog',
    outputModalities: 'provider-catalog',
    reasoning: 'provider-catalog',
    reasoningLevels: 'provider-catalog',
    defaultReasoningLevel: 'provider-catalog',
    reasoningDefaultEnabled: 'provider-catalog',
    reasoningSupportsMaxTokens: 'provider-catalog',
    reasoningMandatory: 'provider-catalog',
    toolCalling: 'provider-catalog',
  });
  assert.equal(models[0].contextWindow, null);
  assert.equal(models[0].maxOutputTokens, null);
  assert.equal(models[1].contextWindow, null);
  assert.equal(models[1].maxOutputTokens, null);
});

test('OpenRouter first-run failure exposes its complete owned snapshot', async () => {
  const result = await openrouter.discover({
    apiKey: 'openrouter-key',
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(result.models.length, 345);
  assert.ok(result.models.some((model) => model.id === 'openrouter/auto'));
  assert.ok(result.models.some((model) => model.id === 'moonshotai/kimi-k2.6'));
  assert.equal(result.fallback.state, 'bundled');
});

test('OpenRouter reasoning metadata distinguishes all-efforts from no exposed effort selector', () => {
  const allEfforts = openrouter.parseRow({
    id: 'vendor/all-efforts',
    architecture: { modality: 'text->text' },
    reasoning: {
      supported_efforts: null,
      default_effort: 'medium',
      default_enabled: true,
      mandatory: false,
    },
  });
  assert.deepEqual(allEfforts.reasoningLevels, [
    'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
  ]);
  assert.equal(allEfforts.defaultReasoningLevel, 'medium');

  const noSelector = openrouter.parseRow({
    id: 'vendor/no-selector',
    architecture: { modality: 'text->text' },
    reasoning: {
      default_enabled: true,
      mandatory: true,
    },
  });
  assert.equal(noSelector.reasoning, true);
  assert.equal(noSelector.reasoningLevels, null);
  assert.equal(noSelector.defaultReasoningLevel, null);
  assert.equal(noSelector.reasoningDefaultEnabled, true);
  assert.equal(noSelector.reasoningMandatory, true);
});

test('Cohere discovery rejects deprecated rows and fills only exact-model seed metadata', async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cohere-catalog-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const payload = {
    models: [
      {
        name: 'command-a-plus-05-2026',
        is_deprecated: false,
        features: ['reasoning', 'vision', 'tools'],
      },
      {
        name: 'custom-chat-model',
        context_window: 99999,
        max_output_tokens: 1234,
        input_modalities: ['text'],
        reasoning: false,
        supports_tools: true,
      },
      { name: 'old-command', is_deprecated: true },
    ],
  };
  const result = await cohere.discover({
    baseUrl: 'https://api.cohere.ai/compatibility/v1/',
    apiKey: 'cohere-key',
    cacheDir,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.cohere.com/v1/models?endpoint=chat&page_size=1000');
      assert.equal(options.headers.Authorization, 'Bearer cohere-key');
      return new Response(JSON.stringify(payload));
    },
  });

  assert.deepEqual(result.models.map((model) => model.id), [
    'command-a-plus-05-2026',
    'custom-chat-model',
  ]);
  assert.equal(result.models[0].contextWindow, 436000);
  assert.equal(result.models[0].maxOutputTokens, null);
  assert.deepEqual(result.models[0].inputModalities, ['text', 'image']);
  assert.equal(result.models[0].reasoning, true);
  assert.equal(result.models[0].reasoningDefaultEnabled, true);
  assert.equal(result.models[0].reasoningSupportsMaxTokens, true);
  assert.equal(result.models[0].reasoningMandatory, false);
  assert.equal(result.models[0].toolCalling, true);
  assert.equal(result.models[0].metadataSources.contextWindow, 'provider-catalog');
  assert.equal(result.models[0].metadataSources.reasoning, 'provider-catalog');
  assert.equal(result.models[1].contextWindow, 99999);
  assert.equal(result.models[1].toolCalling, true);
  assert.equal(result.models[1].metadataSources.contextWindow, 'provider-catalog');
});

test('Cohere discovery enriches exact live ids from the owned snapshot without metadata network calls', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cohere-owned-enrich-'));
  try {
    const result = await cohere.discover({
      baseUrl: cohere.BASE_URL,
      apiKey: 'cohere-secret',
      cacheDir,
      now: () => 1000,
      fetchImpl: async (url, options) => {
        assert.equal(url, cohere.ENDPOINT);
        assert.equal(options.headers.Authorization, 'Bearer cohere-secret');
        return new Response(JSON.stringify({ models: [{ name: 'command-a-plus-05-2026' }] }));
      },
    });
    assert.equal(result.models.length, 1);
    assert.equal(result.models[0].displayName, 'Command A+');
    assert.equal(result.models[0].contextWindow, 436000);
    assert.deepEqual(result.models[0].inputModalities, ['text', 'image']);
    assert.equal(result.models[0].reasoning, true);
    assert.equal(result.models[0].reasoningDefaultEnabled, true);
    assert.equal(result.models[0].reasoningSupportsMaxTokens, true);
    assert.equal(result.models[0].reasoningMandatory, false);
    assert.equal(result.models[0].toolCalling, true);
    assert.equal(result.models[0].metadataSources.contextWindow, 'provider-catalog');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('Cohere discovery skips noncanonical base URLs without probing them', async () => {
  let fetched = false;
  const result = await cohere.discover({
    baseUrl: 'https://cohere-gateway.example/v1',
    fetchImpl: async () => {
      fetched = true;
      throw new Error('must not fetch');
    },
  });
  assert.equal(fetched, false);
  assert.deepEqual(result.models, []);
  assert.match(result.warnings[0], /noncanonical/i);
});

test('static-backed compatible providers expose authenticated ids and enrich exact matches', async () => {
  const cases = [
    {
      adapter: zai,
      provider: 'zai',
      baseUrl: 'https://api.z.ai/api/paas/v4',
      staticId: 'glm-5.2',
      expectedContext: null,
      expectedSource: null,
    },
    {
      adapter: moonshot,
      provider: 'moonshot',
      baseUrl: 'https://api.moonshot.cn/v1',
      staticId: 'kimi-k2.6',
      expectedContext: 262144,
      expectedSource: 'provider-catalog',
    },
    {
      adapter: deepseek,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      staticId: 'deepseek-v4-pro',
      expectedContext: 1048576,
      expectedSource: 'openrouter-catalog',
    },
  ];
  for (const entry of cases) {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), `${entry.provider}-discovery-`));
    try {
      const result = await entry.adapter.discover({
        baseUrl: entry.baseUrl,
        apiKey: `${entry.provider}-secret`,
        cacheDir,
        fetchImpl: async (url, options) => {
          assert.equal(url, `${entry.baseUrl.replace(/\/+$/u, '')}/models`);
          assert.equal(options.headers.Authorization, `Bearer ${entry.provider}-secret`);
          return new Response(JSON.stringify({
            data: [
              { id: entry.staticId },
              { id: 'account/custom', owned_by: 'account' },
              { id: 'bad embedding model' },
            ],
          }));
        },
      });
      assert.deepEqual(result.models.map((model) => model.id), [entry.staticId, 'account/custom']);
      assert.equal(result.models[0].contextWindow, entry.expectedContext);
      assert.equal(result.models[0].metadataSources.contextWindow, entry.expectedSource);
      assert.equal(result.models[1].contextWindow, null);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  }
});

test('a provider without an owned cache rejects a malformed successful payload', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-malformed-live-'));
  try {
    await assert.rejects(zai.discover({
      cacheDir,
      apiKey: 'zai-secret',
      fetchImpl: async () => new Response('{"unexpected":true}'),
    }), /model list/i);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('static fallback never replaces the last authenticated model cache', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-live-cache-precedence-'));
  const common = {
    provider: 'zai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    apiKey: 'zai-secret',
    cacheDir,
  };
  try {
    const first = await discoverModels({
      ...common,
      now: () => 1000,
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'account/private-model' }] })),
    });
    assert.deepEqual(first.models.map((model) => model.id), ['account/private-model']);

    const stale = await discoverModels({
      ...common,
      now: () => 62000,
      fetchImpl: async () => { throw new Error('provider offline'); },
    });
    assert.equal(stale.cache.state, 'stale');
    assert.deepEqual(stale.models.map((model) => model.id), ['account/private-model']);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('Google discovery classifies generateContent Gemini image models', async () => {
  const result = await google.discover({
    apiKey: 'google-secret',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers['x-goog-api-key'], 'google-secret');
      return new Response(JSON.stringify({
        models: [
          {
            name: 'models/gemini-3.1-pro',
            displayName: 'Gemini 3.1 Pro',
            supportedGenerationMethods: ['generateContent'],
            inputTokenLimit: 1048576,
            outputTokenLimit: 65536,
          },
          {
            name: 'models/gemini-3.1-flash-image',
            displayName: 'Gemini 3.1 Flash Image',
            supportedGenerationMethods: ['generateContent'],
            inputTokenLimit: 65536,
            outputTokenLimit: 65536,
          },
          {
            name: 'models/text-embedding-004',
            supportedGenerationMethods: ['embedContent'],
            inputTokenLimit: 2048,
            outputTokenLimit: 1,
          },
          {
            name: 'models/imagen-4.0-generate-001',
            supportedGenerationMethods: ['predict'],
            inputTokenLimit: 480,
            outputTokenLimit: 1,
          },
        ],
      }));
    },
  });
  assert.deepEqual(result.models.map((model) => model.id), [
    'gemini-3.1-pro',
    'gemini-3.1-flash-image',
  ]);
  assert.deepEqual(result.models[0].inputModalities, ['text', 'image', 'audio', 'video', 'document']);
  assert.deepEqual(result.models[0].outputModalities, ['text']);
  assert.deepEqual(result.models[1].inputModalities, ['text', 'image', 'audio', 'video', 'document']);
  assert.deepEqual(result.models[1].outputModalities, ['text', 'image']);
  assert.equal(result.models[0].metadataSources.outputModalities, 'provider-catalog');
});

test('xAI compatibility filtering requires no separate metadata request', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xai-owned-filter-'));
  try {
    const result = await xai.discover({
      apiKey: 'xai-secret',
      cacheDir,
      fetchImpl: async (url) => {
        assert.equal(url, xai.ENDPOINT);
        return new Response(JSON.stringify({ data: [{ id: 'grok-4' }, { id: 'grok-4.20-multi-agent' }] }));
      },
    });
    assert.deepEqual(result.models.map((model) => model.id), ['grok-4']);
    assert.deepEqual(result.warnings, []);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('xAI discovery enriches sparse live rows with exact bundled modalities', async () => {
  const result = await xai.discover({
    apiKey: 'xai-secret',
    fetchImpl: async () => new Response(JSON.stringify({
      data: [
        { id: 'grok-4.5' },
        { id: 'grok-4.20-0309-reasoning' },
        { id: 'grok-imagine-image' },
        { id: 'grok-imagine-video-1.5' },
      ],
    })),
  });

  assert.deepEqual(result.models.map((model) => [
    model.id,
    model.inputModalities,
    model.outputModalities,
    model.reasoningLevels,
    model.defaultReasoningLevel,
  ]), [
    ['grok-4.5', ['text', 'image'], ['text'], ['low', 'medium', 'high'], 'high'],
    ['grok-4.20-0309-reasoning', ['text', 'image'], ['text'], null, null],
    ['grok-imagine-image', ['text', 'image'], ['image'], null, null],
    ['grok-imagine-video-1.5', ['image'], ['video'], null, null],
  ]);
});

test('OpenAI-compatible input metadata preserves known modalities instead of inventing text', () => {
  const audio = require('../src/model-discovery/providers/allowlisted-provider-catalog').parseLiveRow({
    id: 'audio-model',
    input_modalities: ['audio'],
    output_modalities: ['text'],
  }, 'test-catalog');
  assert.deepEqual(audio.inputModalities, ['audio']);
  assert.deepEqual(audio.outputModalities, ['text']);
});

test('OpenAI-compatible live rows normalize explicit reasoning levels', () => {
  const model = require('../src/model-discovery/providers/allowlisted-provider-catalog').parseLiveRow({
    id: 'reasoning-model',
    output_modalities: ['text'],
    reasoning: true,
    reasoning_levels: ['HIGH', 'low', 'high', 'unsupported'],
    defaultReasoningLevel: 'HIGH',
  }, 'test-catalog');
  assert.deepEqual(model.reasoningLevels, ['low', 'high']);
  assert.equal(model.defaultReasoningLevel, 'high');
  assert.equal(model.metadataSources.reasoningLevels, 'provider-catalog');
  assert.equal(model.metadataSources.defaultReasoningLevel, 'provider-catalog');
});

test('xAI discovery filters unsupported multi-agent models locally', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xai-suppressions-'));
  try {
    const result = await xai.discover({
      apiKey: 'xai-secret',
      cacheDir,
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://api.x.ai/v1/models');
        assert.equal(options.headers.Authorization, 'Bearer xai-secret');
        return new Response(JSON.stringify({
          data: [{ id: 'grok-4' }, { id: 'grok-multi-agent' }],
        }));
      },
    });
    assert.deepEqual(result.models.map((model) => model.id), ['grok-4']);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('Ollama discovery combines native context metadata with num_ctx and tolerates partial failures', async () => {
  const tagsPayload = {
    models: [
      { name: 'vision-model', digest: 'one' },
      { name: 'broken-model', digest: 'two' },
    ],
  };
  let active = 0;
  let maxActive = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'http://localhost:11434/api/show');
    assert.equal(options.headers.Authorization, undefined);
    const body = JSON.parse(options.body);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    if (body.name === 'broken-model') return new Response('failure', { status: 500 });
    if (body.name === 'vision-model') {
      return new Response(JSON.stringify({
        model_info: { 'test.context_length': 8192 },
        parameters: 'num_ctx 4096\nnum_ctx 32768',
        capabilities: ['completion', 'vision', 'thinking', 'tools'],
      }));
    }
    return new Response(JSON.stringify({
      model_info: { 'test.context_length': 131072 },
      parameters: 'num_ctx 4096',
      capabilities: ['completion'],
    }));
  };

  const result = await ollama.discover({
    baseUrl: 'http://localhost:11434/v1',
    apiKey: 'must-not-reach-local-ollama',
    detectionPayload: tagsPayload,
    suppliedModels: ['extra-model'],
    concurrency: 2,
    fetchImpl,
  });

  assert.equal(maxActive, 2);
  assert.deepEqual(result.models.slice(0, 3).map((model) => model.id), [
    'vision-model',
    'broken-model',
    'extra-model',
  ]);
  assert.equal(result.models[0].contextWindow, 32768);
  assert.deepEqual(result.models[0].inputModalities, ['text', 'image']);
  assert.equal(result.models[0].reasoning, true);
  assert.equal(result.models[0].metadataSources.outputModalities, 'provider-inspection');
  assert.equal(result.models[0].toolCalling, true);
  assert.equal(result.models[0].maxOutputTokens, null);
  assert.equal(result.models[2].contextWindow, 131072);
  assert.deepEqual(result.models[2].inputModalities, ['text']);
  assert.equal(result.models[2].reasoning, false);
  assert.equal(result.models[2].toolCalling, false);
  assert.equal(result.models[1].contextWindow, null);
  assert.equal(result.models[1].inputModalities, null);
  assert.equal(result.warnings.some((warning) => /broken-model/u.test(warning)), true);
});

test('Ollama owns validation and normalization of its standard local native endpoint', () => {
  assert.equal(
    ollama.resolveLocalApiBase('http://localhost:11434/v1/'),
    'http://localhost:11434',
  );
  assert.equal(
    ollama.resolveLocalApiBase('http://127.0.0.1:11434'),
    'http://127.0.0.1:11434',
  );
  assert.throws(
    () => ollama.resolveLocalApiBase('https://localhost:11434/v1'),
    /standard local Ollama HTTP endpoint/i,
  );
  assert.throws(
    () => ollama.resolveLocalApiBase('http://provider.example/v1'),
    /standard local Ollama HTTP endpoint/i,
  );
});

test('Ollama discovery appends cloud candidates without inspecting or pulling them', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-cloud-catalog-'));
  const calls = [];
  try {
    const result = await ollama.discover({
      baseUrl: 'http://localhost:11434/v1',
      detectionPayload: { models: [{ name: 'local-model' }] },
      cacheDir,
      apiKey: 'must-not-reach-local-ollama',
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), authorization: options.headers.Authorization });
        assert.equal(url, 'http://localhost:11434/api/show');
        assert.equal(JSON.parse(options.body).name, 'local-model');
        return new Response(JSON.stringify({
          model_info: { 'test.context_length': 8192 },
          capabilities: ['completion'],
        }));
      },
    });

    assert.equal(result.models[0].id, 'local-model');
    assert.ok(result.models.slice(1).every((model) =>
      model.id.endsWith(':cloud') || /^gemma4:[^:]+-cloud$/u.test(model.id)));
    assert.ok(result.models.length > 1);
    assert.deepEqual(calls.map((call) => call.authorization), [undefined]);
    assert.equal(calls.some((call) => call.url.endsWith('/api/pull')), false);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('Ollama local discovery reads its cloud candidates without a catalog network request', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-cloud-local-snapshot-'));
  try {
    const discovery = ollama.discover({
      baseUrl: 'http://localhost:11434/v1',
      detectionPayload: { models: [{ name: 'local-model' }] },
      cacheDir,
      fetchImpl: async (url) => {
        assert.equal(url, 'http://localhost:11434/api/show');
        return new Response(JSON.stringify({ capabilities: ['completion'] }));
      },
    });
    const winner = await Promise.race([
      discovery.then(() => 'discovered'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 50)),
    ]);
    assert.equal(winner, 'discovered');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('Ollama live discovery retains exact bundled Gemma 4 cloud enrichment', async () => {
  const result = await ollama.discover({
    baseUrl: 'http://localhost:11434/v1',
    detectionPayload: { models: [{ name: 'gemma4:31b-cloud' }] },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://localhost:11434/api/show');
      assert.equal(JSON.parse(options.body).name, 'gemma4:31b-cloud');
      return new Response(JSON.stringify({
        model_info: { 'gemma4.context_length': 262144 },
        capabilities: ['completion', 'thinking', 'tools', 'vision'],
      }));
    },
  });

  const gemma4 = result.models.find((model) => model.id === 'gemma4:31b-cloud');
  assert.equal(gemma4.displayName, 'Google: Gemma 4 31B');
  assert.deepEqual(gemma4.reasoningLevels, ['none', 'low', 'medium', 'high', 'max']);
  assert.equal(gemma4.metadataSources.reasoningLevels, 'provider-catalog');
  assert.equal(gemma4.contextWindow, 262144);
  assert.deepEqual(gemma4.inputModalities, ['text', 'image']);
});

test('Ollama live discovery applies reasoning controls to the full Gemma 4 family', async () => {
  const result = await ollama.discover({
    baseUrl: 'http://localhost:11434/v1',
    detectionPayload: {
      models: [
        { name: 'gemma4:e2b' },
        { name: 'gemma4:12b-it-q4_K_M' },
        { name: 'gemma4:26b-a4b-it-q8_0' },
      ],
    },
    fetchImpl: async (_url, options) => {
      const id = JSON.parse(options.body).name;
      return new Response(JSON.stringify({
        model_info: { 'gemma4.context_length': id === 'gemma4:e2b' ? 131072 : 262144 },
        capabilities: ['completion', 'thinking', 'tools', 'vision'],
      }));
    },
  });

  for (const id of [
    'gemma4:e2b',
    'gemma4:12b-it-q4_K_M',
    'gemma4:26b-a4b-it-q8_0',
  ]) {
    const model = result.models.find((entry) => entry.id === id);
    assert.deepEqual(model.reasoningLevels, ['none', 'low', 'medium', 'high', 'max']);
    assert.equal(model.metadataSources.reasoningLevels, 'provider-catalog');
  }
});

test('custom discovery skips the network when no models are supplied', async () => {
  let fetched = false;
  const result = await discoverModels({
    baseUrl: 'https://custom-provider.example/v1',
    fetchImpl: async () => {
      fetched = true;
      throw new Error('must not fetch');
    },
  });

  assert.equal(fetched, false);
  assert.equal(result.provider, 'custom');
  assert.equal(result.providerResolution, 'custom-url');
  assert.deepEqual(result.traits, {
    inventoryComplete: false,
    local: false,
    nativeInspection: false,
    supportsCloudPull: false,
  });
  assert.equal(result.cache.state, 'none');
  assert.equal(result.discoverySkipped, true);
  assert.deepEqual(result.models, []);
});

test('custom discovery retains only supplied model families from noisy catalogs', async () => {
  const unrelated = Array.from({ length: 2000 }, (_, index) => ({ id: `noise/model-${index}` }));
  const result = await discoverModels({
    baseUrl: 'https://custom-provider.example/v1',
    apiKey: 'custom-secret',
    suppliedModels: ['deepseek-v4-pro', 'private/model'],
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://custom-provider.example/v1/models');
      assert.equal(options.headers.Authorization, 'Bearer custom-secret');
      return new Response(JSON.stringify({ data: [
        ...unrelated,
        { id: 'deepseek-v4-flash' },
        { id: 'deepseek-v4-pro', context_window: 1000000 },
        { id: 'vendor/deepseek-v4-pro', context_window: 262144 },
        { id: 'deepseek-v4-pro:latest', context_window: 128000 },
      ] }));
    },
  });

  assert.equal(result.provider, 'custom');
  assert.equal(result.providerResolution, 'custom-url');
  assert.equal(result.discoverySkipped, false);
  assert.deepEqual(result.models.map((model) => model.id), [
    'deepseek-v4-pro',
    'vendor/deepseek-v4-pro',
    'deepseek-v4-pro:latest',
    'private/model',
  ]);
  assert.equal(result.models[0].contextWindow, 1000000);
});

test('custom discovery falls back to supplied models when its catalog fails', async () => {
  const result = await discoverModels({
    baseUrl: 'https://custom-provider.example/v1',
    suppliedModels: ['deepseek-v4-pro'],
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });

  assert.equal(result.provider, 'custom');
  assert.deepEqual(result.models.map((model) => model.id), ['deepseek-v4-pro']);
  assert.match(result.warnings[0], /custom model catalog refresh failed/i);
});

test('public discovery auto-resolves NVIDIA, caches its catalog, and retains unmatched supplied ids', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-discovery-public-'));
  let calls = 0;
  try {
    const options = {
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      suppliedModels: ['private/model'],
      cacheDir,
      now: () => 1000,
      fetchImpl: async (url) => {
        calls += 1;
        assert.equal(url, nvidia.ENDPOINT);
        return new Response(JSON.stringify({
          'featured-models': [
            { model: 'featured', 'model-name': 'Featured', context: 32000, 'max-output': 4000 },
          ],
        }));
      },
    };
    const refreshed = await discoverModels(options);
    assert.equal(refreshed.provider, 'nvidia');
    assert.equal(refreshed.providerResolution, 'canonical-url');
    assert.deepEqual(refreshed.traits, {
      inventoryComplete: false,
      local: false,
      nativeInspection: false,
      supportsCloudPull: false,
    });
    assert.equal(refreshed.cache.state, 'refreshed');
    assert.equal(refreshed.discoverySkipped, false);
    assert.equal(refreshed.models[0].id, 'nvidia/featured');
    assert.equal(refreshed.models.at(-1).id, 'private/model');

    const fresh = await discoverModels({
      ...options,
      now: () => 1500,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('fresh cache should avoid fetch');
      },
    });
    assert.equal(fresh.cache.state, 'fresh');
    assert.equal(calls, 1);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('public Ollama discovery exposes local native-inspection traits', async () => {
  const result = await discoverModels({
    baseUrl: 'http://localhost:11434/v1',
    suppliedModels: ['local-model'],
    fetchImpl: async (url) => {
      if (String(url).endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'local-model' }] }));
      }
      return new Response(JSON.stringify({
        capabilities: ['completion', 'vision', 'tools'],
      }));
    },
  });

  assert.equal(result.provider, 'ollama');
  assert.deepEqual(result.traits, {
    inventoryComplete: true,
    local: true,
    nativeInspection: true,
    supportsCloudPull: true,
  });
});

test('public discovery dispatches all five extended providers and retains supplied ids', async () => {
  const cases = [
    ['zai', 'https://api.z.ai/api/paas/v4', 'glm-5.2'],
    ['moonshot', 'https://api.moonshot.ai/v1', 'kimi-k2.6'],
    ['deepseek', 'https://api.deepseek.com', 'deepseek-chat'],
    ['google', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-test'],
    ['xai', 'https://api.x.ai/v1', 'grok-test'],
  ];
  for (const [provider, baseUrl, liveId] of cases) {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), `${provider}-public-`));
    try {
      const result = await discoverModels({
        provider,
        baseUrl,
        apiKey: 'provider-secret',
        suppliedModels: ['private/model'],
        cacheDir,
        fetchImpl: async (url, options) => {
          if (provider === 'google') {
            assert.equal(url, google.ENDPOINT);
            assert.equal(options.headers.Authorization, undefined);
            assert.equal(options.headers['x-goog-api-key'], 'provider-secret');
            return new Response(JSON.stringify({
              models: [{
                name: `models/${liveId}`,
                supportedGenerationMethods: ['generateContent'],
                inputTokenLimit: 100000,
                outputTokenLimit: 8192,
              }],
            }));
          }
          assert.equal(url, `${baseUrl}/models`);
          assert.equal(options.headers.Authorization, 'Bearer provider-secret');
          return new Response(JSON.stringify({ data: [{ id: liveId }] }));
        },
      });
      assert.equal(result.provider, provider);
      assert.equal(result.discoverySkipped, false);
      assert.deepEqual(result.models.map((model) => model.id), [liveId, 'private/model']);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  }
});

test('only approved catalog consumers import standalone model discovery', () => {
  const sourceDir = path.join(__dirname, '..', 'src');
  const productionFiles = fs.readdirSync(sourceDir)
    .filter((name) => name.endsWith('.js'));
  for (const name of productionFiles) {
    const source = fs.readFileSync(path.join(sourceDir, name), 'utf8');
    if (name === 'ollama-cloud-pull.js') {
      assert.match(source, /model-discovery\/provider-catalog/u);
      continue;
    }
    if (name === 'codex-config.js') {
      assert.match(source, /require\(['"]\.\/model-discovery['"]\)/u);
      continue;
    }
    assert.doesNotMatch(
      source,
      /require\([^)]*model-discovery/u,
      `${name} must not import standalone discovery`,
    );
  }
});
