'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bridge = require('../src/plugin-skill-bridge');

test('generic bridge resolves registered placeholders without modifying plugin files', () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-skill-bridge-'));
  const plugin = {
    pluginId: 'example@openai-bundled',
    discoveryQuery: 'example_repl',
    runtimeRoots: [['plugins', 'cache', 'openai-bundled', 'example']],
    bootstrapRelativePath: ['scripts', 'client.mjs'],
    sourceSkillRelativePath: ['skills', 'example', 'SKILL.md'],
    stableSkillRelativePath: ['skills', 'example', 'SKILL.md'],
    sourceRootPlaceholders: ['<plugin root>', '{{PLUGIN_ROOT}}'],
    generatedMarker: '<!-- generated example bridge -->',
    directImportPackage: '@example/runtime',
    runtimeGlobal: 'exampleRuntime',
    bootstrapExport: 'setupRuntime',
    bootstrapCall: 'await setupRuntime({ globals: globalThis });',
  };
  const pluginRoot = path.join(
    codexDir, 'plugins', 'cache', 'openai-bundled', 'example', '1.0.0'
  );
  const bootstrap = path.join(pluginRoot, 'scripts', 'client.mjs');
  const sourceSkill = path.join(pluginRoot, 'skills', 'example', 'SKILL.md');
  fs.mkdirSync(path.dirname(bootstrap), { recursive: true });
  fs.mkdirSync(path.dirname(sourceSkill), { recursive: true });
  fs.writeFileSync(bootstrap, 'export {}\n', 'utf8');
  fs.writeFileSync(sourceSkill, [
    '---',
    'name: example',
    'description: Example plugin.',
    '---',
    'Load <plugin root>/scripts/client.mjs from {{PLUGIN_ROOT}}.',
  ].join('\n'), 'utf8');

  try {
    const result = bridge.installPluginSkill(plugin, { codexDir });
    const output = fs.readFileSync(result.destination, 'utf8');
    const original = fs.readFileSync(sourceSkill, 'utf8');

    assert.equal(result.status, 'created');
    assert.match(output, new RegExp(fs.realpathSync(pluginRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(output, /<plugin root>|\{\{PLUGIN_ROOT\}\}/);
    assert.match(output, /example_repl/);
    assert.match(original, /<plugin root>.*\{\{PLUGIN_ROOT\}\}/);
  } finally {
    fs.rmSync(codexDir, { recursive: true, force: true });
  }
});
