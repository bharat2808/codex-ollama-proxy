'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const webSearch = require('./web-search');
const skillFind = require('./skill-find');
const imagine = require('./imagine');
const markers = require('./ui-markers');
const upstreamLib = require('./upstream');

// proxy-models.toml drives per-request model auto-routing.
// Loaded once at startup; editable without restart by re-running apply script.
const CODEX_DIR = process.env.CODEX_HOME || path.join(process.env.HOME, '.codex');
const RUNTIME_DIR = path.join(CODEX_DIR, 'ollama-shape-proxy');
const PROXY_MODELS_PATH = path.join(RUNTIME_DIR, 'proxy-models.toml');
const UPSTREAM_BODY_LOG = path.join(RUNTIME_DIR, 'upstream-bodies.jsonl');
const ROUTE_CFG = { text_model: null, image_model: null, auto_route_image: false, verbose_tools: false, log_upstream_body: false, enable_find_skill: false, stream_proxy_loop: true, upstream_url: upstreamLib.DEFAULT_UPSTREAM_URL, upstream_api_key: "", imagine_enabled: false, imagine_service: "gemini", imagine_model: "", imagine_api_key: "", imagine_quality: "fast", imagine_enhance: false, imagine_aspect_ratio: "1:1" };
function loadRouteConfig() {
  try {
    const raw = fs.readFileSync(PROXY_MODELS_PATH, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_]+)\s*=\s*"([^"]*)"/);
      if (m && m[1] in ROUTE_CFG) ROUTE_CFG[m[1]] = m[2];
      const b = line.match(/^\s*([A-Za-z_]+)\s*=\s*(true|false)\b/);
      if (b && b[1] in ROUTE_CFG) ROUTE_CFG[b[1]] = b[2] === 'true';
    }
  } catch (e) {
    // Missing file is fine; auto-routing just stays off.
  }
  if (process.env.PROXY_FIND_SKILL === '1') ROUTE_CFG.enable_find_skill = true;
  if (process.env.PROXY_FIND_SKILL === '0') ROUTE_CFG.enable_find_skill = false;
  if (process.env.PROXY_STREAM_LOOP === '1') ROUTE_CFG.stream_proxy_loop = true;
  if (process.env.PROXY_STREAM_LOOP === '0') ROUTE_CFG.stream_proxy_loop = false;
  log('route config: text=' + ROUTE_CFG.text_model + ' image=' + ROUTE_CFG.image_model + ' auto_route_image=' + ROUTE_CFG.auto_route_image + ' verbose_tools=' + ROUTE_CFG.verbose_tools + ' log_upstream_body=' + ROUTE_CFG.log_upstream_body + ' find_skill=' + ROUTE_CFG.enable_find_skill + ' stream_loop=' + ROUTE_CFG.stream_proxy_loop + ' upstream=' + upstreamLib.displayUrl(getUpstream()) + ' imagine=' + ROUTE_CFG.imagine_enabled + ' imagine_service=' + ROUTE_CFG.imagine_service);
}

function getUpstream() {
  return upstreamLib.createUpstream(process.env.PROXY_UPSTREAM_URL || ROUTE_CFG.upstream_url, process.env.PROXY_UPSTREAM_API_KEY || ROUTE_CFG.upstream_api_key);
}
loadRouteConfig();

// Catalog paths (resolved from the proxy dir's parent: ~/.codex).
const MODEL_CATALOG_PATHS = [
  path.join(CODEX_DIR, 'ollama-launch-models-ollama-working.json'),
  path.join(CODEX_DIR, 'ollama-launch-models.json'),
];

// When auto_route_image is on, force the text_model's catalog entry to claim
// image capability so Codex emits input_image blocks even when the active
// model (text_model) is really text-only. The proxy then rewrites the model
// to image_model per-request, so the text model never actually sees the image.
// Idempotent: only writes if the entry actually changed.
function forceImageCapabilityForTextModel() {
  if (!ROUTE_CFG.auto_route_image || !ROUTE_CFG.text_model) return;
  for (const catalogPath of MODEL_CATALOG_PATHS) {
    let raw;
    try {
      raw = fs.readFileSync(catalogPath, 'utf8');
    } catch (e) {
      log('force-image: catalog not found at ' + catalogPath + ', skipping');
      continue;
    }
    let changed = false;
    let catalog;
    try {
      catalog = JSON.parse(raw);
    } catch (e) {
      log('force-image: catalog parse failed at ' + catalogPath + ', skipping');
      continue;
    }
    const models = Array.isArray(catalog.models) ? catalog.models : [];
    for (const m of models) {
      if (m && (m.slug === ROUTE_CFG.text_model || m.display_name === ROUTE_CFG.text_model)) {
        const mods = Array.isArray(m.input_modalities) ? m.input_modalities : [];
        if (!mods.includes('image')) {
          m.input_modalities = ['text', 'image'];
          changed = true;
        }
        if (m.supports_image_detail_original !== true) {
          m.supports_image_detail_original = true;
          changed = true;
        }
        if (changed) {
          log('force-image: patched catalog entry "' + ROUTE_CFG.text_model + '" -> image-capable in ' + catalogPath + ' (auto_route_image=true)');
        }
        break;
      }
    }
    if (changed) {
      try {
        fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
        log('force-image: catalog written ' + catalogPath);
      } catch (e) {
        log('force-image: catalog write failed at ' + catalogPath + ': ' + e.message);
      }
    }
  }
}
forceImageCapabilityForTextModel();

const LISTEN_PORT = parseInt(process.env.PROXY_PORT || '11436', 10);

const TOOL_SEARCH = 'tool_search';
const WEB_SEARCH = 'web_search';
// Function-tool names the proxy self-fulfills inside the streaming loop. The
// model emits these as function_call items (rewritten from native managed tools
// so GLM/Ollama can call them); the proxy fulfills them locally and re-emits
// completed call+output items to the app instead of letting the app execute.
const FIND_SKILL_NAME = skillFind.FIND_SKILL;
const INTERCEPT_NAMES = new Set([WEB_SEARCH, FIND_SKILL_NAME, imagine.GENERATE_IMAGE, imagine.PROXY_STATUS]);
const MAX_STREAM_LOOPS = 6;

// Synthetic function-tool definition for web_search. The native tool arrives as
// type:"web_search" (a managed tool), which Ollama/GLM cannot reliably invoke.
// We rewrite it into a plain `function` tool with a schema so the model emits a
// callable function_call{name:"web_search"}. The proxy then fulfills that call
// (via the runResponsesLoop DDG/Ollama path) and, as a fallback, translates it to
// a native web_search_call for the app-server -- mirroring how tool_search works.
const WEB_SEARCH_FN = {
  type: 'function',
  name: WEB_SEARCH,
  description: 'Search the web for up-to-date information, or open a specific page to read its content. Use this for facts, current events, documentation, or anything you do not already know. With action "search" (default) returns results with title, url, and a content snippet; with action "open_page" it fetches and returns the readable text of a specific URL. Results are returned in the same shape regardless of backend.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['search', 'open_page'], description: '"search" to run a web query (default), or "open_page" to fetch the readable content of a specific URL.' },
      query: { type: 'string', description: 'The search query (required for action="search").' },
      url: { type: 'string', description: 'The page URL to fetch (required for action="open_page").' },
      max_results: { type: 'number', description: 'Maximum number of results to return for action="search" (1-10). Defaults to 5.' },
      start_index: { type: 'number', description: 'For action="open_page": character offset to start reading from (pagination). Defaults to 0.' },
      max_length: { type: 'number', description: 'For action="open_page": max characters of page text to return. Defaults to 8000.' },
    },
    required: [],
  },
};

