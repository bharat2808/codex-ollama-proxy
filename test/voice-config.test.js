'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { assertPrivateFileMode } = require('./helpers/file-mode');

const CLI = path.join(__dirname, '..', 'bin', 'codex-universal-proxy');

function fixture() {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-voice-config-'));
  const runtimeDir = path.join(codexHome, 'codex-universal-proxy');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'proxy-models.toml'), [
    'models = ["local-model", "voice-model"]',
    'default_model = "local-model"',
    'voice_model = "voice-model"',
    '',
  ].join('\n'), 'utf8');

  function run(args) {
    return spawnSync(process.execPath, [CLI, ...args], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_PROXY_PLATFORM: 'unsupported-test-platform',
      },
    });
  }

  return {
    codexConfig: path.join(codexHome, 'config.toml'),
    codexHome,
    cleanup() {
      fs.rmSync(codexHome, { recursive: true, force: true });
    },
    run,
    runtimeDir,
    voiceConfig: path.join(runtimeDir, 'voice.toml'),
  };
}

test('init creates a private voice configuration with local Whisper and Kokoro defaults', () => {
  const f = fixture();
  try {
    const result = f.run(['init']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const config = fs.readFileSync(f.voiceConfig, 'utf8');
    assert.match(config, /^voice_enabled = false$/m);
    assert.match(config, /^whisper_command = "whisper-cli"$/m);
    assert.match(config, /^whisper_model = ""$/m);
    assert.match(config, /^kokoro_model = "onnx-community\/Kokoro-82M-v1\.0-ONNX"$/m);
    assert.match(config, /^kokoro_voice = "af_heart"$/m);
    assert.match(config, /^kokoro_dtype = "q8"$/m);
    assert.match(config, /^kokoro_device = "cpu"$/m);
    assert.match(config, /^kokoro_speed = 1$/m);
    assert.match(config, /^routing_state = "disabled"$/m);
    assertPrivateFileMode(f.voiceConfig);
  } finally {
    f.cleanup();
  }
});

test('voice command updates speech settings and reports them without changing Codex routing while disabled', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.codexConfig, 'sandbox_mode = "danger-full-access"\n', 'utf8');
    const result = f.run([
      'voice',
      '--whisper-command', '/opt/local/bin/whisper-cli',
      '--whisper-model', '/models/ggml-base.en.bin',
      '--kokoro-model', 'local/kokoro',
      '--kokoro-voice', 'bf_emma',
      '--kokoro-dtype', 'fp32',
      '--kokoro-device', 'cpu',
      '--kokoro-speed', '1.15',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(fs.readFileSync(f.codexConfig, 'utf8'), /experimental_realtime_/u);

    const status = f.run(['voice', '--status']);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.match(status.stdout, /voice_enabled = false/u);
    assert.match(status.stdout, /whisper_command = "\/opt\/local\/bin\/whisper-cli"/u);
    assert.match(status.stdout, /whisper_model = "\/models\/ggml-base\.en\.bin"/u);
    assert.match(status.stdout, /kokoro_voice = "bf_emma"/u);
    assert.match(status.stdout, /kokoro_speed = 1\.15/u);
  } finally {
    f.cleanup();
  }
});

test('voice enable points Codex WebRTC call creation and sideband traffic at the active proxy port', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.codexConfig, [
      'sandbox_mode = "danger-full-access"',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(f.runtimeDir, 'launcher-state.json'), JSON.stringify({
      version: 1,
      adaptor: 'none',
      proxy_port: 61234,
    }), 'utf8');

    const result = f.run([
      'voice',
      '--enable',
      '--whisper-model', '/models/ggml-base.en.bin',
      '--no-start',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const config = fs.readFileSync(f.codexConfig, 'utf8');
    assert.match(config, /^experimental_realtime_webrtc_call_base_url = "http:\/\/127\.0\.0\.1:61234\/v1"$/m);
    assert.match(config, /^experimental_realtime_ws_base_url = "http:\/\/127\.0\.0\.1:61234\/v1"$/m);
    assert.equal((config.match(/^experimental_realtime_webrtc_call_base_url\s*=/gm) || []).length, 1);
    assert.equal((config.match(/^experimental_realtime_ws_base_url\s*=/gm) || []).length, 1);
    assert.match(config, /^\[features\]$/m);
    assert.match(config, /^realtime_conversation = true$/m);
    assert.match(fs.readFileSync(f.voiceConfig, 'utf8'), /^voice_enabled = true$/m);

    const disabled = f.run(['voice', '--disable', '--no-start']);
    assert.equal(disabled.status, 0, disabled.stderr || disabled.stdout);
    assert.doesNotMatch(fs.readFileSync(f.codexConfig, 'utf8'), /^realtime_conversation\s*=/m);
  } finally {
    f.cleanup();
  }
});

