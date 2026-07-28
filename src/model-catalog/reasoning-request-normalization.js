'use strict';

function isOpenAiUpstream(baseUrl) {
  if (!(baseUrl instanceof URL)) return false;
  const pathname = baseUrl.pathname.replace(/\/+$/u, '') || '/';
  return baseUrl.protocol === 'https:'
    && baseUrl.hostname === 'api.openai.com'
    && pathname === '/v1';
}

function normalizeOpenAiReasoningRequest(body, upstreamBaseUrl, models) {
  if (!isOpenAiUpstream(upstreamBaseUrl)
    || !body
    || typeof body !== 'object'
    || !body.reasoning
    || typeof body.reasoning !== 'object') return false;
  const model = (Array.isArray(models) ? models : [])
    .find((entry) => entry && (entry.slug === body.model || entry.display_name === body.model));
  if (!model) return false;
  const levels = (Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels
    : [])
    .map((level) => typeof level === 'string' ? level : level && level.effort)
    .filter(Boolean);
  if (levels.length === 0) {
    delete body.reasoning;
    return true;
  }
  if (!Object.prototype.hasOwnProperty.call(body.reasoning, 'effort')
    || levels.includes(body.reasoning.effort)) return false;
  if (typeof model.default_reasoning_level === 'string'
    && levels.includes(model.default_reasoning_level)) {
    body.reasoning.effort = model.default_reasoning_level;
  } else {
    delete body.reasoning.effort;
    if (Object.keys(body.reasoning).length === 0) delete body.reasoning;
  }
  return true;
}

module.exports = {
  normalizeOpenAiReasoningRequest,
};
