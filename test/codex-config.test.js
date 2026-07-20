'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

test('model_config ollama defaults to proxy route text_model', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-route-model-'));
  const runtimeDir = path.join(codexHome, 'ollama-shape-proxy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    'sandbox_mode = "danger-full-access"',
    '',
    '[plugins."storefront-builder@personal"]',
    'enabled = true',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(runtimeDir, 'proxy-models.toml'), [
    'text_model = "z-ai/glm-5.2"',
    'image_model = "thinkingmachines/inkling"',
    'auto_route_image = true',
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
    assert.match(result.stdout, /model=z-ai\/glm-5\.2/);
    const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(config, /^model = "z-ai\/glm-5\.2"$/m);
    assert.match(config, /^model_provider = "ollama-launch-codex-app"$/m);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('CLI switch ollama resets chat-completion upstream config to local Ollama route', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-switch-ollama-'));
  const runtimeDir = path.join(codexHome, 'ollama-shape-proxy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'sandbox_mode = "danger-full-access"\n', 'utf8');
  fs.writeFileSync(path.join(runtimeDir, 'proxy-models.toml'), [
    'text_model = "z-ai/glm-5.2"',
    'image_model = "thinkingmachines/inkling"',
    'upstream_url = "https://integrate.api.nvidia.com/v1"',
    'upstream_api_key = "secret"',
    'auto_route_image = true',
    '',
  ].join('\n'), 'utf8');

  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'switch',
      'ollama',
      '--no-refresh',
      '--no-backup',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /route_reset=ollama/);
    assert.match(result.stdout, /model=glm-5\.2:cloud/);
    const route = fs.readFileSync(path.join(runtimeDir, 'proxy-models.toml'), 'utf8');
    assert.match(route, /^text_model\s*=\s*"glm-5\.2:cloud"$/m);
    assert.match(route, /^image_model\s*=\s*"kimi-k2\.7-code:cloud"$/m);
    assert.match(route, /^upstream_url\s*=\s*"http:\/\/127\.0\.0\.1:11434\/v1"$/m);
    assert.match(route, /^upstream_api_key\s*=\s*""$/m);
    assert.doesNotMatch(route, /integrate\.api\.nvidia|thinkingmachines\/inkling|z-ai\/glm-5\.2|secret/);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('CLI preset add stores provider config without API key and preset use applies route', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-preset-'));
  const runtimeDir = path.join(codexHome, 'ollama-shape-proxy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'sandbox_mode = "danger-full-access"\n', 'utf8');

  try {
    const add = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'preset',
      'add',
      'nvidia',
      '--adaptor',
      'chat-completion',
      '--url',
      'https://integrate.api.nvidia.com/v1',
      '--text-model',
      'z-ai/glm-5.2',
      '--image-model',
      'thinkingmachines/inkling',
      '--auto-image',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(add.status, 0, add.stderr || add.stdout);
    assert.match(add.stdout, /api_key=not_stored/);
    const presetPath = path.join(runtimeDir, 'presets', 'nvidia.toml');
    const preset = fs.readFileSync(presetPath, 'utf8');
    assert.match(preset, /^adaptor\s*=\s*"chat-completion"$/m);
    assert.match(preset, /^upstream_url\s*=\s*"https:\/\/integrate\.api\.nvidia\.com\/v1"$/m);
    assert.doesNotMatch(preset, /api_key|secret|nvapi/u);

    const use = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'preset',
      'use',
      'nvidia',
      '--api-key',
      'provider-secret',
      '--no-refresh',
      '--no-backup',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(use.status, 0, use.stderr || use.stdout);
    assert.match(use.stdout, /preset_applied=nvidia/);
    const route = fs.readFileSync(path.join(runtimeDir, 'proxy-models.toml'), 'utf8');
    assert.match(route, /^upstream_url\s*=\s*"https:\/\/integrate\.api\.nvidia\.com\/v1"$/m);
    assert.match(route, /^upstream_api_key\s*=\s*"provider-secret"$/m);
    assert.match(route, /^text_model\s*=\s*"z-ai\/glm-5\.2"$/m);
    assert.match(route, /^image_model\s*=\s*"thinkingmachines\/inkling"$/m);
    assert.match(route, /^auto_route_image\s*=\s*true$/m);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('CLI preset add can store API key when requested', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-preset-key-'));
  const runtimeDir = path.join(codexHome, 'ollama-shape-proxy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'sandbox_mode = "danger-full-access"\n', 'utf8');

  try {
    const add = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'preset',
      'add',
      'nvidia',
      '--adaptor',
      'chat-completion',
      '--url',
      'https://integrate.api.nvidia.com/v1',
      '--text-model',
      'z-ai/glm-5.2',
      '--api-key',
      'stored-secret',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(add.status, 0, add.stderr || add.stdout);
    assert.match(add.stdout, /api_key=stored/);
    const preset = fs.readFileSync(path.join(runtimeDir, 'presets', 'nvidia.toml'), 'utf8');
    assert.match(preset, /^upstream_api_key\s*=\s*"stored-secret"$/m);

    const use = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'preset',
      'use',
      'nvidia',
      '--no-refresh',
      '--no-backup',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(use.status, 0, use.stderr || use.stdout);
    const route = fs.readFileSync(path.join(runtimeDir, 'proxy-models.toml'), 'utf8');
    assert.match(route, /^upstream_api_key\s*=\s*"stored-secret"$/m);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('CLI preset add can persist imagine_enabled and preset use applies it', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-preset-imagine-'));
  const runtimeDir = path.join(codexHome, 'ollama-shape-proxy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'sandbox_mode = "danger-full-access"\n', 'utf8');

  try {
    const add = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'preset',
      'add',
      'nvidia',
      '--adaptor',
      'chat-completion',
      '--url',
      'https://integrate.api.nvidia.com/v1',
      '--text-model',
      'z-ai/glm-5.2',
      '--image-model',
      'thinkingmachines/inkling',
      '--auto-image',
      '--imagine-enable',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(add.status, 0, add.stderr || add.stdout);
    const preset = fs.readFileSync(path.join(runtimeDir, 'presets', 'nvidia.toml'), 'utf8');
    assert.match(preset, /^imagine_enabled\s*=\s*true$/m);

    const use = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'preset',
      'use',
      'nvidia',
      '--no-refresh',
      '--no-backup',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(use.status, 0, use.stderr || use.stdout);
    const route = fs.readFileSync(path.join(runtimeDir, 'proxy-models.toml'), 'utf8');
    assert.match(route, /^imagine_enabled\s*=\s*true$/m);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('CLI preset add rejects an explicitly empty API key', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-preset-empty-key-'));
  fs.mkdirSync(path.join(codexHome, 'ollama-shape-proxy'), { recursive: true });

  try {
    const add = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'preset',
      'add',
      'nvidia',
      '--adaptor',
      'chat-completion',
      '--url',
      'https://integrate.api.nvidia.com/v1',
      '--text-model',
      'z-ai/glm-5.2',
      '--api-key',
      '',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(add.status, 1);
    assert.match(add.stderr, /--api-key was passed but empty/);
    assert.equal(fs.existsSync(path.join(codexHome, 'ollama-shape-proxy', 'presets', 'nvidia.toml')), false);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});
