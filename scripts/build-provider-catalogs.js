#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CATALOG_DIRECTORY,
  buildProviderCatalog,
} = require('../src/model-discovery/provider-catalog');
const {
  normalizeOpenAiModelCache,
} = require('../src/model-discovery/openai-model-cache');

const cacheDirectory = path.resolve(process.argv[2] || path.join(__dirname, '..', 'model-discovery-cache'));
const outputDirectory = path.resolve(process.argv[3] || CATALOG_DIRECTORY);
const openaiModelCachePath = path.resolve(
  process.argv[4] || path.join(os.homedir(), '.codex', 'models_cache.json'),
);
const providerNames = [
  'anthropic',
  'cohere',
  'deepseek',
  'google',
  'moonshot',
  'nvidia',
  'ollama',
  'openai',
  'openrouter',
  'xai',
];

function cacheDocuments(provider) {
  const directory = path.join(cacheDirectory, provider);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')))
    .filter((document) => document && document.provider === provider && Array.isArray(document.models))
    .sort((left, right) => left.fetchedAt - right.fetchedAt);
}

function cachedModels(provider) {
  const models = [];
  for (const document of cacheDocuments(provider).reverse()) {
    for (const model of document.models) {
      if (provider === 'ollama'
        && !String(model.id || '').endsWith(':cloud')
        && !/^gemma4:[^:]+-cloud$/u.test(String(model.id || ''))) continue;
      models.push(model);
    }
  }
  return models;
}

const openrouter = cachedModels('openrouter');
const openaiModels = fs.existsSync(openaiModelCachePath)
  ? normalizeOpenAiModelCache(JSON.parse(fs.readFileSync(openaiModelCachePath, 'utf8')))
  : cachedModels('openai');
fs.mkdirSync(outputDirectory, { recursive: true });
for (const provider of providerNames) {
  const catalogProvider = provider === 'ollama' ? 'ollama-cloud' : provider;
  const providerModels = provider === 'openai' ? openaiModels : cachedModels(provider);
  const catalog = buildProviderCatalog(catalogProvider, providerModels, openrouter);
  if (!catalog.models.length) continue;
  fs.writeFileSync(
    path.join(outputDirectory, `${catalogProvider}.json`),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );
  process.stdout.write(`${catalogProvider}: ${catalog.models.length} models\n`);
}
