'use strict';

const { fetchJson } = require('../live-catalog');
const { adapterResult } = require('../adapter-result');
const { loadBundledProviderCatalog } = require('../provider-catalog');
const {
  MAX_CONTEXT_WINDOW,
  MAX_OUTPUT_TOKENS,
  emptyMetadataSources,
  isObviousNonTextModelId,
  normalizeModelId,
  normalizeReasoningLevels,
  REASONING_LEVELS,
} = require('../normalize');
const {
  firstBoundedPositiveInteger,
  isUnavailableModelRow,
  normalizedStrings,
  record,
} = require('../model-row-utils');

const ENDPOINT = 'https://openrouter.ai/api/v1/models';
const CACHE_TTL_MS = 60000;
const OPENROUTER_REASONING_EFFORTS = REASONING_LEVELS.filter((effort) => effort !== 'ultra');

function fallbackModels() {
  return loadBundledProviderCatalog('openrouter').models;
}

function modalities(architecture, direction) {
  const explicit = normalizedStrings(architecture && architecture[`${direction}_modalities`]);
  if (explicit.length) return explicit;
  if (!architecture || typeof architecture.modality !== 'string') return [];
  const [input = '', output = ''] = architecture.modality.toLowerCase().split('->', 2);
  return (direction === 'input' ? input : output).split('+').map((value) => value.trim()).filter(Boolean);
}

function parseRow(row) {
  const value = record(row);
  if (isUnavailableModelRow(value)) return null;
  let id;
  try { id = normalizeModelId(value.id); } catch { return null; }
  const architecture = record(value.architecture);
  const outputModalities = modalities(architecture, 'output');
  if (outputModalities.length && !outputModalities.includes('text')) return null;
  if (!outputModalities.length && isObviousNonTextModelId(id)) return null;
  const input = modalities(architecture, 'input');
  const parameters = normalizedStrings(value.supported_parameters);
  const reasoningMetadata = value.reasoning && typeof value.reasoning === 'object'
    && !Array.isArray(value.reasoning) ? value.reasoning : null;
  const topProvider = record(value.top_provider);
  const contextWindow = firstBoundedPositiveInteger(
    MAX_CONTEXT_WINDOW,
    topProvider && topProvider.context_length,
    value.context_length,
  );
  const maxOutputTokens = firstBoundedPositiveInteger(
    MAX_OUTPUT_TOKENS,
    topProvider && topProvider.max_completion_tokens,
    value.max_completion_tokens,
    value.max_output_tokens,
  );
  const reasoning = reasoningMetadata
    || parameters.some((parameter) => parameter === 'reasoning' || parameter === 'include_reasoning')
    ? true
    : null;
  const hasSnakeCaseEfforts = reasoningMetadata
    && Object.prototype.hasOwnProperty.call(reasoningMetadata, 'supported_efforts');
  const hasCamelCaseEfforts = reasoningMetadata
    && Object.prototype.hasOwnProperty.call(reasoningMetadata, 'supportedEfforts');
  const rawSupportedEfforts = hasSnakeCaseEfforts
    ? reasoningMetadata.supported_efforts
    : hasCamelCaseEfforts ? reasoningMetadata.supportedEfforts : undefined;
  const exposesAllEfforts = (hasSnakeCaseEfforts || hasCamelCaseEfforts)
    && rawSupportedEfforts === null;
  const reasoningLevels = exposesAllEfforts
    ? [...OPENROUTER_REASONING_EFFORTS]
    : normalizeReasoningLevels(rawSupportedEfforts);
  const rawDefaultEffort = reasoningMetadata
    ? reasoningMetadata.default_effort ?? reasoningMetadata.defaultEffort
    : null;
  const normalizedDefaultEffort = typeof rawDefaultEffort === 'string'
    ? rawDefaultEffort.trim().toLowerCase()
    : null;
  const defaultReasoningLevel = reasoningLevels?.includes(normalizedDefaultEffort)
    ? normalizedDefaultEffort
    : null;
  const reasoningDefaultEnabled = reasoningMetadata
    && typeof (reasoningMetadata.default_enabled ?? reasoningMetadata.defaultEnabled) === 'boolean'
    ? reasoningMetadata.default_enabled ?? reasoningMetadata.defaultEnabled
    : null;
  const reasoningSupportsMaxTokens = reasoningMetadata
    && typeof (reasoningMetadata.supports_max_tokens ?? reasoningMetadata.supportsMaxTokens) === 'boolean'
    ? reasoningMetadata.supports_max_tokens ?? reasoningMetadata.supportsMaxTokens
    : null;
  const reasoningMandatory = reasoningMetadata
    && typeof reasoningMetadata.mandatory === 'boolean'
    ? reasoningMetadata.mandatory
    : null;
  const toolCalling = parameters.some((parameter) => parameter === 'tools' || parameter === 'tool_choice')
    ? true
    : null;
  const metadataSources = emptyMetadataSources();
  if (contextWindow !== null) metadataSources.contextWindow = 'provider-catalog';
  if (maxOutputTokens !== null) metadataSources.maxOutputTokens = 'provider-catalog';
  metadataSources.inputModalities = 'provider-catalog';
  if (outputModalities.length) metadataSources.outputModalities = 'provider-catalog';
  if (reasoning !== null) metadataSources.reasoning = 'provider-catalog';
  if (reasoningLevels !== null) metadataSources.reasoningLevels = 'provider-catalog';
  if (defaultReasoningLevel !== null) metadataSources.defaultReasoningLevel = 'provider-catalog';
  if (reasoningDefaultEnabled !== null) metadataSources.reasoningDefaultEnabled = 'provider-catalog';
  if (reasoningSupportsMaxTokens !== null) metadataSources.reasoningSupportsMaxTokens = 'provider-catalog';
  if (reasoningMandatory !== null) metadataSources.reasoningMandatory = 'provider-catalog';
  if (toolCalling !== null) metadataSources.toolCalling = 'provider-catalog';
  return {
    id,
    displayName: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id,
    contextWindow,
    maxOutputTokens,
    inputModalities: input.includes('image') ? ['text', 'image'] : ['text'],
    outputModalities: outputModalities.length ? [...new Set(outputModalities)] : null,
    reasoning,
    reasoningLevels,
    defaultReasoningLevel,
    reasoningDefaultEnabled,
    reasoningSupportsMaxTokens,
    reasoningMandatory,
    toolCalling,
    metadataSources,
    source: 'openrouter-catalog',
  };
}

async function discover(options = {}) {
  let payload;
  try {
    payload = await fetchJson({
      url: ENDPOINT,
      provider: 'openrouter',
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      requireHttps: true,
      allowedHostname: 'openrouter.ai',
    });
  } catch (error) {
    if (options.signal && options.signal.aborted) throw error;
    const warnings = ['OpenRouter live catalog refresh failed; using the bundled provider catalog.'];
    return adapterResult({
      models: fallbackModels(),
      warnings,
      origin: 'bundled',
      complete: false,
      fallback: { state: 'bundled', warnings },
    });
  }
  const rows = payload && typeof payload === 'object' && Array.isArray(payload.data) ? payload.data : [];
  const unique = new Map();
  for (const row of rows) {
    const model = parseRow(row);
    if (model && !unique.has(model.id)) unique.set(model.id, model);
  }
  return adapterResult({
    models: [...unique.values()].sort((left, right) => left.id.localeCompare(right.id)),
    warnings: [],
    origin: 'live',
    complete: true,
  });
}

module.exports = { CACHE_TTL_MS, ENDPOINT, discover, fallbackModels, parseRow };
