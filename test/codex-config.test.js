'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-concurrency-'));
process.env.CODEX_HOME = codexHome;
const codexConfig = require('../src/codex-config');

test('local Ollama capability discovery continuously refills a bounded worker pool', async () => {
  const originalFetch = global.fetch;
  const models = Array.from({ length: 40 }, (_, index) => ({ name: `model-${index + 1}` }));
  let active = 0;
  let peak = 0;
  let showRequests = 0;

  global.fetch = async (url) => {
    if (String(url).endsWith('/api/tags')) {
      return { json: async () => ({ models }) };
    }
    showRequests += 1;
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return { json: async () => ({ capabilities: ['completion', 'tools'] }) };
  };

  try {
    const discovered = await codexConfig.localOllamaModels();
    assert.equal(showRequests, models.length);
    assert.equal(peak, codexConfig.OLLAMA_SHOW_CONCURRENCY);
    assert.equal(Object.keys(discovered).length, models.length);
    assert.deepEqual(discovered['model-40'], ['completion', 'tools']);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});
