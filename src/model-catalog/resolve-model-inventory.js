'use strict';

const { isObviousNonTextModelId } = require('../model-discovery/normalize');

function upstreamModelIds(upstreamModels) {
  return new Set((Array.isArray(upstreamModels) ? upstreamModels : [])
    .map((model) => model && (model.id || model.name || model.model))
    .filter((id) => typeof id === 'string' && id.length > 0 && !isObviousNonTextModelId(id)));
}

async function resolveModelInventory(options) {
  const discovery = options.discovery || null;
  const discoveredModels = discovery && Array.isArray(discovery.models) ? discovery.models : [];
  const inventoryComplete = Boolean(discovery && discovery.traits
    && discovery.traits.inventoryComplete);
  let upstreamError = null;
  let upstreamIds;
  if (inventoryComplete) {
    upstreamIds = new Set(discoveredModels.map((model) => model.id));
  } else {
    const upstream = await options.fetchUpstreamModels();
    upstreamIds = upstreamModelIds(upstream.models);
    upstreamError = upstream.error;
  }
  const allKnownIds = new Set([...upstreamIds, ...(options.suppliedModels || [])]);
  for (const model of discoveredModels) allKnownIds.add(model.id);
  return {
    allKnownIds,
    discoveredModels,
    inventoryComplete,
    inventorySource: inventoryComplete ? 'normalized provider discovery' : 'GET /v1/models',
    upstreamError,
    upstreamIds,
  };
}

module.exports = {
  resolveModelInventory,
  upstreamModelIds,
};
