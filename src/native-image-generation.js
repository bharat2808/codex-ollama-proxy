'use strict';

const crypto = require('crypto');

function nativeImageProvider(baseUrl) {
  if (!(baseUrl instanceof URL)) return null;
  const pathname = baseUrl.pathname.replace(/\/+$/u, '') || '/';
  if (baseUrl.protocol === 'https:' && baseUrl.hostname === 'api.x.ai' && pathname === '/v1') {
    return 'xai';
  }
  return null;
}

function textFromContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && typeof part === 'object' && (part.type === 'input_text' || part.type === 'text'))
    .map((part) => String(part.text || '').trim())
    .filter(Boolean)
    .join('\n');
}

function responsesPrompt(body) {
  if (body && typeof body.input === 'string') {
    const prompt = body.input.trim();
    if (prompt) return prompt;
  }
  const input = body && Array.isArray(body.input) ? body.input : [];
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!item || typeof item !== 'object' || item.role !== 'user') continue;
    const prompt = textFromContent(item.content);
    if (prompt) return prompt;
  }
  throw new Error('native image generation requires a non-empty user text prompt');
}

function responsesImages(body) {
  const input = body && Array.isArray(body.input) ? body.input : [];
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!item || item.role !== 'user' || !Array.isArray(item.content)) continue;
    return item.content
      .filter((part) => part && part.type === 'input_image')
      .map((part) => typeof part.image_url === 'string'
        ? part.image_url
        : part.image_url && part.image_url.url)
      .filter((value) => typeof value === 'string' && value);
  }
  return [];
}

function imageResult(item) {
  if (item && typeof item.url === 'string' && item.url) return item.url;
  if (item && typeof item.b64_json === 'string' && item.b64_json) {
    const mimeType = typeof item.mime_type === 'string' && item.mime_type
      ? item.mime_type
      : 'image/png';
    return `data:${mimeType};base64,${item.b64_json}`;
  }
  return null;
}

function responseErrorMessage(payload, fallback) {
  if (payload && payload.error && typeof payload.error.message === 'string') {
    return payload.error.message;
  }
  if (payload && typeof payload.error === 'string') return payload.error;
  return fallback;
}

function responsesUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = Number.isFinite(usage.input_tokens)
    ? usage.input_tokens
    : Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0;
  const outputTokens = Number.isFinite(usage.output_tokens)
    ? usage.output_tokens
    : Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0;
  return {
    ...usage,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: Number.isFinite(usage.total_tokens)
      ? usage.total_tokens
      : inputTokens + outputTokens,
  };
}

async function generateNativeImageResponse({ upstream, body, fetchImpl = fetch }) {
  if (!upstream || nativeImageProvider(upstream.baseUrl) !== 'xai') {
    throw new Error('native image endpoint bridge is not available for this upstream');
  }
  const prompt = responsesPrompt(body);
  const images = responsesImages(body).slice(-3);
  const endpoint = new URL(upstream.baseUrl.href);
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, '') + (images.length ? '/images/edits' : '/images/generations');
  const requestBody = {
    model: body.model,
    prompt,
    ...(images.length === 1
      ? { image: { type: 'image_url', url: images[0] } }
      : images.length > 1
        ? { images: images.map((url) => ({ type: 'image_url', url })) }
        : {}),
    n: 1,
    response_format: 'url',
  };
  const response = await fetchImpl(endpoint.href, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(upstream.apiKey ? { authorization: `Bearer ${upstream.apiKey}` } : {}),
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(120000),
  });
  const raw = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {}
  if (!response.ok) {
    const error = new Error(responseErrorMessage(payload, `native image endpoint returned HTTP ${response.status}`));
    error.statusCode = response.status;
    throw error;
  }
  const output = [];
  for (const item of Array.isArray(payload && payload.data) ? payload.data : []) {
    const result = imageResult(item);
    if (!result) continue;
    const call = {
      id: `ig_${crypto.randomUUID().replace(/-/gu, '')}`,
      type: 'image_generation_call',
      status: 'completed',
      result,
    };
    if (typeof item.revised_prompt === 'string' && item.revised_prompt) {
      call.revised_prompt = item.revised_prompt;
    }
    output.push(call);
  }
  if (!output.length) {
    throw new Error('native image endpoint returned no image results');
  }
  return {
    id: `resp_${crypto.randomUUID().replace(/-/gu, '')}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: body.model,
    output,
    output_text: '',
    usage: responsesUsage(payload && payload.usage),
  };
}

module.exports = {
  generateNativeImageResponse,
  nativeImageProvider,
  responsesImages,
  responsesPrompt,
};