test('voice enable requires a voice model in the active preset', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.codexConfig, 'sandbox_mode = "danger-full-access"\n', 'utf8');
    fs.writeFileSync(path.join(f.runtimeDir, 'proxy-models.toml'), [
      'active_preset = "local-voice"',
      'models = ["local-model"]',
      'default_model = "local-model"',
      'voice_model = ""',
      '',
    ].join('\n'), 'utf8');

    const result = f.run([
      'voice',
      '--enable',
      '--whisper-model', '/models/ggml-base.en.bin',
      '--no-start',
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /active preset requires voice_model/u);
    assert.doesNotMatch(fs.readFileSync(f.codexConfig, 'utf8'), /experimental_realtime_/u);
  } finally {
    f.cleanup();
  }
});

test('voice enable routes Codex handoffs through the configured active preset with OpenAI auth', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.codexConfig, 'sandbox_mode = "danger-full-access"\n', 'utf8');
    fs.writeFileSync(path.join(f.runtimeDir, 'proxy-models.toml'), [
      'active_preset = "local-voice"',
      'default_model = "local-model"',
      'voice_model = "voice-model"',
      'models = ["local-model", "voice-model"]',
      'upstream_url = "http://127.0.0.1:11434/v1"',
      '',
    ].join('\n'), 'utf8');

    const result = f.run([
      'voice',
      '--enable',
      '--whisper-model', '/models/ggml-base.en.bin',
      '--no-start',
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const config = fs.readFileSync(f.codexConfig, 'utf8');
    assert.match(config, /^model_provider = "codex-universal-proxy"$/m);
    assert.match(config, /^\[model_providers\.codex-universal-proxy\]$/m);
    assert.match(config, /^base_url = "http:\/\/127\.0\.0\.1:11436\/v1\/"$/m);
    assert.match(config, /^wire_api = "responses"$/m);
    assert.match(config, /^requires_openai_auth = true$/m);
    const route = fs.readFileSync(path.join(f.runtimeDir, 'proxy-models.toml'), 'utf8');
    assert.match(route, /^active_preset = "local-voice"$/m);
    assert.match(route, /^voice_model = "voice-model"$/m);
  } finally {
    f.cleanup();
  }
});

test('switch openai releases proxy-owned model and voice routing without changing the active preset', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.codexConfig, 'sandbox_mode = "danger-full-access"\n', 'utf8');
    fs.writeFileSync(path.join(f.runtimeDir, 'proxy-models.toml'), [
      'active_preset = "local-voice"',
      'default_model = "local-model"',
      'voice_model = "voice-model"',
      'models = ["local-model", "voice-model"]',
      'upstream_url = "http://127.0.0.1:11434/v1"',
      '',
    ].join('\n'), 'utf8');
    const enabled = f.run([
      'voice',
      '--enable',
      '--whisper-model', '/models/ggml-base.en.bin',
      '--no-start',
    ]);
    assert.equal(enabled.status, 0, enabled.stderr || enabled.stdout);
    fs.appendFileSync(
      path.join(f.runtimeDir, 'proxy-models.toml'),
      '\nactive_preset = "local-voice"\n',
      'utf8',
    );

    const switched = f.run(['switch', 'openai']);

    assert.equal(switched.status, 0, switched.stderr || switched.stdout);
    const config = fs.readFileSync(f.codexConfig, 'utf8');
    assert.doesNotMatch(config, /^model_provider\s*=/m);
    assert.doesNotMatch(config, /^\[model_providers\.codex-universal-proxy\]$/m);
    assert.doesNotMatch(config, /^experimental_realtime_webrtc_call_base_url\s*=/m);
    assert.doesNotMatch(config, /^experimental_realtime_ws_base_url\s*=/m);
    assert.doesNotMatch(config, /^realtime_conversation\s*=/m);
    const localVoice = fs.readFileSync(path.join(f.runtimeDir, 'voice.toml'), 'utf8');
    assert.match(localVoice, /^voice_enabled = false$/m);
    assert.match(localVoice, /^routing_state = "disabled"$/m);
    assert.match(
      fs.readFileSync(path.join(f.runtimeDir, 'proxy-models.toml'), 'utf8'),
      /^active_preset = "local-voice"$/m,
    );
  } finally {
    f.cleanup();
  }
});

