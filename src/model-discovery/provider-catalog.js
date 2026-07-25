'use strict';

const path = require('node:path');
const { validModel } = require('./file-cache');
const { METADATA_FIELDS } = require('./normalize');
const { applyDocumentedModalities } = require('./provider-catalog-overrides');

const CATALOG_DIRECTORY = path.join(__dirname, 'catalogs', 'providers');
const CATALOG_PROVIDERS = Object.freeze([
  'cohere',
  'deepseek',
  'google',
  'moonshot',
  'nvidia',
  'ollama-cloud',
  'openrouter',
  'xai',
]);

const OPENROUTER_PREFIXES = Object.freeze({
  cohere: 'cohere',
  deepseek: 'deepseek',
  google: 'google',
  moonshot: 'moonshotai',
  xai: 'x-ai',
});

const OLLAMA_CLOUD_PREFIXES = Object.freeze({
  glm: 'z-ai',
  kimi: 'moonshotai',
  minimax: 'minimax',
  qwen: 'qwen',
});
const OLLAMA_CLOUD_OPENROUTER_IDS = Object.freeze({
  'gemma4:31b-cloud': 'google/gemma-4-31b-it',
});
const TRUSTED_SOURCE_PATTERN =
  /^(?:provider-(?:catalog|inspection)|ollama-(?:show|tags)|nvidia-featured|(?:cohere|deepseek|google|moonshot|openrouter|xai)-catalog)$/u;

function openRouterIdFor(provider, id) {
  if (typeof id !== 'string' || !id) return null;
  if (provider === 'nvidia') return id.includes('/') ? id : null;
  if (provider === 'openrouter') return id;
  if (provider === 'ollama-cloud') {
    if (OLLAMA_CLOUD_OPENROUTER_IDS[id]) return OLLAMA_CLOUD_OPENROUTER_IDS[id];
    if (!id.endsWith(':cloud')) return null;
    const bare = id.slice(0, -':cloud'.length);
    const family = Object.keys(OLLAMA_CLOUD_PREFIXES).find((prefix) => bare.startsWith(`${prefix}-`));
    return family ? `${OLLAMA_CLOUD_PREFIXES[family]}/${bare}` : null;
  }
  const prefix = OPENROUTER_PREFIXES[provider];
  return prefix ? `${prefix}/${id}` : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nativeModel(row) {
  if (!row || typeof row !== 'object' || !TRUSTED_SOURCE_PATTERN.test(String(row.source || ''))) return null;
  const model = clone(row);
  model.metadataSources = { ...(model.metadataSources || {}) };
  for (const field of METADATA_FIELDS) {
    if (model[field] === undefined) model[field] = null;
    if (model.metadataSources[field] === undefined) model.metadataSources[field] = null;
    if (model.metadataSources[field] === 'provider-seed') {
      model[field] = null;
      model.metadataSources[field] = null;
    }
  }
  return model;
}

function enrichModelFromSeed(live, seed) {
  if (!live || !seed) return live;
  const enriched = clone(live);
  enriched.metadataSources = { ...(enriched.metadataSources || {}) };
  for (const field of METADATA_FIELDS) {
    if (enriched[field] == null && seed[field] != null) {
      enriched[field] = clone(seed[field]);
      enriched.metadataSources[field] = seed.metadataSources?.[field] || 'provider-seed';
    }
  }
  if (enriched.displayName === enriched.id && seed.displayName) {
    enriched.displayName = seed.displayName;
  }
  return enriched;
}

function buildProviderCatalog(provider, providerModels, openRouterModels) {
  const openrouter = new Map();
  for (const model of openRouterModels || []) {
    if (model && typeof model.id === 'string' && !openrouter.has(model.id)) {
      openrouter.set(model.id, model);
    }
  }
  const models = [];
  const seen = new Set();
  for (const row of providerModels || []) {
    let model = nativeModel(row);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    const openrouterModel = openrouter.get(openRouterIdFor(provider, model.id));
    for (const field of METADATA_FIELDS) {
      if (model[field] === null && openrouterModel && openrouterModel[field] != null) {
        model[field] = clone(openrouterModel[field]);
        model.metadataSources[field] = 'openrouter-catalog';
      }
    }
    if (model.displayName === model.id && openrouterModel?.displayName) {
      model.displayName = openrouterModel.displayName;
    }
    model = applyDocumentedModalities(provider, model);
    model.source = 'bundled-provider-catalog';
    models.push(model);
  }
  models.sort((left, right) => left.id.localeCompare(right.id));
  return { schemaVersion: 1, provider, models };
}

function loadBundledProviderCatalog(provider) {
  if (!CATALOG_PROVIDERS.includes(provider)) {
    throw new TypeError(`Unsupported bundled catalog provider: ${provider}`);
  }
  const document = require(path.join(CATALOG_DIRECTORY, `${provider}.json`));
  if (!document || document.schemaVersion !== 1 || document.provider !== provider
    || !Array.isArray(document.models) || !document.models.length
    || document.models.some((model) => !validModel(model))) {
    throw new TypeError(`Invalid bundled provider catalog: ${provider}`);
  }
  return { models: clone(document.models), state: 'bundled', warnings: [] };
}

function hasBundledProviderCatalog(provider) {
  return CATALOG_PROVIDERS.includes(provider);
}

module.exports = {
  CATALOG_DIRECTORY,
  CATALOG_PROVIDERS,
  buildProviderCatalog,
  enrichModelFromSeed,
  hasBundledProviderCatalog,
  loadBundledProviderCatalog,
  openRouterIdFor,
};
