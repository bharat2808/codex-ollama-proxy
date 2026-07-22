'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { discoveryError } = require('./errors');
const {
  MAX_CONTEXT_WINDOW,
  MAX_OUTPUT_TOKENS,
  METADATA_FIELDS,
  normalizeModelId,
} = require('./normalize');

const SCHEMA_VERSION = 1;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const METADATA_SOURCE_VALUES = new Set([
  null,
  'provider-catalog',
  'provider-inspection',
  'provider-seed',
]);
const MODALITIES = new Set(['text', 'image', 'audio', 'video', 'document']);

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
  if (model.inputModalities !== null) {
    if (!Array.isArray(model.inputModalities) || model.inputModalities.length === 0) return false;
    if (model.inputModalities.some((value) => !MODALITIES.has(value))) return false;
  }
  if (![true, false, null].includes(model.reasoning)) return false;
  if (![true, false, null].includes(model.toolCalling)) return false;
  if (!model.metadataSources || typeof model.metadataSources !== 'object') return false;
  if (METADATA_FIELDS.some((field) => !METADATA_SOURCE_VALUES.has(model.metadataSources[field]))) return false;
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

function writeCache(options, identity, models, fetchedAt) {
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
    return { models: cached.document.models, cacheStatus: 'fresh', warnings };
  }

  try {
    const models = await refresh();
    writeCache(options, identity, models, now);
    return { models, cacheStatus: 'refreshed', warnings };
  } catch (error) {
    if (cached.document) {
      warnings.push('Provider catalog refresh failed; using the last successful cache file.');
      return { models: cached.document.models, cacheStatus: 'stale', warnings };
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