test('voice disable restores pre-existing Codex Realtime endpoints without disturbing later user edits', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.codexConfig, [
      "\"experimental_realtime_webrtc_call_base_url\" = 'https://calls.example.test/v1'",
      "experimental_realtime_ws_base_url = 'https://sideband.example.test/v1'",
      '"features".\'realtime_conversation\' = false',
      'sandbox_mode = "danger-full-access"',
      '',
    ].join('\n'), 'utf8');

    const enabled = f.run([
      'voice',
      '--enable',
      '--whisper-model', '/models/ggml-base.en.bin',
      '--no-start',
    ]);
    assert.equal(enabled.status, 0, enabled.stderr || enabled.stdout);

    let config = fs.readFileSync(f.codexConfig, 'utf8');
    config = config.replace(
      /^experimental_realtime_ws_base_url = .*$/m,
      'experimental_realtime_ws_base_url = "https://user-edited.example.test/v1"',
    );
    fs.writeFileSync(f.codexConfig, config, 'utf8');

    const disabled = f.run(['voice', '--disable', '--no-start']);
    assert.equal(disabled.status, 0, disabled.stderr || disabled.stdout);
    config = fs.readFileSync(f.codexConfig, 'utf8');
    assert.match(config, /^experimental_realtime_webrtc_call_base_url = "https:\/\/calls\.example\.test\/v1"$/m);
    assert.match(config, /^experimental_realtime_ws_base_url = "https:\/\/user-edited\.example\.test\/v1"$/m);
    assert.match(config, /^sandbox_mode = "danger-full-access"$/m);
    assert.match(config, /^"features"\.'realtime_conversation' = false$/m);
    assert.doesNotMatch(config, /^\[features\]$/m);
    assert.match(fs.readFileSync(f.voiceConfig, 'utf8'), /^voice_enabled = false$/m);
  } finally {
    f.cleanup();
  }
});

test('voice disable is a no-op for Codex configuration when local voice does not own routing', () => {
  const f = fixture();
  try {
    const original = [
      '"experimental_realtime_webrtc_call_base_url" = "https://calls.example.test/v1"',
      'features.realtime_conversation = true',
      'sandbox_mode = "danger-full-access"',
      '',
    ].join('\n');
    fs.writeFileSync(f.codexConfig, original, 'utf8');

    const disabled = f.run(['voice', '--disable', '--no-start']);
    assert.equal(disabled.status, 0, disabled.stderr || disabled.stdout);
    assert.equal(fs.readFileSync(f.codexConfig, 'utf8'), original);
  } finally {
    f.cleanup();
  }
});

test('voice routing preserves quoted TOML feature tables without creating a duplicate table', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.codexConfig, [
      'sandbox_mode = "danger-full-access"',
      '',
      '["features"]',
      '"realtime_conversation" = false',
      '',
    ].join('\n'), 'utf8');

    const enabled = f.run([
      'voice',
      '--enable',
      '--whisper-model', '/models/ggml-base.en.bin',
      '--no-start',
    ]);
    assert.equal(enabled.status, 0, enabled.stderr || enabled.stdout);
    let config = fs.readFileSync(f.codexConfig, 'utf8');
    assert.equal((config.match(/^\[(?:"features"|features)\]$/gm) || []).length, 1);
    assert.match(config, /^"realtime_conversation" = true$/m);

    const disabled = f.run(['voice', '--disable', '--no-start']);
    assert.equal(disabled.status, 0, disabled.stderr || disabled.stdout);
    config = fs.readFileSync(f.codexConfig, 'utf8');
    assert.equal((config.match(/^\[(?:"features"|features)\]$/gm) || []).length, 1);
    assert.match(config, /^"realtime_conversation" = false$/m);
  } finally {
    f.cleanup();
  }
});

