#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { createAccessTokenProvider } = require('../src/google-adc');

const DEFAULT_PORT = 8787;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const CONTINUATION_TTL_MS = 10 * 60_000;
const MAX_CONTINUATIONS = 256;

function id(prefix) {
  return prefix + '_' + crypto.randomBytes(12).toString('hex');
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
  });
  res.end(body);
}

function sse(res, event, payload) {
  res.write('event: ' + event + '\n');
  res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > 10_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(new Error('invalid JSON body: ' + error.message));
      }
    });
    req.on('error', reject);
  });
}

function dataUri(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/u);
  return match ? { mimeType: match[1], data: match[2].replace(/\s+/gu, '') } : null;
}

const MIME_BY_EXTENSION = Object.freeze({
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.rtf': 'application/rtf',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml',
});

function extensionForSource(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    return path.extname(new URL(value).pathname).toLowerCase();
  } catch {
    return path.extname(value).toLowerCase();
  }
}

function mimeTypeFor(part, source, fallback = 'application/octet-stream') {
  return part.mime_type || part.mimeType
    || MIME_BY_EXTENSION[path.extname(part.filename || '').toLowerCase()]
    || MIME_BY_EXTENSION[extensionForSource(source)]
    || fallback;
}

function mediaPart(part, kind) {
  const value = kind === 'image'
    ? part.image_url || part.url || part.image || part.data
    : part.file_data || part.file_url || part.url || part.data;
  const inline = dataUri(value);
  if (inline) return { inlineData: inline };
  if (typeof value === 'string' && value) {
    if (kind === 'file' && part.file_data && !part.file_url) {
      return { inlineData: { mimeType: mimeTypeFor(part, value), data: value } };
    }
    return { fileData: { mimeType: mimeTypeFor(part, value), fileUri: value } };
  }
  return { text: kind === 'image' ? '[image input unavailable]' : '[file input unavailable]' };
}

function contentParts(content) {
  if (content == null) return [];
  if (typeof content === 'string') return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: String(content) }];
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ text: part });
    } else if (!part || typeof part !== 'object') {
      parts.push({ text: String(part) });
    } else if (['input_text', 'output_text', 'text'].includes(part.type)) {
      parts.push({ text: String(part.text || '') });
    } else if (['input_image', 'output_image', 'image'].includes(part.type)) {
      parts.push(mediaPart(part, 'image'));
    } else if (part.type === 'input_file' || part.file_data || part.file_url) {
      parts.push(mediaPart(part, 'file'));
    }
  }
  return parts;
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function responseValue(value) {
  if (value && typeof value === 'object') return value;
  const text = String(value == null ? '' : value);
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : { output: parsed };
  } catch {
    return { output: text };
  }
}

