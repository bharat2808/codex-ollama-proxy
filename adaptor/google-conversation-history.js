'use strict';

const CONTINUATION_TTL_MS = 10 * 60_000;
const MAX_CONTINUATIONS = 256;

function normalizedModel(model) {
  return String(model || '').replace(/^google\//u, '');
}

function pruneContinuations(continuations, currentTime = Date.now()) {
  for (const [callId, entry] of continuations) {
    if (entry.expiresAt <= currentTime) continuations.delete(callId);
  }
  while (continuations.size > MAX_CONTINUATIONS) {
    continuations.delete(continuations.keys().next().value);
  }
}

function prepareBody(body, model, continuations) {
  if (!body || !Array.isArray(body.input) || !continuations) return body;
  pruneContinuations(continuations);
  const currentModel = normalizedModel(model);
  const mismatchedCallIds = new Set();
  for (const item of body.input) {
    if (!item || item.type !== 'function_call') continue;
    const callId = item.call_id || item.id;
    const entry = continuations.get(callId);
    if (entry && entry.model !== currentModel) mismatchedCallIds.add(callId);
  }
  if (mismatchedCallIds.size === 0) return body;
  return {
    ...body,
    input: body.input.filter((item) => {
      if (!item || !['function_call', 'function_call_output'].includes(item.type)) return true;
      return !mismatchedCallIds.has(item.call_id || item.id);
    }),
  };
}

function continuationFor(body, model, continuations) {
  if (!continuations || !Array.isArray(body.input)) return null;
  pruneContinuations(continuations);
  const currentModel = normalizedModel(model);
  let matchingIndex = -1;
  let entry = null;
  for (let index = 0; index < body.input.length; index += 1) {
    const item = body.input[index];
    if (!item || !['function_call', 'function_call_output'].includes(item.type)) continue;
    const found = continuations.get(item.call_id || item.id);
    if (found && found.model === currentModel) {
      matchingIndex = index;
      entry = found;
      break;
    }
  }
  if (!entry) return null;
  const alreadyHasUserHistory = body.input.slice(0, matchingIndex).some((item) =>
    item && (item.role === 'user' || item.role === 'system' || item.role === 'developer'));
  return alreadyHasUserHistory ? null : entry;
}

function restoreThoughtSignatures(request, body, model, continuations) {
  if (!request || !Array.isArray(request.contents)
    || !body || !Array.isArray(body.input) || !continuations) return;
  pruneContinuations(continuations);
  const currentModel = normalizedModel(model);
  const requestCalls = request.contents.flatMap((content) =>
    Array.isArray(content.parts)
      ? content.parts.filter((part) => part && part.functionCall)
      : []);
  let requestCallIndex = 0;

  for (const item of body.input) {
    if (!item || item.type !== 'function_call') continue;
    const name = item.name || 'unknown_tool';
    while (requestCallIndex < requestCalls.length
      && requestCalls[requestCallIndex].functionCall.name !== name) {
      requestCallIndex += 1;
    }
    if (requestCallIndex >= requestCalls.length) break;
    const requestPart = requestCalls[requestCallIndex++];
    if (requestPart.thoughtSignature || item.thought_signature) continue;

    const entry = continuations.get(item.call_id || item.id);
    if (!entry || entry.model !== currentModel || !Array.isArray(entry.contents)) continue;
    const cachedPart = entry.contents
      .flatMap((content) => Array.isArray(content.parts) ? content.parts : [])
      .find((part) => part && part.functionCall
        && part.functionCall.name === name
        && typeof part.thoughtSignature === 'string'
        && part.thoughtSignature);
    if (cachedPart) requestPart.thoughtSignature = cachedPart.thoughtSignature;
  }
}

function rememberContinuations(continuations, model, request, payload, response) {
  if (!continuations || !request || !response) return;
  pruneContinuations(continuations);
  const parts = payload?.candidates?.[0]?.content?.parts;
  const calls = (response.output || []).filter((item) =>
    item && item.type === 'function_call' && item.call_id);
  if (!Array.isArray(parts) || calls.length === 0) return;
  const entry = {
    model: normalizedModel(model),
    contents: [...request.contents, { role: 'model', parts }],
    systemInstruction: request.systemInstruction,
    expiresAt: Date.now() + CONTINUATION_TTL_MS,
  };
  for (const call of calls) continuations.set(call.call_id, entry);
  pruneContinuations(continuations);
}

module.exports = {
  continuationFor,
  normalizedModel,
  prepareBody,
  rememberContinuations,
  restoreThoughtSignatures,
};
