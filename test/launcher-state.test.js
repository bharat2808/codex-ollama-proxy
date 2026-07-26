'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const launcherState = require('../src/launcher-state');

test('normalizes direct and chat-completion launcher state', () => {
  assert.deepEqual(launcherState.normalize({ version: 1, adaptor: 'none' }), {
    version: 1,
    adaptor: 'none',
    proxy_port: 11436,
  });
  assert.deepEqual(launcherState.normalize({
    version: 1,
    adaptor: 'chat-completion',
    proxy_port: '9122',
    adaptor_port: '9123',
    completion_model: 'provider/model',
    dedupe_large_input: false,
    dedupe_min_chars: '0',
  }), {
    version: 1,
    adaptor: 'chat-completion',
    proxy_port: 9122,
    adaptor_port: 9123,
    completion_model: 'provider/model',
    dedupe_large_input: false,
    dedupe_min_chars: 0,
  });
});

test('rejects invalid, unknown, and secret launcher-state fields', () => {
  assert.throws(() => launcherState.normalize({ version: 1, adaptor: 'other' }), /unsupported adaptor/u);
  assert.throws(() => launcherState.normalize({ version: 1, adaptor: 'none', upstream_api_key: 'secret' }), /unknown launcher state key/u);
  assert.throws(() => launcherState.normalize({ version: 1, adaptor: 'none', proxy_port: 70000 }), /proxy_port/u);
  assert.throws(() => launcherState.normalize({ version: 1, adaptor: 'chat-completion', adaptor_port: 70000 }), /adaptor_port/u);
  assert.throws(() => launcherState.normalize({ version: 1, adaptor: 'none', dedupe_large_input: 'false' }), /dedupe_large_input/u);
  assert.throws(() => launcherState.normalize({ version: 1, adaptor: 'none', dedupe_min_chars: -1 }), /dedupe_min_chars/u);
});

