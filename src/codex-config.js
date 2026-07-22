#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const PACKAGE_DIR = path.resolve(__dirname, '..');
const CODEX_DIR = process.env.CODEX_HOME || path.join(process.env.HOME, '.codex');
const CONFIG = path.join(CODEX_DIR, 'config.toml');
const OLLAMA_REFERENCE = path.join(CODEX_DIR, 'config.toml.ollama-working');
const MODEL_CATALOG = path.join(CODEX_DIR, 'ollama-launch-models-ollama-working.json');
const MODEL_CATALOG_COPY = path.join(CODEX_DIR, 'ollama-launch-models.json');
const DEFAULT_MODEL_CATALOG = path.join(PACKAGE_DIR, 'config', 'model-catalogs', 'ollama-launch-models.default.json');
const MODELS_CACHE = path.join(CODEX_DIR, 'models_cache.json');
const VISION_CACHE = path.join(CODEX_DIR, 'cache', 'vision_capable_models.json');
const BACKUP_DIR = path.join(CODEX_DIR, 'config-backups');
const PROXY_MODELS = path.join(CODEX_DIR, 'ollama-shape-proxy', 'proxy-models.toml');

const DEFAULT_OLLAMA_MODEL = 'glm-5.2:cloud';
const DEFAULT_CONTEXT_WINDOW = '1000000';
const DEFAULT_AUTO_COMPACT = '900000';
const PROVIDER_NAME = 'ollama-launch-codex-app';
const STOREFRONT_PLUGIN_PREFIX = '[plugins."storefront-builder@personal"';
const OLLAMA_PROVIDER_HEADER = `[model_providers.${PROVIDER_NAME}]`;
const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const OLLAMA_SHOW_CONCURRENCY = 10;

const TOOL_CAPABILITY_FIELDS = [
  'apply_patch_tool_type',
  'supports_parallel_tool_calls',
  'supports_search_tool',
  'shell_type',
  'web_search_tool_type',
  'use_responses_lite',
];

const FRESH_INSTRUCTION_FIELDS = [
  'base_instructions',
  'model_messages',
  'include_skills_usage_instructions',
  'experimental_supported_tools',
];

const HARDCODED_CANONICAL = {
  apply_patch_tool_type: 'freeform',
  supports_parallel_tool_calls: true,
  supports_search_tool: true,
  shell_type: 'shell_command',
  web_search_tool_type: 'text_and_image',
  use_responses_lite: false,
};

function exists(file) {
  return fs.existsSync(file);
}

function readText(file) {
  if (!exists(file)) throw new Error(`Missing required file: ${file}`);
  return fs.readFileSync(file, 'utf8');
}

function writeText(file, text) {
  fs.writeFileSync(file, text, 'utf8');
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function makeBackup(mode) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const target = path.join(BACKUP_DIR, `config.toml.${timestamp()}.${mode}.bak`);
  fs.copyFileSync(CONFIG, target);
  return target;
}

function makeBackupOf(file, mode) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const target = path.join(BACKUP_DIR, `${path.basename(file)}.${timestamp()}.${mode}.bak`);
  fs.copyFileSync(file, target);
  return target;
}

function syncModelCatalogCopy(catalogText = null) {
  if (MODEL_CATALOG_COPY === MODEL_CATALOG) return null;
  writeText(MODEL_CATALOG_COPY, catalogText ?? readText(MODEL_CATALOG));
  return MODEL_CATALOG_COPY;
}

function ensureModelCatalog() {
  if (exists(MODEL_CATALOG)) return false;
  if (!exists(DEFAULT_MODEL_CATALOG)) throw new Error(`Missing packaged model catalog: ${DEFAULT_MODEL_CATALOG}`);
  fs.mkdirSync(path.dirname(MODEL_CATALOG), { recursive: true });
  fs.copyFileSync(DEFAULT_MODEL_CATALOG, MODEL_CATALOG);
  syncModelCatalogCopy();
  return true;
}

