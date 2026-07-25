'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { discoveryError } = require('./errors');
const {
  MAX_CONTEXT_WINDOW,
  MAX_OUTPUT_TOKENS,
  METADATA_FIELDS,
  MODALITIES,
  normalizeModelId,
  REASONING_LEVELS,
} = require('./normalize');

const SCHEMA_VERSION = 2;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const METADATA_SOURCE_VALUES = new Set([
  null,
  'openrouter-catalog',
  'provider-catalog',
  'provider-inspection',
  'provider-seed',
]);
const MODALITY_SET = new Set(MODALITIES);
const REASONING_LEVEL_SET = new Set(REASONING_LEVELS);
const DATA_ORIGINS = new Set(['live', 'cache', 'bundled', 'static', 'supplied']);

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function cacheIdentity(options) {
  const endpointDigest = digest(options.endpoint);
  const authScopeDigest = digest(options.apiKey || 'anonymous');
  const directory = path.join(options.cacheDir, options.provider);
  const file = path.join(directory, `${endpointDigest}-${authScopeDigest}.json`);
  return { endpointDigest, authScopeDigest, directory, file };
}

function nullableBoundedPositiveInteger(value, maximum) {
  return value === null || (Number.isSafeInteger(value) && value > 0 && value <= maximum);
}

function validModel(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return false;
  try { normalizeModelId(model.id); } catch { return false; }
  if (typeof model.displayName !== 'string' || !model.displayName.trim()) return false;
  if (!nullableBoundedPositiveInteger(model.contextWindow, MAX_CONTEXT_WINDOW)) return false;
  if (!nullableBoundedPositiveInteger(model.maxOutputTokens, MAX_OUTPUT_TOKENS)) return false;
  for (const field of ['inputModalities', 'outputModalities']) {
    if (model[field] !== null) {
      if (!Array.isArray(model[field]) || model[field].length === 0) return false;
      if (model[field].some((value) => !MODALITY_SET.has(value))) return false;
    }
  }
  if (![true, false, null].includes(model.reasoning)) return false;
  if (model.reasoningLevels !== null) {
    if (!Array.isArray(model.reasoningLevels) || model.reasoningLevels.length === 0) return false;
    if (model.reasoningLevels.some((value) => !REASONING_LEVEL_SET.has(value))) return false;
  }
  const defaultReasoningLevel = model.defaultReasoningLevel ?? null;
  if (defaultReasoningLevel !== null
    && !REASONING_LEVEL_SET.has(defaultReasoningLevel)) return false;
  if (defaultReasoningLevel !== null
    && !model.reasoningLevels?.includes(defaultReasoningLevel)) return false;
  for (const field of [
    'reasoningDefaultEnabled',
    'reasoningSupportsMaxTokens',
    'reasoningMandatory',
  ]) {
    if (![true, false, null, undefined].includes(model[field])) return false;
  }
  if (![true, false, null].includes(model.toolCalling)) return false;
  if (!model.metadataSources || typeof model.metadataSources !== 'object') return false;
  if (METADATA_FIELDS.some((field) => model.metadataSources[field] !== undefined
    && !METADATA_SOURCE_VALUES.has(model.metadataSources[field]))) return false;
  return typeof model.source === 'string' && Boolean(model.source);
}

function sanitizeModelForCache(model) {
  const clone = JSON.parse(JSON.stringify(model));
  if (/^https?:\/\//iu.test(clone.source)) clone.source = 'provider-catalog';
  return clone;
}

function validDocument(document, options, identity) {
  return document && typeof document === 'object' && !Array.isArray(document)
    && document.schemaVersion === SCHEMA_VERSION
    && document.provider === options.provider
    && document.endpointDigest === identity.endpointDigest
    && document.authScopeDigest === identity.authScopeDigest
    && Number.isFinite(document.fetchedAt)
    && DATA_ORIGINS.has(document.origin)
    && typeof document.complete === 'boolean'
    && Array.isArray(document.models)
    && document.models.length > 0
    && document.models.every(validModel);
}

function readCache(options, identity) {
  if (!fs.existsSync(identity.file)) return { document: null, warning: null };
  try {
    const stat = fs.statSync(identity.file);
    if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) throw new Error('unsafe cache file');
    const document = JSON.parse(fs.readFileSync(identity.file, 'utf8'));
    if (!validDocument(document, options, identity)) throw new Error('invalid cache schema');
    return { document, warning: null };
  } catch {
    return { document: null, warning: 'Ignored an invalid provider discovery cache file.' };
  }
}

function writeCache(options, identity, models, fetchedAt, metadata = {}) {
  if (!Array.isArray(models) || models.length === 0 || !models.every(validModel)) {
    throw discoveryError('INVALID_SCHEMA', options.provider, 'Provider catalog contained no valid models.');
  }
  fs.mkdirSync(identity.directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(identity.directory, 0o700);
  const document = {
    schemaVersion: SCHEMA_VERSION,
    provider: options.provider,
    endpointDigest: identity.endpointDigest,
    authScopeDigest: identity.authScopeDigest,
    fetchedAt,
    origin: DATA_ORIGINS.has(metadata.origin) ? metadata.origin : 'cache',
    complete: metadata.complete === true,
    models: models.map(sanitizeModelForCache),
  };
  const temporary = path.join(
    identity.directory,
    `.${path.basename(identity.file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, identity.file);
    fs.chmodSync(identity.file, 0o600);
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }
}

async function withProviderCache(options, refresh) {
  const identity = cacheIdentity(options);
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const cached = readCache(options, identity);
  const warnings = cached.warning ? [cached.warning] : [];
  if (cached.document && now - cached.document.fetchedAt <= options.ttlMs) {
    return {
      models: cached.document.models,
      state: 'fresh',
      warnings,
      origin: cached.document.origin,
      complete: cached.document.complete,
    };
  }

  try {
    const refreshed = await refresh();
    const models = Array.isArray(refreshed) ? refreshed : refreshed.models;
    const fallback = Array.isArray(refreshed) ? null : refreshed.fallback;
    const metadata = Array.isArray(refreshed)
      ? { origin: 'cache', complete: false }
      : { origin: refreshed.origin, complete: refreshed.complete };
    if (fallback) {
      if (cached.document) {
        warnings.push(...(fallback.warnings || []), 'Provider catalog refresh failed; using the last successful cache file.');
        return {
          models: cached.document.models,
          state: 'stale',
          warnings,
          origin: cached.document.origin,
          complete: cached.document.complete,
        };
      }
      return {
        models,
        state: fallback.state || 'fallback',
        warnings: [...warnings, ...(fallback.warnings || [])],
        ...metadata,
      };
    }
    writeCache(options, identity, models, now, metadata);
    return { models, state: 'refreshed', warnings, ...metadata };
  } catch (error) {
    if ((options.signal && options.signal.aborted) || (error && error.code === 'CANCELLED')) throw error;
    if (cached.document) {
      warnings.push('Provider catalog refresh failed; using the last successful cache file.');
      return {
        models: cached.document.models,
        state: 'stale',
        warnings,
        origin: cached.document.origin,
        complete: cached.document.complete,
      };
    }
    if (error && error.code) throw error;
    throw discoveryError('REFRESH_FAILED', options.provider, 'Provider catalog refresh failed.', error);
  }
}

module.exports = {
  SCHEMA_VERSION,
  cacheIdentity,
  readCache,
  validModel,
  withProviderCache,
  writeCache,
};
