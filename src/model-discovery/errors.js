'use strict';

class ModelDiscoveryError extends Error {
  constructor(code, provider, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'ModelDiscoveryError';
    this.code = code;
    this.provider = provider || null;
  }
}

function discoveryError(code, provider, message, cause) {
  if (cause instanceof ModelDiscoveryError) return cause;
  return new ModelDiscoveryError(code, provider, message, { cause });
}

module.exports = { ModelDiscoveryError, discoveryError };
