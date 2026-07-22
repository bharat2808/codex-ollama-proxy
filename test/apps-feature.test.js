'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ensureTableKey } = require('../src/codex-config');

test('ensureTableKey inserts a key into an existing [features] table', () => {
  const text = [
    'sandbox_mode = "danger-full-access"',
    '',
    '[features]',
    'tool_search = true',
    'js_repl = false',
    '',
    '[mcp_servers]',
    '',
  ].join('\n');
  const result = ensureTableKey(text, '[features]', 'enable_mcp_apps', 'true');
  assert.match(result, /^enable_mcp_apps = true$/m);
  assert.match(result, /^tool_search = true$/m);
  assert.match(result, /^js_repl = false$/m);
});

test('ensureTableKey replaces an existing key in [features]', () => {
  const text = [
    'sandbox_mode = "danger-full-access"',
    '',
    '[features]',
    'enable_mcp_apps = false',
    'tool_search = true',
    '',
  ].join('\n');
  const result = ensureTableKey(text, '[features]', 'enable_mcp_apps', 'true');
  assert.match(result, /^enable_mcp_apps = true$/m);
  assert.doesNotMatch(result, /^enable_mcp_apps = false$/m);
  assert.match(result, /^tool_search = true$/m);
});

test('ensureTableKey creates [features] table when absent', () => {
  const text = [
    'sandbox_mode = "danger-full-access"',
    '',
    '[mcp_servers]',
    '',
  ].join('\n');
  const result = ensureTableKey(text, '[features]', 'enable_mcp_apps', 'true');
  assert.match(result, /^\[features\]$/m);
  assert.match(result, /^enable_mcp_apps = true$/m);
});

test('normalizeOllama enables apps feature in [features]', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-apps-'));
  const runtimeDir = path.join(codexHome, 'ollama-shape-proxy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    'sandbox_mode = "danger-full-access"',
    '',
    '[features]',
    'tool_search = true',
    'js_repl = false',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(runtimeDir, 'proxy-models.toml'), [
    'text_model = "glm-5.2:cloud"',
    '',
  ].join('\n'), 'utf8');

  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'model_config.js'),
      'ollama',
      '--no-refresh',
      '--no-backup',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /apps_enabled=yes/);
    const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(config, /^enable_mcp_apps = true$/m);
    assert.match(config, /^tool_search = true$/m);
    assert.match(config, /^requires_openai_auth = true$/m);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('normalizeOpenAI preserves apps feature in [features]', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-apps-openai-'));
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    'sandbox_mode = "danger-full-access"',
    'model = "glm-5.2:cloud"',
    'model_provider = "ollama-launch-codex-app"',
    '',
    '[features]',
    'enable_mcp_apps = false',
    'tool_search = true',
    '',
  ].join('\n'), 'utf8');

  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'model_config.js'),
      'openai',
      '--no-backup',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /apps_enabled=yes/);
    const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(config, /^enable_mcp_apps = true$/m);
    assert.doesNotMatch(config, /^model_provider =/m);
    assert.doesNotMatch(config, /requires_openai_auth/);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('normalizeOllama sets requires_openai_auth on provider table (no reference)', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-provider-auth-'));
  const runtimeDir = path.join(codexHome, 'ollama-shape-proxy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    'sandbox_mode = "danger-full-access"',
    '',
    '[features]',
    'tool_search = true',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(runtimeDir, 'proxy-models.toml'), [
    'text_model = "glm-5.2:cloud"',
    '',
  ].join('\n'), 'utf8');

  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'model_config.js'),
      'ollama',
      '--no-refresh',
      '--no-backup',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(config, /^requires_openai_auth = true$/m);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});
