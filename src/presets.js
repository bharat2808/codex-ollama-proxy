'use strict';

const fs = require('fs');
const path = require('path');
const schema = require('./route-config-schema');
const { resolveProviderProfile } = require('./provider-profiles');

function die(message) {
  const error = new Error(message);
  error.isCliError = true;
  throw error;
}

function presetsDir(runtimeDir) {
  return path.join(runtimeDir, 'presets');
}

function escapeTomlString(value) {
  return String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

function unescapeTomlString(value) {
  return String(value).replace(/\\"/gu, '"').replace(/\\\\/gu, '\\');
}

function validatePresetName(name) {
  if (!name || !/^[A-Za-z0-9._-]+$/u.test(name) || name === '.' || name === '..') {
    die('Error: preset name must contain only letters, numbers, dots, dashes, and underscores.');
  }
}

function presetPath(runtimeDir, name) {
  validatePresetName(name);
  return path.join(presetsDir(runtimeDir), name + '.toml');
}

// --- type-aware TOML readers (mirror proxy.js loadRouteConfig parsing) -----

function readTomlString(text, key, fallback = '') {
  const match = text.match(new RegExp('^\\s*' + key + '\\s*=\\s*"((?:\\\\.|[^"])*)"', 'm'));
  return match ? unescapeTomlString(match[1]) : fallback;
}

function readTomlBool(text, key, fallback = false) {
  const match = text.match(new RegExp('^\\s*' + key + '\\s*=\\s*(true|false)\\b', 'm'));
  return match ? match[1] === 'true' : fallback;
}

function readTomlNumber(text, key, fallback = 0) {
  const match = text.match(new RegExp('^\\s*' + key + '\\s*=\\s*(\\d+)\\b', 'm'));
  return match ? Number(match[1]) : fallback;
}
function readTomlStringArray(text, key, fallback = []) {
  const match = text.match(new RegExp('^\\s*' + key + '\\s*=\\s*\\[([^\\]]*)\\]', 'm'));
  if (!match) return fallback;
  return [...match[1].matchAll(/"((?:\\.|[^"])*)"/gu)].map((entry) => unescapeTomlString(entry[1]));
}

function readTomlKey(text, def) {
  if (def.type === 'bool') return readTomlBool(text, def.key, def.default);
  if (def.type === 'number') return readTomlNumber(text, def.key, def.default);
  if (def.type === 'string-array') return readTomlStringArray(text, def.key, def.default);
  return readTomlString(text, def.key, def.default);
}

function renderValue(def, value) {
  if (def.type === 'bool') return value ? 'true' : 'false';
  if (def.type === 'number') return String(Number(value) || 0);
  if (def.type === 'string-array') return `[${value.map((entry) => `"${escapeTomlString(entry)}"`).join(', ')}]`;
  return `"${escapeTomlString(value)}"`;
}

// A preset is a saved partial proxy-models.toml: a bag of the non-imagine
// ROUTE_CFG keys the user chose to pin, plus the special `adaptor` launcher
// field (none|chat-completion|google). Keys the preset does not store keep the
// template default at apply time — this is the single source of truth the
// proxy already reads, so new toggles become preset-able with no schema
// surgery here.

// Render the preset TOML. `adaptor` is always written first; then every stored
// config value in schema order. Required keys (upstream_url, default_model) are
// always present; image_model is always present (derived from default_model when
// not explicitly set), preserving the --model/--text-model shorthand.
function renderPresetToml(preset) {
  const lines = ['# codex-universal-proxy preset', `adaptor = "${escapeTomlString(preset.adaptor)}"`];
  for (const def of schema.PRESET_KEY_DEFS) {
    if (def.key in preset.values) {
      lines.push(`${def.key} = ${renderValue(def, preset.values[def.key])}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function normalizePreset(name, text) {
  const adaptor = readTomlString(text, 'adaptor', 'none');
  if (!['none', 'chat-completion', 'google'].includes(adaptor)) {
    die(`Error: preset ${name} uses unsupported adaptor "${adaptor}". Supported: "chat-completion", "google", or "none".`);
  }

  // Collect every top-level key declared in the preset file so we can validate
  // it against the known schema (catches typos'd/hand-edited presets early).
  const declared = new Set();
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_]+)\s*=/);
    if (m) declared.add(m[1]);
  }
  for (const key of declared) {
    if (key === 'adaptor') continue;
    if (!(key in schema.PRESET_KEYS)) {
      die(`Error: preset ${name} has unknown key "${key}". Valid keys: ${Object.keys(schema.PRESET_KEYS).join(', ')} (imagine_* keys are composed from imagine.toml, not stored in presets).`);
    }
  }

  const values = {};
  for (const def of schema.PRESET_KEY_DEFS) {
    // Only record keys the preset actually declares. This keeps the preset a
    // true partial config: undeclared keys fall back to the template default
    // at apply time rather than being pinned by the preset.
    if (!declared.has(def.key)) continue;
    values[def.key] = readTomlKey(text, def);
  }

  // Required fields.
  for (const key of schema.REQUIRED_PRESET_KEYS) {
    if (!(key in values) || values[key] === '' || values[key] == null
      || (Array.isArray(values[key]) && values[key].length === 0)) {
      die(`Error: preset ${name} is missing ${key}.`);
    }
  }
  // image_model is a derived shorthand: if not explicitly set, mirror
  // default_model so a single --model/--text-model is enough (matches `switch
  // ollama --model`). It is always present in the stored preset.
  if (!values.models.includes(values.default_model)) die(`Error: preset ${name} default_model must occur in models.`);
  if (values.image_model && !values.models.includes(values.image_model)) die(`Error: preset ${name} image_model must occur in models.`);
  // auto_route_image is a core identity field, always resolved by the preset
  // (false when absent) so a preset fully determines image routing — matching
  // addPreset, which always stores it.
  if (!('auto_route_image' in values)) values.auto_route_image = false;

  return { name, adaptor, values };
}

function readPreset(runtimeDir, name) {
  const file = presetPath(runtimeDir, name);
  if (!fs.existsSync(file)) die(`Error: preset not found: ${name}`);
  return normalizePreset(name, fs.readFileSync(file, 'utf8'));
}

// Map CLI flags -> preset config keys. Booleans use paired --flag/--no-flag
// forms; a toggle is only stored when one of the pair is passed (undeclared
// toggles keep the template default at apply time). Required keys (upstream_url,
// default_model) are always stored; image_model is always stored (derived).
function flagsToValues(flags) {
  const values = {};

  if (!flags.url) die('Error: preset add requires --url URL.');
  try {
    const url = new URL(flags.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('must use http or https');
  } catch (err) {
    die('Error: --url must be an absolute http(s) URL. ' + err.message);
  }
  values.upstream_url = flags.url;

  // --model is a shorthand that sets both default_model and image_model (mirrors
  // `switch ollama --model`). --text-model/--image-model override it per-field.
  const rawModels = flags.models || [
    flags.textModel,
    flags.imageModel,
  ].filter(Boolean).join(',');
  if (!rawModels) die('Error: preset add requires --models MODEL[,MODEL...].');
  const seen = new Set();
  values.models = String(rawModels).split(',').map((entry) => entry.trim()).filter((entry) => {
    if (!entry || seen.has(entry)) return false;
    seen.add(entry);
    return true;
  });
  if (!values.models.length) die('Error: --models must contain at least one model.');
  values.default_model = flags.defaultModel || values.models[0];
  values.image_model = flags.imageModel || (flags.textModel ? flags.textModel : '');
  if (!values.models.includes(values.default_model)) die('Error: --default-model must occur in --models.');
  if (values.image_model && !values.models.includes(values.image_model)) die('Error: --image-model must occur in --models.');

  if (flags.apiKey === '') {
    die('Error: --api-key was passed but empty. Check your shell variable with: echo ${NVIDIA_API_KEY:+set}');
  }
  if (flags.apiKey !== undefined) values.upstream_api_key = flags.apiKey || '';

  // auto_route_image is a core provider-identity field, always stored so a
  // preset fully determines image routing. It defaults to false (off) when
  // neither --auto-image nor --no-auto-image is given, preserving historical
  // behavior — the behavior toggles below remain true partial config (stored
  // only when their flag is passed, template-default otherwise).
  values.auto_route_image = Boolean(flags.autoImage) && !flags.noAutoImage;

  if (flags.persistImages) values.persist_inline_images = true;
  else if (flags.noPersistImages) values.persist_inline_images = false;
  if (flags.imageRetentionDays !== undefined) {
    const n = Number(flags.imageRetentionDays);
    if (!Number.isInteger(n) || n < 0) die('Error: --image-retention-days must be a non-negative integer.');
    values.inline_image_retention_days = n;
  }

  if (flags.dedupeLargeInput) values.dedupe_large_input = true;
  else if (flags.noDedupeLargeInput) values.dedupe_large_input = false;
  if (flags.dedupeMinChars !== undefined) {
    const n = Number(flags.dedupeMinChars);
    if (!Number.isInteger(n) || n < 0) die('Error: --dedupe-min-chars must be a non-negative integer.');
    values.duplicate_input_min_chars = n;
  }

  if (flags.verboseTools) values.verbose_tools = true;
  else if (flags.noVerboseTools) values.verbose_tools = false;
  if (flags.logUpstreamBody) values.log_upstream_body = true;
  else if (flags.noLogUpstreamBody) values.log_upstream_body = false;
  if (flags.enableFindSkill) values.enable_find_skill = true;
  else if (flags.noEnableFindSkill) values.enable_find_skill = false;
  if (flags.streamLoop) values.stream_proxy_loop = true;
  else if (flags.noStreamLoop) values.stream_proxy_loop = false;

  return values;
}

function addPreset(runtimeDir, name, flags, log = console.log) {
  validatePresetName(name);
  const resolved = resolveProviderProfile(flags);
  const adaptor = resolved.adaptor;
  if (!['none', 'chat-completion', 'google'].includes(adaptor)) {
    die('Error: --adaptor must be "chat-completion", "google", or "none".');
  }

  if (flags.vertexToken !== undefined && resolved.provider !== 'vertexai') {
    die('Error: --vertex-token can only be used with --provider vertexai.');
  }
  if (flags.vertexToken !== undefined && flags.apiKey !== undefined) {
    die('Error: use either --vertex-token or --api-key, not both.');
  }
  if (flags.vertexToken === '') {
    die('Error: --vertex-token was passed but empty.');
  }
  const values = flagsToValues({
    ...flags,
    url: resolved.url,
    apiKey: flags.vertexToken !== undefined ? flags.vertexToken : flags.apiKey,
  });

  fs.mkdirSync(presetsDir(runtimeDir), { recursive: true });
  const preset = { name, adaptor, values };
  const file = presetPath(runtimeDir, name);
  fs.writeFileSync(file, renderPresetToml(preset), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(file, 0o600);
  log(`preset=${name}`);
  log(`created=${file}`);
  log(`api_key=${flags.apiKey !== undefined && flags.apiKey ? 'stored' : 'not_stored'}`);
}

function listPresets(runtimeDir, log = console.log) {
  const dir = presetsDir(runtimeDir);
  if (!fs.existsSync(dir)) {
    log('(no presets)');
    return;
  }
  const names = fs.readdirSync(dir)
    .filter((entry) => entry.endsWith('.toml'))
    .map((entry) => entry.slice(0, -5))
    .sort();
  if (names.length === 0) log('(no presets)');
  else for (const name of names) log(name);
}

function showPreset(runtimeDir, name, log = console.log) {
  const file = presetPath(runtimeDir, name);
  if (!fs.existsSync(file)) die(`Error: preset not found: ${name}`);
  log(fs.readFileSync(file, 'utf8').trim());
}

module.exports = {
  addPreset,
  listPresets,
  presetPath,
  readPreset,
  renderPresetToml,
  showPreset,
  validatePresetName,
  normalizePreset,
  flagsToValues,
  PRESET_KEY_DEFS: schema.PRESET_KEY_DEFS,
};