const TOOL_SEARCH_FN = {
  type: 'function',
  name: TOOL_SEARCH,
  description: 'Search the available deferred Codex tools, plugin tools, MCP namespaces, and connectors by query. Use this when a needed tool is not already present in the current tool list. Returns matching tool definitions for a follow-up call.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query describing the tool or capability needed.' },
      limit: { type: 'number', description: 'Maximum number of matching tools to return. Defaults to 8.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

// Persistent (process-wide) map of flat tool name -> {namespace, name}.
// Populated from request tools (namespace entries) AND from tool_search_output
// items in the conversation input, so deferred MCP tools (which never appear in
// the request tools array) can still be split back into namespace + name.
const knownNamespaces = new Map();

function ingestNamespaces(tools) {
  if (!Array.isArray(tools)) return;
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'namespace' && t.name && Array.isArray(t.tools)) {
      for (const sub of t.tools) {
        if (sub && sub.name) knownNamespaces.set(t.name + '__' + sub.name, { namespace: t.name, name: sub.name, parameters: sub.parameters });
      }
    }
  }
}

function flattenNamespaceTool(namespace, tool) {
  if (!namespace || !tool || !tool.name) return null;
  return {
    type: 'function',
    name: namespace + '__' + tool.name,
    description: tool.description || '',
    strict: tool.strict === true,
    ...(tool.defer_loading !== undefined ? { defer_loading: tool.defer_loading } : {}),
    parameters: tool.parameters || {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  };
}

function flattenDiscoveredTools(tools) {
  const out = [];
  if (!Array.isArray(tools)) return out;
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'namespace' && t.name && Array.isArray(t.tools)) {
      for (const sub of t.tools) {
        const flat = flattenNamespaceTool(t.name, sub);
        if (flat) out.push(flat);
      }
    } else if (t.type === 'function' && t.name) {
      out.push(t);
    }
  }
  return out;
}

function log(...args) {
  process.stderr.write('[shape-proxy] ' + args.join(' ') + '\n');
}

function debugLog(...args) {
  if (ROUTE_CFG.verbose_tools) log(...args);
}

function verboseToolLog(label, value) {
  if (!ROUTE_CFG.verbose_tools) return;
  try {
    log('[verbose-tools] ' + label + ': ' + JSON.stringify(value));
  } catch (e) {
    log('[verbose-tools] ' + label + ': <unserializable: ' + e.message + '>');
  }
}

function logUpstreamBody(clientReq, body) {
  if (!ROUTE_CFG.log_upstream_body || !body || typeof body !== 'object') return;
  try {
    fs.appendFileSync(UPSTREAM_BODY_LOG, JSON.stringify({
      ts: new Date().toISOString(),
      method: clientReq.method,
      path: clientReq.url,
      body,
    }) + '\n');
    log('upstream body logged: ' + UPSTREAM_BODY_LOG);
  } catch (e) {
    log('upstream body log failed: ' + e.message);
  }
}

function asArgsString(v) {
  if (v == null) return '{}';
  if (typeof v === 'string') return v === '' ? '{}' : v;
  return JSON.stringify(v);
}
function asOutputString(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}
function customToolArgumentsForModel(name, input) {
  return JSON.stringify({ input: typeof input === 'string' ? input : asOutputString(input) });
}

function summarizeValueShape(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return { kind: 'array', length: value.length };
  if (typeof value === 'object') return { kind: 'object', keys: Object.keys(value).sort() };
  return { kind: typeof value, value: typeof value === 'string' ? value.slice(0, 80) : value };
}

function summarizeToolShape(tool) {
  const out = {};
  for (const [key, value] of Object.entries(tool || {})) out[key] = summarizeValueShape(value);
  return out;
}

// --- request-side (input items + tool defs): Codex -> Ollama ---

function translateInputItem(item) {
  if (!item || typeof item !== 'object') return item;
  switch (item.type) {
    case 'function_call': {
      verboseToolLog('request input function_call', item);
      // MCP/namespace tool calls arrive as function_call{namespace, name}.
      // Ollama only understands a flat function_call{name}, so join them.
      const ns = item.namespace;
      if (ns && ns !== '' && item.name) {
        const flat = ns + '__' + item.name;
        return {
          type: 'function_call',
          call_id: item.call_id,
          name: flat,
          arguments: asArgsString(item.arguments),
          ...(item.status ? { status: item.status } : {}),
          ...(item.id ? { id: item.id } : {}),
        };
      }
      return item; // built-in function tool: pass through unchanged
    }
    case 'tool_search_call': {
      verboseToolLog('request input tool_search_call', item);
      return {
        type: 'function_call',
        call_id: item.call_id,
        name: TOOL_SEARCH,
        arguments: asArgsString(item.arguments),
        ...(item.status ? { status: item.status } : {}),
        ...(item.id ? { id: item.id } : {}),
      };
    }
    case 'web_search_call': {
      verboseToolLog('request input web_search_call', item);
      return {
        type: 'function_call',
        call_id: item.call_id,
        name: WEB_SEARCH,
        arguments: asArgsString(item.arguments),
        ...(item.status ? { status: item.status } : {}),
        ...(item.id ? { id: item.id } : {}),
      };
    }
    case 'tool_search_output': {
      verboseToolLog('request input tool_search_output', item);
      // The model must invoke each surfaced tool by its FULL namespaced function
      // name:  <namespace>__<tool>  (e.g. mcp__storefront_builder__groceryio_bridge_manage).
      // glm tends to guess the bare tool name first and gets "unsupported call", so
      // append the exact callable names to the output it sees.
      const tools = item.tools;
      const callAs = [];
      if (Array.isArray(tools)) {
        for (const ns of tools) {
          if (ns && ns.type === 'namespace' && ns.name && Array.isArray(ns.tools)) {
            for (const sub of ns.tools) {
              if (sub && sub.name) callAs.push(ns.name + '__' + sub.name);
            }
          } else if (ns && ns.type === 'function' && ns.name) {
            callAs.push(ns.name);
          }
        }
      }
      let out = tools == null ? '[]' : JSON.stringify(tools);
      if (callAs.length) {
        out += '\n\nInvoke each tool by its exact name: ' + callAs.join(', ');
      }
      return {
        type: 'function_call_output',
        call_id: item.call_id,
        output: out,
        ...(item.id ? { id: item.id } : {}),
      };
    }
    case 'web_search_output': {
      verboseToolLog('request input web_search_output', item);
      return {
        type: 'function_call_output',
        call_id: item.call_id,
        output: asOutputString(item.output),
        ...(item.id ? { id: item.id } : {}),
      };
    }
    case 'image_generation_call': {
      verboseToolLog('request input image_generation_call', item);
      const bits = [];
      const status = item.status ? String(item.status) : '';
      if (status) bits.push('status=' + status);
      if (item.revised_prompt) bits.push('prompt=' + String(item.revised_prompt));
      if (item.saved_path) bits.push('saved_path=' + String(item.saved_path));
      if (item.result && !item.saved_path) bits.push('result=' + String(item.result).slice(0, 200));
      return {
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: '[image_generation_call] ' + (bits.length ? bits.join(' ') : 'completed'),
        }],
      };
    }
    case 'custom_tool_call': {
      verboseToolLog('request input custom_tool_call', item);
      return {
        type: 'function_call',
        call_id: item.call_id,
        name: item.name,
        arguments: customToolArgumentsForModel(item.name, item.input),
        ...(item.status ? { status: item.status } : {}),
        ...(item.id ? { id: item.id } : {}),
      };
    }
    case 'custom_tool_call_output': {
      verboseToolLog('request input custom_tool_call_output', item);
      return {
        type: 'function_call_output',
        call_id: item.call_id,
        output: asOutputString(item.output),
        ...(item.id ? { id: item.id } : {}),
      };
    }
    default:
      return item;
  }
}