function loadRouteConfig() {
  const cfg = { text_model: null, image_model: null, auto_route_image: false };
  if (!exists(PROXY_MODELS)) return cfg;
  const text = readText(PROXY_MODELS);
  for (const line of text.split(/\n/)) {
    const stringMatch = line.match(/^\s*([A-Za-z_]+)\s*=\s*"([^"]*)"/);
    if (stringMatch && Object.prototype.hasOwnProperty.call(cfg, stringMatch[1])) {
      cfg[stringMatch[1]] = stringMatch[2];
    }
    const boolMatch = line.match(/^\s*([A-Za-z_]+)\s*=\s*(true|false)\b/);
    if (boolMatch && Object.prototype.hasOwnProperty.call(cfg, boolMatch[1])) {
      cfg[boolMatch[1]] = boolMatch[2] === 'true';
    }
  }
  return cfg;
}

function defaultOllamaModel() {
  const routeCfg = loadRouteConfig();
  return routeCfg.text_model || DEFAULT_OLLAMA_MODEL;
}

function forceImageCapabilityForRouteModel(catalog) {
  const routeCfg = loadRouteConfig();
  if (!routeCfg.auto_route_image) {
    return { changed: false, routeCfg };
  }
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  let changed = false;
  for (const model of models) {
    if (!model) continue;
    const modalities = Array.isArray(model.input_modalities) ? model.input_modalities : [];
    if (!modalities.includes('image')) {
      model.input_modalities = ['text', 'image'];
      changed = true;
    }
    if (model.supports_image_detail_original !== true) {
      model.supports_image_detail_original = true;
      changed = true;
    }
  }
  return { changed, routeCfg };
}

function splitTopLevel(text) {
  const match = text.match(/^\[[^\n]+\]/m);
  if (!match || match.index === undefined) return [text, ''];
  return [text.slice(0, match.index), text.slice(match.index)];
}

function replaceOrInsert(lines, key, value, comment = false) {
  const pattern = new RegExp(`^\\s*#?\\s*${escapeRegExp(key)}\\s*=`);
  const rendered = `${comment ? '# ' : ''}${key} = ${value}`;
  const index = lines.findIndex((line) => pattern.test(line));
  if (index >= 0) lines[index] = rendered;
  else lines.push(rendered);
  return lines;
}

function removeKey(lines, key) {
  const pattern = new RegExp(`^\\s*#?\\s*${escapeRegExp(key)}\\s*=`);
  return lines.filter((line) => !pattern.test(line));
}

