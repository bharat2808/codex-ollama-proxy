'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  mergeDiscoveredWithSupplied,
  normalizeSuppliedModels,
} = require('../src/model-discovery/normalize');
const { resolveProvider } = require('../src/model-discovery/provider-resolution');
const { fetchJson } = require('../src/model-discovery/live-catalog');
const { cacheIdentity, withProviderCache } = require('../src/model-discovery/file-cache');
const {
  CATALOG_TTL_MS,
  OPENCLAW_CATALOGS,
  loadOpenClawCatalog,
  parseOpenClawCatalog,
} = require('../src/model-discovery/openclaw-catalog');
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

test('OpenClaw catalog sync includes the extended static providers and preserves Ollama Cloud', () => {
  assert.deepEqual(Object.keys(OPENCLAW_CATALOGS).sort(), [
    'cohere', 'deepseek', 'moonshot', 'nvidia', 'ollama-cloud', 'zai',
  ]);
  assert.equal(CATALOG_TTL_MS, 24 * 60 * 60 * 1000);
  for (const entry of Object.values(OPENCLAW_CATALOGS)) {
    const url = new URL(entry.url);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, 'raw.githubusercontent.com');
    assert.match(url.pathname, /^\/openclaw\/openclaw\/main\/extensions\//u);
    assert.match(url.pathname, /\/openclaw\.plugin\.json$/u);
  }
  assert.equal(OPENCLAW_CATALOGS.ollama, undefined);
});