// Build:
//   namespaceMap: flatName -> {namespace, name}  (from type:"namespace" tools)
//   customNames: Set<name>                       (from type:"custom" tools, e.g. apply_patch)
function collectCustomToolInfo(tools) {
  const customNames = new Set();
  if (!Array.isArray(tools)) return { customNames };
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'custom' && t.name) {
      customNames.add(t.name);
    }
  }
  return { customNames };
}

// Detect whether any input message carries actual image content.
// A historical view_image function_call is not enough by itself: after the app
// executes view_image, the follow-up turn may only need to summarize or return
// the generated image path. Routing those turns to the vision model has caused
// the stream to hang, so only route when image content is present.
function requestHasImage(body) {
  if (!body || !Array.isArray(body.input)) return false;
  for (const item of body.input) {
    if (!item || typeof item !== 'object') continue;
    const content = item.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && (
          block.type === 'input_image' ||
          block.type === 'output_image' ||
          block.type === 'image' ||
          block.image_url ||
          block.file_id
        )) return true;
      }
    }
    if (item.type === 'function_call_output' && Array.isArray(item.output)) {
      for (const block of item.output) {
        if (block && typeof block === 'object' && (
          block.type === 'input_image' ||
          block.type === 'output_image' ||
          block.type === 'image' ||
          block.image_url ||
          block.file_id
        )) return true;
      }
    }
  }
  return false;
}

// Apply per-request model routing based on the config + presence of an image.
function applyModelRouting(body) {
  if (!body || typeof body !== 'object') return body;
  const hasImage = requestHasImage(body);
  debugLog('auto-route: requestHasImage=' + hasImage + ' model="' + body.model + '" image_model="' + ROUTE_CFG.image_model + '"');
  if (hasImage) {
    if (body.model !== ROUTE_CFG.image_model) {
      debugLog('auto-route: request has image -> model "' + body.model + '" -> "' + ROUTE_CFG.image_model + '"');
      body.model = ROUTE_CFG.image_model;
    }
  } else if (ROUTE_CFG.text_model && body.model !== ROUTE_CFG.text_model) {
    debugLog('auto-route: text request -> model "' + body.model + '" -> "' + ROUTE_CFG.text_model + '"');
    body.model = ROUTE_CFG.text_model;
  }
  return body;
}

function translateRequestBody(body) {
  if (!body || typeof body !== 'object') return body;
  liftAdditionalToolsInput(body);
  // Learn namespace/tool splits from the request tools (upfront tools) and
  // from tool_search_output items (deferred tools surfaced by tool_search).
  if (Array.isArray(body.tools)) ingestNamespaces(body.tools);
  applyModelRouting(body);
  let inputChanged = false;
  const deferredTools = [];
  if (Array.isArray(body.input)) {
    const newInput = body.input.map((it) => {
      if (it && it.type === 'tool_search_output' && Array.isArray(it.tools)) {
        ingestNamespaces(it.tools);
        deferredTools.push(...flattenDiscoveredTools(it.tools));
      }
      const t = translateInputItem(it);
      if (t !== it) inputChanged = true;
      return t;
    });
    if (inputChanged) body.input = newInput;
  }
  {
    verboseToolLog('request tools', body.tools);
    const hasIncomingTools = Array.isArray(body.tools) && body.tools.length > 0;
    let toolsChanged = false;
    const mapped = [];
    for (const t of (Array.isArray(body.tools) ? body.tools : [])) {
      if (t && t.type === WEB_SEARCH) {
        debugLog('native web_search tool shape: ' + JSON.stringify(summarizeToolShape(t)) + ' -> function tool');
        toolsChanged = true;
        mapped.push(WEB_SEARCH_FN);
        continue;
      }
      if (t && t.type === TOOL_SEARCH) {
        debugLog('native tool_search tool shape: ' + JSON.stringify(summarizeToolShape(t)) + ' -> function tool');
        toolsChanged = true;
        mapped.push(TOOL_SEARCH_FN);
        continue;
      }
      if (t && t.type === 'namespace' && t.name && Array.isArray(t.tools)) {
        let count = 0;
        for (const sub of t.tools) {
          const flat = flattenNamespaceTool(t.name, sub);
          if (flat) {
            mapped.push(flat);
            count += 1;
          }
        }
        if (count > 0) {
          debugLog('flattened namespace tool definitions: ' + t.name + ' -> ' + count + ' function tools');
          toolsChanged = true;
          continue;
        }
      }
      mapped.push(t);
    }
    for (const t of deferredTools) {
      if (!mapped.some((existing) => existing && existing.type === 'function' && existing.name === t.name)) {
        mapped.push(t);
        toolsChanged = true;
      }
    }
    if (ROUTE_CFG.enable_find_skill && !mapped.some((t) => t && t.type === 'function' && t.name === skillFind.FIND_SKILL)) {
      mapped.push(skillFind.FIND_SKILL_FN);
      toolsChanged = true;
    }
    if (!mapped.some((t) => t && ((t.type === 'function' && t.name === TOOL_SEARCH) || t.type === TOOL_SEARCH))) {
      mapped.push(TOOL_SEARCH_FN);
      toolsChanged = true;
    }
    if (!mapped.some((t) => t && ((t.type === 'function' && t.name === WEB_SEARCH) || t.type === WEB_SEARCH))) {
      mapped.push(WEB_SEARCH_FN);
      toolsChanged = true;
    }
    if (ROUTE_CFG.imagine_enabled && !mapped.some((t) => t && t.type === 'function' && t.name === imagine.GENERATE_IMAGE)) {
      mapped.push(imagine.GENERATE_IMAGE_FN);
      toolsChanged = true;
    }
    if (!mapped.some((t) => t && t.type === 'function' && t.name === imagine.PROXY_STATUS)) {
      mapped.push(imagine.PROXY_STATUS_FN);
      toolsChanged = true;
    }
    if (toolsChanged) {
      body.tools = mapped;
      debugLog('rewrote request tools for Ollama-compatible function surface');
    }
  }
  if (inputChanged) debugLog('translated request input items');
  return body;
}

// Newer Codex app-server builds send turn-local tool definitions as an input
// item: {type:"additional_tools", role:"developer", tools:[...]}.
// Ollama-compatible /v1/responses endpoints do not accept that input item, but
// they do accept the same definitions in the top-level tools array. Lift them
// before the rest of the normal tool translation runs.
function liftAdditionalToolsInput(body) {
  if (!body || !Array.isArray(body.input)) return false;
  const lifted = [];
  const keptInput = [];
  let changed = false;

  for (const item of body.input) {
    if (item && item.type === 'additional_tools' && Array.isArray(item.tools)) {
      lifted.push(...item.tools);
      changed = true;
      const residual = {};
      if (item.role) residual.role = item.role;
      if (item.content !== undefined) residual.content = item.content;
      if (Object.keys(residual).length > 1 || residual.content !== undefined) {
        keptInput.push(residual);
      }
      continue;
    }
    keptInput.push(item);
  }

  if (!changed) return false;
  body.input = keptInput;
  if (lifted.length) {
    body.tools = Array.isArray(body.tools) ? [...body.tools, ...lifted] : lifted;
    debugLog('lifted additional_tools input item(s) into top-level tools: +' + lifted.length);
  }
  return true;
}

// --- response-side: Ollama -> Codex ---

function parseArgsObject(argsStr) {
  if (argsStr == null) return {};
  if (typeof argsStr !== 'string') return argsStr;
  const s = argsStr.trim();
  if (s === '') return {};
  try { return JSON.parse(s); } catch { return {}; }
}

