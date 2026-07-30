'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const WEBRTC_KEY = 'experimental_realtime_webrtc_call_base_url';
const SIDEBAND_KEY = 'experimental_realtime_ws_base_url';
const REALTIME_FEATURE = 'realtime_conversation';

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function tomlKeyPattern(key) {
  const escaped = escapeRegExp(key);
  return `(?:${escaped}|"${escaped}"|'${escaped}')`;
}

function assignmentKeyPattern(key) {
  return String(key)
    .split('.')
    .map(tomlKeyPattern)
    .join('\\s*\\.\\s*');
}

function topLevelEnd(lines) {
  const index = lines.findIndex((line) => /^\s*\[[^\]]+\]\s*(?:#.*)?$/u.test(line));
  return index < 0 ? lines.length : index;
}

function topLevelString(text, key) {
  const allLines = text.split(/\r?\n/u);
  const lines = allLines.slice(0, topLevelEnd(allLines));
  const assignment = new RegExp(`^\\s*${assignmentKeyPattern(key)}\\s*=`, 'u');
  const line = lines.find((candidate) => assignment.test(candidate));
  if (line === undefined) return { present: false, value: '' };
  const pattern = new RegExp(
    `^\\s*${assignmentKeyPattern(key)}\\s*=\\s*(?:"((?:\\\\.|[^"])*)"|'([^']*)')\\s*(?:#.*)?$`,
    'u',
  );
  const match = line.match(pattern);
  if (!match) {
    throw new Error(`Unsupported TOML value for ${key}; use a single-line quoted URL`);
  }
  if (match[2] !== undefined) return { present: true, value: match[2] };
  try {
    return { present: true, value: JSON.parse(`"${match[1]}"`) };
  } catch {
    throw new Error(`Unsupported TOML escape in ${key}; use a plain single-line URL`);
  }
}

function setTopLevelString(text, key, value) {
  const lines = text.split(/\r?\n/u);
  const end = topLevelEnd(lines);
  const pattern = new RegExp(`^\\s*${assignmentKeyPattern(key)}\\s*=`, 'u');
  const rendered = `${key} = ${JSON.stringify(String(value))}`;
  const index = lines.slice(0, end).findIndex((line) => pattern.test(line));
  if (index >= 0) {
    lines[index] = rendered;
  } else {
    let insertAt = end;
    while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt -= 1;
    lines.splice(insertAt, 0, rendered);
  }
  return lines.join('\n').replace(/\n*$/u, '\n');
}

function removeTopLevelKey(text, key) {
  const lines = text.split(/\r?\n/u);
  const end = topLevelEnd(lines);
  const pattern = new RegExp(`^\\s*${assignmentKeyPattern(key)}\\s*=`, 'u');
  return lines
    .filter((line, index) => index >= end || !pattern.test(line))
    .join('\n')
    .replace(/\n*$/u, '\n');
}

function tableRange(lines, header) {
  const pattern = new RegExp(
    `^\\s*\\[\\s*${tomlKeyPattern(header)}\\s*\\]\\s*(?:#.*)?$`,
    'u',
  );
  const start = lines.findIndex((line) => pattern.test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[[^\]]+\]\s*(?:#.*)?$/u.test(lines[end])) end += 1;
  return { start, end };
}

function tableBool(text, header, key) {
  const dotted = topLevelBool(text, `${header}.${key}`);
  if (dotted.present) return dotted;
  const lines = text.split(/\r?\n/u);
  const range = tableRange(lines, header);
  if (!range) return { present: false, value: false };
  const pattern = new RegExp(
    `^\\s*${assignmentKeyPattern(key)}\\s*=\\s*(true|false)\\b`,
    'u',
  );
  const match = lines.slice(range.start + 1, range.end)
    .map((line) => line.match(pattern))
    .find(Boolean);
  return match
    ? { present: true, value: match[1] === 'true' }
    : { present: false, value: false };
}

function topLevelBool(text, key) {
  const lines = text.split(/\r?\n/u);
  const end = topLevelEnd(lines);
  const pattern = new RegExp(
    `^\\s*${assignmentKeyPattern(key)}\\s*=\\s*(true|false)\\b`,
    'u',
  );
  const match = lines.slice(0, end).map((line) => line.match(pattern)).find(Boolean);
  return match
    ? { present: true, value: match[1] === 'true' }
    : { present: false, value: false };
}

function setTableBool(text, header, key, value) {
  const dottedKey = `${header}.${key}`;
  if (topLevelBool(text, dottedKey).present) {
    const lines = text.split(/\r?\n/u);
    const end = topLevelEnd(lines);
    const pattern = new RegExp(`^\\s*${assignmentKeyPattern(dottedKey)}\\s*=`, 'u');
    const index = lines.slice(0, end).findIndex((line) => pattern.test(line));
    lines[index] = lines[index].replace(
      /(=\s*)(?:true|false)\b/u,
      `$1${value ? 'true' : 'false'}`,
    );
    return lines.join('\n').replace(/\n*$/u, '\n');
  }
  const lines = text.split(/\r?\n/u);
  const range = tableRange(lines, header);
  if (!range) {
    while (lines.length && lines.at(-1).trim() === '') lines.pop();
    if (lines.length) lines.push('');
    lines.push(`[${header}]`, `${key} = ${value ? 'true' : 'false'}`, '');
    return lines.join('\n');
  }
  const pattern = new RegExp(`^\\s*${assignmentKeyPattern(key)}\\s*=`, 'u');
  const relative = lines.slice(range.start + 1, range.end)
    .findIndex((line) => pattern.test(line));
  if (relative >= 0) {
    const index = range.start + 1 + relative;
    lines[index] = lines[index].replace(
      /(=\s*)(?:true|false)\b/u,
      `$1${value ? 'true' : 'false'}`,
    );
  } else {
    let insertAt = range.end;
    while (insertAt > range.start + 1 && lines[insertAt - 1].trim() === '') insertAt -= 1;
    lines.splice(insertAt, 0, `${key} = ${value ? 'true' : 'false'}`);
  }
  return lines.join('\n').replace(/\n*$/u, '\n');
}

function removeTableKey(text, header, key) {
  const dottedKey = `${header}.${key}`;
  if (topLevelBool(text, dottedKey).present) {
    return removeTopLevelKey(text, dottedKey);
  }
  const lines = text.split(/\r?\n/u);
  const range = tableRange(lines, header);
  if (!range) return text;
  const pattern = new RegExp(`^\\s*${assignmentKeyPattern(key)}\\s*=`, 'u');
  return lines
    .filter((line, index) => index <= range.start || index >= range.end || !pattern.test(line))
    .join('\n')
    .replace(/\n*$/u, '\n');
}

function readText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function captureRestoreState(text) {
  const webrtc = topLevelString(text, WEBRTC_KEY);
  const sideband = topLevelString(text, SIDEBAND_KEY);
  const feature = tableBool(text, 'features', REALTIME_FEATURE);
  return {
    restore_realtime_webrtc_call_base_url_present: webrtc.present,
    restore_realtime_webrtc_call_base_url: webrtc.value,
    restore_realtime_ws_base_url_present: sideband.present,
    restore_realtime_ws_base_url: sideband.value,
    restore_realtime_conversation_present: feature.present,
    restore_realtime_conversation: feature.value,
  };
}

function capture(file) {
  return captureRestoreState(readText(file));
}

function enable(file, baseUrl, voiceState) {
  let text = readText(file);
  const restore = voiceState.voice_enabled
    ? {}
    : captureRestoreState(text);
  text = setTopLevelString(text, WEBRTC_KEY, baseUrl);
  text = setTopLevelString(text, SIDEBAND_KEY, baseUrl);
  text = setTableBool(text, 'features', REALTIME_FEATURE, true);
  writeText(file, text);
  return {
    ...restore,
    managed_realtime_base_url: baseUrl,
  };
}

function reapply(file, baseUrl, voiceState) {
  let text = readText(file);
  const previousManaged = voiceState.managed_realtime_base_url;
  for (const key of [WEBRTC_KEY, SIDEBAND_KEY]) {
    const current = topLevelString(text, key);
    if (!current.present || current.value === previousManaged) {
      text = setTopLevelString(text, key, baseUrl);
    }
  }
  const feature = tableBool(text, 'features', REALTIME_FEATURE);
  if (!feature.present || feature.value) {
    text = setTableBool(text, 'features', REALTIME_FEATURE, true);
  }
  writeText(file, text);
  return { managed_realtime_base_url: baseUrl };
}

function restoreKey(text, key, managedValue, present, value) {
  const current = topLevelString(text, key);
  if (!current.present || current.value !== managedValue) return text;
  return present
    ? setTopLevelString(text, key, value)
    : removeTopLevelKey(text, key);
}

function disable(file, voiceState) {
  let text = readText(file);
  text = restoreKey(
    text,
    WEBRTC_KEY,
    voiceState.managed_realtime_base_url,
    voiceState.restore_realtime_webrtc_call_base_url_present,
    voiceState.restore_realtime_webrtc_call_base_url,
  );
  text = restoreKey(
    text,
    SIDEBAND_KEY,
    voiceState.managed_realtime_base_url,
    voiceState.restore_realtime_ws_base_url_present,
    voiceState.restore_realtime_ws_base_url,
  );
  const feature = tableBool(text, 'features', REALTIME_FEATURE);
  if (feature.present && feature.value) {
    text = voiceState.restore_realtime_conversation_present
      ? setTableBool(
        text,
        'features',
        REALTIME_FEATURE,
        voiceState.restore_realtime_conversation,
      )
      : removeTableKey(text, 'features', REALTIME_FEATURE);
  }
  writeText(file, text);
  return {
    managed_realtime_base_url: '',
    restore_realtime_webrtc_call_base_url_present: false,
    restore_realtime_webrtc_call_base_url: '',
    restore_realtime_ws_base_url_present: false,
    restore_realtime_ws_base_url: '',
    restore_realtime_conversation_present: false,
    restore_realtime_conversation: false,
  };
}

module.exports = {
  SIDEBAND_KEY,
  WEBRTC_KEY,
  capture,
  disable,
  enable,
  reapply,
  topLevelString,
};
