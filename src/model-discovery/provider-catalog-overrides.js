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
      reasoning: true,
      reasoningDefaultEnabled: true,
      reasoningSupportsMaxTokens: true,
      reasoningMandatory: false,
      toolCalling: true,
    }),
    'command-a-reasoning-08-2025': Object.freeze({
      inputModalities: Object.freeze(['text']),
      outputModalities: Object.freeze(['text']),
      reasoning: true,
      reasoningDefaultEnabled: true,
      reasoningSupportsMaxTokens: true,
      reasoningMandatory: false,
    }),
    'command-a-vision-07-2025': Object.freeze({
      inputModalities: Object.freeze(['text', 'image']),
      outputModalities: Object.freeze(['text']),
      toolCalling: false,
    }),
    'north-mini-code-1-0': Object.freeze({
      inputModalities: Object.freeze(['text', 'image']),
      outputModalities: Object.freeze(['text']),
      reasoning: true,
      reasoningDefaultEnabled: true,
      reasoningSupportsMaxTokens: true,
      reasoningMandatory: false,
    }),
  }),
  google: Object.freeze({
    'gemini-2.5-flash': Object.freeze({
      reasoning: true,
      reasoningLevels: Object.freeze(['none', 'minimal', 'low', 'medium', 'high']),
      reasoningDefaultEnabled: true,
      reasoningSupportsMaxTokens: true,
      reasoningMandatory: false,
    }),
    'gemini-2.5-flash-lite': Object.freeze({
      reasoning: true,
      reasoningLevels: Object.freeze(['none', 'minimal', 'low', 'medium', 'high']),
      defaultReasoningLevel: 'none',
      reasoningDefaultEnabled: false,
      reasoningSupportsMaxTokens: true,
      reasoningMandatory: false,
    }),
    'gemini-2.5-pro': Object.freeze({
      reasoning: true,
      reasoningLevels: Object.freeze(['minimal', 'low', 'medium', 'high']),
      reasoningDefaultEnabled: true,
      reasoningSupportsMaxTokens: true,
      reasoningMandatory: true,
    }),
    'gemini-3-pro-preview': Object.freeze({
      reasoning: true,
      reasoningLevels: Object.freeze(['low', 'high']),
      defaultReasoningLevel: 'high',
      reasoningDefaultEnabled: true,
      reasoningSupportsMaxTokens: false,
      reasoningMandatory: true,
    }),
  }),
  nvidia: Object.freeze({
    'deepseek-ai/deepseek-v4-pro': Object.freeze({
      inputModalities: Object.freeze(['text']),
      outputModalities: Object.freeze(['text']),
      reasoning: true,
      reasoningLevels: Object.freeze(['none', 'high', 'max']),
      defaultReasoningLevel: 'high',
      reasoningDefaultEnabled: true,
      reasoningSupportsMaxTokens: false,
      reasoningMandatory: false,
      toolCalling: true,
    }),
    'minimaxai/minimax-m3': Object.freeze({
      inputModalities: Object.freeze(['text', 'image', 'video']),
      outputModalities: Object.freeze(['text']),
      reasoning: true,
      toolCalling: true,
    }),
  }),
  'ollama-cloud': Object.freeze(Object.fromEntries([
    'glm-5.2:cloud',
    'kimi-k2.7-code:cloud',
    'minimax-m2.7:cloud',
    'nemotron-3-ultra:cloud',
  ].map((id) => [id, Object.freeze({
    reasoning: true,
    reasoningLevels: Object.freeze(['none', 'low', 'medium', 'high', 'max']),
  })]))),
  xai: Object.freeze({
    'grok-4.5': Object.freeze({
      reasoningLevels: Object.freeze(['low', 'medium', 'high']),
      defaultReasoningLevel: 'high',
    }),
    'grok-4.20-0309-non-reasoning': Object.freeze({
      inputModalities: Object.freeze(['text', 'image']),
      outputModalities: Object.freeze(['text']),
      reasoning: false,
      reasoningDefaultEnabled: false,
      reasoningSupportsMaxTokens: false,
      reasoningMandatory: false,
    }),
    'grok-4.20-0309-reasoning': Object.freeze({
      inputModalities: Object.freeze(['text', 'image']),
      outputModalities: Object.freeze(['text']),
      reasoning: true,
      reasoningDefaultEnabled: true,
      reasoningSupportsMaxTokens: false,
      reasoningMandatory: true,
    }),
    'grok-build-0.1': Object.freeze({
      inputModalities: Object.freeze(['text', 'image']),
      outputModalities: Object.freeze(['text']),
      reasoning: true,
      reasoningDefaultEnabled: true,
      reasoningSupportsMaxTokens: false,
      reasoningMandatory: true,
      toolCalling: true,
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
  for (const field of [
    'inputModalities',
    'outputModalities',
    'reasoning',
    'reasoningLevels',
    'defaultReasoningLevel',
    'reasoningDefaultEnabled',
    'reasoningSupportsMaxTokens',
    'reasoningMandatory',
    'toolCalling',
  ]) {
    if (!(field in documented)) continue;
    enriched[field] = Array.isArray(documented[field])
      ? [...documented[field]]
      : documented[field];
    enriched.metadataSources[field] = 'provider-catalog';
  }
  return enriched;
}

module.exports = { applyDocumentedModalities };
