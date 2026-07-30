'use strict';

// Single source of truth for every key the proxy reads from proxy-models.toml.
// proxy.js builds ROUTE_CFG from ALL_ROUTE_KEYS; presets.js validates/renders
// stored preset keys against PRESET_KEY_DEFS. Adding a new config toggle means
// adding one entry here (its toml key + type + default) plus the CLI flag that
// maps to it — the preset layer picks it up automatically, with no per-toggle
// surgery in renderPresetToml/normalizePreset/addPreset/applyPreset.

const upstreamLib = require('./upstream');

// Ordered definitions for every key the proxy reads from proxy-models.toml.
// `imagine: true` marks keys that live in imagine.toml and compose into the
// route separately — presets never store them.
const ROUTE_KEY_DEFS = [
  // Provider-identity block (first, so `preset show` reads naturally and the
  // stored preset mirrors the order of the runtime proxy-models.toml).
  { key: 'upstream_url', type: 'string', default: upstreamLib.DEFAULT_UPSTREAM_URL },
  { key: 'upstream_api_key', type: 'string', default: '' },
  { key: 'models', type: 'string-array', default: [] },
  { key: 'default_model', type: 'string', default: '' },
  { key: 'voice_model', type: 'string', default: '' },
  { key: 'image_model', type: 'string', default: '' },
  { key: 'auto_route_image', type: 'bool', default: false },
  { key: 'persist_inline_images', type: 'bool', default: true },
  { key: 'inline_image_retention_days', type: 'number', default: 30 },
  { key: 'dedupe_large_input', type: 'bool', default: false },
  { key: 'duplicate_input_min_chars', type: 'number', default: 512 },
  { key: 'verbose_tools', type: 'bool', default: false },
  { key: 'log_upstream_body', type: 'bool', default: false },
  { key: 'enable_find_skill', type: 'bool', default: false },
  { key: 'stream_proxy_loop', type: 'bool', default: true },
  { key: 'imagine_enabled', type: 'bool', default: false, imagine: true },
  { key: 'imagine_service', type: 'string', default: 'gemini', imagine: true },
  { key: 'imagine_model', type: 'string', default: '', imagine: true },
  { key: 'imagine_base_url', type: 'string', default: '', imagine: true },
  { key: 'imagine_api_key', type: 'string', default: '', imagine: true },
  { key: 'imagine_quality', type: 'string', default: 'fast', imagine: true },
  { key: 'imagine_enhance', type: 'bool', default: false, imagine: true },
  { key: 'imagine_aspect_ratio', type: 'string', default: '1:1', imagine: true },
];

// ROUTE_CFG shape the proxy mutates in place at load time (same keys/defaults
// as the old inline literal in proxy.js).
const ALL_ROUTE_KEYS = {};
for (const def of ROUTE_KEY_DEFS) ALL_ROUTE_KEYS[def.key] = def.default;

// Preset-scope keys: every non-imagine config value a preset may save.
const PRESET_KEY_DEFS = ROUTE_KEY_DEFS.filter((def) => !def.imagine);
const PRESET_KEYS = {};
for (const def of PRESET_KEY_DEFS) PRESET_KEYS[def.key] = def;

// key -> type lookup across all route keys.
const KEY_TYPES = {};
for (const def of ROUTE_KEY_DEFS) KEY_TYPES[def.key] = def.type;

// Required keys for a preset to be valid.
const REQUIRED_PRESET_KEYS = ['upstream_url', 'models', 'default_model'];

module.exports = {
  ROUTE_KEY_DEFS,
  ALL_ROUTE_KEYS,
  PRESET_KEY_DEFS,
  PRESET_KEYS,
  KEY_TYPES,
  REQUIRED_PRESET_KEYS,
};
