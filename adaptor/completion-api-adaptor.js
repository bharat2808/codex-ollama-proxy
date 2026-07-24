#!/usr/bin/env node
'use strict';

const http = require('http');
const crypto = require('crypto');

const DEFAULT_PORT = 8787;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

function now() {
  return Math.floor(Date.now() / 1000);
}

function id(prefix) {
  return prefix + '_' + crypto.randomBytes(12).toString('hex');
}

function parseBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/iu.test(String(value));
}

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
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
  res.write('data: ' + JSON.stringify(payload, null, 0) + '\n\n');
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
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error('invalid JSON body: ' + error.message));
      }
    });
    req.on('error', reject);
  });
}

function inputImageUrl(part) {
  return part.image_url || part.url || part.image || part.data;
}

function contentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  const pieces = [];
  for (const part of content) {
    if (typeof part === 'string') {
      pieces.push(part);
    } else if (part && typeof part === 'object') {
      if (['input_text', 'output_text', 'text'].includes(part.type)) {
        pieces.push(String(part.text || ''));
      } else if (part.type === 'input_image') {
        pieces.push(inputImageUrl(part) ? '[image input attached]' : '[image input missing URL]');
      }
    }
  }
  return pieces.filter(Boolean).join('\n');
}

function contentForChat(role, content) {
  if (role !== 'user' || !Array.isArray(content)) return contentText(content);

  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ type: 'text', text: part });
      continue;
    }
    if (!part || typeof part !== 'object') {
      parts.push({ type: 'text', text: String(part) });
      continue;
    }
    if (['input_text', 'output_text', 'text'].includes(part.type)) {
      parts.push({ type: 'text', text: String(part.text || '') });
    } else if (part.type === 'input_image') {
      const url = inputImageUrl(part);
      parts.push(url ? { type: 'image_url', image_url: { url } } : { type: 'text', text: '[image input missing URL]' });
    }
  }
  return parts.length ? parts : contentText(content);
}

function responsesInputToChatMessages(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: String(body.instructions) });

  const input = body.input;
  if (typeof input === 'string') return messages.concat({ role: 'user', content: input });
  if (!Array.isArray(input)) {
    const prompt = body.message || body.prompt;
    return prompt ? messages.concat({ role: 'user', content: String(prompt) }) : messages;
  }

  let pendingToolCalls = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call') {
      pendingToolCalls.push({
        id: item.call_id || item.id || id('call'),
        type: 'function',
        function: { name: item.name || 'unknown_tool', arguments: item.arguments || '{}' },
      });
      continue;
    }
    if (item.type === 'function_call_output') {
      if (pendingToolCalls.length) {
        messages.push({ role: 'assistant', content: '', tool_calls: pendingToolCalls });
        pendingToolCalls = [];
      }
      messages.push({ role: 'tool', tool_call_id: item.call_id || item.id || id('call'), content: contentText(item.output) });
      continue;
    }

    const role = item.role || (item.type === 'message' ? 'user' : null);
    if (role === 'system' || role === 'developer') {
      messages.push({ role: 'system', content: contentText(item.content) });
    } else if (role === 'user' || role === 'assistant') {
      messages.push({ role, content: contentForChat(role, item.content) });
    }
  }
  if (pendingToolCalls.length) messages.push({ role: 'assistant', content: '', tool_calls: pendingToolCalls });
  return messages.length ? messages : [{ role: 'user', content: '' }];
}

function responsesToolsToChatTools(tools) {
  const out = [];
  for (const tool of tools || []) {
    if (!tool || tool.type !== 'function' || !tool.name) continue;
    out.push({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.parameters || { type: 'object', properties: {} },
      },
    });
  }
  return out;
}