function referenceTopLevelLine(key) {
  if (!exists(OLLAMA_REFERENCE)) return null;
  const [top] = splitTopLevel(readText(OLLAMA_REFERENCE));
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=.*$`, 'm');
  const match = top.match(pattern);
  return match ? match[0] : null;
}

function tableBlocks(text) {
  const blocks = {};
  let currentHeader = null;
  let currentLines = [];
  for (const line of text.split(/\n/)) {
    if (/^\[[^\n]+\]\s*$/.test(line)) {
      if (currentHeader !== null) blocks[currentHeader] = currentLines;
      currentHeader = line.trim();
      currentLines = [line];
    } else if (currentHeader !== null) {
      currentLines.push(line);
    }
  }
  if (currentHeader !== null) blocks[currentHeader] = currentLines;
  return Object.fromEntries(
    Object.entries(blocks).map(([header, lines]) => [header, lines.join('\n').replace(/\s+$/u, '')]),
  );
}

function insertionIndexForTables(lines) {
  const index = lines.findIndex((line) => /^\[(projects|features|mcp_servers)\b/.test(line));
  return index >= 0 ? index : lines.length;
}

function ensureTableKey(text, tableHeader, key, value) {
  const lines = text.split(/\n/);
  let blockStart = -1;
  let blockEnd = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === tableHeader) {
      blockStart = i;
      blockEnd = i + 1;
      while (blockEnd < lines.length && !/^\[[^\n]+\]\s*$/.test(lines[blockEnd])) {
        blockEnd += 1;
      }
      break;
    }
  }
  if (blockStart === -1) {
    const allLines = text.replace(/\s+$/u, '').split(/\n/);
    const insertAt = insertionIndexForTables(allLines);
    const before = allLines.slice(0, insertAt);
    const after = allLines.slice(insertAt);
    const combined = before.slice();
    if (combined.length) combined.push('');
    combined.push(tableHeader);
    combined.push(`${key} = ${value}`);
    if (after.length) {
      combined.push('');
      combined.push(...after);
    }
    return combined.join('\n').replace(/\s+$/u, '') + '\n';
  }
  const blockLines = lines.slice(blockStart + 1, blockEnd);
  const updatedBlockLines = replaceOrInsert(blockLines, key, value);
  const newLines = [...lines.slice(0, blockStart + 1), ...updatedBlockLines, ...lines.slice(blockEnd)];
  return newLines.join('\n');
}

function ensureReferenceTables(text, referenceText, wantedHeaders) {
  const existing = tableBlocks(text);
  const reference = tableBlocks(referenceText);
  const missing = wantedHeaders
    .filter((header) => reference[header] && !existing[header])
    .map((header) => reference[header]);
  if (!missing.length) return text;

  const lines = text.replace(/\n+$/u, '').split(/\n/);
  const insertAt = insertionIndexForTables(lines);
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  const inserted = [];
  for (const block of missing) {
    if (inserted.length) inserted.push('');
    inserted.push(...block.split(/\n/));
  }

  const combined = before.slice();
  if (combined.length && inserted.length) combined.push('');
  combined.push(...inserted);
  if (after.length) {
    combined.push('');
    combined.push(...after);
  }
  return combined.join('\n').replace(/\s+$/u, '') + '\n';
}

function referenceHeaders(referenceText) {
  const headers = Object.keys(tableBlocks(referenceText));
  return {
    storefrontHeaders: headers.filter((header) => header.startsWith(STOREFRONT_PLUGIN_PREFIX)),
    providerHeaders: headers.filter((header) => header === OLLAMA_PROVIDER_HEADER),
  };
}

function ensureStorefrontPluginTables(text) {
  if (!exists(OLLAMA_REFERENCE)) return text;
  const referenceText = readText(OLLAMA_REFERENCE);
  const { storefrontHeaders } = referenceHeaders(referenceText);
  return ensureReferenceTables(text, referenceText, storefrontHeaders);
}

function ensureOllamaProviderTable(text) {
  if (!exists(OLLAMA_REFERENCE)) {
    const blocks = tableBlocks(text);
    if (Object.prototype.hasOwnProperty.call(blocks, OLLAMA_PROVIDER_HEADER)) return text;
    return `${text.replace(/\s+$/u, '')}\n\n${OLLAMA_PROVIDER_HEADER}\nname = "Ollama"\nbase_url = "http://127.0.0.1:11434/v1/"\nwire_api = "responses"\nrequires_openai_auth = true\n`;
  }
  const referenceText = readText(OLLAMA_REFERENCE);
  const { providerHeaders } = referenceHeaders(referenceText);
  let result = ensureReferenceTables(text, referenceText, providerHeaders);
  return ensureTableKey(result, OLLAMA_PROVIDER_HEADER, 'requires_openai_auth', 'true');
}

function normalizeOllama(text, model) {
  const [top, rest] = splitTopLevel(text);
  let lines = top.replace(/\n+$/u, '').split(/\n/);
  lines = lines.filter((line) => line !== '# custom Ollama model disabled; using Codex built-in ChatGPT model');
  lines = removeKey(lines, 'developer_instructions');
  const instructionLine = referenceTopLevelLine('developer_instructions');
  if (instructionLine) lines.push(instructionLine);
  if (model) {
    lines = replaceOrInsert(lines, 'model', `"${model}"`);
  } else {
    lines = removeKey(lines, 'model');
  }
  lines = replaceOrInsert(lines, 'model_context_window', DEFAULT_CONTEXT_WINDOW);
  lines = replaceOrInsert(lines, 'model_auto_compact_token_limit', DEFAULT_AUTO_COMPACT);
  lines = replaceOrInsert(lines, 'model_provider', `"${PROVIDER_NAME}"`);
  lines = replaceOrInsert(lines, 'model_catalog_json', `"${MODEL_CATALOG}"`);
  let normalized = lines.join('\n').replace(/\s+$/u, '') + '\n\n' + rest.replace(/^\n+/u, '');
  normalized = ensureStorefrontPluginTables(normalized);
  normalized = ensureTableKey(normalized, '[features]', 'enable_mcp_apps', 'true');
  return ensureOllamaProviderTable(normalized);
}

function removeTable(text, header) {
  const lines = text.split(/\n/);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\[[^\n]+\]\s*$/.test(line)) skipping = line.trim() === header;
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function normalizeOpenAI(text) {
  const [top, rest] = splitTopLevel(text);
  let lines = top.replace(/\n+$/u, '').split(/\n/);
  lines = lines.filter((line) => line !== '# custom Ollama model disabled; using Codex built-in ChatGPT model');
  lines = removeKey(lines, 'model');
  lines = removeKey(lines, 'model_auto_compact_token_limit');
  lines = removeKey(lines, 'model_context_window');
  lines = removeKey(lines, 'model_provider');
  lines = removeKey(lines, 'model_catalog_json');
  lines = removeKey(lines, 'web_search');

  let normalized = lines.join('\n').replace(/\s+$/u, '') + '\n\n' + rest.replace(/^\n+/u, '');
  normalized = removeTable(normalized, OLLAMA_PROVIDER_HEADER);
  normalized = ensureTableKey(normalized, '[features]', 'enable_mcp_apps', 'true');
  return normalized.replace(/\s+$/u, '') + '\n';
}

function listMcpAndPluginTables(text) {
  const headers = Object.keys(tableBlocks(text));
  return {
    mcp: headers.filter((header) => header.startsWith('[mcp_servers.')),
    plugins: headers.filter((header) => header.startsWith('[plugins.')),
  };
}

function catalogEntry(modelSlug) {
  if (!exists(MODEL_CATALOG)) return null;
  try {
    const data = JSON.parse(readText(MODEL_CATALOG));
    const models = Array.isArray(data.models) ? data.models : [];
    return models.find((m) => m && (m.slug === modelSlug || m.display_name === modelSlug)) || null;
  } catch {
    return null;
  }
}

function currentStatus(text) {
  const [top] = splitTopLevel(text);
  const activeProvider = top.match(/^model_provider\s*=\s*"([^"]+)"/m);
  const activeModel = top.match(/^model\s*=\s*"([^"]+)"/m);
  const commentedProvider = top.match(/^#\s*model_provider\s*=/m);
  const mode = activeProvider ? 'ollama' : commentedProvider ? 'openai' : 'openai';
  const model = activeModel ? activeModel[1] : '(built-in/default)';
  const provider = activeProvider ? activeProvider[1] : '(built-in/default)';
  const blocks = tableBlocks(text);
  const storefrontTables = Object.keys(blocks).filter((header) => header.startsWith(STOREFRONT_PLUGIN_PREFIX));
  const hasOllamaProvider = Object.prototype.hasOwnProperty.call(blocks, OLLAMA_PROVIDER_HEADER);
  const featuresBlock = blocks['[features]'] || '';
  const appsMatch = featuresBlock.match(/^enable_mcp_apps\s*=\s*(true|false)\b/m);
  const appsEnabled = appsMatch ? appsMatch[1] === 'true' : false;
  const { mcp, plugins } = listMcpAndPluginTables(text);
  let catalogTools = '';
  if (mode === 'ollama') {
    const entry = catalogEntry(model) || {};
    const apt = entry.apply_patch_tool_type;
    catalogTools =
      `\ncatalog_tools=${apt === 'freeform' ? 'on' : 'off'} ` +
      `(apply_patch_tool_type=${valueForStatus(apt)}, ` +
      `supports_parallel_tool_calls=${valueForStatus(entry.supports_parallel_tool_calls)}, ` +
      `supports_search_tool=${valueForStatus(entry.supports_search_tool)}, ` +
      `shell_type=${valueForStatus(entry.shell_type)})`;
  }
  return [
    `mode=${mode}`,
    `model=${model}`,
    `model_provider=${provider}`,
    `storefront_builder_tables=${storefrontTables.length}`,
    `mcp_servers=${mcp.length}`,
    `plugins=${plugins.length}`,
    `ollama_provider_table=${hasOllamaProvider ? 'yes' : 'no'}`,
    `apps_enabled=${appsEnabled ? 'yes' : 'no'}`,
    `config=${CONFIG}${catalogTools}`,
  ].join('\n');
}

function canonicalToolValues() {
  if (exists(MODELS_CACHE)) {
    try {
      const data = JSON.parse(readText(MODELS_CACHE));
      const models = Array.isArray(data.models) ? data.models : [];
      const model = models.find((m) => m && m.apply_patch_tool_type === 'freeform');
      if (model) {
        return Object.fromEntries(
          TOOL_CAPABILITY_FIELDS.map((key) => [key, model[key] ?? HARDCODED_CANONICAL[key]]),
        );
      }
    } catch {
      // Fall back below.
    }
  }
  return { ...HARDCODED_CANONICAL };
}

function canonicalInstructionValuesFromCache(cacheData) {
  const models = cacheData && Array.isArray(cacheData.models) ? cacheData.models : [];
  const source = models.find((m) => m && (m.base_instructions || m.model_messages)) || null;
  if (!source) return {};
  const out = {};
  for (const key of FRESH_INSTRUCTION_FIELDS) {
    if (source[key] !== undefined) out[key] = JSON.parse(JSON.stringify(source[key]));
  }
  return out;
}

function canonicalInstructionValues() {
  if (!exists(MODELS_CACHE)) return {};
  try {
    return canonicalInstructionValuesFromCache(JSON.parse(readText(MODELS_CACHE)));
  } catch {
    return {};
  }
}

function applyFreshInstructionValues(catalog, instructionValues) {
  const models = catalog && Array.isArray(catalog.models) ? catalog.models : [];
  const keys = Object.keys(instructionValues || {});
  if (!models.length || !keys.length) return 0;
  let changed = 0;
  for (const model of models) {
    if (!model) continue;
    let modelChanged = false;
    for (const key of keys) {
      const next = instructionValues[key];
      if (JSON.stringify(model[key]) === JSON.stringify(next)) continue;
      model[key] = JSON.parse(JSON.stringify(next));
      modelChanged = true;
    }
    if (modelChanged) changed += 1;
  }
  return changed;
}

async function fetchJson(url, timeoutMs = 5000, body = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body,
      signal: controller.signal,
    });
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUpstreamModels() {
  const routeCfg = loadRouteConfig();
  const rawUrl = routeCfg.upstream_url || OLLAMA_BASE_URL + '/v1';
  let baseUrl = rawUrl.replace(/\/+$/u, '');
  if (!baseUrl.endsWith('/v1')) baseUrl += '/v1';
  const modelsUrl = baseUrl + '/models';
  const headers = {};
  if (routeCfg.upstream_api_key) headers['Authorization'] = 'Bearer ' + routeCfg.upstream_api_key;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(modelsUrl, { method: 'GET', headers, signal: controller.signal });
    if (!response.ok) return { models: [], error: 'HTTP ' + response.status };
    const data = await response.json();
    const models = Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : []);
    return { models, error: null };
  } catch (e) {
    return { models: [], error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function isOllamaUpstream() {
  const routeCfg = loadRouteConfig();
  const rawUrl = routeCfg.upstream_url || OLLAMA_BASE_URL + '/v1';
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return false;
  const pathname = url.pathname.replace(/\/+$/u, '');
  if (pathname !== '/v1') return false;
  // Probe /api/tags — Ollama-native endpoint
  const root = new URL(url.href);
  root.pathname = '/';
  const tagsUrl = new URL('api/tags', root).href;
  try {
    const res = await fetch(tagsUrl, { method: 'GET', signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    return data && Array.isArray(data.models);
  } catch {
    return false;
  }
}

async function probeOllamaVisionCapabilities(modelIds) {
  const routeCfg = loadRouteConfig();
  const rawUrl = routeCfg.upstream_url || OLLAMA_BASE_URL + '/v1';
  const url = new URL(rawUrl);
  const root = new URL(url.href);
  root.pathname = '/';
  const showUrl = new URL('api/show', root).href;
  const visionSet = new Set();
  await mapLimit(modelIds, OLLAMA_SHOW_CONCURRENCY, async (name) => {
    try {
      const res = await fetch(showUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      if (Array.isArray(data.capabilities) && data.capabilities.includes('vision')) {
        visionSet.add(name);
      }
    } catch {
      // Lookup failed — assume no vision
    }
  });
  return visionSet;
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

async function localOllamaModels() {
  const tags = (await fetchJson(`${OLLAMA_BASE_URL}/api/tags`)) || {};
  const out = {};
  const showNames = new Set();
  for (const m of Array.isArray(tags.models) ? tags.models : []) {
    const name = m.name || m.model;
    if (!name) continue;
    if (Array.isArray(m.capabilities)) out[name] = m.capabilities;
    else showNames.add(name);
  }
  if (exists(MODEL_CATALOG)) {
    let catalog = {};
    try {
      catalog = JSON.parse(readText(MODEL_CATALOG));
    } catch {
      catalog = {};
    }
    for (const entry of Array.isArray(catalog.models) ? catalog.models : []) {
      const slug = entry && entry.slug;
      if (slug && !Object.prototype.hasOwnProperty.call(out, slug)) showNames.add(slug);
    }
  }
  await mapLimit([...showNames], OLLAMA_SHOW_CONCURRENCY, async (name) => {
    const show = (await fetchJson(
      `${OLLAMA_BASE_URL}/api/show`,
      8000,
      JSON.stringify({ model: name }),
    )) || {};
    // A failed lookup means capabilities are unknown, not authoritatively empty.
    if (Array.isArray(show.capabilities)) out[name] = show.capabilities;
  });
  return out;
}

async function refreshCatalog() {
  ensureModelCatalog();
  let catalog = JSON.parse(readText(MODEL_CATALOG));
  let models = Array.isArray(catalog.models) ? catalog.models : catalog;
  if (!Array.isArray(models)) models = [];
  if (!catalog || Array.isArray(catalog)) catalog = { models };

  const canonical = canonicalToolValues();
  const freshInstructions = canonicalInstructionValues();
  const routeCfg = loadRouteConfig();

  // Always include the configured text_model and image_model from proxy-models.toml
  // even if the upstream endpoint doesn't return them.
  const suppliedModels = new Set();
  if (routeCfg.text_model) suppliedModels.add(routeCfg.text_model);
  if (routeCfg.image_model) suppliedModels.add(routeCfg.image_model);

  // Fetch model IDs from GET /v1/models
  const { models: upstreamModels, error: upstreamError } = await fetchUpstreamModels();
  const upstreamIds = new Set(
    upstreamModels.map((m) => m && (m.id || m.name || m.model)).filter(Boolean),
  );

  // Merge: all upstream IDs + supplied models (dedupe)
  const allKnownIds = new Set([...upstreamIds, ...suppliedModels]);

  // Detect Ollama and probe vision capabilities
  const isOllama = await isOllamaUpstream();
  let visionCapable = new Set();
  let local = {};
  if (isOllama) {
    // Probe /api/show for vision capabilities on all known models
    const allIds = [...allKnownIds];
    if (allIds.length > 0) {
      visionCapable = await probeOllamaVisionCapabilities(allIds);
    }
    // Also get tool capabilities from /api/show
    local = await localOllamaModels();
  }

  // The image_model is always vision-capable (it's the image routing target)
  if (routeCfg.image_model) visionCapable.add(routeCfg.image_model);

  const template = models.length ? JSON.parse(JSON.stringify(models[0])) : {};
  let changed = 0;
  let pruned = 0;

  // Prune models not in upstream OR supplied — keep only what's known
  models = models.filter((m) => {
    if (!m || !m.slug) return false;
    if (allKnownIds.has(m.slug) || allKnownIds.has(m.display_name)) return true;
    pruned += 1;
    return false;
  });

  // Patch capabilities for surviving models
  for (const m of models) {
    if (!m) continue;
    const before = Object.fromEntries(TOOL_CAPABILITY_FIELDS.map((key) => [key, m[key]]));
    const caps = local[m.slug] || local[m.display_name];
    m.apply_patch_tool_type = canonical.apply_patch_tool_type;
    m.supports_parallel_tool_calls = Array.isArray(caps)
      ? caps.includes('tools')
      : canonical.supports_parallel_tool_calls;
    m.supports_search_tool = canonical.supports_search_tool;
    m.shell_type = canonical.shell_type;
    m.web_search_tool_type = canonical.web_search_tool_type;
    m.use_responses_lite = canonical.use_responses_lite;

    // Ollama: use probed vision capability. Non-Ollama: text-only by default.
    // image_model is always vision-capable.
    const hasVision = isOllama
      ? visionCapable.has(m.slug) || visionCapable.has(m.display_name)
      : (m.slug === routeCfg.image_model || m.display_name === routeCfg.image_model);
    const newMods = hasVision ? ['text', 'image'] : ['text'];
    if (JSON.stringify(m.input_modalities) !== JSON.stringify(newMods)) m.input_modalities = newMods;
    if (m.supports_image_detail_original !== hasVision) m.supports_image_detail_original = hasVision;

    const after = Object.fromEntries(TOOL_CAPABILITY_FIELDS.map((key) => [key, m[key]]));
    if (JSON.stringify(before) !== JSON.stringify(after)) changed += 1;
  }

  // Add new models from upstream + supplied (dedupe against existing)
  const existingSlugs = new Set(models.map((m) => m && m.slug).filter(Boolean));
  const added = [];
  for (const id of allKnownIds) {
    if (existingSlugs.has(id)) continue;
    const entry = JSON.parse(JSON.stringify(template));
    entry.slug = id;
    entry.display_name = id;
    entry.description = isOllama ? 'Ollama local model' : 'Upstream model';
    entry.apply_patch_tool_type = canonical.apply_patch_tool_type;
    entry.supports_parallel_tool_calls = Array.isArray(local[id]) ? local[id].includes('tools') : canonical.supports_parallel_tool_calls;
    entry.supports_search_tool = canonical.supports_search_tool;
    entry.shell_type = canonical.shell_type;
    entry.web_search_tool_type = canonical.web_search_tool_type;
    entry.use_responses_lite = canonical.use_responses_lite;
    // Ollama: use probed vision. Non-Ollama: image_model is vision, rest text-only.
    const hasVision = isOllama
      ? visionCapable.has(id)
      : (id === routeCfg.image_model);
    entry.input_modalities = hasVision ? ['text', 'image'] : ['text'];
    entry.supports_image_detail_original = hasVision;
    models.push(entry);
    added.push(id);
    existingSlugs.add(id);
  }

  catalog.models = models;
  const instructionsPatched = applyFreshInstructionValues(catalog, freshInstructions);
  // Note: do NOT call forceImageCapabilityForRouteModel here. The catalog on disk
  // must contain TRUE capabilities (from Ollama probes or optimistic defaults).
  // The proxy's forceImageCapabilityForTextModel() will force ALL entries to
  // image-capable at startup, snapshotting the true vision set first.
  const backup = makeBackupOf(MODEL_CATALOG, 'refresh');
  // Write vision cache so the proxy can restore the true vision set on restart
  // even after it has forced all catalog entries to image-capable.
  try {
    fs.mkdirSync(path.dirname(VISION_CACHE), { recursive: true });
    writeText(VISION_CACHE, JSON.stringify({ models: [...visionCapable] }, null, 2) + '\n');
  } catch (e) {
    // Non-fatal: proxy falls back to reading catalog modalities
  }
  const renderedCatalog = JSON.stringify(catalog, null, 2) + '\n';
  writeText(MODEL_CATALOG, renderedCatalog);
  const catalogCopy = syncModelCatalogCopy(renderedCatalog);
  const lines = [
    `catalog=${MODEL_CATALOG}`,
    `catalog_copy=${catalogCopy || '(same as catalog)'}`,
    `backup=${backup}`,
    `canonical_source=${exists(MODELS_CACHE) ? 'models_cache.json' : 'hardcoded defaults'}`,
    `canonical=${pythonishDict(canonical)}`,
    `instructions_patched=${instructionsPatched}`,
    `models_patched=${changed}`,
    `models_pruned=${pruned}`,
    `models_added=${added.length}`,
    `catalog_source=${isOllama ? 'ollama /api/show (probed)' : 'GET /v1/models'}`,
    `vision_capable=${visionCapable.size}`,
    upstreamError ? `upstream_error=${upstreamError}` : null,
    `auto_route_image=${routeCfg.auto_route_image ? 'true' : 'false'}`,
  ];
  if (routeCfg.auto_route_image && routeCfg.text_model) {
    lines.push(`auto_route_text_model=${routeCfg.text_model}`);
  }
  if (added.length) lines.push(`added=${added.join(',')}`);
  const localNames = Object.keys(local).sort();
  if (isOllama) {
    lines.push(localNames.length ? `local_ollama_models=${localNames.join(',')}` : 'local_ollama_models=(unreachable; skipped sync)');
  } else {
    lines.push(`upstream_models=${upstreamIds.size > 0 ? [...upstreamIds].join(',') : '(none)'}`);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { mode: null, model: null, noModel: false, noBackup: false, noRefresh: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (['status', 'openai', 'ollama', 'refresh'].includes(arg) && !args.mode) args.mode = arg;
    else if (arg === '--model') args.model = argv[++i];
    else if (arg.startsWith('--model=')) args.model = arg.slice('--model='.length);
    else if (arg === '--no-model') args.noModel = true;
    else if (arg === '--no-backup') args.noBackup = true;
    else if (arg === '--no-refresh') args.noRefresh = true;
    else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.mode) throw new Error('missing mode: expected status, openai, ollama, or refresh');
  return args;
}

function printHelp() {
  console.log(`Usage: model_config.js {status,openai,ollama,refresh} [--model MODEL] [--no-backup] [--no-refresh]

Switch ~/.codex/config.toml between normal OpenAI and Ollama launch config.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const text = readText(CONFIG);
  if (args.mode === 'status') {
    console.log(currentStatus(text));
    return;
  }
  if (args.mode === 'refresh') {
    console.log(await refreshCatalog());
    return;
  }
  if (args.mode === 'openai') {
    const backup = args.noBackup ? null : makeBackup(args.mode);
    const newText = normalizeOpenAI(text);
    writeText(CONFIG, newText);
    console.log('switched=openai');
    if (backup) console.log(`backup=${backup}`);
    console.log(currentStatus(newText));
    return;
  }

  const catalogCreated = ensureModelCatalog();
  if (args.noRefresh) {
    const catalogCopy = syncModelCatalogCopy();
    console.log(`catalog_copy=${catalogCopy || '(same as catalog)'}`);
  } else {
    console.log(await refreshCatalog());
  }
  if (catalogCreated) console.log(`catalog_initialized=${MODEL_CATALOG}`);
  console.log('');

  const backup = args.noBackup ? null : makeBackup(args.mode);
  const modelArg = args.noModel ? null : (args.model || null);
  const newText = normalizeOllama(text, modelArg);
  writeText(CONFIG, newText);
  console.log(`switched=${args.mode}`);
  if (backup) console.log(`backup=${backup}`);
  console.log(currentStatus(newText));
}

function pythonishDict(obj) {
  const parts = Object.entries(obj).map(([key, value]) => `'${key}': ${pythonishValue(value)}`);
  return `{${parts.join(', ')}}`;
}

function pythonishValue(value) {
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return `'${value}'`;
  return String(value);
}

function valueForStatus(value) {
  if (value === undefined) return 'undefined';
  if (value === true) return 'true';
  if (value === false) return 'false';
  return String(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  FRESH_INSTRUCTION_FIELDS,
  OLLAMA_SHOW_CONCURRENCY,
  canonicalInstructionValuesFromCache,
  applyFreshInstructionValues,
  localOllamaModels,
  fetchUpstreamModels,
  isOllamaUpstream,
  probeOllamaVisionCapabilities,
  refreshCatalog,
  ensureTableKey,
  main,
};
