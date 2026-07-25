'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = 1;
const DEFAULT_PROXY_PORT = 11436;
const DEFAULT_ADAPTOR_PORT = 8787;
const ALLOWED_KEYS = new Set([
  'version',
  'adaptor',
  'proxy_port',
  'adaptor_port',
  'completion_model',
  'dedupe_large_input',
  'dedupe_min_chars',
]);

function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('launcher state must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) throw new Error(`unknown launcher state key "${key}"`);
  }
  if (input.version !== VERSION) throw new Error(`unsupported launcher state version "${input.version}"`);
  if (!['none', 'chat-completion', 'google'].includes(input.adaptor)) {
    throw new Error(`unsupported adaptor "${input.adaptor}" in launcher state`);
  }

  const proxyPort = input.proxy_port === undefined ? DEFAULT_PROXY_PORT : Number(input.proxy_port);
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    throw new Error('launcher state proxy_port must be an integer from 1 to 65535');
  }

  const state = { version: VERSION, adaptor: input.adaptor, proxy_port: proxyPort };
  if (state.adaptor === 'chat-completion' || state.adaptor === 'google') {
    const port = input.adaptor_port === undefined ? DEFAULT_ADAPTOR_PORT : Number(input.adaptor_port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('launcher state adaptor_port must be an integer from 1 to 65535');
    }
    state.adaptor_port = port;
    if (input.completion_model !== undefined) {
      if (typeof input.completion_model !== 'string' || input.completion_model.trim() === '') {
        throw new Error('launcher state completion_model must be a non-empty string');
      }
      state.completion_model = input.completion_model;
    }
  }
  if (input.dedupe_large_input !== undefined) {
    if (typeof input.dedupe_large_input !== 'boolean') {
      throw new Error('launcher state dedupe_large_input must be a boolean');
    }
    state.dedupe_large_input = input.dedupe_large_input;
  }
  if (input.dedupe_min_chars !== undefined) {
    const minimum = Number(input.dedupe_min_chars);
    if (!Number.isInteger(minimum) || minimum < 0) {
      throw new Error('launcher state dedupe_min_chars must be a non-negative integer');
    }
    state.dedupe_min_chars = minimum;
  }
  return state;
}

function read(file) {
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`invalid launcher state at ${file}: ${error.message}`);
  }
  return normalize(parsed);
}

function write(file, input) {
  const state = normalize(input);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }
  return state;
}

function serveArgs(input) {
  const state = normalize(input);
  const args = ['serve'];
  if (state.adaptor === 'chat-completion' || state.adaptor === 'google') {
    args.push('--adaptor', state.adaptor, '--adaptor-port', String(state.adaptor_port));
    if (state.completion_model) args.push('--completion-model', state.completion_model);
  }
  if (state.dedupe_large_input === true) args.push('--dedupe-large-input');
  if (state.dedupe_large_input === false) args.push('--no-dedupe-large-input');
  if (state.dedupe_min_chars !== undefined) args.push('--dedupe-min-chars', String(state.dedupe_min_chars));
  return args;
}

function fromPreset(preset, overrides = {}) {
  return normalize({
    version: VERSION,
    adaptor: preset && ['chat-completion', 'google'].includes(preset.adaptor) ? preset.adaptor : 'none',
    ...overrides,
  });
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function renderProgramArgumentsXml(input, nodePath, binPath) {
  return [nodePath, binPath, ...serveArgs(input)]
    .map((argument) => `    <string>${escapeXml(argument)}</string>`)
    .join('\n');
}

function systemdQuote(value) {
  return `"${String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

function renderSystemdUnit(input, nodePath, binPath, logPath, codexHome) {
  const state = normalize(input);
  const command = [nodePath, binPath, ...serveArgs(state)].map(systemdQuote).join(' ');
  const systemdLogPath = String(logPath).replace(/ /gu, '\\x20');
  return `[Unit]\nDescription=Codex Ollama Proxy\nAfter=network.target\n\n[Service]\nType=simple\nEnvironment=${systemdQuote(`CODEX_HOME=${codexHome}`)}\nEnvironment=PROXY_PORT=${state.proxy_port}\nExecStart=${command}\nRestart=always\nRestartSec=2\nStandardOutput=append:${systemdLogPath}\nStandardError=append:${systemdLogPath}\n\n[Install]\nWantedBy=default.target\n`;
}

function cmdQuote(value) {
  return `"${String(value).replace(/%/gu, '%%').replace(/"/gu, '""')}"`;
}

function renderWindowsCommand(input, nodePath, binPath, logPath, codexHome) {
  const state = normalize(input);
  const command = [nodePath, binPath, ...serveArgs(state)].map(cmdQuote).join(' ');
  return `@echo off\r\nset "CODEX_HOME=${String(codexHome).replace(/%/gu, '%%')}"\r\nset "PROXY_PORT=${state.proxy_port}"\r\n${command} >> ${cmdQuote(logPath)} 2>&1\r\n`;
}

function writeWhenListening(file, input, servers) {
  const state = normalize(input);
  return new Promise((resolve, reject) => {
    const pending = new Set(servers || []);
    const handlers = new Map();

    function cleanup() {
      for (const [server, handler] of handlers) {
        server.removeListener('listening', handler.listening);
        server.removeListener('error', handler.error);
      }
    }

    function commitIfReady() {
      if (pending.size !== 0) return;
      cleanup();
      try {
        resolve(write(file, state));
      } catch (error) {
        reject(error);
      }
    }

    for (const server of pending) {
      if (server && server.listening) {
        pending.delete(server);
        continue;
      }
      const handler = {
        listening: () => {
          pending.delete(server);
          commitIfReady();
        },
        error: (error) => {
          cleanup();
          reject(error);
        },
      };
      handlers.set(server, handler);
      server.once('listening', handler.listening);
      server.once('error', handler.error);
    }
    commitIfReady();
  });
}

module.exports = {
  DEFAULT_ADAPTOR_PORT,
  DEFAULT_PROXY_PORT,
  VERSION,
  escapeXml,
  fromPreset,
  normalize,
  read,
  renderProgramArgumentsXml,
  renderSystemdUnit,
  renderWindowsCommand,
  serveArgs,
  write,
  writeWhenListening,
};
