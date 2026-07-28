'use strict';

const fs = require('fs');
const path = require('path');

const COMMAND = 'codex-universal-proxy';
const COMMAND_ALIASES = ['codex-ollama-proxy'];
const RUNTIME_DIRNAME = 'codex-universal-proxy';
const LEGACY_RUNTIME_DIRNAME = 'ollama-shape-proxy';
const PROVIDER_NAME = 'codex-universal-proxy';
const LEGACY_PROVIDER_NAMES = ['ollama-launch-codex-app'];
const LAUNCHD_LABEL = 'com.user.codex-universal-proxy';
const LEGACY_LAUNCHD_LABELS = ['com.user.codex-ollama-shape-proxy'];
const SYSTEMD_SERVICE = 'codex-universal-proxy.service';
const LEGACY_SYSTEMD_SERVICES = ['codex-ollama-proxy.service'];
const WINDOWS_TASK = 'Codex Universal Proxy';
const LEGACY_WINDOWS_TASKS = ['Codex Ollama Proxy'];
const MODEL_CATALOG_FILENAME = 'codex-universal-models.json';
const MODEL_CATALOG_WORKING_FILENAME = 'codex-universal-models-working.json';
const LEGACY_MODEL_CATALOG_FILENAMES = [
  'ollama-launch-models-ollama-working.json',
  'ollama-launch-models.json',
];
const REFERENCE_CONFIG_FILENAME = 'config.toml.codex-universal-proxy';
const LEGACY_REFERENCE_CONFIG_FILENAMES = ['config.toml.ollama-working'];
const ATTACHMENT_DIRNAME = 'codex-universal-proxy-inline-images';
const LEGACY_ATTACHMENT_DIRNAMES = ['ollama-shape-proxy-inline-images'];
const RUNTIME_OWNED_ENTRIES = [
  'imagine.toml',
  'launcher-state.json',
  'model-discovery-cache',
  'presets',
  'proxy-models.toml',
  'start-proxy.cmd',
];

function runtimeDirectory(codexDir) {
  return path.join(codexDir, RUNTIME_DIRNAME);
}

function legacyRuntimeDirectory(codexDir) {
  return path.join(codexDir, LEGACY_RUNTIME_DIRNAME);
}

function resolveRuntimeDirectory(codexDir) {
  const canonical = runtimeDirectory(codexDir);
  if (fs.existsSync(canonical)) return canonical;
  const legacy = legacyRuntimeDirectory(codexDir);
  return fs.existsSync(legacy) ? legacy : canonical;
}

function migrateRuntimeDirectory(codexDir) {
  const runtimeDir = runtimeDirectory(codexDir);
  const legacyDir = legacyRuntimeDirectory(codexDir);
  const canonicalExists = fs.existsSync(runtimeDir);
  const legacyExists = fs.existsSync(legacyDir);
  const sourceCheckout = legacyExists && (
    fs.existsSync(path.join(legacyDir, '.git'))
    || (
      fs.existsSync(path.join(legacyDir, 'package.json'))
      && fs.existsSync(path.join(legacyDir, 'src'))
      && fs.existsSync(path.join(legacyDir, 'bin'))
    )
  );
  if (!canonicalExists && sourceCheckout) {
    const copied = [];
    for (const name of RUNTIME_OWNED_ENTRIES) {
      const source = path.join(legacyDir, name);
      if (!fs.existsSync(source)) continue;
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.cpSync(source, path.join(runtimeDir, name), {
        errorOnExist: false,
        force: false,
        recursive: true,
      });
      copied.push(name);
    }
    return {
      runtimeDir,
      legacyDir,
      migrated: copied.length > 0,
      conflict: false,
      sourceCheckout: true,
      copied,
    };
  }
  if (!canonicalExists && legacyExists) {
    fs.renameSync(legacyDir, runtimeDir);
    return { runtimeDir, legacyDir, migrated: true, conflict: false };
  }
  return {
    runtimeDir,
    legacyDir,
    migrated: false,
    conflict: canonicalExists && legacyExists,
    sourceCheckout,
  };
}

function firstExisting(codexDir, canonicalName, legacyNames = []) {
  const canonical = path.join(codexDir, canonicalName);
  if (fs.existsSync(canonical)) return canonical;
  for (const name of legacyNames) {
    const candidate = path.join(codexDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return canonical;
}

function migrateLegacyFile(codexDir, canonicalName, legacyNames = []) {
  const canonical = path.join(codexDir, canonicalName);
  if (fs.existsSync(canonical)) return { path: canonical, migrated: false };
  const source = firstExisting(codexDir, canonicalName, legacyNames);
  if (source === canonical) return { path: canonical, migrated: false };
  fs.copyFileSync(source, canonical);
  return { path: canonical, source, migrated: true };
}

module.exports = {
  ATTACHMENT_DIRNAME,
  COMMAND,
  COMMAND_ALIASES,
  LAUNCHD_LABEL,
  LEGACY_ATTACHMENT_DIRNAMES,
  LEGACY_LAUNCHD_LABELS,
  LEGACY_MODEL_CATALOG_FILENAMES,
  LEGACY_PROVIDER_NAMES,
  LEGACY_REFERENCE_CONFIG_FILENAMES,
  LEGACY_RUNTIME_DIRNAME,
  LEGACY_SYSTEMD_SERVICES,
  LEGACY_WINDOWS_TASKS,
  MODEL_CATALOG_FILENAME,
  MODEL_CATALOG_WORKING_FILENAME,
  PROVIDER_NAME,
  REFERENCE_CONFIG_FILENAME,
  RUNTIME_OWNED_ENTRIES,
  RUNTIME_DIRNAME,
  SYSTEMD_SERVICE,
  WINDOWS_TASK,
  firstExisting,
  legacyRuntimeDirectory,
  migrateLegacyFile,
  migrateRuntimeDirectory,
  resolveRuntimeDirectory,
  runtimeDirectory,
};