test('writes launcher state atomically with private permissions and reads it back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launcher-state-'));
  const file = path.join(dir, 'launcher-state.json');
  try {
    launcherState.write(file, {
      version: 1,
      adaptor: 'chat-completion',
      adaptor_port: 8787,
      completion_model: 'override-model',
    });
    assert.deepEqual(launcherState.read(file), {
      version: 1,
      adaptor: 'chat-completion',
      proxy_port: 11436,
      adaptor_port: 8787,
      completion_model: 'override-model',
    });
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    else assert.equal(fs.existsSync(file), true);
    assert.deepEqual(fs.readdirSync(dir), ['launcher-state.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renders only non-secret serve arguments needed to restore the launcher', () => {
  assert.deepEqual(launcherState.serveArgs({ version: 1, adaptor: 'none' }), ['serve']);
  assert.deepEqual(launcherState.serveArgs({
    version: 1,
    adaptor: 'chat-completion',
    adaptor_port: 9123,
    completion_model: 'provider/model',
  }), [
    'serve',
    '--adaptor', 'chat-completion',
    '--adaptor-port', '9123',
    '--completion-model', 'provider/model',
  ]);
  assert.deepEqual(launcherState.serveArgs({
    version: 1,
    adaptor: 'none',
    dedupe_large_input: false,
    dedupe_min_chars: 777,
  }), [
    'serve',
    '--no-dedupe-large-input',
    '--dedupe-min-chars', '777',
  ]);
});

test('derives migration state from an active preset without copying route values', () => {
  assert.deepEqual(launcherState.fromPreset({ adaptor: 'none', values: { upstream_api_key: 'secret' } }), {
    version: 1,
    adaptor: 'none',
    proxy_port: 11436,
  });
  assert.deepEqual(launcherState.fromPreset({ adaptor: 'chat-completion', values: { default_model: 'text', upstream_api_key: 'secret' } }), {
    version: 1,
    adaptor: 'chat-completion',
    proxy_port: 11436,
    adaptor_port: 8787,
  });
});

test('renders XML-safe launchd program arguments from launcher state', () => {
  assert.equal(
    launcherState.renderProgramArgumentsXml(
      { version: 1, adaptor: 'chat-completion', adaptor_port: 9123, completion_model: 'provider&model' },
      '/path/to/node',
      '/path/to/codex-ollama-proxy',
    ),
    [
      '    <string>/path/to/node</string>',
      '    <string>/path/to/codex-ollama-proxy</string>',
      '    <string>serve</string>',
      '    <string>--adaptor</string>',
      '    <string>chat-completion</string>',
      '    <string>--adaptor-port</string>',
      '    <string>9123</string>',
      '    <string>--completion-model</string>',
      '    <string>provider&amp;model</string>',
    ].join('\n'),
  );
});

test('renders a systemd user unit with restart policy, port, logs, and saved arguments', () => {
  const unit = launcherState.renderSystemdUnit({
    version: 1,
    adaptor: 'chat-completion',
    proxy_port: 61234,
    adaptor_port: 8877,
  }, '/usr/bin/node', '/opt/codex proxy/bin/codex-ollama-proxy', '/tmp/proxy.log', '/home/me/Codex Files');

  assert.match(unit, /^\[Unit\]/u);
  assert.match(unit, /Environment=PROXY_PORT=61234/u);
  assert.match(unit, /Environment="CODEX_HOME=\/home\/me\/Codex Files"/u);
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/opt\/codex proxy\/bin\/codex-ollama-proxy" "serve" "--adaptor" "chat-completion"/u);
  assert.match(unit, /Restart=always/u);
  assert.match(unit, /StandardOutput=append:\/tmp\/proxy.log/u);
  assert.match(unit, /WantedBy=default.target/u);
});

test('renders a Windows startup command with environment, logs, and saved arguments', () => {
  const command = launcherState.renderWindowsCommand({
    version: 1,
    adaptor: 'none',
    proxy_port: 61234,
    dedupe_large_input: true,
  }, 'C:\\Program Files\\nodejs\\node.exe', 'C:\\proxy app\\bin\\codex-ollama-proxy', 'C:\\proxy app\\proxy.log', 'C:\\Users\\Me\\Codex Files');

  assert.match(command, /^@echo off\r\n/u);
  assert.match(command, /set "PROXY_PORT=61234"/u);
  assert.match(command, /set "CODEX_HOME=C:\\Users\\Me\\Codex Files"/u);
  assert.match(command, /"C:\\Program Files\\nodejs\\node.exe" "C:\\proxy app\\bin\\codex-ollama-proxy" "serve" "--dedupe-large-input"/u);
  assert.match(command, />> "C:\\proxy app\\proxy.log" 2>&1/u);
});

test('commits launcher state only after every server is listening', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launcher-listening-'));
  const file = path.join(dir, 'launcher-state.json');
  const proxy = new EventEmitter();
  const adaptor = new EventEmitter();
  try {
    const committed = launcherState.writeWhenListening(file, {
      version: 1,
      adaptor: 'chat-completion',
      adaptor_port: 8787,
    }, [proxy, adaptor]);
    proxy.emit('listening');
    assert.equal(fs.existsSync(file), false);
    adaptor.emit('listening');
    await committed;
    assert.equal(launcherState.read(file).adaptor, 'chat-completion');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('does not commit launcher state when a server fails before listening', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launcher-error-'));
  const file = path.join(dir, 'launcher-state.json');
  const proxy = new EventEmitter();
  const adaptor = new EventEmitter();
  try {
    const committed = launcherState.writeWhenListening(file, {
      version: 1,
      adaptor: 'chat-completion',
      adaptor_port: 8787,
    }, [proxy, adaptor]);
    proxy.emit('listening');
    adaptor.emit('error', new Error('port occupied'));
    await assert.rejects(committed, /port occupied/u);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
