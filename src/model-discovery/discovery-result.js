'use strict';

function cacheState(cacheStatus) {
  return ['fresh', 'refreshed', 'stale'].includes(cacheStatus) ? cacheStatus : 'none';
}

function createDiscoveryResult(options = {}) {
  const models = options.models === undefined ? [] : options.models;
  const warnings = options.warnings === undefined ? [] : options.warnings;
  if (!Array.isArray(models)) throw new TypeError('Discovery result models must be an array.');
  if (!Array.isArray(warnings)) throw new TypeError('Discovery result warnings must be an array.');
  const cacheStatus = options.cacheStatus || 'none';
  return {
    provider: options.provider || null,
    providerResolution: options.providerResolution || 'unknown',
    traits: options.traits || {},
    source: options.source || 'none',
    cacheStatus,
    cache: { state: cacheState(cacheStatus) },
    dataOrigin: options.dataOrigin || 'none',
    discoverySkipped: Boolean(options.discoverySkipped),
    models,
    warnings,
  };
}

module.exports = { cacheState, createDiscoveryResult };
