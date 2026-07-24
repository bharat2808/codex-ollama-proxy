'use strict';

const DOCUMENTED_MODALITIES = Object.freeze({
  cohere: Object.freeze({
    'command-a-03-2025': Object.freeze({
      inputModalities: Object.freeze(['text']),
      outputModalities: Object.freeze(['text']),
    }),
    'command-a-plus-05-2026': Object.freeze({
      inputModalities: Object.freeze(['text', 'image']),
      outputModalities: Object.freeze(['text']),
    }),
    'command-a-reasoning-08-2025': Object.freeze({
      inputModalities: Object.freeze(['text']),
      outputModalities: Object.freeze(['text']),
    }),
    'command-a-vision-07-2025': Object.freeze({
      inputModalities: Object.freeze(['text', 'image']),
      outputModalities: Object.freeze(['text']),
      toolCalling: false,
    }),
    'north-mini-code-1-0': Object.freeze({
      inputModalities: Object.freeze(['text', 'image']),
      outputModalities: Object.freeze(['text']),
    }),
  }),
  xai: Object.freeze({
    'grok-4.20-0309-non-reasoning': Object.freeze({
      inputModalities: Object.freeze(['text', 'image']),
      outputModalities: Object.freeze(['text']),
    }),
    'grok-4.20-0309-reasoning': Object.freeze({
      inputModalities: Object.freeze(['text', 'image']),
      outputModalities: Object.freeze(['text']),
    }),
    'grok-imagine-image': Object.freeze({
      inputModalities: Object.freeze(['text', 'image']),
      outputModalities: Object.freeze(['image']),
    }),
    'grok-imagine-image-quality': Object.freeze({
      inputModalities: Object.freeze(['text', 'image']),
      outputModalities: Object.freeze(['image']),
    }),
    'grok-imagine-video': Object.freeze({
      inputModalities: Object.freeze(['text', 'image', 'video']),
      outputModalities: Object.freeze(['video']),
    }),
    'grok-imagine-video-1.5': Object.freeze({
      inputModalities: Object.freeze(['image']),
      outputModalities: Object.freeze(['video']),
    }),
  }),
});

function applyDocumentedModalities(provider, model) {
  const documented = DOCUMENTED_MODALITIES[provider]?.[model.id];
  if (!documented) return model;
  const enriched = { ...model, metadataSources: { ...model.metadataSources } };
  for (const field of ['inputModalities', 'outputModalities', 'toolCalling']) {
    if (!(field in documented)) continue;
    if (enriched[field] !== null) continue;
    enriched[field] = Array.isArray(documented[field])
      ? [...documented[field]]
      : documented[field];
    enriched.metadataSources[field] = 'provider-catalog';
  }
  return enriched;
}

module.exports = { applyDocumentedModalities };