function coerceArgsForSchema(args, schema) {
  if (!args || typeof args !== 'object' || !schema || typeof schema !== 'object') return args;
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  for (const [key, prop] of Object.entries(props)) {
    if (!(key in args) || !prop || typeof prop !== 'object') continue;
    const value = args[key];
    const types = Array.isArray(prop.type) ? prop.type : [prop.type];
    if ((types.includes('integer') || types.includes('number')) && typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) {
      args[key] = types.includes('integer') ? parseInt(value, 10) : Number(value);
    } else if (types.includes('boolean') && typeof value === 'string' && /^(true|false)$/i.test(value)) {
      args[key] = value.toLowerCase() === 'true';
    } else if (types.includes('object')) {
      coerceArgsForSchema(value, prop);
    } else if (types.includes('array') && Array.isArray(value) && prop.items) {
      for (const item of value) coerceArgsForSchema(item, prop.items);
    }
  }
  return args;
}

function customToolInput(name, args) {
  // Normalise a string argument first: the model may hand us the raw patch,
  // a JSON string, or a JSON object depending on how the freeform slot serialises.
  if (typeof args === 'string') {
    const trimmed = args.trim();
    // Raw patch passthrough: nothing to unwrap.
    if (name === 'apply_patch' && trimmed.startsWith('*** Begin Patch')) return args;
    try {
      args = JSON.parse(trimmed);
    } catch {
      // Not JSON; treat the literal string as the body.
      return args;
    }
  }

  if (args && typeof args === 'object') {
    // `command: ['apply_patch', '<patch>']` tuple form.
    if (Array.isArray(args.command) && args.command[0] === 'apply_patch' && typeof args.command[1] === 'string') {
      return args.command[1];
    }
    // Any string value in the object is treated as the patch body, regardless
    // of how the freeform slot was named (e.g. {"parameter1": "*** Begin Patch…"}).
    for (const v of Object.values(args)) {
      if (typeof v === 'string') return v;
    }
  }

  return asArgsString(args);
}

// state.rewrittenIds: item ids rewritten to a NON-function_call type
//   (tool_search_call / custom_tool_call) -> drop their fn_call arg deltas.
// state.namespaceMap / state.customNames: from the request tools.
function translateOutputItem(item, state) {
  if (!item || typeof item !== 'object') return item;
  if (
    item.type === 'function_call' ||
    item.type === 'tool_search_call' ||
    item.type === 'custom_tool_call' ||
    item.type === 'web_search_call'
  ) {
    const key = item.id || item.call_id || JSON.stringify([item.type, item.name, item.arguments]);
    if (!state.verboseLoggedToolCalls) state.verboseLoggedToolCalls = new Set();
    if (!state.verboseLoggedToolCalls.has(key)) {
      state.verboseLoggedToolCalls.add(key);
      verboseToolLog('response tool call item', item);
    }
  }
  if (item.type === 'function_call' && item.name === TOOL_SEARCH) {
    // glm serializes numeric args (e.g. limit) as strings; the app-server's
    // tool_search parser strictly types `limit` as usize and rejects strings,
    // which drops the tool_search output ("Tool search output is missing").
    // Coerce numeric-string fields back to numbers before handing to the app-server.
    const args = parseArgsObject(item.arguments);
    for (const k of ['limit']) {
      if (args[k] !== undefined && typeof args[k] === 'string' && /^-?\d+$/.test(args[k])) {
        args[k] = Number(args[k]);
      }
    }
    const out = {
      type: 'tool_search_call',
      execution: 'client',
      arguments: args,
    };
    if (item.call_id !== undefined) out.call_id = item.call_id;
    if (item.id) { out.id = item.id; state.rewrittenIds.add(item.id); }
    if (item.status) out.status = item.status;
    debugLog('response: function_call -> tool_search_call (call_id=' + item.call_id + ')');
    return out;
  }
  if (item.type === 'function_call' && item.name === WEB_SEARCH) {
    // Mirror the tool_search bridge: model emits function_call{web_search},
    // app-server expects a native web_search_call. Coerce numeric-string args
    // (max_results/limit) back to numbers for the strict parser, same as `limit`
    // is coerced for tool_search above.
    const args = parseArgsObject(item.arguments);
    for (const k of ['max_results', 'limit']) {
      if (args[k] !== undefined && typeof args[k] === 'string' && /^-?\d+$/.test(args[k])) {
        args[k] = Number(args[k]);
      }
    }
    const out = {
      type: 'web_search_call',
      execution: 'client',
      arguments: args,
    };
    if (item.call_id !== undefined) out.call_id = item.call_id;
    if (item.id) { out.id = item.id; state.rewrittenIds.add(item.id); }
    if (item.status) out.status = item.status;
    debugLog('response: function_call -> web_search_call (call_id=' + item.call_id + ')');
    return out;
  }
  if (item.type === 'function_call' && item.name === imagine.GENERATE_IMAGE) {
    // generate_image -> image_generation_call (native Codex server item type).
    // The proxy fulfills generate_image locally; this translation handles the
    // non-streaming path where the function_call appears in the final response.
    // Fields match ResponseItem::ImageGenerationCall in the Rust server:
    // id, status, revised_prompt, result, saved_path.
    let parsedOutput = {};
    try {
      // The output was fed back as function_call_output in the loop; we can't
      // access it here, so we build a minimal item from the call args.
    } catch {}
    const args = parseArgsObject(item.arguments);
    const out = {
      type: 'image_generation_call',
      status: 'completed',
    };
    if (item.call_id !== undefined) out.call_id = item.call_id;
    if (item.id) { out.id = item.id; state.rewrittenIds.add(item.id); }
    if (args.prompt) out.revised_prompt = args.prompt;
    debugLog('response: function_call -> image_generation_call (call_id=' + item.call_id + ')');
    return out;
  }
  if (item.type === 'function_call' && item.name === imagine.PROXY_STATUS) {
    // ollama_proxy_status is fulfilled silently; translate to a no-op item so the
    // app-server doesn't try to execute it as a pending function_call.
    const out = {
      type: 'function_call',
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments || '{}',
      status: 'completed',
    };
    if (item.id) { out.id = item.id; state.rewrittenIds.add(item.id); }
    debugLog('response: ollama_proxy_status function_call marked completed (call_id=' + item.call_id + ')');
    return out;
  }
  if (item.type === 'function_call' && item.name && state.customNames.has(item.name)) {
    // freeform/custom tool (apply_patch): function_call -> custom_tool_call
    const out = {
      type: 'custom_tool_call',
      call_id: item.call_id,
      name: item.name,
      input: customToolInput(item.name, item.arguments),
    };
    if (item.id) { out.id = item.id; state.rewrittenIds.add(item.id); }
    if (item.status) out.status = item.status;
    debugLog('response: function_call -> custom_tool_call (name=' + item.name + ' call_id=' + item.call_id + ')');
    return out;
  }
  if (item.type === 'function_call' && item.name && knownNamespaces.has(item.name)) {
    // MCP/namespace tool: Ollama flattened name -> split back into namespace + name.
    const info = knownNamespaces.get(item.name);
    const args = coerceArgsForSchema(parseArgsObject(item.arguments), info.parameters);
    const out = {
      type: 'function_call',
      namespace: info.namespace,
      name: info.name,
      call_id: item.call_id,
      arguments: asArgsString(args),
    };
    if (item.id) out.id = item.id;
    if (item.status) out.status = item.status;
    debugLog('response: function_call split -> namespace=' + info.namespace + ' name=' + info.name + ' (call_id=' + item.call_id + ')');
    return out;
  }
  return item;
}