function buildGenerateContentRequest(body, model = '') {
  const contents = [];
  const systemParts = body.instructions ? [{ text: String(body.instructions) }] : [];
  const callNames = new Map();
  let groupedItemType = null;
  const input = typeof body.input === 'string'
    ? [{ type: 'message', role: 'user', content: body.input }]
    : Array.isArray(body.input) ? body.input : [];

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call') {
      const name = item.name || 'unknown_tool';
      if (item.call_id || item.id) callNames.set(item.call_id || item.id, name);
    }
  }

  function pushPart(role, part, itemType) {
    const previous = contents.at(-1);
    if (groupedItemType === itemType && previous && previous.role === role) {
      previous.parts.push(part);
    } else {
      contents.push({ role, parts: [part] });
    }
    groupedItemType = itemType;
  }

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call') {
      const name = item.name || 'unknown_tool';
      pushPart('model', {
        functionCall: { name, args: parseArguments(item.arguments) },
        ...(item.thought_signature ? { thoughtSignature: item.thought_signature } : {}),
      }, 'function_call');
      continue;
    }
    if (item.type === 'function_call_output') {
      pushPart('user', {
        functionResponse: {
          name: item.name || callNames.get(item.call_id || item.id) || 'unknown_tool',
          response: responseValue(item.output),
        },
      }, 'function_call_output');
      continue;
    }
    groupedItemType = null;
    const role = item.role || (item.type === 'message' ? 'user' : '');
    if (role === 'system' || role === 'developer') {
      systemParts.push(...contentParts(item.content));
    } else if (role === 'user' || role === 'assistant' || role === 'model') {
      contents.push({
        role: role === 'assistant' ? 'model' : role,
        parts: contentParts(item.content),
      });
    }
  }
  if (contents.length === 0) {
    const prompt = body.message || body.prompt || '';
    contents.push({ role: 'user', parts: [{ text: String(prompt) }] });
  }

  const request = { contents };
  if (systemParts.length) request.systemInstruction = { parts: systemParts };
  const functionDeclarations = (body.tools || [])
    .filter((tool) => tool && tool.type === 'function' && tool.name)
    .map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      parametersJsonSchema: tool.parameters || { type: 'object', properties: {} },
    }));
  if (functionDeclarations.length) request.tools = [{ functionDeclarations }];
  if (body.tool_choice && functionDeclarations.length) {
    const choice = body.tool_choice;
    let mode = 'AUTO';
    const functionCallingConfig = {};
    if (choice === 'none') mode = 'NONE';
    else if (choice === 'required') mode = 'ANY';
    else if (choice && typeof choice === 'object' && choice.name) {
      mode = 'ANY';
      functionCallingConfig.allowedFunctionNames = [choice.name];
    }
    functionCallingConfig.mode = mode;
    request.toolConfig = { functionCallingConfig };
  }

  const generationConfig = {};
  if (body.max_output_tokens || body.max_tokens) {
    generationConfig.maxOutputTokens = body.max_output_tokens || body.max_tokens;
  }
  if (body.temperature != null) generationConfig.temperature = body.temperature;
  if (body.top_p != null) generationConfig.topP = body.top_p;
  if (Array.isArray(body.modalities) && body.modalities.length) {
    generationConfig.responseModalities = body.modalities.map((value) => String(value).toUpperCase());
  }
  const effort = body.reasoning && body.reasoning.effort;
  if (effort) {
    if (/^gemini-2\.5-/u.test(normalizedModel(model))) {
      const budgets = { low: 1024, medium: 8192, high: 24576, xhigh: 24576, max: 24576 };
      generationConfig.thinkingConfig = { thinkingBudget: budgets[effort] || budgets.medium };
    } else {
      const levels = {
        none: 'MINIMAL',
        minimal: 'MINIMAL',
        low: 'LOW',
        medium: 'MEDIUM',
        high: 'HIGH',
        xhigh: 'HIGH',
        max: 'HIGH',
      };
      generationConfig.thinkingConfig = { thinkingLevel: levels[effort] || 'MEDIUM' };
    }
  }
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;
  return request;
}

function pruneContinuations(continuations, currentTime = Date.now()) {
  for (const [callId, entry] of continuations) {
    if (entry.expiresAt <= currentTime) continuations.delete(callId);
  }
  while (continuations.size > MAX_CONTINUATIONS) {
    continuations.delete(continuations.keys().next().value);
  }
}

