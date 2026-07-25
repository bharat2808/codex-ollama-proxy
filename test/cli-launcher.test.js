'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function installWithState(state) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launchd-home-'));
  const codexHome = path.join(home, '.codex');
  const runtimeDir = path.join(codexHome, 'ollama-shape-proxy');
  const stubBin = path.join(home, 'bin');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(stubBin, { recursive: true });
  const launchctl = path.join(stubBin, 'launchctl');
  fs.writeFileSync(launchctl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (state) {
    fs.writeFileSync(path.join(runtimeDir, 'launcher-state.json'), JSON.stringify(state), 'utf8');
  }

  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
    'install',
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      HOME: home,
      CODEX_HOME: codexHome,
      CODEX_PROXY_PLATFORM: 'darwin',
      PATH: `${stubBin}:${process.env.PATH}`,
    }),
  });
  return {
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
    plist: path.join(home, 'Library', 'LaunchAgents', 'com.user.codex-ollama-shape-proxy.plist'),
    result,
  };
}

test('CLI install creates default launcher state and renders its proxy port', () => {
  const installed = installWithState(null);
  try {
    assert.equal(installed.result.status, 0, installed.result.stderr || installed.result.stdout);
    const plist = fs.readFileSync(installed.plist, 'utf8');
    assert.match(plist, /<key>PROXY_PORT<\/key>\s*<string>11436<\/string>/u);
    assert.doesNotMatch(plist, /undefined/u);
  } finally {
    installed.cleanup();
  }
});

test('CLI install renders saved custom port and dedupe overrides', () => {
  const installed = installWithState({
    version: 1,
    adaptor: 'none',
    proxy_port: 61234,
    dedupe_large_input: false,
    dedupe_min_chars: 777,
  });
  try {
    assert.equal(installed.result.status, 0, installed.result.stderr || installed.result.stdout);
    const plist = fs.readFileSync(installed.plist, 'utf8');
    assert.match(plist, /<key>PROXY_PORT<\/key>\s*<string>61234<\/string>/u);
    assert.match(plist, /<string>--no-dedupe-large-input<\/string>/u);
    assert.match(plist, /<string>--dedupe-min-chars<\/string>\s*<string>777<\/string>/u);
  } finally {
    installed.cleanup();
  }
});
