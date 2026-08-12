'use strict';

const REASONING_EFFORTS = Object.freeze([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

function nonEmptyString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sessionKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const metadata = value.metadata && typeof value.metadata === 'object'
    && !Array.isArray(value.metadata)
    ? value.metadata
    : {};
  const conversation = value.conversation;
  const candidates = [
    ['session_id', value.session_id, value.sessionId, metadata.session_id, metadata.sessionId],
    ['thread_id', value.thread_id, value.threadId, metadata.thread_id, metadata.threadId],
    ['conversation_id', value.conversation_id, value.conversationId,
      metadata.conversation_id, metadata.conversationId],
    ['conversation', conversation && typeof conversation === 'object'
      ? conversation.id
      : conversation],
    ['prompt_cache_key', value.prompt_cache_key, value.promptCacheKey,
      metadata.prompt_cache_key, metadata.promptCacheKey],
  ];
  const keys = [];
  for (const [kind, ...values] of candidates) {
    const id = values.map(nonEmptyString).find(Boolean);
    if (id) keys.push(`${kind}:${id}`, `id:${id}`);
  }
  return [...new Set(keys)];
}

function createActiveModelTracker({ maxEntries = 1024 } = {}) {
  const entries = new Map();
  let sequence = 0;

  function trim() {
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  function record(request) {
    const model = nonEmptyString(request && request.model);
    const keys = sessionKeys(request);
    if (!model || keys.length === 0) return false;
    sequence += 1;
    for (const key of keys) {
      entries.delete(key);
      entries.set(key, { model, sequence });
    }
    trim();
    return true;
  }

  function resolve(session) {
    let match = null;
    for (const key of sessionKeys(session)) {
      const entry = entries.get(key);
      if (entry && (!match || entry.sequence > match.sequence)) match = entry;
    }
    return match ? match.model : '';
  }

  return { record, resolve };
}

function resolveVoiceModel({ configuredModel, defaultModel, tracker, session } = {}) {
  return nonEmptyString(configuredModel)
    || (tracker && typeof tracker.resolve === 'function' ? nonEmptyString(tracker.resolve(session)) : '')
    || nonEmptyString(defaultModel);
}

function lowestReasoningEffort(modelName, catalogModels) {
  const name = nonEmptyString(modelName);
  const model = (Array.isArray(catalogModels) ? catalogModels : []).find((entry) => (
    entry && (entry.slug === name || entry.display_name === name)
  ));
  if (!model || !Array.isArray(model.supported_reasoning_levels)) return null;
  const supported = new Set(model.supported_reasoning_levels
    .map((level) => typeof level === 'string' ? level : level && level.effort)
    .map(nonEmptyString)
    .filter(Boolean));
  return REASONING_EFFORTS.find((effort) => supported.has(effort)) || null;
}

module.exports = {
  createActiveModelTracker,
  lowestReasoningEffort,
  resolveVoiceModel,
  sessionKeys,
};