const DROP = Symbol('drop');

function rewriteSseJson(obj, state) {
  if (!obj || typeof obj !== 'object') return obj;
  const t = obj.type || '';
  if (t === 'response.function_call_arguments.delta' || t === 'response.function_call_arguments.done') {
    if (obj.item_id && state.rewrittenIds.has(obj.item_id)) {
      debugLog('drop ' + t + ' for rewritten item ' + obj.item_id);
      return DROP;
    }
    return obj;
  }
  if (obj.item) {
    const newItem = translateOutputItem(obj.item, state);
    if (newItem !== obj.item) obj.item = newItem;
  }
  if (obj.response && Array.isArray(obj.response.output)) {
    obj.response.output = obj.response.output.map((it) => translateOutputItem(it, state));
  }
  return obj;
}

function processSseChunk(chunkBuf, clientRes, state) {
  let data = chunkBuf.toString('utf8');
  let idx;
  while ((idx = data.indexOf('\n\n')) !== -1) {
    const block = data.slice(0, idx);
    data = data.slice(idx + 2);
    const lines = block.split('\n');
    let dataLines = [];
    let eventLine = null;
    for (const line of lines) {
      if (line.startsWith('event:')) eventLine = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) {
      clientRes.write(block + '\n\n');
      continue;
    }
    const payloadStr = dataLines.join('\n');
    try {
      const obj = JSON.parse(payloadStr);
      const rewritten = rewriteSseJson(obj, state);
      if (rewritten === DROP) continue;
      const out = JSON.stringify(rewritten);
      const prefix = eventLine ? 'event: ' + eventLine + '\n' : '';
      clientRes.write(prefix + 'data: ' + out + '\n\n');
    } catch {
      const prefix = eventLine ? 'event: ' + eventLine + '\n' : '';
      clientRes.write(prefix + 'data: ' + payloadStr + '\n\n');
    }
  }
  return Buffer.from(data, 'utf8');
}

// --- streaming proxy loop: passthrough SSE with selective interception ---
//
// When the app streams a /v1/responses turn and the proxy must be able to
// self-fulfill `web_search` / `find_skill` (Ollama/GLM can only call them as
// plain function tools), the older non-streaming runResponsesLoop collapse
// buffers the whole turn and flushes only at the end, so the Codex UI shows
// nothing while the proxy works and then jumps to the final answer ("feels
// stuck"). Instead we stream the upstream SSE straight to the app and only
// intercept the tool calls we own: web_search / find_skill function_call items
// are suppressed from the stream, fulfilled locally, then re-emitted to the app
// as already-completed call + output pairs (rendered as finished tool chips
// without re-execution), and the turn is continued with a follow-up upstream
// request. Everything else (text deltas, reasoning, MCP/apply_patch calls, the
// native tool_search) passes through untouched and live.

