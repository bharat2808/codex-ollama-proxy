'use strict';

const { fetchJson } = require('../live-catalog');
const { adapterResult } = require('../adapter-result');
const {
  MAX_CONTEXT_WINDOW,
  MAX_OUTPUT_TOKENS,
  emptyMetadataSources,
  isObviousNonTextModelId,
  normalizeModelId,
} = require('../normalize');
const {
  firstBoundedPositiveInteger,
  isUnavailableModelRow,
  normalizedStrings,
  record,
} = require('../model-row-utils');

const ENDPOINT = 'https://openrouter.ai/api/v1/models';
const CACHE_TTL_MS = 60000;
const FALLBACK_MODELS = Object.freeze([
  ['openrouter/auto', 'OpenRouter Auto', 200000, 8192, false],
  ['moonshotai/kimi-k2.6', 'MoonshotAI: Kimi K2.6', 262144, 262144, true],
  ['moonshotai/kimi-k2.5', 'MoonshotAI: Kimi K2.5', 262144, 262144, true],
]);

function fallbackModels() {
  return FALLBACK_MODELS.map(([id, displayName, contextWindow, maxOutputTokens, reasoning]) => ({
    id,
    displayName,
    contextWindow,
    maxOutputTokens,
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    reasoning,
    reasoningLevels: null,
    toolCalling: null,
    metadataSources: {
      contextWindow: 'provider-seed',
      maxOutputTokens: 'provider-seed',
      inputModalities: 'provider-seed',
      outputModalities: 'provider-seed',
      reasoning: 'provider-seed',
      reasoningLevels: null,
      toolCalling: null,
    },
    source: 'openclaw-static',
  }));
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
  const reasoning = parameters.some((parameter) => parameter === 'reasoning' || parameter === 'include_reasoning')
    ? true
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
  if (toolCalling !== null) metadataSources.toolCalling = 'provider-catalog';
  return {
    id,
    displayName: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id,
    contextWindow,
    maxOutputTokens,
    inputModalities: input.includes('image') ? ['text', 'image'] : ['text'],
    outputModalities: outputModalities.length ? [...new Set(outputModalities)] : null,
    reasoning,
    reasoningLevels: null,
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
    const warnings = ['OpenRouter live catalog refresh failed; using the bundled OpenClaw seed.'];
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