function continuationFor(body, continuations) {
  if (!continuations || !Array.isArray(body.input)) return null;
  pruneContinuations(continuations);
  let matchingIndex = -1;
  let entry = null;
  for (let index = 0; index < body.input.length; index += 1) {
    const item = body.input[index];
    if (!item || !['function_call', 'function_call_output'].includes(item.type)) continue;
    const found = continuations.get(item.call_id || item.id);
    if (found) {
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

function buildGoogleRequest(body, model, continuations) {
  const request = buildGenerateContentRequest(body, model);
  const continuation = continuationFor(body, continuations);
  if (!continuation) return request;
  const suffix = request.contents.filter((content) =>
    !content.parts.every((part) => part && part.functionCall));
  request.contents = [...continuation.contents, ...suffix];
  if (!request.systemInstruction && continuation.systemInstruction) {
    request.systemInstruction = continuation.systemInstruction;
  }
  return request;
}

function rememberContinuations(continuations, request, payload, response) {
  if (!continuations || !request || !response) return;
  pruneContinuations(continuations);
  const parts = payload?.candidates?.[0]?.content?.parts;
  const calls = (response.output || []).filter((item) => item && item.type === 'function_call' && item.call_id);
  if (!Array.isArray(parts) || calls.length === 0) return;
  const entry = {
    contents: [...request.contents, { role: 'model', parts }],
    systemInstruction: request.systemInstruction,
    expiresAt: Date.now() + CONTINUATION_TTL_MS,
  };
  for (const call of calls) continuations.set(call.call_id, entry);
  pruneContinuations(continuations);
}

function normalizedModel(model) {
  return String(model || '').replace(/^google\//u, '');
}

function googleTarget(options, model, stream) {
  if (!options.baseUrl) throw new Error('GOOGLE_API_BASE_URL is not set');
  const base = new URL(options.baseUrl);
  const pathname = base.pathname.replace(/\/+$/u, '');
  const vertexMatch = pathname.match(/^(\/v1\/projects\/[^/]+\/locations\/[^/]+)\/endpoints\/openapi$/u);
  const method = stream ? 'streamGenerateContent' : 'generateContent';
  let url;
  let vertex = false;
  if (vertexMatch) {
    vertex = true;
    url = new URL(base.origin + vertexMatch[1] + '/publishers/google/models/'
      + encodeURIComponent(normalizedModel(model)) + ':' + method + (stream ? '?alt=sse' : ''));
  } else {
    const nativePath = pathname.replace(/\/openai$/u, '');
    url = new URL(base.origin + nativePath + '/models/'
      + encodeURIComponent(normalizedModel(model)) + ':' + method + (stream ? '?alt=sse' : ''));
  }
  const headers = { 'content-type': 'application/json' };
  if (options.apiKey) {
    if (vertex) headers.authorization = 'Bearer ' + options.apiKey;
    else headers['x-goog-api-key'] = options.apiKey;
  }
  return { url, headers, vertex };
}

async function callGoogle(body, options, stream, request = null) {
  const model = body.model || options.defaultModel;
  if (!model) throw new Error('Google model is not set');
  const target = googleTarget(options, model, stream);
  if (target.vertex && !target.headers.authorization) {
    const getAccessToken = options.accessTokenProvider
      || (options.accessTokenProvider = createAccessTokenProvider());
    target.headers.authorization = 'Bearer ' + await getAccessToken();
  }
  const timeoutMs = Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs > 0
    ? options.requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
  let response;
  try {
    response = await (options.fetchImpl || fetch)(target.url, {
      method: 'POST',
      headers: target.headers,
      body: JSON.stringify(request || buildGenerateContentRequest(body, model)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      const timeoutError = new Error('upstream request timed out after ' + timeoutMs + 'ms');
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  }
  if (!response.ok) {
    const detail = await response.text();
    const error = new Error('upstream ' + response.status + ': ' + detail);
    error.statusCode = response.status;
    throw error;
  }
  return response;
}

function messageItem(text, itemId = id('msg')) {
  return {
    id: itemId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function imageItem(part, itemId = id('ig')) {
  return {
    id: itemId,
    type: 'image_generation_call',
    status: 'completed',
    result: `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`,
  };
}

function toolItem(part) {
  return {
    id: id('fc'),
    type: 'function_call',
    status: 'completed',
    call_id: id('call'),
    name: part.functionCall.name || 'unknown_tool',
    arguments: JSON.stringify(part.functionCall.args || {}),
    ...(part.thoughtSignature ? { thought_signature: part.thoughtSignature } : {}),
  };
}

function usageFor(payload) {
  const usage = payload && payload.usageMetadata;
  if (!usage) return null;
  return {
    input_tokens: usage.promptTokenCount || 0,
    output_tokens: usage.candidatesTokenCount || 0,
    total_tokens: usage.totalTokenCount || 0,
  };
}

function geminiToResponse(payload, model) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((part) => typeof part.text === 'string').map((part) => part.text).join('');
  const output = [];
  if (text) output.push(messageItem(text));
  for (const part of parts) {
    if (part.functionCall) output.push(toolItem(part));
    if (part.inlineData && part.inlineData.data) output.push(imageItem(part));
  }
  if (output.length === 0) output.push(messageItem(''));
  return {
    id: id('resp'),
    object: 'response',
    created_at: now(),
    status: 'completed',
    model,
    output,
    output_text: text,
    usage: usageFor(payload),
  };
}

function parseSseBlock(block) {
  const data = [];
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return data.join('\n');
}

async function streamGoogleResponse(res, body, options, continuations) {
  const model = body.model || options.defaultModel;
  const responseId = id('resp');
  const createdAt = now();
  let sequence = 0;
  let nextOutputIndex = 0;
  let text = '';
  let messageId = null;
  let textOutputIndex = null;
  const output = [];
  const modelParts = [];

  const request = buildGoogleRequest(body, model, continuations);
  const upstream = await callGoogle(body, options, true, request);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
  });
  sse(res, 'response.created', {
    type: 'response.created',
    sequence_number: sequence++,
    response: { id: responseId, object: 'response', created_at: createdAt, status: 'in_progress', model, output: [] },
  });

  let buffer = '';
  for await (const chunk of upstream.body) {
    buffer += Buffer.from(chunk).toString('utf8');
    const blocks = buffer.split(/\r?\n\r?\n/u);
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      const data = parseSseBlock(block);
      if (!data || data === '[DONE]') continue;
      let payload;
      try { payload = JSON.parse(data); } catch { continue; }
      const parts = payload?.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        modelParts.push(part);
        if (typeof part.text === 'string' && part.text) {
          if (!messageId) {
            messageId = id('msg');
            textOutputIndex = nextOutputIndex++;
            sse(res, 'response.output_item.added', {
              type: 'response.output_item.added',
              output_index: textOutputIndex,
              sequence_number: sequence++,
              item: { id: messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
            });
            sse(res, 'response.content_part.added', {
              type: 'response.content_part.added',
              item_id: messageId,
              output_index: textOutputIndex,
              content_index: 0,
              sequence_number: sequence++,
              part: { type: 'output_text', text: '', annotations: [] },
            });
          }
          text += part.text;
          sse(res, 'response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: messageId,
            output_index: textOutputIndex,
            content_index: 0,
            sequence_number: sequence++,
            delta: part.text,
          });
        }
        if (part.functionCall) {
          const item = toolItem(part);
          const index = nextOutputIndex++;
          output[index] = item;
          sse(res, 'response.output_item.added', {
            type: 'response.output_item.added',
            output_index: index,
            sequence_number: sequence++,
            item: {
              id: item.id,
              type: item.type,
              status: 'in_progress',
              call_id: item.call_id,
              name: item.name,
              arguments: '',
              ...(item.thought_signature ? { thought_signature: item.thought_signature } : {}),
            },
          });
          sse(res, 'response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: item.id,
            output_index: index,
            sequence_number: sequence++,
            delta: item.arguments,
          });
          sse(res, 'response.function_call_arguments.done', {
            type: 'response.function_call_arguments.done',
            item_id: item.id,
            output_index: index,
            sequence_number: sequence++,
            arguments: item.arguments,
          });
          sse(res, 'response.output_item.done', {
            type: 'response.output_item.done', output_index: index, sequence_number: sequence++, item,
          });
        }
        if (part.inlineData && part.inlineData.data) {
          const item = imageItem(part);
          const index = nextOutputIndex++;
          output[index] = item;
          sse(res, 'response.output_item.added', {
            type: 'response.output_item.added',
            output_index: index,
            sequence_number: sequence++,
            item: { id: item.id, type: item.type, status: 'in_progress' },
          });
          sse(res, 'response.output_item.done', {
            type: 'response.output_item.done', output_index: index, sequence_number: sequence++, item,
          });
        }
      }
    }
  }
  if (messageId) {
    const item = messageItem(text, messageId);
    output[textOutputIndex] = item;
    sse(res, 'response.output_text.done', {
      type: 'response.output_text.done',
      item_id: messageId,
      output_index: textOutputIndex,
      content_index: 0,
      sequence_number: sequence++,
      text,
    });
    sse(res, 'response.content_part.done', {
      type: 'response.content_part.done',
      item_id: messageId,
      output_index: textOutputIndex,
      content_index: 0,
      sequence_number: sequence++,
      part: item.content[0],
    });
    sse(res, 'response.output_item.done', {
      type: 'response.output_item.done', output_index: textOutputIndex, sequence_number: sequence++, item,
    });
  }
  if (output.length === 0) output.push(messageItem(''));
  rememberContinuations(
    continuations,
    request,
    { candidates: [{ content: { parts: modelParts } }] },
    { output },
  );
  sse(res, 'response.completed', {
    type: 'response.completed',
    sequence_number: sequence++,
    response: {
      id: responseId, object: 'response', created_at: createdAt, status: 'completed', model,
      output: output.filter(Boolean), output_text: text,
    },
  });
  res.end();
}

function envOptions(env = process.env) {
  return {
    port: parseInt(env.GOOGLE_API_ADAPTOR_PORT || env.PORT || String(DEFAULT_PORT), 10),
    baseUrl: env.GOOGLE_API_BASE_URL || '',
    apiKey: env.GOOGLE_API_KEY || '',
    defaultModel: env.GOOGLE_API_MODEL || env.MODEL || '',
    requestTimeoutMs: parseInt(env.GOOGLE_API_REQUEST_TIMEOUT_MS || String(DEFAULT_REQUEST_TIMEOUT_MS), 10),
    verbose: /^(1|true|yes|on)$/iu.test(env.GOOGLE_API_ADAPTOR_VERBOSE || ''),
  };
}

function startServer(options = {}) {
  const config = Object.assign(envOptions(), options);
  const continuations = new Map();
  const server = http.createServer(async (req, res) => {
    const requestPath = req.url.replace(/\?.*$/u, '').replace(/\/+$/u, '') || '/';
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type,authorization',
        });
        return res.end();
      }
      if (req.method === 'GET' && (requestPath === '/' || requestPath === '/health')) {
        return jsonResponse(res, 200, {
          ok: true,
          adaptor: 'google',
          base_url_set: Boolean(config.baseUrl),
          api_key_set: Boolean(config.apiKey),
          default_model: config.defaultModel,
        });
      }
      if (req.method === 'GET' && requestPath === '/v1/models') {
        return jsonResponse(res, 200, {
          object: 'list',
          data: config.defaultModel ? [{ id: config.defaultModel, object: 'model', owned_by: 'google' }] : [],
        });
      }
      if (req.method === 'POST' && (requestPath === '/v1/responses' || requestPath === '/responses')) {
        const body = await parseJsonBody(req);
        if (body.stream) return await streamGoogleResponse(res, body, config, continuations);
        const model = body.model || config.defaultModel;
        const request = buildGoogleRequest(body, model, continuations);
        const upstream = await callGoogle(body, config, false, request);
        const payload = await upstream.json();
        const response = geminiToResponse(payload, model);
        rememberContinuations(continuations, request, payload, response);
        return jsonResponse(res, 200, response);
      }
      return jsonResponse(res, 404, { error: 'not found' });
    } catch (error) {
      if (config.verbose) console.error('[google-api-adaptor]', error);
      if (!res.headersSent) return jsonResponse(res, error.statusCode || 500, { error: error.message });
      sse(res, 'response.error', { type: 'response.error', error: { message: error.message } });
      res.end();
    }
  });
  server.listen(config.port, '127.0.0.1', () => {
    console.log('[google-api-adaptor] listening on http://127.0.0.1:' + config.port + '/v1 -> '
      + (config.baseUrl || '(GOOGLE_API_BASE_URL not set)'));
  });
  server.once('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
      console.error('[google-api-adaptor] port already in use: 127.0.0.1:' + config.port);
      process.exitCode = 1;
      return;
    }
    throw error;
  });
  return server;
}

if (require.main === module) startServer();

module.exports = {
  buildGenerateContentRequest,
  envOptions,
  geminiToResponse,
  googleTarget,
  startServer,
};
