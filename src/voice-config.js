'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULTS = {
  voice_enabled: false,
  interruption_mode: 'vad',
  interruption_key: 'right-command',
  routing_state: 'disabled',
  whisper_model: 'onnx-community/whisper-base.en',
  whisper_dtype: 'q8',
  whisper_device: 'cpu',
  kokoro_model: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  kokoro_voice: 'af_heart',
  kokoro_dtype: 'q8',
  kokoro_device: 'cpu',
  kokoro_speed: 1,
  managed_realtime_base_url: '',
  restore_realtime_webrtc_call_base_url_present: false,
  restore_realtime_webrtc_call_base_url: '',
  restore_realtime_ws_base_url_present: false,
  restore_realtime_ws_base_url: '',
  restore_realtime_conversation_present: false,
  restore_realtime_conversation: false,
};

const PUBLIC_FIELDS = [
  'voice_enabled',
  'interruption_mode',
  'interruption_key',
  'whisper_model',
  'whisper_dtype',
  'whisper_device',
  'kokoro_model',
  'kokoro_voice',
  'kokoro_dtype',
  'kokoro_device',
  'kokoro_speed',
];

const STRING_FIELDS = [
  'interruption_mode',
  'interruption_key',
  'whisper_model',
  'whisper_dtype',
  'whisper_device',
  'kokoro_model',
  'kokoro_voice',
  'kokoro_dtype',
  'kokoro_device',
  'routing_state',
  'managed_realtime_base_url',
  'restore_realtime_webrtc_call_base_url',
  'restore_realtime_ws_base_url',
];

const BOOL_FIELDS = [
  'voice_enabled',
  'restore_realtime_webrtc_call_base_url_present',
  'restore_realtime_ws_base_url_present',
  'restore_realtime_conversation_present',
  'restore_realtime_conversation',
];

function escapeTomlString(value) {
  return String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

function unescapeTomlString(value) {
  return String(value).replace(/\\"/gu, '"').replace(/\\\\/gu, '\\');
}

function readTomlString(text, key, fallback) {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"((?:\\\\.|[^"])*)"`, 'm'));
  return match ? unescapeTomlString(match[1]) : fallback;
}

function readTomlBool(text, key, fallback) {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(true|false)\\b`, 'm'));
  return match ? match[1] === 'true' : fallback;
}

function readTomlNumber(text, key, fallback) {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+))\\b`, 'm'));
  return match ? Number(match[1]) : fallback;
}

function normalize(raw = {}) {
  return { ...DEFAULTS, ...raw };
}

function render(raw = {}) {
  const config = normalize(raw);
  return [
    '# codex-universal-proxy local voice configuration',
    `voice_enabled = ${config.voice_enabled ? 'true' : 'false'}`,
    `interruption_mode = "${escapeTomlString(config.interruption_mode)}"`,
    `interruption_key = "${escapeTomlString(config.interruption_key)}"`,
    `whisper_model = "${escapeTomlString(config.whisper_model)}"`,
    `whisper_dtype = "${escapeTomlString(config.whisper_dtype)}"`,
    `whisper_device = "${escapeTomlString(config.whisper_device)}"`,
    `kokoro_model = "${escapeTomlString(config.kokoro_model)}"`,
    `kokoro_voice = "${escapeTomlString(config.kokoro_voice)}"`,
    `kokoro_dtype = "${escapeTomlString(config.kokoro_dtype)}"`,
    `kokoro_device = "${escapeTomlString(config.kokoro_device)}"`,
    `kokoro_speed = ${config.kokoro_speed}`,
    '',
    '# Managed routing state. Use the voice command instead of editing these fields.',
    `routing_state = "${escapeTomlString(config.routing_state)}"`,
    `managed_realtime_base_url = "${escapeTomlString(config.managed_realtime_base_url)}"`,
    `restore_realtime_webrtc_call_base_url_present = ${config.restore_realtime_webrtc_call_base_url_present ? 'true' : 'false'}`,
    `restore_realtime_webrtc_call_base_url = "${escapeTomlString(config.restore_realtime_webrtc_call_base_url)}"`,
    `restore_realtime_ws_base_url_present = ${config.restore_realtime_ws_base_url_present ? 'true' : 'false'}`,
    `restore_realtime_ws_base_url = "${escapeTomlString(config.restore_realtime_ws_base_url)}"`,
    `restore_realtime_conversation_present = ${config.restore_realtime_conversation_present ? 'true' : 'false'}`,
    `restore_realtime_conversation = ${config.restore_realtime_conversation ? 'true' : 'false'}`,
    '',
  ].join('\n');
}

function read(file) {
  if (!fs.existsSync(file)) return normalize();
  const text = fs.readFileSync(file, 'utf8');
  const values = {};
  for (const key of STRING_FIELDS) values[key] = readTomlString(text, key, DEFAULTS[key]);
  if (/\.bin$/iu.test(values.whisper_model)) values.whisper_model = DEFAULTS.whisper_model;
  for (const key of BOOL_FIELDS) values[key] = readTomlBool(text, key, DEFAULTS[key]);
  values.kokoro_speed = readTomlNumber(text, 'kokoro_speed', DEFAULTS.kokoro_speed);
  return normalize(values);
}

function write(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, render(values), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function ensure(file) {
  if (!fs.existsSync(file)) write(file, DEFAULTS);
  else fs.chmodSync(file, 0o600);
}

function update(file, values) {
  const next = normalize({ ...read(file), ...values });
  write(file, next);
  return next;
}

module.exports = {
  DEFAULTS,
  PUBLIC_FIELDS,
  ensure,
  read,
  render,
  update,
  write,
};
