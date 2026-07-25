#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  CATALOG_DIRECTORY,
  buildProviderCatalog,
} = require('../src/model-discovery/provider-catalog');

const cacheDirectory = path.resolve(process.argv[2] || path.join(__dirname, '..', 'model-discovery-cache'));
const outputDirectory = path.resolve(process.argv[3] || CATALOG_DIRECTORY);
const providerNames = ['cohere', 'deepseek', 'google', 'moonshot', 'nvidia', 'ollama', 'openrouter', 'xai'];

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
fs.mkdirSync(outputDirectory, { recursive: true });
for (const provider of providerNames) {
  const catalogProvider = provider === 'ollama' ? 'ollama-cloud' : provider;
  const catalog = buildProviderCatalog(catalogProvider, cachedModels(provider), openrouter);
  if (!catalog.models.length) continue;
  fs.writeFileSync(
    path.join(outputDirectory, `${catalogProvider}.json`),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );
  process.stdout.write(`${catalogProvider}: ${catalog.models.length} models\n`);
}
