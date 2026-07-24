'use strict';

const MAX_MODEL_ID_LENGTH = 512;
const MAX_CONTEXT_WINDOW = 10000000;
const MAX_OUTPUT_TOKENS = 1000000;
const METADATA_FIELDS = [
  'contextWindow',
  'maxOutputTokens',
  'inputModalities',
  'outputModalities',
  'reasoning',
  'reasoningLevels',
  'defaultReasoningLevel',
  'toolCalling',
];
const REASONING_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const MODALITIES = Object.freeze(['text', 'image', 'audio', 'video', 'document']);

function normalizeReasoningLevels(value) {
  if (!Array.isArray(value)) return null;
  const requested = new Set(value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase()));
  const levels = REASONING_LEVELS.filter((level) => requested.has(level));
  return levels.length ? levels : null;
}
const NON_TEXT_MODEL_ID_PATTERN =
  /(?:^|[/_:.-])(?:embed(?:ding)?|rerank(?:er)?|whisper|transcri(?:be|ption)|tts|speech|moderation|guard|gpt-image|dall-e|flux|sdxl|stable-diffusion|imagen|image-gen(?:eration)?|text-to-image|veo|sora|video-gen(?:eration)?|text-to-video)(?:$|[/_:.-])/i;

function normalizeModelId(value) {
  if (typeof value !== 'string') throw new TypeError('Unsafe model id: expected a string.');
  const id = value.trim();
  if (!id || id.length > MAX_MODEL_ID_LENGTH) throw new TypeError('Unsafe model id: empty or too long.');
  for (const char of id) {
    const codePoint = char.codePointAt(0) || 0;
    if (codePoint <= 0x20 || codePoint === 0x7f) {
      throw new TypeError('Unsafe model id: whitespace and control characters are not allowed.');
    }
  }
  return id;
}

function boundedPositiveInteger(value, maximum) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : null;
}

function emptyMetadataSources() {
  return Object.fromEntries(METADATA_FIELDS.map((field) => [field, null]));
}

function suppliedModel(id) {
  return {
    id,
    displayName: id,
    contextWindow: null,
    maxOutputTokens: null,
    inputModalities: null,
    outputModalities: null,
    reasoning: null,
    reasoningLevels: null,
    defaultReasoningLevel: null,
    toolCalling: null,
    metadataSources: emptyMetadataSources(),
    source: 'supplied',
  };
}

function normalizeSuppliedModels(values = []) {
  if (!Array.isArray(values)) throw new TypeError('suppliedModels must be an array.');
  const seen = new Set();
  const models = [];
  for (const value of values) {
    const id = normalizeModelId(value);
    if (seen.has(id)) continue;
    seen.add(id);
    models.push(suppliedModel(id));
  }
  return models;
}

function mergeDiscoveredWithSupplied(discovered = [], supplied = []) {
  const models = [];
  const seen = new Set();
  for (const model of discovered) {
    if (!model || typeof model.id !== 'string' || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  for (const model of supplied) {
    if (!model || typeof model.id !== 'string' || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

module.exports = {
  MAX_CONTEXT_WINDOW,
  MAX_MODEL_ID_LENGTH,
  MAX_OUTPUT_TOKENS,
  METADATA_FIELDS,
  MODALITIES,
  boundedPositiveInteger,
  emptyMetadataSources,
  mergeDiscoveredWithSupplied,
  isObviousNonTextModelId: (id) => NON_TEXT_MODEL_ID_PATTERN.test(id),
  normalizeModelId,
  normalizeReasoningLevels,
  normalizeSuppliedModels,
  REASONING_LEVELS,
  suppliedModel,
};