function postUpstreamStream(upstream, body, signal) {
  return new Promise((resolve, reject) => {
    const url = upstreamLib.responsesUrl(upstream);
    const payload = JSON.stringify(body);
    const req = upstreamLib.transport(url).request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      method: 'POST',
      path: url.pathname + url.search,
      headers: Object.assign({
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        accept: 'text/event-stream',
      }, upstreamLib.authHeaders(upstream)),
      signal,
    }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        let buf = '';
        res.on('data', (c) => { buf += c.toString('utf8'); });
        res.on('end', () => reject(new Error('upstream ' + res.statusCode + ': ' + buf.slice(0, 500))));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function responseSnapshot(response) {
  if (!response || typeof response !== 'object') return {};
  const snapshot = Object.assign({}, response);
  delete snapshot.output;
  return snapshot;
}

function rememberResponse(streamState, response) {
  streamState.response = Object.assign({}, streamState.response, responseSnapshot(response));
}

function streamCanWrite(clientRes, streamState) {
  return !streamState.clientClosed && !streamState.terminalEvent && !clientRes.destroyed && !clientRes.writableEnded;
}

function ensureStreamLifecycle(clientRes, streamState, response) {
  if (!streamCanWrite(clientRes, streamState)) return false;
  rememberResponse(streamState, response);
  const base = Object.assign({}, streamState.response, { status: 'in_progress', output: [] });
  if (!base.id) base.id = streamState.id;
  if (!streamState.created) {
    markers.writeSseEvent(clientRes, 'response.created', { type: 'response.created', response: base });
    streamState.created = true;
  }
  if (!streamState.inProgress) {
    markers.writeSseEvent(clientRes, 'response.in_progress', { type: 'response.in_progress', response: base });
    streamState.inProgress = true;
  }
  return true;
}

function writeStreamTerminal(clientRes, streamState, type, event) {
  if (!streamCanWrite(clientRes, streamState)) return false;
  streamState.terminalEvent = type;
  markers.writeSseEvent(clientRes, type, event);
  clientRes.end();
  return true;
}

function completeStream(clientRes, streamState, sourceEvent, output) {
  ensureStreamLifecycle(clientRes, streamState, sourceEvent && sourceEvent.response);
  const response = Object.assign(
    {},
    streamState.response,
    responseSnapshot(sourceEvent && sourceEvent.response),
    { id: (sourceEvent && sourceEvent.response && sourceEvent.response.id) || streamState.response.id || streamState.id,
      status: 'completed',
      output }
  );
  delete response.error;
  delete response.incomplete_details;
  return writeStreamTerminal(clientRes, streamState, 'response.completed', {
    type: 'response.completed',
    response,
  });
}

function failStream(clientRes, streamState, message, sourceEvent, output) {
  const sourceResponse = sourceEvent && sourceEvent.response;
  rememberResponse(streamState, sourceResponse);
  ensureStreamLifecycle(clientRes, streamState, sourceResponse);
  const sourceError = (sourceResponse && sourceResponse.error) || (sourceEvent && sourceEvent.error) || {};
  const response = Object.assign({}, streamState.response, responseSnapshot(sourceResponse), {
    id: (sourceResponse && sourceResponse.id) || streamState.response.id || streamState.id,
    status: 'failed',
    output: output || [],
    error: {
      code: sourceError.code || 'proxy_stream_error',
      message: sourceError.message || message,
    },
  });
  return writeStreamTerminal(clientRes, streamState, 'response.failed', {
    type: 'response.failed',
    response,
  });
}

function outputKey(obj) {
  if (Number.isInteger(obj.output_index)) return 'index:' + obj.output_index;
  if (obj.item && obj.item.id) return 'id:' + obj.item.id;
  if (obj.item && obj.item.call_id) return 'call:' + obj.item.call_id;
  return null;
}

// Pipe one upstream SSE turn while buffering terminal transport markers. The
// caller owns the single downstream terminal event, including when the
// upstream uses [DONE] or EOF instead of response.completed.
function pipeAndCollect(upstreamRes, clientRes, streamState, customNames, interceptNames, outputIndexOffset, sequenceNumberOffset) {
  const state = { rewrittenIds: new Set(), customNames };
  const suppressed = new Set();          // item ids we are intercepting
  const pending = new Map();             // id -> { id, call_id, name, arguments }
  const interceptedCalls = [];
  const allOutputItems = [];
  const visibleOutputItems = [];
  const openOutputItems = new Map();
  const doneOutputKeys = new Set();
  let completedEvent = null;
  let failureEvent = null;
  let leftover = '';
  let maxOutputIndex = -1;
  let maxSequenceNumber = -1;

  return new Promise((resolve, reject) => {
    let settled = false;

    function nextSequenceNumber() {
      maxSequenceNumber = Math.max(maxSequenceNumber, (sequenceNumberOffset || 0) - 1) + 1;
      return maxSequenceNumber;
    }

    function addInterceptedCall(item) {
      if (!item || interceptedCalls.some((call) => call.call_id && call.call_id === item.call_id)) return;
      interceptedCalls.push({
        id: item.id,
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments || '',
        status: item.status || 'completed',
      });
    }

    function reconcileCompletedOutput(event) {
      const output = event && event.response && Array.isArray(event.response.output)
        ? event.response.output : [];
      for (let i = 0; i < output.length; i += 1) {
        const item = output[i];
        const outputIndex = (outputIndexOffset || 0) + i;
        const key = 'index:' + outputIndex;
        if (doneOutputKeys.has(key)) continue;
        const isIntercepted = item && item.type === 'function_call' && interceptNames.has(item.name);
        allOutputItems.push(item);
        doneOutputKeys.add(key);
        const open = openOutputItems.get(key);
        openOutputItems.delete(key);
        maxOutputIndex = Math.max(maxOutputIndex, outputIndex);
        if (isIntercepted) {
          addInterceptedCall(item);
          continue;
        }
        const rewritten = translateOutputItem(item, state);
        if (open) {
          markers.writeSseEvent(clientRes, 'response.output_item.done', {
            type: 'response.output_item.done',
            output_index: outputIndex,
            sequence_number: nextSequenceNumber(),
            item: rewritten,
          });
        } else {
          markers.writeSseEvent(clientRes, 'response.output_item.added', {
            type: 'response.output_item.added',
            output_index: outputIndex,
            sequence_number: nextSequenceNumber(),
            item: rewritten,
          });
          markers.writeSseEvent(clientRes, 'response.output_item.done', {
            type: 'response.output_item.done',
            output_index: outputIndex,
            sequence_number: nextSequenceNumber(),
            item: rewritten,
          });
        }
        visibleOutputItems.push(rewritten);
      }
    }

    function cleanup() {
      upstreamRes.removeListener('data', onData);
      upstreamRes.removeListener('end', onEnd);
      upstreamRes.removeListener('error', onError);
      upstreamRes.removeListener('aborted', onAborted);
    }

    function result(endedBy) {
      return {
        interceptedCalls,
        allOutputItems,
        visibleOutputItems,
        pendingOutputItems: [...openOutputItems.values()],
        completedEvent,
        failureEvent,
        endedBy,
        maxOutputIndex,
        maxSequenceNumber,
      };
    }

    function settle(endedBy) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result(endedBy));
      if (endedBy !== 'eof' && !upstreamRes.complete) {
        upstreamRes.on('error', () => {});
        upstreamRes.destroy();
      }
    }

    function onError(error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    function onAborted() {
      onError(new Error('upstream stream aborted before a terminal event'));
    }

    function processBlock(block) {
      if (settled) return false;
      const lines = block.split(/\r?\n/);
      let eventLine = null;
      const dataLines = [];
      for (const line of lines) {
        if (line.startsWith('event:')) eventLine = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) {
        if (block.trim() && streamCanWrite(clientRes, streamState)) clientRes.write(block + '\n\n');
        return true;
      }
      const payload = dataLines.join('\n');
      if (payload.trim() === '[DONE]') {
        settle('done');
        return false;
      }
      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        if (streamCanWrite(clientRes, streamState)) {
          const prefix = eventLine ? 'event: ' + eventLine + '\n' : '';
          clientRes.write(prefix + 'data: ' + payload + '\n\n');
        }
        return true;
      }
      if (Number.isInteger(obj.output_index)) obj.output_index += outputIndexOffset || 0;
      if (Number.isInteger(obj.sequence_number)) obj.sequence_number += sequenceNumberOffset || 0;
      const t = obj.type || eventLine || '';
      if (Number.isInteger(obj.output_index)) maxOutputIndex = Math.max(maxOutputIndex, obj.output_index);
      if (Number.isInteger(obj.sequence_number)) maxSequenceNumber = Math.max(maxSequenceNumber, obj.sequence_number);
      if (obj.response) rememberResponse(streamState, obj.response);

      if (t === 'response.created') {
        if (!streamState.created && streamCanWrite(clientRes, streamState)) {
          streamState.created = true;
          markers.writeSseEvent(clientRes, 'response.created', obj);
        }
        return true;
      }
      if (t === 'response.in_progress') {
        if (!streamState.created) ensureStreamLifecycle(clientRes, streamState, obj.response);
        if (!streamState.inProgress && streamCanWrite(clientRes, streamState)) {
          streamState.inProgress = true;
          markers.writeSseEvent(clientRes, 'response.in_progress', obj);
        }
        return true;
      }
      if (t === 'response.queued') return true;
      if (t === 'response.completed') {
        ensureStreamLifecycle(clientRes, streamState, obj.response);
        completedEvent = obj;
        reconcileCompletedOutput(obj);
        settle('completed');
        return false;
      }
      if (t === 'response.failed' || t === 'response.incomplete' || t === 'response.error' || t === 'error') {
        failureEvent = obj;
        settle('failed');
        return false;
      }

      ensureStreamLifecycle(clientRes, streamState, obj.response);
      const key = outputKey(obj);
      const isInterceptedItem = obj.item && obj.item.type === 'function_call' && interceptNames.has(obj.item.name);
      if (t === 'response.output_item.added' && key) {
        openOutputItems.set(key, { outputIndex: obj.output_index, item: obj.item, suppressed: isInterceptedItem });
      }
      if (t === 'response.output_item.done' && obj.item) {
        if (key && !doneOutputKeys.has(key)) {
          allOutputItems.push(obj.item);
          doneOutputKeys.add(key);
        }
        if (key) openOutputItems.delete(key);
      }

      // Intercept proxy-owned function_call items.
      if ((t === 'response.output_item.added' || t === 'response.output_item.done') && isInterceptedItem) {
        if (obj.item.id) suppressed.add(obj.item.id);
        if (t === 'response.output_item.added') {
          pending.set(obj.item.id || ('c' + interceptedCalls.length), {
            id: obj.item.id, call_id: obj.item.call_id, name: obj.item.name, arguments: obj.item.arguments || '',
          });
        } else {
          const pendingKey = obj.item.id || ('c' + interceptedCalls.length);
          const p = pending.get(pendingKey) || { id: obj.item.id, call_id: obj.item.call_id, name: obj.item.name, arguments: '' };
          const args = (obj.item.arguments !== undefined && obj.item.arguments !== '') ? obj.item.arguments : p.arguments;
          addInterceptedCall(Object.assign({}, obj.item, { arguments: args }));
          pending.delete(pendingKey);
        }
        return true;
      }

      // Drop argument deltas for suppressed items and retain them for the call.
      if ((t === 'response.function_call_arguments.delta' || t === 'response.function_call_arguments.done') &&
          obj.item_id && suppressed.has(obj.item_id)) {
        if (t === 'response.function_call_arguments.delta' && typeof obj.delta === 'string') {
          const p = pending.get(obj.item_id);
          if (p) p.arguments = (p.arguments || '') + obj.delta;
        }
        return true;
      }

      const rewritten = rewriteSseJson(obj, state);
      if (rewritten === DROP) return true;
      if (t === 'response.output_item.done' && rewritten.item) visibleOutputItems.push(rewritten.item);
      if (streamCanWrite(clientRes, streamState)) markers.writeSseEvent(clientRes, eventLine || t, rewritten);
      return true;
    }

    function processBufferedBlocks(final) {
      let match;
      while ((match = leftover.match(/\r?\n\r?\n/))) {
        const idx = match.index;
        const block = leftover.slice(0, idx);
        leftover = leftover.slice(idx + match[0].length);
        if (!processBlock(block)) return false;
      }
      if (final && leftover.trim()) {
        const block = leftover;
        leftover = '';
        return processBlock(block);
      }
      return true;
    }

    function onData(chunk) {
      leftover += chunk.toString('utf8');
      processBufferedBlocks(false);
    }

    function onEnd() {
      if (settled) return;
      processBufferedBlocks(true);
      if (!settled) settle('eof');
    }

    upstreamRes.on('error', onError);
    upstreamRes.on('aborted', onAborted);
    upstreamRes.on('data', onData);
    upstreamRes.on('end', onEnd);
  });
}


