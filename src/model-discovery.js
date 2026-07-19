'use strict';

const { mapLimit } = require('./async-utils');
const upstreamLib = require('./upstream');

const CACHE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 15 * 1000;

let current = { source: 'none', complete: false, models: [], fetchedAt: 0, checkedAt: 0, upstream: '' };
const pending = new Map();

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
  const discoveredModels = ollamaModels || await discoverOpenAI(upstream);
  const inferredModels = current.upstream === upstreamKey
    ? current.models.filter((model) => model.inferredImageGeneration)
    : [];
  const models = discoveredModels.map((model) => {
    const inferred = inferredModels.find((entry) => namesEqual(entry.name, model.name));
    return inferred ? Object.assign({}, model, {
      imageGeneration: true,
      textGeneration: false,
      transport: inferred.transport,
      inferredImageGeneration: true,
    }) : model;
  });
  for (const inferred of inferredModels) {
    if (!models.some((model) => namesEqual(model.name, inferred.name))) models.push(inferred);
  }
  const now = Date.now();
  if (models.length === 0 && current.models.length > 0 && current.upstream === upstreamKey) {
    current = Object.assign({}, current, { checkedAt: now });
    return current;
  }
  current = {
    source: ollamaModels ? 'ollama' : 'openai',
    complete: models.length > 0,
    models,
    fetchedAt: models.length > 0 ? now : 0,
    checkedAt: now,
    upstream: upstreamKey,
  };
  return current;
}

function prewarm(upstream) {
  const upstreamKey = upstreamLib.displayUrl(upstream);
  const checkedAt = current.checkedAt || current.fetchedAt || 0;
  const ttl = current.complete ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
  if (current.upstream === upstreamKey && Date.now() - checkedAt < ttl) {
    return Promise.resolve(current);
  }
  if (pending.has(upstreamKey)) return pending.get(upstreamKey);
  const request = discover(upstream).finally(() => { pending.delete(upstreamKey); });
  pending.set(upstreamKey, request);
  return request;
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

function markImageModel(name, transport = 'openai_images', upstream) {
  const modelName = String(name || '').trim();
  if (!modelName) return null;
  const upstreamKey = upstream ? upstreamLib.displayUrl(upstream) : current.upstream;
  const sameUpstream = !upstreamKey || current.upstream === upstreamKey;
  const existing = sameUpstream ? findModel(modelName) : null;
  const inferred = Object.assign({}, existing || {}, {
    name: existing ? existing.name : modelName,
    source: existing ? existing.source : 'provider_error',
    imageGeneration: true,
    textGeneration: false,
    transport,
    inferredImageGeneration: true,
  });
  current = Object.assign({}, current, {
    source: sameUpstream ? current.source : 'provider_error',
    complete: sameUpstream ? current.complete : false,
    fetchedAt: sameUpstream ? current.fetchedAt : 0,
    checkedAt: Date.now(),
    upstream: upstreamKey || current.upstream,
    models: existing
      ? current.models.map((model) => model === existing ? inferred : model)
      : [...(sameUpstream ? current.models : []), inferred],
  });
  return inferred;
}

function replaceSnapshot(state) {
  current = Object.assign({ source: 'test', complete: true, models: [], fetchedAt: Date.now(), checkedAt: Date.now(), upstream: '' }, state);
  pending.clear();
}

module.exports = {
  CACHE_TTL_MS,
  NEGATIVE_CACHE_TTL_MS,
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