function buildChatBody(body, options, stream) {
  const model = body.model || options.defaultModel;
  const tools = responsesToolsToChatTools(body.tools);
  const payload = {
    model,
    messages: body.messages || responsesInputToChatMessages(body),
    stream,
  };
  for (const key of ['temperature', 'top_p', 'seed', 'presence_penalty', 'frequency_penalty']) {
    if (body[key] != null) payload[key] = body[key];
  }
  if (Array.isArray(body.modalities) && body.modalities.length) {
    payload.modalities = [...body.modalities];
  }
  payload.max_tokens = body.max_tokens || body.max_output_tokens || options.maxTokens;
  if (tools.length) {
    payload.tools = tools;
    if (body.tool_choice) payload.tool_choice = body.tool_choice;
  }
  return payload;
}

function messageItem(text) {
  return {
    id: id('msg'),
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function toolItem(toolCall) {
  const fn = toolCall.function || {};
  return {
    id: id('fc'),
    type: 'function_call',
    status: 'completed',
    call_id: toolCall.id || id('call'),
    name: fn.name || 'unknown_tool',
    arguments: fn.arguments || '{}',
  };
}

function imageUrl(image) {
  if (typeof image === 'string') return image;
  if (!image || typeof image !== 'object') return '';
  if (typeof image.url === 'string') return image.url;
  if (typeof image.image_url === 'string') return image.image_url;
  return image.image_url && typeof image.image_url.url === 'string' ? image.image_url.url : '';
}

function imageItem(image, itemId = id('ig')) {
  const result = imageUrl(image);
  return result ? {
    id: itemId,
    type: 'image_generation_call',
    status: 'completed',
    result,
  } : null;
}

function completionToResponse(completion, model) {
  const choice = completion.choices && completion.choices[0];
  const msg = choice && choice.message ? choice.message : {};
  const text = msg.content || '';
  const output = [];
  for (const call of msg.tool_calls || []) output.push(toolItem(call));
  for (const image of msg.images || []) {
    const item = imageItem(image);
    if (item) output.push(item);
  }
  if (text || output.length === 0) output.push(messageItem(text));
  return {
    id: id('resp'),
    object: 'response',
    created_at: now(),
    status: 'completed',
    model,
    output,
    output_text: text,
    usage: completion.usage || null,
  };
}

async function callChatCompletion(body, options, stream) {
  if (!options.baseUrl) throw new Error('CHAT_COMPLETION_BASE_URL is not set');
  const target = new URL(options.baseUrl.replace(/\/+$/u, '') + '/chat/completions');
  const headers = { 'content-type': 'application/json' };
  if (options.apiKey) headers.authorization = 'Bearer ' + options.apiKey;
  const timeoutMs = Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs > 0
    ? options.requestTimeoutMs
    : DEFAULT_REQUEST_TIMEOUT_MS;
  let response;
  try {
    response = await fetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildChatBody(body, options, stream)),
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
    throw new Error('upstream ' + response.status + ': ' + detail);
  }
  return response;
}

function parseSseBlock(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.join('\n') };
}

