'use strict';

const TEXT_IMAGE_INPUT = Object.freeze(['text', 'image']);
const TEXT_OUTPUT = Object.freeze(['text']);
const ALL_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const STANDARD_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'max']);
const LEGACY_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high']);

function documented(reasoningLevels = null) {
  return Object.freeze({
    inputModalities: TEXT_IMAGE_INPUT,
    outputModalities: TEXT_OUTPUT,
    reasoningLevels,
    defaultReasoningLevel: reasoningLevels ? 'high' : null,
    toolCalling: true,
  });
}

const ANTHROPIC_DOCUMENTED_MODELS = Object.freeze({
  'claude-fable-5': documented(ALL_EFFORT_LEVELS),
  'claude-haiku-4-5-20251001': documented(),
  'claude-opus-4-1-20250805': documented(),
  'claude-opus-4-5-20251101': documented(LEGACY_EFFORT_LEVELS),
  'claude-opus-4-6': documented(STANDARD_EFFORT_LEVELS),
  'claude-opus-4-7': documented(ALL_EFFORT_LEVELS),
  'claude-opus-4-8': documented(ALL_EFFORT_LEVELS),
  'claude-opus-5': documented(ALL_EFFORT_LEVELS),
  'claude-sonnet-4-5-20250929': documented(),
  'claude-sonnet-4-6': documented(STANDARD_EFFORT_LEVELS),
  'claude-sonnet-5': documented(ALL_EFFORT_LEVELS),
});

function enrichAnthropicFromDocumentation(model) {
  const documentedModel = ANTHROPIC_DOCUMENTED_MODELS[model?.id];
  if (!documentedModel) return model;
  const enriched = { ...model, metadataSources: { ...model.metadataSources } };
  for (const field of [
    'inputModalities',
    'outputModalities',
    'reasoningLevels',
    'defaultReasoningLevel',
    'toolCalling',
  ]) {
    if (enriched[field] !== null || documentedModel[field] === null) continue;
    enriched[field] = Array.isArray(documentedModel[field])
      ? [...documentedModel[field]]
      : documentedModel[field];
    enriched.metadataSources[field] = 'provider-catalog';
  }
  return enriched;
}

module.exports = {
  ANTHROPIC_DOCUMENTED_MODELS,
  enrichAnthropicFromDocumentation,
};
