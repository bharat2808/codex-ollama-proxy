'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const branding = require('../src/branding');

test('exposes the universal brand and every intentional legacy alias', () => {
  assert.equal(branding.COMMAND, 'codex-universal-proxy');
  assert.deepEqual(branding.COMMAND_ALIASES, ['codex-ollama-proxy']);
  assert.equal(branding.RUNTIME_DIRNAME, 'codex-universal-proxy');
  assert.equal(branding.LEGACY_RUNTIME_DIRNAME, 'ollama-shape-proxy');
  assert.equal(branding.PROVIDER_NAME, 'codex-universal-proxy');
  assert.deepEqual(branding.LEGACY_PROVIDER_NAMES, ['ollama-launch-codex-app']);
  assert.equal(branding.SYSTEMD_SERVICE, 'codex-universal-proxy.service');
  assert.deepEqual(branding.LEGACY_SYSTEMD_SERVICES, ['codex-ollama-proxy.service']);
});

test('migrates a legacy-only runtime directory atomically and idempotently', () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-proxy-branding-'));
  const legacyDir = path.join(codexDir, branding.LEGACY_RUNTIME_DIRNAME);
  const runtimeDir = path.join(codexDir, branding.RUNTIME_DIRNAME);
  fs.mkdirSync(path.join(legacyDir, 'presets'), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'presets', 'openai.toml'), 'provider = "openai"\n');

  const first = branding.migrateRuntimeDirectory(codexDir);
  assert.equal(first.migrated, true);
  assert.equal(fs.existsSync(legacyDir), false);
  assert.equal(fs.readFileSync(path.join(runtimeDir, 'presets', 'openai.toml'), 'utf8'), 'provider = "openai"\n');

  const second = branding.migrateRuntimeDirectory(codexDir);
  assert.equal(second.migrated, false);
  assert.equal(second.runtimeDir, runtimeDir);
});

test('does not overwrite a canonical runtime directory when both layouts exist', () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-proxy-branding-'));
  const legacyDir = path.join(codexDir, branding.LEGACY_RUNTIME_DIRNAME);
  const runtimeDir = path.join(codexDir, branding.RUNTIME_DIRNAME);
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'proxy-models.toml'), 'legacy\n');
  fs.writeFileSync(path.join(runtimeDir, 'proxy-models.toml'), 'canonical\n');

  const result = branding.migrateRuntimeDirectory(codexDir);
  assert.equal(result.migrated, false);
  assert.equal(result.conflict, true);
  assert.equal(fs.readFileSync(path.join(runtimeDir, 'proxy-models.toml'), 'utf8'), 'canonical\n');
  assert.equal(fs.readFileSync(path.join(legacyDir, 'proxy-models.toml'), 'utf8'), 'legacy\n');
});

test('copies only runtime-owned data when the legacy directory is a source checkout', () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-proxy-branding-'));
  const legacyDir = path.join(codexDir, branding.LEGACY_RUNTIME_DIRNAME);
  fs.mkdirSync(path.join(legacyDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'package.json'), '{"name":"codex-universal-proxy"}\n');
  fs.writeFileSync(path.join(legacyDir, 'proxy-models.toml'), 'default_model = "demo"\n');

  const result = branding.migrateRuntimeDirectory(codexDir);
  assert.equal(result.migrated, true);
  assert.equal(result.sourceCheckout, true);
  assert.equal(fs.existsSync(legacyDir), true);
  assert.equal(
    fs.readFileSync(path.join(codexDir, branding.RUNTIME_DIRNAME, 'proxy-models.toml'), 'utf8'),
    'default_model = "demo"\n',
  );
  assert.equal(fs.existsSync(path.join(codexDir, branding.RUNTIME_DIRNAME, 'package.json')), false);
});

test('resolves a legacy runtime read without mutating it', () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-proxy-branding-'));
  const legacyDir = path.join(codexDir, branding.LEGACY_RUNTIME_DIRNAME);
  fs.mkdirSync(legacyDir, { recursive: true });

  assert.equal(branding.resolveRuntimeDirectory(codexDir), legacyDir);
  assert.equal(fs.existsSync(path.join(codexDir, branding.RUNTIME_DIRNAME)), false);
});
