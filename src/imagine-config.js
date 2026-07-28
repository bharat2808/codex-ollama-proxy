'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  imagine_enabled: false,
  imagine_service: 'gemini',
  imagine_model: '',
  imagine_base_url: '',
  imagine_api_key: '',
  imagine_quality: 'fast',
  imagine_enhance: false,
  imagine_aspect_ratio: '1:1',
};

const STRING_FIELDS = ['imagine_service', 'imagine_model', 'imagine_base_url', 'imagine_api_key', 'imagine_quality', 'imagine_aspect_ratio'];
const BOOL_FIELDS = ['imagine_enabled', 'imagine_enhance'];
const FIELDS = [...BOOL_FIELDS.slice(0, 1), ...STRING_FIELDS.slice(0, 4), 'imagine_quality', 'imagine_enhance', 'imagine_aspect_ratio'];

function escapeTomlString(value) {
  return String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

function unescapeTomlString(value) {
  return String(value).replace(/\\"/gu, '"').replace(/\\\\/gu, '\\');
}

function readTomlString(text, key, fallback = '') {
  const match = text.match(new RegExp('^\\s*' + key + '\\s*=\\s*"((?:\\\\.|[^"])*)"', 'm'));
  return match ? unescapeTomlString(match[1]) : fallback;
}

function readTomlBool(text, key, fallback = false) {
  const match = text.match(new RegExp('^\\s*' + key + '\\s*=\\s*(true|false)\\b', 'm'));
  return match ? match[1] === 'true' : fallback;
}

function render(config) {
  return [
    '# codex-universal-proxy image generation config',
    `imagine_enabled = ${config.imagine_enabled ? 'true' : 'false'}`,
    `imagine_service = "${escapeTomlString(config.imagine_service)}"`,
    `imagine_model = "${escapeTomlString(config.imagine_model)}"`,
    `imagine_base_url = "${escapeTomlString(config.imagine_base_url)}"`,
    `imagine_api_key = "${escapeTomlString(config.imagine_api_key)}"`,
    `imagine_quality = "${escapeTomlString(config.imagine_quality)}"`,
    `imagine_enhance = ${config.imagine_enhance ? 'true' : 'false'}`,
    `imagine_aspect_ratio = "${escapeTomlString(config.imagine_aspect_ratio)}"`,
    '',
  ].join('\n');
}

function normalize(raw = {}) {
  return Object.assign({}, DEFAULTS, raw);
}

function read(file) {
  if (!fs.existsSync(file)) return normalize();
  const text = fs.readFileSync(file, 'utf8');
  return normalize({
    imagine_enabled: readTomlBool(text, 'imagine_enabled', DEFAULTS.imagine_enabled),
    imagine_service: readTomlString(text, 'imagine_service', DEFAULTS.imagine_service),
    imagine_model: readTomlString(text, 'imagine_model', DEFAULTS.imagine_model),
    imagine_base_url: readTomlString(text, 'imagine_base_url', DEFAULTS.imagine_base_url),
    imagine_api_key: readTomlString(text, 'imagine_api_key', DEFAULTS.imagine_api_key),
    imagine_quality: readTomlString(text, 'imagine_quality', DEFAULTS.imagine_quality),
    imagine_enhance: readTomlBool(text, 'imagine_enhance', DEFAULTS.imagine_enhance),
    imagine_aspect_ratio: readTomlString(text, 'imagine_aspect_ratio', DEFAULTS.imagine_aspect_ratio),
  });
}

function write(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, render(normalize(config)), 'utf8');
}

function ensure(file) {
  if (!fs.existsSync(file)) write(file, DEFAULTS);
}

function update(file, values) {
  const next = normalize(Object.assign(read(file), values));
  write(file, next);
  return next;
}

module.exports = {
  BOOL_FIELDS,
  DEFAULTS,
  FIELDS,
  STRING_FIELDS,
  ensure,
  read,
  render,
  update,
  write,
};