async function streamResponse(res, body, options) {
  const responseId = id('resp');
  const createdAt = now();
  const model = body.model || options.defaultModel;
  let sequence = 0;
  let outputIndex = 0;
  const msgId = id('msg');
  let textStarted = false;
  let textOutputIndex = null;
  let text = '';
  const toolStates = new Map();
  const output = [];

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    'access-control-allow-origin': '*',
  });
  sse(res, 'response.created', {
    type: 'response.created',
    sequence_number: sequence++,
    response: { id: responseId, object: 'response', created_at: createdAt, status: 'in_progress', model, output: [], output_text: '' },
  });

  const upstream = await callChatCompletion(body, options, true);
  let buffer = '';
  for await (const chunk of upstream.body) {
    buffer += Buffer.from(chunk).toString('utf8');
    const blocks = buffer.split(/\n\n/u);
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      const parsed = parseSseBlock(block);
      if (!parsed.data || parsed.data === '[DONE]') continue;
      let payload;
      try { payload = JSON.parse(parsed.data); } catch { continue; }
      const choice = payload.choices && payload.choices[0];
      const delta = choice && choice.delta ? choice.delta : {};

      for (const toolCall of delta.tool_calls || []) {
        const index = toolCall.index || 0;
        let state = toolStates.get(index);
        if (!state) {
          state = { id: id('fc'), callId: toolCall.id || id('call'), name: '', arguments: '', outputIndex: outputIndex++, added: false, emitted: 0 };
          toolStates.set(index, state);
        }
        if (toolCall.id) state.callId = toolCall.id;
        if (toolCall.function && toolCall.function.name) state.name += toolCall.function.name;
        if (toolCall.function && toolCall.function.arguments) state.arguments += toolCall.function.arguments;
        if (!state.added && state.name) {
          state.added = true;
          sse(res, 'response.output_item.added', {
            type: 'response.output_item.added',
            output_index: state.outputIndex,
            sequence_number: sequence++,
            item: { id: state.id, type: 'function_call', status: 'in_progress', call_id: state.callId, name: state.name, arguments: '' },
          });
        }
        if (state.added && state.arguments.length > state.emitted) {
          const deltaArgs = state.arguments.slice(state.emitted);
          state.emitted = state.arguments.length;
          sse(res, 'response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: state.id,
            output_index: state.outputIndex,
            sequence_number: sequence++,
            delta: deltaArgs,
          });
        }
      }

      for (const image of delta.images || []) {
        const itemId = id('ig');
        const item = imageItem(image, itemId);
        if (!item) continue;
        const imageOutputIndex = outputIndex++;
        sse(res, 'response.output_item.added', {
          type: 'response.output_item.added',
          output_index: imageOutputIndex,
          sequence_number: sequence++,
          item: { id: itemId, type: 'image_generation_call', status: 'in_progress' },
        });
        sse(res, 'response.output_item.done', {
          type: 'response.output_item.done',
          output_index: imageOutputIndex,
          sequence_number: sequence++,
          item,
        });
        output.push(item);
      }

      if (delta.content) {
        if (!textStarted) {
          textStarted = true;
          textOutputIndex = outputIndex++;
          sse(res, 'response.output_item.added', {
            type: 'response.output_item.added',
            output_index: textOutputIndex,
            sequence_number: sequence++,
            item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
          });
          sse(res, 'response.content_part.added', {
            type: 'response.content_part.added',
            item_id: msgId,
            output_index: textOutputIndex,
            content_index: 0,
            sequence_number: sequence++,
            part: { type: 'output_text', text: '', annotations: [] },
          });
        }
        text += delta.content;
        sse(res, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: msgId,
          output_index: textOutputIndex,
          content_index: 0,
          sequence_number: sequence++,
          delta: delta.content,
        });
      }
    }
  }

  for (const state of toolStates.values()) {
    const item = { id: state.id, type: 'function_call', status: 'completed', call_id: state.callId, name: state.name || 'unknown_tool', arguments: state.arguments || '{}' };
    sse(res, 'response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: state.id, output_index: state.outputIndex, sequence_number: sequence++, arguments: item.arguments });
    sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: state.outputIndex, sequence_number: sequence++, item });
    output.push(item);
  }

  if (textStarted) {
    const item = { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
    sse(res, 'response.output_text.done', { type: 'response.output_text.done', item_id: msgId, output_index: textOutputIndex, content_index: 0, sequence_number: sequence++, text });
    sse(res, 'response.content_part.done', { type: 'response.content_part.done', item_id: msgId, output_index: textOutputIndex, content_index: 0, sequence_number: sequence++, part: item.content[0] });
    sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: textOutputIndex, sequence_number: sequence++, item });
    output.push(item);
  }

  sse(res, 'response.completed', {
    type: 'response.completed',
    sequence_number: sequence++,
    response: { id: responseId, object: 'response', created_at: createdAt, status: 'completed', model, output: output.length ? output : [messageItem('')], output_text: text },
  });
  res.end();
}

