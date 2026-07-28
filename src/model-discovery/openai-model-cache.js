'use strict';

const {
  MAX_CONTEXT_WINDOW,
  boundedPositiveInteger,
  emptyMetadataSources,
  normalizeModelId,
  normalizeReasoningLevels,
} = require('./normalize');

const MODALITIES = new Set(['text', 'image', 'audio', 'video', 'document']);

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stringArray(value) {
  if (!Array.isArray(value)) return null;
  const entries = [...new Set(value.filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean))];
  return entries.length ? entries : null;
}

function modalities(value) {
  const entries = stringArray(value);
  if (!entries) return null;
  const supported = entries.filter((entry) => MODALITIES.has(entry));
  return supported.length ? supported : null;
}

function reasoningLevels(value) {
  if (!Array.isArray(value)) return null;
  return normalizeReasoningLevels(value.map((entry) => record(entry).effort));
}

function metadataSource(value) {
  return value == null ? null : 'provider-catalog';
}

function normalizeOpenAiModelCacheRow(row) {
  const value = record(row);
  let id;
  try { id = normalizeModelId(value.slug); } catch { return null; }
  const levels = reasoningLevels(value.supported_reasoning_levels);
  const requestedDefault = typeof value.default_reasoning_level === 'string'
    ? value.default_reasoning_level.trim().toLowerCase()
    : null;
  const defaultLevel = levels?.includes(requestedDefault) ? requestedDefault : null;
  const contextWindow = boundedPositiveInteger(value.context_window, MAX_CONTEXT_WINDOW);
  const inputModalities = modalities(value.input_modalities);
  const toolCalling = value.supports_parallel_tool_calls === true ? true : null;
  const reasoning = levels ? true : null;
  const reasoningDefaultEnabled = defaultLevel ? defaultLevel !== 'none' : null;
  const reasoningMandatory = reasoning ? !levels.includes('none') : null;
  const providerMetadata = {};
  if (typeof value.description === 'string' && value.description.trim()) {
    providerMetadata.description = value.description.trim();
  }
  if (typeof value.visibility === 'string' && value.visibility.trim()) {
    providerMetadata.visibility = value.visibility.trim();
  }
  if (typeof value.supported_in_api === 'boolean') {
    providerMetadata.supportedInApi = value.supported_in_api;
  }
  const maximumContextWindow = boundedPositiveInteger(
    value.max_context_window,
    MAX_CONTEXT_WINDOW,
  );
  if (maximumContextWindow) providerMetadata.maximumContextWindow = maximumContextWindow;
  const additionalSpeedTiers = stringArray(value.additional_speed_tiers);
  if (additionalSpeedTiers) providerMetadata.additionalSpeedTiers = additionalSpeedTiers;
  if (Array.isArray(value.service_tiers) && value.service_tiers.length) {
    providerMetadata.serviceTiers = JSON.parse(JSON.stringify(value.service_tiers));
  }
  return {
    id,
    displayName: typeof value.display_name === 'string' && value.display_name.trim()
      ? value.display_name.trim()
      : id,
    contextWindow,
    maxOutputTokens: null,
    inputModalities,
    outputModalities: null,
    reasoning,
    reasoningLevels: levels,
    defaultReasoningLevel: defaultLevel,
    reasoningDefaultEnabled,
    reasoningSupportsMaxTokens: null,
    reasoningMandatory,
    toolCalling,
    metadataSources: {
      ...emptyMetadataSources(),
      contextWindow: metadataSource(contextWindow),
      inputModalities: metadataSource(inputModalities),
      reasoning: metadataSource(reasoning),
      reasoningLevels: metadataSource(levels),
      defaultReasoningLevel: metadataSource(defaultLevel),
      reasoningDefaultEnabled: metadataSource(reasoningDefaultEnabled),
      reasoningMandatory: metadataSource(reasoningMandatory),
      toolCalling: metadataSource(toolCalling),
    },
    providerMetadata,
    source: 'openai-model-cache',
  };
}

function normalizeOpenAiModelCache(document) {
  if (!document || typeof document !== 'object' || !Array.isArray(document.models)) {
    throw new TypeError('Codex model cache is missing its model list.');
  }
  const models = [];
  const seen = new Set();
  for (const row of document.models) {
    const model = normalizeOpenAiModelCacheRow(row);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  if (!models.length) throw new TypeError('Codex model cache contained no valid models.');
  return models;
}

module.exports = {
  normalizeOpenAiModelCache,
  normalizeOpenAiModelCacheRow,
};