async function runStreamingLoop(upstream, body, clientRes, info, options) {
  const log = options.log || (() => {});
  const customNames = info.customNames || new Set();
  const interceptNames = options.interceptNames || INTERCEPT_NAMES;
  const seq = { index: 0, num: 0 };
  const completedItems = [];
  const streamState = {
    id: 'resp_proxy_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    response: {},
    created: false,
    inProgress: false,
    terminalEvent: null,
    clientClosed: false,
  };
  const abortController = new AbortController();
  let workBody = JSON.parse(JSON.stringify(body));
  workBody.stream = true;

  clientRes.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const onClientClose = () => {
    if (!clientRes.writableEnded) {
      streamState.clientClosed = true;
      abortController.abort();
    }
  };
  clientRes.on('close', onClientClose);

  try {
    const maxLoops = interceptNames.size > 0 ? MAX_STREAM_LOOPS : 1;
    for (let loop = 0; loop < maxLoops; loop += 1) {
      let result;
      try {
        const upstreamRes = await postUpstreamStream(upstream, workBody, abortController.signal);
        result = await pipeAndCollect(
          upstreamRes,
          clientRes,
          streamState,
          customNames,
          interceptNames,
          loop === 0 ? 0 : seq.index,
          loop === 0 ? 0 : seq.num
        );
      } catch (e) {
        if (streamState.clientClosed) return;
        log('streaming loop: upstream failed: ' + e.message);
        failStream(clientRes, streamState, 'proxy upstream failed: ' + e.message, null, completedItems);
        return;
      }

      seq.index = Math.max(seq.index, result.maxOutputIndex + 1);
      seq.num = Math.max(seq.num, result.maxSequenceNumber + 1);
      completedItems.push(...result.visibleOutputItems);

      if (result.failureEvent) {
        failStream(clientRes, streamState, 'upstream response failed', result.failureEvent, completedItems);
        return;
      }
      if (result.pendingOutputItems.length > 0) {
        failStream(clientRes, streamState, 'upstream stream ended before all output items were finalized', null, completedItems);
        return;
      }

      const calls = result.interceptedCalls;
      if (calls.length === 0) {
        if (!result.completedEvent && result.allOutputItems.length === 0) {
          failStream(clientRes, streamState, 'upstream stream ended before a complete response was available', null, completedItems);
          return;
        }
        completeStream(clientRes, streamState, result.completedEvent, completedItems);
        return;
      }

      debugLog('streaming loop: fulfilling ' + calls.length + ' intercepted call(s): ' + calls.map((c) => c.name).join(','));
      const outputs = [];
      for (const call of calls) {
        let outputStr = '';
        if (call.name === WEB_SEARCH) {
          const args = parseArgsObject(call.arguments);
          try {
            const search = await webSearch.searchWeb(args, debugLog);
            debugLog('web_search source: ' + (search.source || 'unknown'));
            outputStr = webSearch.formatSearchResult(search);
          } catch (err) {
            outputStr = '[web_search error]\n' + err.message;
          }
        } else if (call.name === imagine.GENERATE_IMAGE) {
       // Emit an in-progress marker immediately so the app-server can fire
       // the legacy ImageGenerationBegin event and the UI shows a placeholder.
       // Yield to the event loop so the SSE frame reaches the client before
       // the synchronous fulfillment runs and the completed marker follows.
          const startedMarker = markers.makeImageGenerationStartedMarker(call);
          const markerIndex = markers.emitOutputItemAdded(clientRes, startedMarker, seq);
          await new Promise((resolve) => setTimeout(resolve, 0));
          try {
            const r = await imagine.fulfillGenerateImage(call, upstream, ROUTE_CFG, debugLog);
            outputStr = r.output;
          } catch (err) {
            outputStr = '[generate_image error] ' + err.message;
          }
          const doneMarker = markers.makeImageGenerationMarker(call, outputStr);
          markers.emitOutputItemDoneAt(clientRes, doneMarker, markerIndex, seq);
          completedItems.push(doneMarker);
        } else if (call.name === imagine.PROXY_STATUS) {
          const r = imagine.fulfillProxyStatus(call, ROUTE_CFG, debugLog);
          outputStr = r.output;
        } else {
       // find_skill
          const r = skillFind.fulfillFindSkill(call, debugLog);
          outputStr = r.output;
        }
    // web_search -> web_search_call chip; generate_image -> image_generation_call chip;
    // find_skill / ollama_proxy_status -> no chip (fulfilled silently).
        const marker = markers.makeMarker(call, outputStr);
        if (marker && call.name !== imagine.GENERATE_IMAGE) {
          markers.emitOutputItem(clientRes, marker, seq);
          completedItems.push(marker);
        }
        outputs.push({ type: 'function_call_output', call_id: call.call_id, output: outputStr });
      }

      const prevOutput = result.completedEvent && result.completedEvent.response && Array.isArray(result.completedEvent.response.output)
        ? result.completedEvent.response.output : result.allOutputItems;
      workBody = Object.assign({}, workBody, { input: [...prevOutput, ...outputs], stream: true });
    }

    debugLog('streaming loop: exceeded ' + MAX_STREAM_LOOPS + ' iterations');
    failStream(clientRes, streamState, 'proxy exceeded the internal tool-call turn limit', null, completedItems);
  } catch (e) {
    if (!streamState.clientClosed) {
      log('streaming loop failed: ' + e.message);
      failStream(clientRes, streamState, 'proxy streaming loop failed: ' + e.message, null, completedItems);
    }
  } finally {
    clientRes.removeListener('close', onClientClose);
  }
}

function translateFinalResponse(response, info) {
  if (!response || typeof response !== 'object') return response;
  const state = { rewrittenIds: new Set(), customNames: info.customNames || new Set() };
  if (Array.isArray(response.output)) {
    response.output = response.output.map((it) => translateOutputItem(it, state));
  }
  return response;
}

function sendJsonResponse(clientRes, statusCode, response) {
  const payload = JSON.stringify(response);
  clientRes.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  clientRes.end(payload);
}

function sendSseCompleted(clientRes, response) {
  clientRes.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  let sequence = 0;
  const inProgress = Object.assign({}, response, { status: 'in_progress', output: [] });
  markers.writeSseEvent(clientRes, 'response.created', {
    type: 'response.created',
    response: inProgress,
  });
  markers.writeSseEvent(clientRes, 'response.in_progress', {
    type: 'response.in_progress',
    response: inProgress,
  });
  if (Array.isArray(response.output)) {
    response.output.forEach((item, outputIndex) => {
      clientRes.write('event: response.output_item.added\n');
      clientRes.write('data: ' + JSON.stringify({
        type: 'response.output_item.added',
        output_index: outputIndex,
        sequence_number: sequence++,
        item,
      }) + '\n\n');
      clientRes.write('event: response.output_item.done\n');
      clientRes.write('data: ' + JSON.stringify({
        type: 'response.output_item.done',
        output_index: outputIndex,
        sequence_number: sequence++,
        item,
      }) + '\n\n');
    });
  }
  const completed = { type: 'response.completed', response };
  clientRes.write('event: response.completed\n');
  clientRes.write('data: ' + JSON.stringify(completed) + '\n\n');
  clientRes.end();
}

