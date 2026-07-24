'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

test('inline image persistence is enabled by default in schema and packaged config', () => {
  const schema = require('../src/route-config-schema');
  const packaged = fs.readFileSync(path.join(__dirname, '..', 'config', 'proxy-models.default.toml'), 'utf8');

  assert.equal(schema.ALL_ROUTE_KEYS.persist_inline_images, true);
  assert.match(packaged, /^persist_inline_images\s*=\s*true$/m);
});

test('model_config ollama defaults to proxy route default_model', () => {
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
    'default_model = "z-ai/glm-5.2"',
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
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
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
    'default_model = "z-ai/glm-5.2"',
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
      '--no-start',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /route_reset=ollama/);
    assert.match(result.stdout, /switched=ollama/);
    const route = fs.readFileSync(path.join(runtimeDir, 'proxy-models.toml'), 'utf8');
    assert.match(route, /^default_model\s*=\s*"glm-5\.2:cloud"$/m);
    assert.match(route, /^image_model\s*=\s*"kimi-k2\.7-code:cloud"$/m);
    assert.match(route, /^upstream_url\s*=\s*"http:\/\/127\.0\.0\.1:11434\/v1"$/m);
    assert.match(route, /^upstream_api_key\s*=\s*""$/m);
    assert.doesNotMatch(route, /integrate\.api\.nvidia|thinkingmachines\/inkling|z-ai\/glm-5\.2|secret/);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('CLI route configures inline image persistence and retention', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-inline-images-'));
  const runtimeDir = path.join(codexHome, 'ollama-shape-proxy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'proxy-models.toml'), [
    'persist_inline_images = false',
    'inline_image_retention_days = 30',
    '',
  ].join('\n'), 'utf8');

  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'route',
      '--persist-images',
      '--image-retention-days',
      '14',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const route = fs.readFileSync(path.join(runtimeDir, 'proxy-models.toml'), 'utf8');
    assert.match(route, /^persist_inline_images\s*=\s*true$/m);
    assert.match(route, /^inline_image_retention_days\s*=\s*14$/m);

    const disable = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'route',
      '--no-persist-images',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(disable.status, 0, disable.stderr || disable.stdout);
    const disabledRoute = fs.readFileSync(path.join(runtimeDir, 'proxy-models.toml'), 'utf8');
    assert.match(disabledRoute, /^persist_inline_images\s*=\s*false$/m);
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
      '--models',
      'z-ai/glm-5.2,thinkingmachines/inkling,z-ai/glm-5.2',
      '--default-model',
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
    assert.match(preset, /^models\s*=\s*\["z-ai\/glm-5\.2", "thinkingmachines\/inkling"\]$/m);
    assert.match(preset, /^default_model\s*=\s*"z-ai\/glm-5\.2"$/m);
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
      '--no-start',
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
    assert.doesNotMatch(route, /^text_model\s*=/m);
    assert.match(route, /^models\s*=\s*\["z-ai\/glm-5\.2", "thinkingmachines\/inkling"\]$/m);
    assert.match(route, /^default_model\s*=\s*"z-ai\/glm-5\.2"$/m);
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
    const presetPath = path.join(runtimeDir, 'presets', 'nvidia.toml');
    const preset = fs.readFileSync(presetPath, 'utf8');
    assert.match(preset, /^upstream_api_key\s*=\s*"stored-secret"$/m);
    assert.equal(fs.statSync(presetPath).mode & 0o777, 0o600);

    const use = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'preset',
      'use',
      'nvidia',
      '--no-refresh',
      '--no-backup',
      '--no-start',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(use.status, 0, use.stderr || use.stdout);
    const routePath = path.join(runtimeDir, 'proxy-models.toml');
    const route = fs.readFileSync(routePath, 'utf8');
    assert.match(route, /^upstream_api_key\s*=\s*"stored-secret"$/m);
    assert.equal(fs.statSync(routePath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('CLI imagine config is separate from presets and composes into route', () => {
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
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(add.status, 0, add.stderr || add.stdout);
    const preset = fs.readFileSync(path.join(runtimeDir, 'presets', 'nvidia.toml'), 'utf8');
    assert.doesNotMatch(preset, /^imagine_/m);

    const use = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'preset',
      'use',
      'nvidia',
      '--no-refresh',
      '--no-backup',
      '--no-start',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(use.status, 0, use.stderr || use.stdout);
    let route = fs.readFileSync(path.join(runtimeDir, 'proxy-models.toml'), 'utf8');
    assert.match(route, /^imagine_enabled\s*=\s*false$/m);

    const imagine = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'imagine',
      '--enable',
      '--service',
      'gemini',
      '--model',
      'gemini-2.5-flash-image',
      '--api-key',
      'gemini-secret',
      '--quality',
      'quality',
      '--enhance',
      '--aspect-ratio',
      '16:9',
      '--no-start',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(imagine.status, 0, imagine.stderr || imagine.stdout);
    const imagineConfig = fs.readFileSync(path.join(runtimeDir, 'imagine.toml'), 'utf8');
    assert.match(imagineConfig, /^imagine_enabled\s*=\s*true$/m);
    assert.match(imagineConfig, /^imagine_service\s*=\s*"gemini"$/m);
    assert.match(imagineConfig, /^imagine_model\s*=\s*"gemini-2\.5-flash-image"$/m);
    assert.match(imagineConfig, /^imagine_api_key\s*=\s*"gemini-secret"$/m);
    assert.match(imagineConfig, /^imagine_quality\s*=\s*"quality"$/m);
    assert.match(imagineConfig, /^imagine_enhance\s*=\s*true$/m);
    assert.match(imagineConfig, /^imagine_aspect_ratio\s*=\s*"16:9"$/m);
    const updatedPreset = fs.readFileSync(path.join(runtimeDir, 'presets', 'nvidia.toml'), 'utf8');
    assert.doesNotMatch(updatedPreset, /^imagine_/m);
    route = fs.readFileSync(path.join(runtimeDir, 'proxy-models.toml'), 'utf8');
    assert.match(route, /^imagine_api_key\s*=\s*"gemini-secret"$/m);

    const noKeyImagine = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'imagine',
      '--service',
      'gemini',
      '--model',
      'gemini-2.5-flash-image',
      '--no-start',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(noKeyImagine.status, 0, noKeyImagine.stderr || noKeyImagine.stdout);
    const preservedImagineConfig = fs.readFileSync(path.join(runtimeDir, 'imagine.toml'), 'utf8');
    assert.match(preservedImagineConfig, /^imagine_api_key\s*=\s*"gemini-secret"$/m);
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

test('CLI preset add --model sets both text and image model, and preset use --model overrides both for the run', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-preset-model-shorthand-'));
  const runtimeDir = path.join(codexHome, 'ollama-shape-proxy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'sandbox_mode = "danger-full-access"\n', 'utf8');

  try {
    // --model (no --text-model) is the shorthand for "default model for both".
    const add = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'preset',
      'add',
      'single',
      '--url',
      'https://provider.example.com/v1',
      '--text-model',
      'single-model',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });
    assert.equal(add.status, 0, add.stderr || add.stdout);

    const presetPath = path.join(runtimeDir, 'presets', 'single.toml');
    const preset = fs.readFileSync(presetPath, 'utf8');
    assert.match(preset, /^adaptor\s*=\s*"none"$/m);
    assert.match(preset, /^default_model\s*=\s*"single-model"$/m);
    assert.match(preset, /^image_model\s*=\s*"single-model"$/m);

    // --model at use time overrides both text and image for this run only,
    // without modifying the stored preset.
    const use = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'preset',
      'use',
      'single',
      '--text-model',
      'override-model',
      '--no-refresh',
      '--no-backup',
      '--no-start',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });
    assert.equal(use.status, 0, use.stderr || use.stdout);
    assert.match(use.stdout, /preset_applied=single/);

    const route = fs.readFileSync(path.join(runtimeDir, 'proxy-models.toml'), 'utf8');
    assert.match(route, /^default_model\s*=\s*"override-model"$/m);
    assert.match(route, /^image_model\s*=\s*"override-model"$/m);
    assert.match(route, /^upstream_url\s*=\s*"https:\/\/provider\.example\.com\/v1"$/m);

    // The stored preset is unchanged.
    const presetAfter = fs.readFileSync(presetPath, 'utf8');
    assert.match(presetAfter, /^default_model\s*=\s*"single-model"$/m);
    assert.match(presetAfter, /^image_model\s*=\s*"single-model"$/m);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('CLI preset add stores any config toggle and preset use applies it (dynamic schema, no per-toggle surgery)', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-preset-toggles-'));
  const runtimeDir = path.join(codexHome, 'ollama-shape-proxy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'sandbox_mode = "danger-full-access"\n', 'utf8');

  try {
    const add = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'preset',
      'add',
      'toggled',
      '--url',
      'https://provider.example.com/v1',
      '--text-model',
      't-model',
      '--persist-images',
      '--image-retention-days',
      '14',
      '--dedupe-large-input',
      '--dedupe-min-chars',
      '1024',
      '--verbose-tools',
      '--log-upstream-body',
      '--enable-find-skill',
      '--no-stream-loop',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(add.status, 0, add.stderr || add.stdout);
    const presetPath = path.join(runtimeDir, 'presets', 'toggled.toml');
    const preset = fs.readFileSync(presetPath, 'utf8');
    assert.match(preset, /^adaptor\s*=\s*"none"$/m);
    assert.match(preset, /^persist_inline_images\s*=\s*true$/m);
    assert.match(preset, /^inline_image_retention_days\s*=\s*14$/m);
    assert.match(preset, /^dedupe_large_input\s*=\s*true$/m);
    assert.match(preset, /^duplicate_input_min_chars\s*=\s*1024$/m);
    assert.match(preset, /^verbose_tools\s*=\s*true$/m);
    assert.match(preset, /^log_upstream_body\s*=\s*true$/m);
    assert.match(preset, /^enable_find_skill\s*=\s*true$/m);
    assert.match(preset, /^stream_proxy_loop\s*=\s*false$/m);

    const use = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'preset',
      'use',
      'toggled',
      '--no-refresh',
      '--no-backup',
      '--no-start',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(use.status, 0, use.stderr || use.stdout);
    assert.match(use.stdout, /preset_applied=toggled/);
    const route = fs.readFileSync(path.join(runtimeDir, 'proxy-models.toml'), 'utf8');
    assert.match(route, /^persist_inline_images\s*=\s*true$/m);
    assert.match(route, /^inline_image_retention_days\s*=\s*14$/m);
    assert.match(route, /^dedupe_large_input\s*=\s*true$/m);
    assert.match(route, /^duplicate_input_min_chars\s*=\s*1024$/m);
    assert.match(route, /^verbose_tools\s*=\s*true$/m);
    assert.match(route, /^log_upstream_body\s*=\s*true$/m);
    assert.match(route, /^enable_find_skill\s*=\s*true$/m);
    assert.match(route, /^stream_proxy_loop\s*=\s*false$/m);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('CLI preset without toggle flags leaves template defaults (partial config)', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-preset-toggles-default-'));
  const runtimeDir = path.join(codexHome, 'ollama-shape-proxy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'sandbox_mode = "danger-full-access"\n', 'utf8');

  try {
    const add = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'preset',
      'add',
      'plain',
      '--url',
      'https://provider.example.com/v1',
      '--text-model',
      'p-model',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });
    assert.equal(add.status, 0, add.stderr || add.stdout);
    const preset = fs.readFileSync(path.join(runtimeDir, 'presets', 'plain.toml'), 'utf8');
    assert.doesNotMatch(preset, /^dedupe_large_input\b/m);
    assert.doesNotMatch(preset, /^stream_proxy_loop\b/m);
    assert.doesNotMatch(preset, /^enable_find_skill\b/m);

    const use = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'preset',
      'use',
      'plain',
      '--no-refresh',
      '--no-backup',
      '--no-start',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });
    assert.equal(use.status, 0, use.stderr || use.stdout);
    const route = fs.readFileSync(path.join(runtimeDir, 'proxy-models.toml'), 'utf8');
    assert.match(route, /^dedupe_large_input\s*=\s*false$/m);
    assert.match(route, /^stream_proxy_loop\s*=\s*true$/m);
    assert.match(route, /^enable_find_skill\s*=\s*true$/m);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('preset normalize rejects an unknown key (schema validation)', () => {
  const presets = require('../src/presets');
  assert.throws(
    () => presets.normalizePreset('bogus', [
      '# codex-ollama-proxy preset',
      'adaptor = "none"',
      'upstream_url = "https://provider.example.com/v1"',
      'default_model = "m"',
      'not_a_real_key = true',
    ].join('\n')),
    /unknown key "not_a_real_key"/,
  );
});

test('CLI preset use preserves replacement-token sequences in API keys', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-preset-dollar-key-'));
  const runtimeDir = path.join(codexHome, 'ollama-shape-proxy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'sandbox_mode = "danger-full-access"\n', 'utf8');

  try {
    const apiKey = 'provider-$&-$1-secret';
    const add = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'preset',
      'add',
      'literal-key',
      '--url',
      'https://provider.example.com/v1',
      '--text-model',
      'test-model',
      '--api-key',
      apiKey,
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });
    assert.equal(add.status, 0, add.stderr || add.stdout);

    const use = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'preset',
      'use',
      'literal-key',
      '--no-refresh',
      '--no-backup',
      '--no-start',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });
    assert.equal(use.status, 0, use.stderr || use.stdout);

    const route = fs.readFileSync(path.join(runtimeDir, 'proxy-models.toml'), 'utf8');
    assert.match(route, /^upstream_api_key\s*=\s*"provider-\$&-\$1-secret"$/m);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('CLI preset add rejects a fractional dedupe threshold', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-preset-fractional-dedupe-'));

  try {
    const add = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'preset',
      'add',
      'fractional',
      '--url',
      'https://provider.example.com/v1',
      '--text-model',
      'test-model',
      '--dedupe-min-chars',
      '0.5',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(add.status, 1, add.stderr || add.stdout);
    assert.match(add.stderr, /--dedupe-min-chars must be a non-negative integer/);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('CLI preset use stops when the route reset fails', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-preset-reset-failure-'));
  const runtimeDir = path.join(codexHome, 'ollama-shape-proxy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'sandbox_mode = "danger-full-access"\n', 'utf8');

  try {
    const add = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'preset',
      'add',
      'reset-failure',
      '--url',
      'https://provider.example.com/v1',
      '--text-model',
      'provider-model',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });
    assert.equal(add.status, 0, add.stderr || add.stdout);

    const preload = path.join(codexHome, 'fail-first-route-write.js');
    fs.writeFileSync(preload, [
      "'use strict';",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const target = path.join(process.env.CODEX_HOME, 'ollama-shape-proxy', 'proxy-models.toml');",
      'const originalWriteFileSync = fs.writeFileSync;',
      'let failed = false;',
      'fs.writeFileSync = function patchedWriteFileSync(file, ...args) {',
      '  if (!failed && path.resolve(String(file)) === path.resolve(target)) {',
      '    failed = true;',
      "    throw new Error('simulated route reset failure');",
      '  }',
      '  return originalWriteFileSync.call(this, file, ...args);',
      '};',
      '',
    ].join('\n'), 'utf8');

    const use = spawnSync(process.execPath, [
      '--require',
      preload,
      path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
      'preset',
      'use',
      'reset-failure',
      '--no-refresh',
      '--no-backup',
      '--no-start',
    ], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { CODEX_HOME: codexHome }),
      encoding: 'utf8',
    });

    assert.equal(use.status, 1, use.stderr || use.stdout);
    assert.match(use.stderr, /simulated route reset failure/);
    assert.doesNotMatch(use.stdout, /preset_applied=reset-failure/);
    const route = fs.readFileSync(path.join(runtimeDir, 'proxy-models.toml'), 'utf8');
    assert.doesNotMatch(route, /provider\.example\.com|provider-model|active_preset/);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('catalog capability state comes only from normalized discovery metadata', () => {
  const {
    nativeCapabilitiesFromDiscovery,
  } = require('../src/model-catalog/project-codex-catalog');
  const capabilities = nativeCapabilitiesFromDiscovery({
    provider: 'ollama',
    traits: {
      local: true,
      nativeInspection: true,
      supportsCloudPull: true,
    },
    models: [
      { id: 'vision-tools', inputModalities: ['text', 'image'], toolCalling: true },
      { id: 'text-only', inputModalities: ['text'], toolCalling: false },
      { id: 'unknown', inputModalities: null, toolCalling: null },
    ],
  }, 'forced-image');

  assert.equal(capabilities.isOllama, true);
  assert.deepEqual([...capabilities.visionCapable], ['vision-tools', 'forced-image']);
  assert.equal(capabilities.toolCalling.get('vision-tools'), true);
  assert.equal(capabilities.toolCalling.get('text-only'), false);
  assert.equal(capabilities.toolCalling.has('unknown'), false);
});

test('discovered metadata maps into supported Codex catalog fields without guessing unknowns', () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-discovered-metadata-'));
  process.env.CODEX_HOME = codexHome;
  delete require.cache[require.resolve('../src/codex-config')];
  const {
    applyDiscoveredMetadata,
  } = require('../src/model-catalog/project-codex-catalog');
  try {
    const catalogModels = [
      { slug: 'vision-reasoning', input_modalities: ['text'], supported_reasoning_levels: [] },
      { slug: 'unknown', input_modalities: ['text'], supported_reasoning_levels: ['high'] },
    ];
    const discovered = [
      {
        id: 'vision-reasoning', displayName: 'Vision Reasoning', contextWindow: 128000,
        maxOutputTokens: 8192, inputModalities: ['text', 'image'], outputModalities: ['text'],
        reasoning: true, reasoningLevels: ['low', 'high'], toolCalling: true,
      },
      {
        id: 'unknown', displayName: 'Unknown', contextWindow: null, maxOutputTokens: null,
        inputModalities: null, outputModalities: null, reasoning: null,
        reasoningLevels: null, toolCalling: null,
      },
    ];
    applyDiscoveredMetadata(catalogModels, discovered);
    assert.deepEqual(catalogModels[0].input_modalities, ['text', 'image']);
    assert.equal(catalogModels[0].supports_image_detail_original, true);
    assert.deepEqual(catalogModels[0].supported_reasoning_levels, ['low', 'high']);
    assert.equal(catalogModels[0].context_window, 128000);
    assert.equal(catalogModels[0].max_context_window, 128000);
    assert.deepEqual(catalogModels[1].input_modalities, ['text']);
    assert.deepEqual(catalogModels[1].supported_reasoning_levels, ['high']);
  } finally {
    delete require.cache[require.resolve('../src/codex-config')];
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('upstream catalog IDs exclude models that are obviously not generative text models', () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-filter-upstream-'));
  process.env.CODEX_HOME = codexHome;
  delete require.cache[require.resolve('../src/codex-config')];
  const {
    upstreamModelIds,
  } = require('../src/model-catalog/resolve-model-inventory');
  try {
    assert.deepEqual([...upstreamModelIds([
      { id: 'meta/llama-3.3-70b-instruct' },
      { id: 'nvidia/embed-qa-4' },
      { id: 'meta/llama-guard-4-12b' },
      { name: 'z-ai/glm-5.2' },
    ])], ['meta/llama-3.3-70b-instruct', 'z-ai/glm-5.2']);
  } finally {
    delete require.cache[require.resolve('../src/codex-config')];
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});