test('extended OpenClaw static catalogs use bundled first-run fallbacks', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extended-openclaw-bundled-'));
  try {
    for (const provider of ['zai', 'moonshot', 'deepseek']) {
      const result = await loadOpenClawCatalog({
        provider,
        cacheDir,
        fetchImpl: async () => { throw new Error('offline'); },
      });
      assert.equal(result.cacheStatus, 'bundled');
      assert.ok(result.models.length > 0, `${provider} must bundle model rows`);
    }
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('Ollama Cloud catalog parsing requires the distinct cloud provider base URL', () => {
  const payload = {
    modelCatalog: {
      providers: {
        'ollama-cloud': {
          baseUrl: 'https://ollama.com',
          models: [{
            id: 'cloud-test:cloud',
            name: 'Cloud Test',
            input: ['text'],
            contextWindow: 128000,
            maxTokens: 8192,
            compat: { supportsTools: true },
          }],
        },
      },
    },
  };

  const models = parseOpenClawCatalog('ollama-cloud', payload);
  assert.deepEqual(models.map((model) => model.id), ['cloud-test:cloud']);
  assert.equal(models[0].toolCalling, true);
  payload.modelCatalog.providers['ollama-cloud'].baseUrl = 'http://localhost:11434';
  assert.throws(() => parseOpenClawCatalog('ollama-cloud', payload), /base URL/i);
});

test('bundled provider snapshots preserve provider-native Ollama and Moonshot capabilities', () => {
  const ollamaCloud = require('../src/model-discovery/catalogs/openclaw/ollama-cloud.json');
  const ollamaModels = new Map(
    ollamaCloud.modelCatalog.providers['ollama-cloud'].models.map((model) => [model.id, model]),
  );
  assert.equal(ollamaModels.get('kimi-k2.5:cloud').contextWindow, 262144);
  assert.deepEqual(ollamaModels.get('kimi-k2.5:cloud').input, ['text', 'image']);
  assert.equal(ollamaModels.get('minimax-m2.7:cloud').contextWindow, 196608);
  assert.equal(ollamaModels.get('glm-5.1:cloud').contextWindow, 202752);

  const moonshotCatalog = require('../src/model-discovery/catalogs/openclaw/moonshot.json');
  const moonshotModels = new Map(
    moonshotCatalog.modelCatalog.providers.moonshot.models.map((model) => [model.id, model]),
  );
  assert.equal(moonshotModels.get('kimi-k2.6').reasoning, true);
  assert.equal(moonshotModels.get('kimi-k2.5').reasoning, true);
});

test('provider-native corrections override stale OpenClaw catalog metadata', () => {
  const ollamaModels = parseOpenClawCatalog('ollama-cloud', {
    modelCatalog: { providers: { 'ollama-cloud': {
      baseUrl: 'https://ollama.com',
      models: [
        { id: 'kimi-k2.5:cloud', input: ['text'], contextWindow: 128000 },
        { id: 'minimax-m2.7:cloud', input: ['text'], contextWindow: 128000 },
        { id: 'glm-5.1:cloud', input: ['text'], contextWindow: 128000 },
      ],
    } } },
  });
  assert.deepEqual(ollamaModels.map((model) => ({
    id: model.id,
    contextWindow: model.contextWindow,
    inputModalities: model.inputModalities,
  })), [
    { id: 'kimi-k2.5:cloud', contextWindow: 262144, inputModalities: ['text', 'image'] },
    { id: 'minimax-m2.7:cloud', contextWindow: 196608, inputModalities: ['text'] },
    { id: 'glm-5.1:cloud', contextWindow: 202752, inputModalities: ['text'] },
  ]);

  const moonshotModels = parseOpenClawCatalog('moonshot', {
    modelCatalog: { providers: { moonshot: {
      baseUrl: 'https://api.moonshot.ai/v1',
      models: [
        { id: 'kimi-k2.6', input: ['text', 'image'] },
        { id: 'kimi-k2.5', input: ['text', 'image'] },
      ],
    } } },
  });
  assert.deepEqual(moonshotModels.map((model) => model.reasoning), [true, true]);
});

test('OpenClaw catalog parsing validates provider identity and drops deprecated models', () => {
  const payload = {
    modelCatalog: {
      providers: {
        nvidia: {
          baseUrl: 'https://integrate.api.nvidia.com/v1',
          models: [
            {
              id: 'vendor/current',
              name: 'Current',
              input: ['text', 'image'],
              contextWindow: 131072,
              maxTokens: 8192,
              reasoning: true,
              compat: { supportsTools: true },
            },
            {
              id: 'vendor/old',
              name: 'Old',
              input: ['text'],
              contextWindow: 32000,
              maxTokens: 4096,
              status: 'deprecated',
            },
          ],
        },
      },
    },
  };

  const models = parseOpenClawCatalog('nvidia', payload);
  assert.deepEqual(models.map((model) => model.id), ['vendor/current']);
  assert.deepEqual(models[0].inputModalities, ['text', 'image']);
  assert.equal(models[0].reasoning, true);
  assert.equal(models[0].toolCalling, true);
  assert.equal(models[0].source, 'openclaw-static');

  payload.modelCatalog.providers.nvidia.baseUrl = 'https://attacker.example/v1';
  assert.throws(() => parseOpenClawCatalog('nvidia', payload), /base URL/i);
  assert.throws(() => parseOpenClawCatalog('ollama', payload), /unsupported OpenClaw catalog/i);
});

test('OpenClaw catalog uses supported provider efforts instead of assuming every Codex level', () => {
  const payload = {
    modelCatalog: {
      providers: {
        zai: {
          baseUrl: 'https://api.z.ai/api/paas/v4',
          models: [{
            id: 'glm-capable',
            name: 'GLM Capable',
            input: ['text', 'image'],
            output: ['text'],
            reasoning: true,
            contextWindow: 128000,
            maxTokens: 8192,
            thinkingLevelMap: { low: null, high: 'max', max: 'max' },
            compat: { supportsReasoningEffort: true, supportedReasoningEfforts: ['max'] },
          }],
        },
      },
    },
  };
  const [model] = parseOpenClawCatalog('zai', payload);
  assert.deepEqual(model.inputModalities, ['text', 'image']);
  assert.deepEqual(model.outputModalities, ['text']);
  assert.deepEqual(model.reasoningLevels, ['max']);
  assert.equal(model.metadataSources.outputModalities, 'provider-seed');
  assert.equal(model.metadataSources.reasoningLevels, 'provider-seed');
});

test('OpenClaw catalog leaves exact reasoning levels unknown when only configurability is known', () => {
  const payload = {
    modelCatalog: { providers: { zai: {
      baseUrl: 'https://api.z.ai/api/paas/v4',
      models: [{ id: 'glm-unknown-levels', reasoning: true, compat: { supportsReasoningEffort: true } }],
    } } },
  };
  assert.equal(parseOpenClawCatalog('zai', payload)[0].reasoningLevels, null);
});

test('OpenClaw catalog normalizes thinking map values when explicit efforts are absent', () => {
  const payload = {
    modelCatalog: { providers: { zai: {
      baseUrl: 'https://api.z.ai/api/paas/v4',
      models: [{
        id: 'glm-mapped-levels', reasoning: true,
        thinkingLevelMap: { low: null, high: 'max', xhigh: 'max' },
      }],
    } } },
  };
  assert.deepEqual(parseOpenClawCatalog('zai', payload)[0].reasoningLevels, ['max']);
});

test('OpenClaw catalog sync refreshes at most daily and retains the last successful file', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-catalog-sync-'));
  let calls = 0;
  const payload = {
    modelCatalog: {
      providers: {
        cohere: {
          baseUrl: 'https://api.cohere.ai/compatibility/v1',
          models: [{
            id: 'command-test',
            name: 'Command Test',
            input: ['text'],
            contextWindow: 128000,
            maxTokens: 8000,
          }],
        },
      },
    },
  };
  try {
    const options = {
      provider: 'cohere',
      cacheDir,
      now: () => 1000,
      fetchImpl: async (url, request) => {
        calls += 1;
        assert.equal(url, OPENCLAW_CATALOGS.cohere.url);
        assert.equal(request.headers.Authorization, undefined);
        return new Response(JSON.stringify(payload));
      },
    };
    const refreshed = await loadOpenClawCatalog(options);
    assert.equal(refreshed.cacheStatus, 'refreshed');
    assert.deepEqual(refreshed.models.map((model) => model.id), ['command-test']);

    const fresh = await loadOpenClawCatalog({
      ...options,
      now: () => 1000 + CATALOG_TTL_MS,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('fresh catalog must not fetch');
      },
    });
    assert.equal(fresh.cacheStatus, 'fresh');
    assert.equal(calls, 1);

    const stale = await loadOpenClawCatalog({
      ...options,
      now: () => 1001 + CATALOG_TTL_MS,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('offline');
      },
    });
    assert.equal(stale.cacheStatus, 'stale');
    assert.deepEqual(stale.models.map((model) => model.id), ['command-test']);
    assert.match(stale.warnings[0], /last successful/i);
    assert.equal(calls, 2);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('OpenClaw catalog sync uses its bundled snapshot on first-run network failure', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-catalog-bundled-'));
  try {
    const result = await loadOpenClawCatalog({
      provider: 'nvidia',
      cacheDir,
      fetchImpl: async () => { throw new Error('offline'); },
    });
    assert.equal(result.cacheStatus, 'bundled');
    assert.ok(result.models.length > 0);
    assert.match(result.warnings[0], /bundled OpenClaw catalog/i);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('OpenClaw catalog sync does not replace caller cancellation with a bundled snapshot', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-catalog-cancel-'));
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(loadOpenClawCatalog({
      provider: 'cohere',
      cacheDir,
      signal: controller.signal,
      fetchImpl: async () => { throw new Error('aborted'); },
    }), (error) => error.code === 'CANCELLED');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('NVIDIA discovery merges the daily OpenClaw catalog behind the live NVIDIA feed', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-openclaw-merge-'));
  const staticPayload = {
    modelCatalog: {
      providers: {
        nvidia: {
          baseUrl: 'https://integrate.api.nvidia.com/v1',
          models: [{
            id: 'static/model',
            name: 'Static Model',
            input: ['text'],
            contextWindow: 64000,
            maxTokens: 4000,
          }],
        },
      },
    },
  };
  try {
    const result = await nvidia.discover({
      apiKey: 'nvidia-secret',
      cacheDir,
      now: () => 1000,
      fetchImpl: async (url, options) => {
        if (url === OPENCLAW_CATALOGS.nvidia.url) {
          assert.equal(options.headers.Authorization, undefined);
          return new Response(JSON.stringify(staticPayload));
        }
        assert.equal(url, nvidia.ENDPOINT);
        return new Response(JSON.stringify({
          'featured-models': [{
            model: 'live/model',
            'model-name': 'Live Model',
            context: 128000,
            'max-output': 8000,
          }],
        }));
      },
    });
    assert.deepEqual(result.models.map((model) => model.id), ['live/model', 'static/model']);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('NVIDIA discovery does not replace caller cancellation with its static catalog', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-openclaw-cancel-'));
  const controller = new AbortController();
  try {
    await assert.rejects(nvidia.discover({
      cacheDir,
      signal: controller.signal,
      fetchImpl: async (url) => {
        if (url === OPENCLAW_CATALOGS.nvidia.url) {
          return new Response(JSON.stringify({
            modelCatalog: {
              providers: {
                nvidia: {
                  baseUrl: 'https://integrate.api.nvidia.com/v1',
                  models: [{
                    id: 'static/model',
                    name: 'Static Model',
                    input: ['text'],
                    contextWindow: 64000,
                    maxTokens: 4000,
                  }],
                },
              },
            },
          }));
        }
        controller.abort();
        throw new Error('aborted');
      },
    }), (error) => error.code === 'CANCELLED');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
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
    toolCalling: null,
    metadataSources: {
      contextWindow: null,
      maxOutputTokens: null,
      inputModalities: null,
      outputModalities: null,
      reasoning: null,
      reasoningLevels: null,
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
      return [model];
    });
    assert.equal(first.cacheStatus, 'refreshed');

    const fresh = await withProviderCache({ ...common, now: () => 1500 }, async () => {
      refreshes += 1;
      throw new Error('must not refresh');
    });
    assert.equal(fresh.cacheStatus, 'fresh');
    assert.equal(refreshes, 1);

    const stale = await withProviderCache({ ...common, now: () => 3000 }, async () => {
      refreshes += 1;
      throw new Error('provider offline');
    });
    assert.equal(stale.cacheStatus, 'stale');
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

test('provider cache upgrades legacy models with unknown rich capability metadata', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-discovery-legacy-cache-'));
  const options = {
    provider: 'zai', endpoint: 'https://catalog.example/models', apiKey: 'secret',
    cacheDir, ttlMs: 60000, now: () => 1500,
  };
  try {
    const identity = cacheIdentity(options);
    fs.mkdirSync(identity.directory, { recursive: true });
    const legacy = normalizeSuppliedModels(['provider/model'])[0];
    delete legacy.outputModalities;
    delete legacy.reasoningLevels;
    delete legacy.metadataSources.outputModalities;
    delete legacy.metadataSources.reasoningLevels;
    fs.writeFileSync(identity.file, JSON.stringify({
      schemaVersion: 1,
      provider: options.provider,
      endpointDigest: identity.endpointDigest,
      authScopeDigest: identity.authScopeDigest,
      fetchedAt: 1000,
      models: [legacy],
    }));
    const fresh = await withProviderCache(options, async () => { throw new Error('must not refresh'); });
    assert.equal(fresh.cacheStatus, 'fresh');
    assert.equal(fresh.models[0].outputModalities, null);
    assert.equal(fresh.models[0].reasoningLevels, null);
    assert.equal(fresh.models[0].metadataSources.outputModalities, null);
    assert.equal(fresh.models[0].metadataSources.reasoningLevels, null);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('provider cache writes schema version 2 after upgrading version 1', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-discovery-v2-cache-'));
  const options = {
    provider: 'zai', endpoint: 'https://catalog.example/models', apiKey: 'secret',
    cacheDir, ttlMs: 1, now: () => 2000,
  };
  try {
    const identity = cacheIdentity(options);
    fs.mkdirSync(identity.directory, { recursive: true });
    const legacy = normalizeSuppliedModels(['provider/legacy'])[0];
    delete legacy.outputModalities;
    delete legacy.reasoningLevels;
    delete legacy.metadataSources.outputModalities;
    delete legacy.metadataSources.reasoningLevels;
    fs.writeFileSync(identity.file, JSON.stringify({
      schemaVersion: 1, provider: options.provider,
      endpointDigest: identity.endpointDigest, authScopeDigest: identity.authScopeDigest,
      fetchedAt: 1000, models: [legacy],
    }));
    await withProviderCache(options, async () => normalizeSuppliedModels(['provider/current']));
    assert.equal(JSON.parse(fs.readFileSync(identity.file, 'utf8')).schemaVersion, 2);
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
    assert.equal(result.cacheStatus, 'refreshed');
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
    assert.equal(result.cacheStatus, 'refreshed');
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
      if (String(url) === OPENCLAW_CATALOGS.nvidia.url) {
        return new Response(JSON.stringify({
          modelCatalog: {
            providers: {
              nvidia: {
                baseUrl: 'https://integrate.api.nvidia.com/v1',
                models: [{
                  id: 'meta/llama-test',
                  name: 'Llama Test',
                  input: ['text'],
                  contextWindow: 65536,
                  maxTokens: 4096,
                }],
              },
            },
          },
        }));
      }
      return new Response(JSON.stringify(payload));
    },
  });
  const models = result.models;

  assert.deepEqual(calls, [
    OPENCLAW_CATALOGS.nvidia.url,
    'https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json',
  ]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(models.map((model) => model.id), ['nvidia/nemotron-test', 'meta/llama-test']);
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
  assert.deepEqual(rich.reasoningLevels, null);
  assert.equal(rich.reasoning, true);
  assert.equal(rich.toolCalling, true);
  assert.deepEqual(rich.metadataSources, {
    contextWindow: 'provider-catalog',
    maxOutputTokens: 'provider-catalog',
    inputModalities: 'provider-catalog',
    outputModalities: 'provider-catalog',
    reasoning: 'provider-catalog',
    reasoningLevels: null,
    toolCalling: 'provider-catalog',
  });
  assert.equal(models[0].contextWindow, null);
  assert.equal(models[0].maxOutputTokens, null);
  assert.equal(models[1].contextWindow, null);
  assert.equal(models[1].maxOutputTokens, null);
});

test('OpenRouter first-run failure exposes its bundled OpenClaw seed', async () => {
  const result = await openrouter.discover({
    apiKey: 'openrouter-key',
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.deepEqual(result.models.map((model) => model.id), [
    'openrouter/auto',
    'moonshotai/kimi-k2.6',
    'moonshotai/kimi-k2.5',
  ]);
  assert.equal(result.fallback.cacheStatus, 'bundled');
});

test('Cohere discovery rejects deprecated rows and fills only exact-model seed metadata', async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cohere-catalog-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const payload = {
    models: [
      { name: 'command-a-plus-05-2026', is_deprecated: false },
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
  assert.equal(result.models[0].contextWindow, 128000);
  assert.equal(result.models[0].maxOutputTokens, 64000);
  assert.deepEqual(result.models[0].inputModalities, ['text', 'image']);
  assert.equal(result.models[0].reasoning, true);
  assert.equal(result.models[0].metadataSources.contextWindow, 'provider-seed');
  assert.equal(result.models[1].contextWindow, 99999);
  assert.equal(result.models[1].toolCalling, true);
  assert.equal(result.models[1].metadataSources.contextWindow, 'provider-catalog');
});

test('Cohere discovery enriches live accessible models from the daily OpenClaw catalog', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cohere-openclaw-enrich-'));
  const staticPayload = {
    modelCatalog: {
      providers: {
        cohere: {
          baseUrl: 'https://api.cohere.ai/compatibility/v1',
          models: [{
            id: 'command-synced',
            name: 'Command Synced',
            input: ['text', 'image'],
            contextWindow: 200000,
            maxTokens: 16000,
            reasoning: true,
            compat: { supportsTools: true },
          }],
        },
      },
    },
  };
  try {
    const result = await cohere.discover({
      baseUrl: cohere.BASE_URL,
      apiKey: 'cohere-secret',
      cacheDir,
      now: () => 1000,
      fetchImpl: async (url, options) => {
        if (url === OPENCLAW_CATALOGS.cohere.url) {
          assert.equal(options.headers.Authorization, undefined);
          return new Response(JSON.stringify(staticPayload));
        }
        assert.equal(url, cohere.ENDPOINT);
        assert.equal(options.headers.Authorization, 'Bearer cohere-secret');
        return new Response(JSON.stringify({ models: [{ name: 'command-synced' }] }));
      },
    });
    assert.equal(result.models.length, 1);
    assert.equal(result.models[0].displayName, 'Command Synced');
    assert.equal(result.models[0].contextWindow, 200000);
    assert.deepEqual(result.models[0].inputModalities, ['text', 'image']);
    assert.equal(result.models[0].reasoning, true);
    assert.equal(result.models[0].toolCalling, true);
    assert.equal(result.models[0].metadataSources.contextWindow, 'provider-seed');
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
      expectedContext: 1000000,
    },
    {
      adapter: moonshot,
      provider: 'moonshot',
      baseUrl: 'https://api.moonshot.cn/v1',
      staticId: 'kimi-k2.6',
      expectedContext: 262144,
    },
    {
      adapter: deepseek,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      staticId: 'deepseek-chat',
      expectedContext: 1000000,
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
          if (url === OPENCLAW_CATALOGS[entry.provider].url) {
            assert.equal(options.headers.Authorization, undefined);
            throw new Error('use bundled catalog');
          }
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
      assert.equal(result.models[0].metadataSources.contextWindow, 'provider-seed');
      assert.equal(result.models[1].contextWindow, null);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  }
});

test('static-backed discovery treats a malformed successful payload as refresh failure', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-malformed-live-'));
  try {
    const result = await zai.discover({
      cacheDir,
      apiKey: 'zai-secret',
      fetchImpl: async (url) => {
        if (url === OPENCLAW_CATALOGS.zai.url) throw new Error('use bundled catalog');
        return new Response('{"unexpected":true}');
      },
    });
    assert.ok(result.models.length > 0);
    assert.match(result.warnings.at(-1), /live catalog refresh failed/i);
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
      fetchImpl: async (url) => {
        if (url === OPENCLAW_CATALOGS.zai.url) throw new Error('use bundled catalog');
        return new Response(JSON.stringify({ data: [{ id: 'account/private-model' }] }));
      },
    });
    assert.deepEqual(first.models.map((model) => model.id), ['account/private-model']);

    const stale = await discoverModels({
      ...common,
      now: () => 62000,
      fetchImpl: async () => { throw new Error('provider offline'); },
    });
    assert.equal(stale.cacheStatus, 'stale');
    assert.deepEqual(stale.models.map((model) => model.id), ['account/private-model']);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('Google discovery uses the native catalog and keeps only generateContent text models', async () => {
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
  assert.deepEqual(result.models.map((model) => model.id), ['gemini-3.1-pro']);
  assert.deepEqual(result.models[0].inputModalities, ['text', 'image']);
  assert.equal(result.models[0].metadataSources.outputModalities, 'provider-catalog');
});

test('malformed xAI suppression refresh retains the bundled suppressions', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xai-suppressions-malformed-'));
  try {
    const result = await xai.discover({
      apiKey: 'xai-secret',
      cacheDir,
      fetchImpl: async (url) => {
        if (url.includes('raw.githubusercontent.com')) {
          return new Response(JSON.stringify({ unexpected: true }));
        }
        return new Response(JSON.stringify({ data: [{ id: 'grok-4' }, { id: 'grok-4.20-multi-agent' }] }));
      },
    });
    assert.deepEqual(result.models.map((model) => model.id), ['grok-4']);
    assert.match(result.warnings[0], /bundled snapshot/i);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
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
  }, 'test-catalog');
  assert.deepEqual(model.reasoningLevels, ['low', 'high']);
  assert.equal(model.metadataSources.reasoningLevels, 'provider-catalog');
});

test('xAI discovery removes OpenClaw-suppressed models without sending its API key to GitHub', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xai-suppressions-'));
  try {
    const result = await xai.discover({
      apiKey: 'xai-secret',
      cacheDir,
      fetchImpl: async (url, options) => {
        if (url === 'https://raw.githubusercontent.com/openclaw/openclaw/main/extensions/xai/openclaw.plugin.json') {
          assert.equal(options.headers.Authorization, undefined);
          return new Response(JSON.stringify({
            modelCatalog: {
              discovery: { xai: 'refreshable' },
              suppressions: [{ provider: 'xai', model: 'grok-multi-agent' }],
            },
          }));
        }
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
    assert.ok(result.models.slice(1).every((model) => model.id.endsWith(':cloud')));
    assert.ok(result.models.length > 1);
    assert.deepEqual(calls.map((call) => call.authorization), [undefined]);
    assert.equal(calls.some((call) => call.url.endsWith('/api/pull')), false);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('Ollama local discovery does not wait for a stalled cloud catalog refresh', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-cloud-nonblocking-'));
  let releaseCloud;
  const cloudBlocked = new Promise((resolve) => { releaseCloud = resolve; });
  try {
    const discovery = ollama.discover({
      baseUrl: 'http://localhost:11434/v1',
      detectionPayload: { models: [{ name: 'local-model' }] },
      cacheDir,
      fetchImpl: async (url) => {
        if (String(url).includes('raw.githubusercontent.com')) {
          await cloudBlocked;
          throw new Error('offline');
        }
        return new Response(JSON.stringify({ capabilities: ['completion'] }));
      },
    });
    const winner = await Promise.race([
      discovery.then(() => 'discovered'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 50)),
    ]);
    assert.equal(winner, 'discovered');
  } finally {
    releaseCloud();
    fs.rmSync(cacheDir, { recursive: true, force: true });
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
  assert.equal(result.cacheStatus, 'none');
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
        if (String(url) === OPENCLAW_CATALOGS.nvidia.url) {
          return new Response(JSON.stringify({
            modelCatalog: {
              providers: {
                nvidia: {
                  baseUrl: 'https://integrate.api.nvidia.com/v1',
                  models: [{
                    id: 'nvidia/featured',
                    name: 'Featured',
                    input: ['text'],
                    contextWindow: 32000,
                    maxTokens: 4000,
                  }],
                },
              },
            },
          }));
        }
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
    assert.equal(refreshed.cacheStatus, 'refreshed');
    assert.equal(refreshed.discoverySkipped, false);
    assert.deepEqual(refreshed.models.map((model) => model.id), [
      'nvidia/featured',
      'private/model',
    ]);

    const fresh = await discoverModels({
      ...options,
      now: () => 1500,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('fresh cache should avoid fetch');
      },
    });
    assert.equal(fresh.cacheStatus, 'fresh');
    assert.equal(calls, 2);
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
          if (String(url).startsWith('https://raw.githubusercontent.com/openclaw/openclaw/main/extensions/')) {
            assert.equal(options.headers.Authorization, undefined);
            throw new Error('use bundled metadata');
          }
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
      assert.match(source, /model-discovery\/openclaw-catalog/u);
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