const server = http.createServer((clientReq, clientRes) => {
  const isResponses = clientReq.method === 'POST' && clientReq.url.endsWith('/responses');
  const chunks = [];
  clientReq.on('data', (c) => chunks.push(c));
  clientReq.on('end', async () => {
    let bodyBuf = Buffer.concat(chunks);
    let info = { customNames: new Set() };
    let body = null;
    let originalStream = false;
    if (isResponses) {
      try {
        body = JSON.parse(bodyBuf.toString('utf8'));
        originalStream = body && body.stream === true;
        translateRequestBody(body);
        info = collectCustomToolInfo(body.tools);
        {
          const byType = {};
          const nsNames = [];
          if (Array.isArray(body.tools)) for (const t of body.tools) {
            const k = (t && t.type) || '?';
            byType[k] = (byType[k] || 0) + 1;
            if (t && t.type === 'namespace' && t.name) nsNames.push(t.name + '(' + (Array.isArray(t.tools) ? t.tools.length : 0) + ')');
          }
          debugLog('REQ tools: count=' + (Array.isArray(body.tools) ? body.tools.length : 0) + ' byType=' + JSON.stringify(byType) + ' ns=[' + nsNames.join(',') + '] custom=[' + [...info.customNames].join(',') + ']');
        }
        logUpstreamBody(clientReq, body);
        bodyBuf = Buffer.from(JSON.stringify(body), 'utf8');
      } catch (e) {
        log('request body parse/translate failed: ' + e.message + ' (passing through)');
      }
    }
    const upstream = getUpstream();
    if (isResponses && body && originalStream && ROUTE_CFG.stream_proxy_loop) {
      debugLog('streaming response lifecycle enabled');
      await runStreamingLoop(upstream, body, clientRes, info, {
        log: (...a) => log(...a),
        interceptNames: INTERCEPT_NAMES,
      });
      return;
    }
    if (isResponses && body && (webSearch.hasNativeWebSearchTool(body) || imagine.hasProxyStatusTool(body) || (ROUTE_CFG.imagine_enabled && imagine.hasGenerateImageTool(body)) || (ROUTE_CFG.enable_find_skill && skillFind.hasFindSkillTool(body)))) {
      if (!webSearch.hasNativeWebSearchTool(body) && (imagine.hasProxyStatusTool(body) || (ROUTE_CFG.imagine_enabled && imagine.hasGenerateImageTool(body)))) {
        try {
          debugLog('imagine proxy loop enabled (generate_image + ollama_proxy_status)');
          const result = await imagine.runGenerateImageLoop(upstream, body, ROUTE_CFG, { log: (...a) => debugLog(...a) });
          const response = result.response;
          translateFinalResponse(response, info);
          if (originalStream) sendSseCompleted(clientRes, response);
          else sendJsonResponse(clientRes, 200, response);
          return;
        } catch (e) {
          log('imagine proxy loop failed: ' + e.message);
          if (!clientRes.headersSent) {
            sendJsonResponse(clientRes, 502, {
              error: {
                message: 'proxy imagine failed: ' + e.message,
                type: 'proxy_imagine_error',
              },
            });
          } else {
            clientRes.end();
          }
          return;
        }
      }
      try {
        debugLog('native web_search proxy loop enabled');
        const result = await webSearch.runResponsesLoop({
          baseUrl: upstream.baseUrl,
          apiKey: upstream.apiKey,
        }, body, { log: (...args) => debugLog(...args), verboseTools: ROUTE_CFG.verbose_tools });
        const response = result.response;
        translateFinalResponse(response, info);
        if (!result.fulfilledWebSearch) {
          debugLog('native web_search proxy loop: no web_search call fulfilled; returning model response');
          if (originalStream) sendSseCompleted(clientRes, response);
          else sendJsonResponse(clientRes, 200, response);
          return;
        } else {
          if (originalStream) sendSseCompleted(clientRes, response);
          else sendJsonResponse(clientRes, 200, response);
          return;
        }
      } catch (e) {
        log('native web_search proxy loop failed: ' + e.message);
        if (webSearch.hasToolSearchTool(body)) {
          log('native web_search proxy loop failed with tool_search present; falling through to normal tool_search flow');
        } else {
          if (!clientRes.headersSent) {
            sendJsonResponse(clientRes, 502, {
              error: {
                message: 'proxy web_search failed: ' + e.message,
                type: 'proxy_web_search_error',
              },
            });
          } else {
            clientRes.end();
          }
          return;
        }
      }
    }
    if (isResponses && body && ROUTE_CFG.enable_find_skill && skillFind.hasFindSkillTool(body)) {
      try {
        debugLog('find_skill proxy loop enabled');
        const result = await skillFind.runFindSkillLoop(upstream, body, { log: (...a) => debugLog(...a) });
        const response = result.response;
        translateFinalResponse(response, info);
        if (originalStream) sendSseCompleted(clientRes, response);
        else sendJsonResponse(clientRes, 200, response);
        return;
      } catch (e) {
        log('find_skill proxy loop failed: ' + e.message);
        log('find_skill proxy loop failed; falling through to normal proxy flow');
      }
    }

    const targetUrl = upstreamLib.urlForClientPath(upstream, clientReq.url);
    const upstreamHeaders = Object.assign({}, clientReq.headers, upstreamLib.authHeaders(upstream));
    upstreamHeaders.host = targetUrl.host;
    upstreamHeaders['content-length'] = String(bodyBuf.length);
    const upstreamReq = upstreamLib.transport(targetUrl).request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || undefined,
      method: clientReq.method,
      path: targetUrl.pathname + targetUrl.search,
      headers: upstreamHeaders,
    }, (upstreamRes) => {
      if (isResponses && originalStream) {
        clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        const state = { rewrittenIds: new Set(), customNames: info.customNames };
        let leftover = Buffer.alloc(0);
        upstreamRes.on('data', (chunk) => {
          leftover = processSseChunk(Buffer.concat([leftover, chunk]), clientRes, state);
        });
        upstreamRes.on('end', () => {
          if (leftover.length) clientRes.write(leftover.toString('utf8'));
          clientRes.end();
        });
      } else if (isResponses) {
        const chunks = [];
        upstreamRes.on('data', (chunk) => chunks.push(chunk));
        upstreamRes.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            const response = JSON.parse(raw);
            translateFinalResponse(response, info);
            sendJsonResponse(clientRes, upstreamRes.statusCode || 200, response);
          } catch (e) {
            clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers);
            clientRes.end(raw);
          }
        });
      } else {
        clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      }
    });
    upstreamReq.on('error', (e) => {
      log('upstream error: ' + e.message);
      if (!clientRes.headersSent) clientRes.writeHead(502);
      clientRes.end('proxy upstream error: ' + e.message);
    });
    upstreamReq.write(bodyBuf);
    upstreamReq.end();
  });
  clientReq.on('error', (e) => log('client error: ' + e.message));
});

function startServer(port = LISTEN_PORT) {
  server.once('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
      log('port already in use: 127.0.0.1:' + port);
      log('Set PROXY_PORT to another port, or stop the existing proxy before starting this one.');
      process.exitCode = 1;
      return;
    }
    throw error;
  });
  server.listen(port, '127.0.0.1', () => {
    log('listening on 127.0.0.1:' + port + ' -> ' + upstreamLib.displayUrl(getUpstream()));
  });
  return server;
}

if (require.main === module || process.env.CODEX_OLLAMA_PROXY_AUTOSTART === '1') {
  startServer();
}

module.exports = {
  translateInputItem,
  translateRequestBody,
  getUpstream,
  startServer,
  server,
};