function envOptions(env = process.env) {
  return {
    port: parseInt(env.CHAT_COMPLETION_ADAPTOR_PORT || env.COMPLETION_ADAPTOR_PORT || env.PORT || String(DEFAULT_PORT), 10),
    baseUrl: env.CHAT_COMPLETION_BASE_URL || env.COMPLETION_BASE_URL || '',
    apiKey: env.CHAT_COMPLETION_API_KEY || env.COMPLETION_API_KEY || '',
    defaultModel: env.CHAT_COMPLETION_MODEL || env.COMPLETION_MODEL || env.MODEL || '',
    maxTokens: parseInt(env.CHAT_COMPLETION_MAX_TOKENS || env.COMPLETION_MAX_TOKENS || '16384', 10),
    requestTimeoutMs: parseInt(env.CHAT_COMPLETION_REQUEST_TIMEOUT_MS || env.COMPLETION_REQUEST_TIMEOUT_MS || String(DEFAULT_REQUEST_TIMEOUT_MS), 10),
    verbose: parseBool(env.CHAT_COMPLETION_ADAPTOR_VERBOSE, false),
  };
}

function startServer(options = {}) {
  const config = Object.assign(envOptions(), options);
  const server = http.createServer(async (req, res) => {
    const path = req.url.replace(/\?.*$/u, '').replace(/\/+$/u, '') || '/';
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type,authorization',
        });
        res.end();
        return;
      }
      if (req.method === 'GET' && (path === '/' || path === '/health')) {
        return jsonResponse(res, 200, {
          ok: true,
          adaptor: 'chat-completion',
          base_url_set: Boolean(config.baseUrl),
          api_key_set: Boolean(config.apiKey),
          default_model: config.defaultModel,
          upstream_path: '/chat/completions',
        });
      }
      if (req.method === 'GET' && path === '/v1/models') {
        if (!config.baseUrl) return jsonResponse(res, 500, { error: 'CHAT_COMPLETION_BASE_URL is not set' });
        const url = new URL(config.baseUrl.replace(/\/+$/u, '') + '/models');
        const headers = config.apiKey ? { authorization: 'Bearer ' + config.apiKey } : {};
        const upstream = await fetch(url, { headers });
        const text = await upstream.text();
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
        res.end(text);
        return;
      }
      if (req.method === 'POST' && (path === '/v1/responses' || path === '/responses')) {
        const body = await parseJsonBody(req);
        if (body.stream) {
          await streamResponse(res, body, config);
          return;
        }
        const upstream = await callChatCompletion(body, config, false);
        const completion = await upstream.json();
        return jsonResponse(res, 200, completionToResponse(completion, body.model || config.defaultModel));
      }
      return jsonResponse(res, 404, { error: 'not found' });
    } catch (error) {
      if (config.verbose) console.error('[completion-api-adaptor]', error);
      if (!res.headersSent) return jsonResponse(res, error.statusCode || 500, { error: error.message });
      sse(res, 'response.error', { type: 'response.error', error: { message: error.message } });
      res.end();
    }
  });

  server.listen(config.port, '127.0.0.1', () => {
    console.log('[completion-api-adaptor] listening on http://127.0.0.1:' + config.port + '/v1 -> ' + (config.baseUrl || '(CHAT_COMPLETION_BASE_URL not set)'));
  });
  server.once('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
      console.error('[completion-api-adaptor] port already in use: 127.0.0.1:' + config.port);
      console.error('[completion-api-adaptor] Set --adaptor-port to another port, or stop the existing adaptor first.');
      process.exitCode = 1;
      return;
    }
    throw error;
  });
  return server;
}

if (require.main === module) startServer();

module.exports = {
  buildChatBody,
  completionToResponse,
  envOptions,
  responsesInputToChatMessages,
  responsesToolsToChatTools,
  startServer,
};