test('install completes an interrupted voice disable before attempting service installation', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.codexConfig, [
      'experimental_realtime_webrtc_call_base_url = "https://calls.example.test/v1"',
      'experimental_realtime_ws_base_url = "https://sideband.example.test/v1"',
      '',
    ].join('\n'), 'utf8');
    const enabled = f.run([
      'voice',
      '--enable',
      '--whisper-model', '/models/ggml-base.en.bin',
      '--no-start',
    ]);
    assert.equal(enabled.status, 0, enabled.stderr || enabled.stdout);

    const pending = fs.readFileSync(f.voiceConfig, 'utf8')
      .replace(/^routing_state = "enabled"$/m, 'routing_state = "disabling"');
    fs.writeFileSync(f.voiceConfig, pending, { encoding: 'utf8', mode: 0o600 });

    const installed = f.run(['install']);
    assert.equal(installed.status, 1);
    assert.match(installed.stderr, /background installation is not supported/u);
    const config = fs.readFileSync(f.codexConfig, 'utf8');
    assert.match(config, /^experimental_realtime_webrtc_call_base_url = "https:\/\/calls\.example\.test\/v1"$/m);
    assert.match(config, /^experimental_realtime_ws_base_url = "https:\/\/sideband\.example\.test\/v1"$/m);
    assert.doesNotMatch(config, /^realtime_conversation\s*=/m);
    const voice = fs.readFileSync(f.voiceConfig, 'utf8');
    assert.match(voice, /^voice_enabled = false$/m);
    assert.match(voice, /^routing_state = "disabled"$/m);
  } finally {
    f.cleanup();
  }
});

test('install completes an interrupted voice enable before attempting service installation', () => {
  const f = fixture();
  try {
    const original = [
      'experimental_realtime_webrtc_call_base_url = "https://calls.example.test/v1"',
      'experimental_realtime_ws_base_url = "https://sideband.example.test/v1"',
      '',
    ].join('\n');
    fs.writeFileSync(f.codexConfig, original, 'utf8');
    const enabled = f.run([
      'voice',
      '--enable',
      '--whisper-model', '/models/ggml-base.en.bin',
      '--no-start',
    ]);
    assert.equal(enabled.status, 0, enabled.stderr || enabled.stdout);

    const pending = fs.readFileSync(f.voiceConfig, 'utf8')
      .replace(/^routing_state = "enabled"$/m, 'routing_state = "enabling"');
    fs.writeFileSync(f.voiceConfig, pending, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(f.codexConfig, original, 'utf8');

    const installed = f.run(['install']);
    assert.equal(installed.status, 1);
    assert.match(installed.stderr, /background installation is not supported/u);
    const config = fs.readFileSync(f.codexConfig, 'utf8');
    assert.match(config, /^experimental_realtime_webrtc_call_base_url = "http:\/\/127\.0\.0\.1:11436\/v1"$/m);
    assert.match(config, /^experimental_realtime_ws_base_url = "http:\/\/127\.0\.0\.1:11436\/v1"$/m);
    assert.match(config, /^realtime_conversation = true$/m);
    const voice = fs.readFileSync(f.voiceConfig, 'utf8');
    assert.match(voice, /^voice_enabled = true$/m);
    assert.match(voice, /^routing_state = "enabled"$/m);
  } finally {
    f.cleanup();
  }
});

test('install reapplies enabled voice routing when the saved proxy port changes', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.codexConfig, 'sandbox_mode = "danger-full-access"\n', 'utf8');
    fs.writeFileSync(path.join(f.runtimeDir, 'launcher-state.json'), JSON.stringify({
      version: 1,
      adaptor: 'none',
      proxy_port: 62000,
    }), 'utf8');
    const enabled = f.run([
      'voice',
      '--enable',
      '--whisper-model', '/models/ggml-base.en.bin',
      '--no-start',
    ]);
    assert.equal(enabled.status, 0, enabled.stderr || enabled.stdout);

    fs.writeFileSync(path.join(f.runtimeDir, 'launcher-state.json'), JSON.stringify({
      version: 1,
      adaptor: 'none',
      proxy_port: 62001,
    }), 'utf8');
    const installed = f.run(['install']);
    assert.equal(installed.status, 1);
    assert.match(installed.stderr, /background installation is not supported/u);
    const config = fs.readFileSync(f.codexConfig, 'utf8');
    assert.match(config, /^experimental_realtime_webrtc_call_base_url = "http:\/\/127\.0\.0\.1:62001\/v1"$/m);
    assert.match(config, /^experimental_realtime_ws_base_url = "http:\/\/127\.0\.0\.1:62001\/v1"$/m);
  } finally {
    f.cleanup();
  }
});
