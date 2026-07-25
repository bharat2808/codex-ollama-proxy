'use strict';

const ORIGINS = new Set(['live', 'cache', 'bundled', 'static', 'supplied']);

function adapterResult(options = {}) {
  if (!Array.isArray(options.models)) throw new TypeError('Adapter result models must be an array.');
  if (!Array.isArray(options.warnings)) throw new TypeError('Adapter result warnings must be an array.');
  if (!ORIGINS.has(options.origin)) throw new TypeError('Adapter result origin is invalid.');
  if (typeof options.complete !== 'boolean') {
    throw new TypeError('Adapter result complete must be a boolean.');
  }
  const result = {
    models: options.models,
    warnings: options.warnings,
    origin: options.origin,
    complete: options.complete,
  };
  if (options.fallback) result.fallback = options.fallback;
  return result;
}

module.exports = { adapterResult, ORIGINS };
