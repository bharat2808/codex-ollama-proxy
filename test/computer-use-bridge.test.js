'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bridge = require('../src/computer-use-bridge');

function makeRuntime(codexDir, version = '1.2.3', parent) {
  const root = path.join(
    parent || path.join(codexDir, 'skills', '.system', 'computer-use'),
    version
  );
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'computer-use'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'computer-use-client.mjs'), 'export {}\n', 'utf8');
  fs.writeFileSync(path.join(root, 'skills', 'computer-use', 'SKILL.md'), [
    '---',
    'name: computer-use',
    'description: Control local apps.',
    '---',
    '',
    '## Bootstrap',
    '',
    'Do not import `@oai/sky` directly.',
    'Import `<plugin root>/scripts/computer-use-client.mjs`.',
    '',
  ].join('\n'), 'utf8');
  return root;
}

test('installs a stable Computer Use skill with an absolute bootstrap path', () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-use-bridge-'));
  try {
    const runtimeRoot = makeRuntime(codexDir);
    const result = bridge.installCompatibilitySkill({ codexDir });
    const destination = path.join(codexDir, 'skills', 'computer-use', 'SKILL.md');
    const text = fs.readFileSync(destination, 'utf8');
    const bootstrap = path.join(runtimeRoot, 'scripts', 'computer-use-client.mjs');

    assert.equal(result.status, 'created');
    assert.equal(result.destination, destination);
    assert.match(text, /computer-use@openai-bundled.*plugin identifier/);
    assert.match(text, /\{"query":"node_repl"\}/);
    assert.match(text, new RegExp(bootstrap.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(text, /Do not import `@oai\/sky` directly/);
    assert.doesNotMatch(text, /<plugin root>/);
  } finally {
    fs.rmSync(codexDir, { recursive: true, force: true });
  }
});

test('refreshes a generated skill to the latest bundled runtime', () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-use-bridge-'));
  try {
    makeRuntime(codexDir, '1.2.3');
    bridge.installCompatibilitySkill({ codexDir });
    const latest = makeRuntime(codexDir, '1.10.0');
    const result = bridge.installCompatibilitySkill({ codexDir });
    const text = fs.readFileSync(result.destination, 'utf8');

    assert.equal(result.status, 'updated');
    assert.match(text, new RegExp(latest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    fs.rmSync(codexDir, { recursive: true, force: true });
  }
});

test('does not overwrite an unmanaged user skill', () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-use-bridge-'));
  try {
    makeRuntime(codexDir);
    const destination = path.join(codexDir, 'skills', 'computer-use', 'SKILL.md');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, 'user-owned\n', 'utf8');

    const result = bridge.installCompatibilitySkill({ codexDir });

    assert.equal(result.status, 'conflict');
    assert.equal(fs.readFileSync(destination, 'utf8'), 'user-owned\n');
  } finally {
    fs.rmSync(codexDir, { recursive: true, force: true });
  }
});

test('finds Computer Use in the openai-bundled plugin cache', () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-use-bridge-'));
  try {
    const pluginRoot = makeRuntime(
      codexDir,
      '2.0.0',
      path.join(codexDir, 'plugins', 'cache', 'openai-bundled', 'computer-use')
    );

    const runtime = bridge.resolveComputerUseRuntime(codexDir);

    assert.equal(runtime.pluginRoot, fs.realpathSync(pluginRoot));
  } finally {
    fs.rmSync(codexDir, { recursive: true, force: true });
  }
});
