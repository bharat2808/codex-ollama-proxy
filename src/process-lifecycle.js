'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_PROXY_SCRIPTS = [
  path.resolve(__dirname, '..', 'bin', 'codex-universal-proxy'),
  path.resolve(__dirname, '..', 'bin', 'codex-ollama-proxy'),
];

function commandTokens(command) {
  const tokens = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s]+)/gu;
  for (const match of String(command || '').matchAll(pattern)) {
    tokens.push((match[1] ?? match[2] ?? match[3]).replace(/\\([\\"'])/gu, '$1'));
  }
  return tokens;
}

function isNodeExecutable(token) {
  return /^node(?:\.exe)?$/iu.test(path.basename(token || ''));
}

function canonicalPath(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value || '');
  }
}

function isVerifiedProxyCommand(command, expectedProxyScript = DEFAULT_PROXY_SCRIPTS) {
  const tokens = commandTokens(command);
  if (tokens.length < 2) return false;
  const expected = (Array.isArray(expectedProxyScript) ? expectedProxyScript : [expectedProxyScript])
    .map(canonicalPath);

  if (expected.includes(canonicalPath(tokens[0])) && tokens[1] === 'serve') return true;

  return tokens.length >= 3
    && isNodeExecutable(tokens[0])
    && expected.includes(canonicalPath(tokens[1]))
    && tokens[2] === 'serve';
}

function classifyProxyListeners(pids, commandForPid, expectedProxyScript = DEFAULT_PROXY_SCRIPTS) {
  const result = { verified: [], unverified: [] };
  for (const rawPid of pids) {
    const pid = String(rawPid);
    let command = '';
    try {
      command = String(commandForPid(pid) || '').trim();
    } catch {}
    const entry = { pid, command };
    (isVerifiedProxyCommand(command, expectedProxyScript) ? result.verified : result.unverified).push(entry);
  }
  return result;
}

function requireVerifiedProxyListeners(pids, commandForPid, expectedProxyScript = DEFAULT_PROXY_SCRIPTS) {
  const listeners = classifyProxyListeners(pids, commandForPid, expectedProxyScript);
  if (listeners.unverified.length > 0) {
    const details = listeners.unverified
      .map(({ pid, command }) => `PID ${pid}: ${command || '<command unavailable>'}`)
      .join('\n');
    throw new Error(`Refusing to stop unverified listener ${details}`);
  }
  return listeners.verified.map(({ pid }) => pid);
}

module.exports = {
  classifyProxyListeners,
  isVerifiedProxyCommand,
  requireVerifiedProxyListeners,
};
