'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const SOURCE = path.join(
  __dirname,
  '..',
  '..',
  'native',
  'macos-right-command-push-to-talk.swift',
);

function rightCommandPushToTalkEnabled(config, platform = process.platform) {
  return platform === 'darwin'
    && Boolean(config?.voice_enabled)
    && config?.interruption_mode === 'manual'
    && config?.interruption_key === 'right-command';
}

function buildHelper(runtimeDir, { compile = spawnSync, log = () => {} } = {}) {
  const binary = path.join(runtimeDir, 'right-command-push-to-talk');
  const sourceModified = fs.statSync(SOURCE).mtimeMs;
  const binaryModified = fs.existsSync(binary) ? fs.statSync(binary).mtimeMs : 0;
  if (binaryModified >= sourceModified) return binary;

  fs.mkdirSync(runtimeDir, { recursive: true });
  const temporary = `${binary}.${process.pid}.tmp`;
  const result = compile('/usr/bin/swiftc', [SOURCE, '-o', temporary], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
    log(`right-command push-to-talk build failed: ${result.error?.message || String(result.stderr || '').trim()}`);
    return null;
  }
  fs.renameSync(temporary, binary);
  fs.chmodSync(binary, 0o700);
  return binary;
}

function startMacosInterruptionKey({
  config,
  port,
  runtimeDir,
  platform = process.platform,
  compile,
  spawnProcess = spawn,
  log = () => {},
} = {}) {
  if (!rightCommandPushToTalkEnabled(config, platform)) return null;
  const binary = buildHelper(runtimeDir, { compile, log });
  if (!binary) return null;
  const child = spawnProcess(binary, [String(port)], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (chunk) => {
    const message = String(chunk).trim();
    if (message) log(`right-command push-to-talk: ${message}`);
  });
  child.once('error', (error) => {
    log(`right-command push-to-talk failed: ${error.message}`);
  });
  child.once('exit', (code, signal) => {
    if (code && code !== 0) {
      log(`right-command push-to-talk stopped: ${signal || `exit ${code}`}`);
    }
  });
  log('right-command push-to-talk monitor started');
  return child;
}

module.exports = {
  buildHelper,
  rightCommandPushToTalkEnabled,
  startMacosInterruptionKey,
};
