'use strict';

const fs = require('fs');
const path = require('path');

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

function readTomlString(text, key, fallback = '') {
  const match = text.match(new RegExp('^\\s*' + key + '\\s*=\\s*"((?:\\\\.|[^"])*)"', 'm'));
  return match ? unescapeTomlString(match[1]) : fallback;
}

function readTomlBool(text, key, fallback = false) {
  const match = text.match(new RegExp('^\\s*' + key + '\\s*=\\s*(true|false)\\b', 'm'));
  return match ? match[1] === 'true' : fallback;
}

function renderPresetToml(preset) {
  const lines = [
    '# codex-ollama-proxy preset',
    `adaptor = "${escapeTomlString(preset.adaptor)}"`,
    `upstream_url = "${escapeTomlString(preset.upstream_url)}"`,
  ];
  if (preset.upstream_api_key !== undefined) {
    lines.push(`upstream_api_key = "${escapeTomlString(preset.upstream_api_key)}"`);
  }
  lines.push(
    `text_model = "${escapeTomlString(preset.text_model)}"`,
    `image_model = "${escapeTomlString(preset.image_model)}"`,
    `auto_route_image = ${preset.auto_route_image ? 'true' : 'false'}`,
  );
  if (preset.imagine_enabled !== undefined) {
    lines.push(`imagine_enabled = ${preset.imagine_enabled ? 'true' : 'false'}`);
  }
  lines.push('');
  return lines.join('\n');
}

function normalizePreset(name, text) {
  const preset = {
    name,
    adaptor: readTomlString(text, 'adaptor'),
    upstream_url: readTomlString(text, 'upstream_url'),
    upstream_api_key: readTomlString(text, 'upstream_api_key', undefined),
    text_model: readTomlString(text, 'text_model'),
    image_model: readTomlString(text, 'image_model'),
    auto_route_image: readTomlBool(text, 'auto_route_image', false),
    imagine_enabled: readTomlBool(text, 'imagine_enabled', undefined),
  };
  if (!preset.adaptor || !preset.upstream_url || !preset.text_model) {
    die(`Error: preset ${name} is missing adaptor, upstream_url, or text_model.`);
  }
  if (!preset.image_model) preset.image_model = preset.text_model;
  if (preset.adaptor !== 'chat-completion') {
    die(`Error: preset ${name} uses unsupported adaptor "${preset.adaptor}".`);
  }
  return preset;
}

function readPreset(runtimeDir, name) {
  const file = presetPath(runtimeDir, name);
  if (!fs.existsSync(file)) die(`Error: preset not found: ${name}`);
  return normalizePreset(name, fs.readFileSync(file, 'utf8'));
}

function addPreset(runtimeDir, name, flags, log = console.log) {
  validatePresetName(name);
  if (!flags.adaptor) die('Error: preset add requires --adaptor chat-completion.');
  if (flags.adaptor !== 'chat-completion') die('Error: --adaptor must be "chat-completion".');
  if (!flags.url) die('Error: preset add requires --url URL.');
  if (!flags.textModel) die('Error: preset add requires --text-model MODEL.');
  if (flags.apiKey === '') {
    die('Error: --api-key was passed but empty. Check your shell variable with: echo ${NVIDIA_API_KEY:+set}');
  }
  try {
    const url = new URL(flags.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('must use http or https');
  } catch (err) {
    die('Error: --url must be an absolute http(s) URL. ' + err.message);
  }

  fs.mkdirSync(presetsDir(runtimeDir), { recursive: true });
  const preset = {
    adaptor: flags.adaptor,
    upstream_url: flags.url,
    ...(flags.apiKey !== undefined ? { upstream_api_key: flags.apiKey || '' } : {}),
    text_model: flags.textModel,
    image_model: flags.imageModel || flags.textModel,
    auto_route_image: Boolean(flags.autoImage) && !flags.noAutoImage,
    ...(flags.imagineEnable ? { imagine_enabled: true } : {}),
    ...(flags.imagineDisable ? { imagine_enabled: false } : {}),
  };
  const file = presetPath(runtimeDir, name);
  fs.writeFileSync(file, renderPresetToml(preset), 'utf8');
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
};
