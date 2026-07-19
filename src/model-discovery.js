'use strict';

const upstreamLib = require('./upstream');

let current = { source: 'none', complete: false, models: [], fetchedAt: 0, upstream: '' };
let pending = null;

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? null : JSON.stringify(options.body);
    const req = upstreamLib.transport(url).request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: url.pathname + url.search,
      method: options.method || (payload == null ? 'GET' : 'POST'),
      headers: Object.assign({}, options.headers || {}, payload == null ? {} : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      }),
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300 && parsed) {
          resolve(parsed);
          return;
        }
        const error = new Error('HTTP ' + res.statusCode);
        error.statusCode = res.statusCode;
        reject(error);
      });
    });
    req.setTimeout(options.timeoutMs || 1500, () => req.destroy(new Error('model metadata timeout')));
    req.on('error', reject);
    req.end(payload || undefined);
  });
}

function ollamaNativeUrl(upstream, apiPath) {
  if (!upstream || !upstream.baseUrl) return null;
  const url = new URL(upstream.baseUrl.href);
  const basePath = url.pathname.replace(/\/+$/u, '');
  if (!/\/v1$/u.test(basePath)) return null;
  url.pathname = basePath.slice(0, -3) + '/' + String(apiPath || '').replace(/^\/+/, '');
  url.search = '';
  url.hash = '';
  return url;
}

function normalizeList(value) {
  return Array.isArray(value) ? value.map((item) => String(item).toLowerCase()) : [];
}

function recordFor(name, metadata, source) {
  const capabilities = normalizeList(metadata && metadata.capabilities);
  const architecture = metadata && metadata.architecture && typeof metadata.architecture === 'object'
    ? metadata.architecture : {};
  const inputModalities = normalizeList(
    (metadata && metadata.input_modalities) || architecture.input_modalities
  );
  const outputModalities = normalizeList(
    (metadata && metadata.output_modalities) || architecture.output_modalities
  );
  const imageGeneration = (source === 'ollama' && capabilities.includes('image')) ||
    capabilities.includes('image_generation') || outputModalities.includes('image');
  const hasExplicitText = capabilities.includes('completion') || capabilities.includes('tools') ||
    outputModalities.includes('text');
  return {
    name,
    source,
    capabilities,
    inputModalities,
    outputModalities,
    imageGeneration,
    textGeneration: hasExplicitText || (capabilities.length === 0 && outputModalities.length === 0),
    transport: source === 'ollama' && imageGeneration ? 'ollama_native' : 'openai_images',
  };
}

async function mapLimit(values, limit, mapper) {
  const output = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output;
}

async function discoverOllama(upstream) {
  const tagsUrl = ollamaNativeUrl(upstream, '/api/tags');
  if (!tagsUrl) return null;
  let tags;
  try {
    tags = await requestJson(tagsUrl, { headers: upstreamLib.authHeaders(upstream) });
  } catch {
    return null;
  }
  const listed = Array.isArray(tags.models) ? tags.models : [];
  const models = await mapLimit(listed, 8, async (entry) => {
    const name = String(entry && (entry.name || entry.model) || '').trim();
    if (!name) return null;
    let metadata = entry;
    if (!Array.isArray(entry.capabilities)) {
      const showUrl = ollamaNativeUrl(upstream, '/api/show');
      try {
        metadata = await requestJson(showUrl, {
          method: 'POST',
          body: { model: name },
          headers: upstreamLib.authHeaders(upstream),
          timeoutMs: 2500,
        });
      } catch {}
    }
    return recordFor(name, metadata, 'ollama');
  });
  return models.filter(Boolean);
}

async function discoverOpenAI(upstream) {
  const url = upstreamLib.urlForClientPath(upstream, '/v1/models');
  let response;
  try {
    response = await requestJson(url, { headers: upstreamLib.authHeaders(upstream) });
  } catch {
    return [];
  }
  const listed = Array.isArray(response.data) ? response.data
    : (Array.isArray(response.models) ? response.models : []);
  return listed.map((entry) => {
    const name = String(entry && (entry.id || entry.name || entry.model) || '').trim();
    return name ? recordFor(name, entry, 'openai') : null;
  }).filter(Boolean);
}

async function discover(upstream) {
  const upstreamKey = upstreamLib.displayUrl(upstream);
  const ollamaModels = await discoverOllama(upstream);
  const models = ollamaModels || await discoverOpenAI(upstream);
  current = {
    source: ollamaModels ? 'ollama' : 'openai',
    complete: models.length > 0,
    models,
    fetchedAt: Date.now(),
    upstream: upstreamKey,
  };
  return current;
}

function prewarm(upstream) {
  const upstreamKey = upstreamLib.displayUrl(upstream);
  if (current.complete && current.upstream === upstreamKey) return Promise.resolve(current);
  if (pending) return pending;
  pending = discover(upstream).finally(() => { pending = null; });
  return pending;
}

function snapshot() {
  return current;
}

function namesEqual(a, b) {
  const left = String(a || '').toLowerCase();
  const right = String(b || '').toLowerCase();
  return left === right || left + ':latest' === right || right + ':latest' === left;
}

function findModel(name, state = current) {
  return (state.models || []).find((model) => namesEqual(model.name, name)) || null;
}

function chooseImageModel(requested, configured, state = current) {
  const requestedInfo = findModel(requested, state);
  if (requestedInfo && requestedInfo.imageGeneration) return requestedInfo;

  if (configured) {
    const configuredInfo = findModel(configured, state);
    if (configuredInfo && configuredInfo.imageGeneration) return configuredInfo;
    if (!state.complete || !configuredInfo) {
      return {
        name: configured,
        source: 'configured',
        imageGeneration: true,
        textGeneration: false,
        transport: 'openai_images',
      };
    }
  }

  const imageModels = (state.models || []).filter((model) => model.imageGeneration);
  if (imageModels.length === 1) return imageModels[0];
  return null;
}

function markImageModel(name, transport = 'openai_images') {
  const modelName = String(name || '').trim();
  if (!modelName) return null;
  const existing = findModel(modelName);
  const inferred = Object.assign({}, existing || {}, {
    name: existing ? existing.name : modelName,
    source: existing ? existing.source : 'provider_error',
    imageGeneration: true,
    textGeneration: false,
    transport,
  });
  current = Object.assign({}, current, {
    models: existing
      ? current.models.map((model) => model === existing ? inferred : model)
      : [...current.models, inferred],
  });
  return inferred;
}

function replaceSnapshot(state) {
  current = Object.assign({ source: 'test', complete: true, models: [], fetchedAt: Date.now(), upstream: '' }, state);
  pending = null;
}

module.exports = {
  chooseImageModel,
  discover,
  findModel,
  markImageModel,
  ollamaNativeUrl,
  prewarm,
  recordFor,
  replaceSnapshot,
  snapshot,
};
