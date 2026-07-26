'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const childProcess = require('node:child_process');

test('skill index honors CODEX_HOME independently of package location', () => {
  const expected = path.join('/tmp', 'codex-home-for-skill-index-test');
  process.env.CODEX_HOME = expected;

  delete require.cache[require.resolve('../src/codex-app-server-skills')];
  delete require.cache[require.resolve('../src/skill-index')];
  const skillIndex = require('../src/skill-index');

  assert.equal(skillIndex.CODEX_DIR, expected);
});

test('skill index uses Codex app-server effective enabled skills when available', () => {
  const originalSpawnSync = childProcess.spawnSync;
  const originalCodexHome = process.env.CODEX_HOME;
  const originalAppServerPath = process.env.CODEX_APP_SERVER_PATH;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skill-index-'));
  const fakeCodexAppServer = path.join(tempHome, 'codex');
  const pluginSkillsRoot = path.join(
    tempHome,
    'plugins',
    'cache',
    'openai-curated-remote',
    'superpowers',
    '6.1.1',
    'skills'
  );
  fs.mkdirSync(pluginSkillsRoot, { recursive: true });
  fs.writeFileSync(fakeCodexAppServer, '', 'utf8');

  const pluginList = {
    id: 2,
    result: {
      marketplaces: [{
        name: 'openai-curated-remote',
        plugins: [{
          id: 'superpowers@openai-curated-remote',
          name: 'superpowers',
          localVersion: '6.1.1',
          version: '6.1.1',
          installed: true,
          enabled: true,
        }],
      }],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    },
  };
  const skillsList = {
    id: 3,
    result: {
      data: [{
        cwd: process.cwd(),
        skills: [{
          name: 'superpowers:systematic-debugging',
          description: 'Use when encountering any bug',
          path: path.join(pluginSkillsRoot, 'systematic-debugging', 'SKILL.md'),
          scope: 'user',
          enabled: true,
        }, {
          name: 'superpowers:brainstorming',
          description: 'Use before creative work',
          path: path.join(pluginSkillsRoot, 'brainstorming', 'SKILL.md'),
          scope: 'user',
          enabled: true,
        }, {
          name: 'mzs-metrics:view-mzs-metrics',
          description: 'disabled skill',
          path: path.join(tempHome, 'disabled', 'SKILL.md'),
          scope: 'user',
          enabled: false,
        }],
        errors: [],
      }],
    },
  };

  childProcess.spawnSync = (command, args, options) => {
    assert.equal(command, fakeCodexAppServer);
    assert.deepEqual(args, ['app-server', '--stdio']);
    const input = String((options && options.input) || '');
    if (input.includes('"plugin/list"')) {
      return {
        status: 0,
        stdout: Buffer.from(JSON.stringify({ id: 1, result: {} }) + '\n' + JSON.stringify(pluginList) + '\n'),
        stderr: Buffer.alloc(0),
      };
    }
    if (input.includes('"skills/list"')) {
      assert.match(input, new RegExp(pluginSkillsRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return {
        status: 0,
        stdout: Buffer.from(JSON.stringify({ id: 1, result: {} }) + '\n' + JSON.stringify({ id: 2, result: {} }) + '\n' + JSON.stringify(skillsList) + '\n'),
        stderr: Buffer.alloc(0),
      };
    }
    throw new Error('unexpected app-server request: ' + input);
  };

  try {
    process.env.CODEX_HOME = tempHome;
    process.env.CODEX_APP_SERVER_PATH = fakeCodexAppServer;
    delete require.cache[require.resolve('../src/codex-app-server-skills')];
    delete require.cache[require.resolve('../src/skill-index')];
    const skillIndex = require('../src/skill-index');

    const entries = skillIndex.buildEntries();

    assert.deepEqual(entries.map((entry) => entry.skill_name), [
      'superpowers:systematic-debugging',
      'superpowers:brainstorming',
    ]);
    assert.equal(entries[0].plugin_name, 'superpowers');
    assert.equal(entries[0].scope, 'user');

    const skillFind = require('../src/skill-find');
    const result = skillFind.fulfillFindSkill({
      call_id: 'call_summary',
      arguments: JSON.stringify({ action: 'summary' }),
    });
    const summary = JSON.parse(result.output);

    assert.equal(summary.type, 'skills_summary');
    assert.equal(summary.total_enabled_skills, 2);
    assert.deepEqual(summary.by_plugin, { superpowers: 2 });
    assert.deepEqual(summary.by_scope, { user: 2 });

    const listResult = skillFind.fulfillFindSkill({
      call_id: 'call_list',
      arguments: JSON.stringify({ action: 'list', plugin: 'superpowers', scope: 'user' }),
    });
    const list = JSON.parse(listResult.output);

    assert.equal(list.type, 'skills_list');
    assert.equal(list.total_enabled_skills, 2);
    assert.deepEqual(list.filters, { plugin: 'superpowers', scope: 'user' });
    assert.deepEqual(list.skills.map((entry) => entry.skill_name), [
      'superpowers:brainstorming',
      'superpowers:systematic-debugging',
    ]);
    assert.equal(list.skills[0].root, 'plugin');
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalAppServerPath === undefined) delete process.env.CODEX_APP_SERVER_PATH;
    else process.env.CODEX_APP_SERVER_PATH = originalAppServerPath;
    delete require.cache[require.resolve('../src/codex-app-server-skills')];
    delete require.cache[require.resolve('../src/skill-index')];
    delete require.cache[require.resolve('../src/skill-find')];
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('fallback skill index uses installed plugin markers and skill disables', () => {
  const originalCodexHome = process.env.CODEX_HOME;
  const originalAppServerPath = process.env.CODEX_APP_SERVER_PATH;
  const originalAgentsSkillsDir = process.env.CODEX_AGENTS_SKILLS_DIR;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skill-fallback-'));
  const agentsSkillsRoot = path.join(tempHome, '.agents', 'skills');
  const superSkillDir = path.join(
    tempHome,
    'plugins',
    'cache',
    'openai-curated-remote',
    'superpowers',
    '6.1.1',
    'skills',
    'systematic-debugging'
  );
  const disabledSkillDir = path.join(
    tempHome,
    'plugins',
    'cache',
    'openai-curated-remote',
    'superpowers',
    '6.1.1',
    'skills',
    'brainstorming'
  );
  const agentSkillDir = path.join(agentsSkillsRoot, 'wrangler');
  const disabledAgentSkillDir = path.join(agentsSkillsRoot, 'web-perf');
  const uninstalledSkillDir = path.join(
    tempHome,
    'plugins',
    'cache',
    'openai-curated-remote',
    'not-installed',
    '1.0.0',
    'skills',
    'unused'
  );
  fs.mkdirSync(superSkillDir, { recursive: true });
  fs.mkdirSync(disabledSkillDir, { recursive: true });
  fs.mkdirSync(agentSkillDir, { recursive: true });
  fs.mkdirSync(disabledAgentSkillDir, { recursive: true });
  fs.mkdirSync(uninstalledSkillDir, { recursive: true });
  fs.mkdirSync(path.join(tempHome, 'plugins', 'cache', 'openai-curated-remote', 'superpowers'), { recursive: true });
  fs.mkdirSync(path.join(tempHome, 'plugins', 'cache', 'openai-curated-remote', 'superpowers', '6.1.1', '.codex-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(tempHome, 'plugins', 'cache', 'openai-curated-remote', 'superpowers', '.codex-remote-plugin-install.json'),
    JSON.stringify({ schema_version: 1, remote_plugin_id: 'plugin-superpowers' }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(tempHome, 'plugins', 'cache', 'openai-curated-remote', 'superpowers', '6.1.1', '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'superpowers' }),
    { encoding: 'utf8', flag: 'w' }
  );
  fs.writeFileSync(path.join(superSkillDir, 'SKILL.md'), '---\nname: systematic-debugging\ndescription: Debug bugs\n---\n', 'utf8');
  fs.writeFileSync(path.join(disabledSkillDir, 'SKILL.md'), '---\nname: brainstorming\ndescription: Think first\n---\n', 'utf8');
  fs.writeFileSync(path.join(agentSkillDir, 'SKILL.md'), '---\nname: wrangler\ndescription: Cloudflare CLI\n---\n', 'utf8');
  fs.writeFileSync(path.join(disabledAgentSkillDir, 'SKILL.md'), '---\nname: web-perf\ndescription: Performance checks\n---\n', 'utf8');
  fs.writeFileSync(path.join(uninstalledSkillDir, 'SKILL.md'), '---\nname: not-installed:unused\ndescription: Should not appear\n---\n', 'utf8');
  fs.writeFileSync(
    path.join(tempHome, 'config.toml'),
    '[[skills.config]]\nname = "superpowers:brainstorming"\nenabled = false\n\n' +
      '[[skills.config]]\npath = "' + path.join(disabledAgentSkillDir, 'SKILL.md') + '"\nenabled = false\n',
    'utf8'
  );

  try {
    process.env.CODEX_HOME = tempHome;
    process.env.CODEX_APP_SERVER_PATH = path.join(tempHome, 'missing-codex');
    process.env.CODEX_AGENTS_SKILLS_DIR = agentsSkillsRoot;
    delete require.cache[require.resolve('../src/codex-app-server-skills')];
    delete require.cache[require.resolve('../src/skill-index')];
    const skillIndex = require('../src/skill-index');

    const entries = skillIndex.buildEntries();

    assert.deepEqual(entries.map((entry) => entry.skill_name), ['wrangler', 'superpowers:systematic-debugging']);
    assert.equal(entries[0].plugin_name, '');
    assert.equal(entries[0].scope, 'user');
    assert.equal(entries[1].plugin_name, 'superpowers');
  } finally {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalAppServerPath === undefined) delete process.env.CODEX_APP_SERVER_PATH;
    else process.env.CODEX_APP_SERVER_PATH = originalAppServerPath;
    if (originalAgentsSkillsDir === undefined) delete process.env.CODEX_AGENTS_SKILLS_DIR;
    else process.env.CODEX_AGENTS_SKILLS_DIR = originalAgentsSkillsDir;
    delete require.cache[require.resolve('../src/codex-app-server-skills')];
    delete require.cache[require.resolve('../src/skill-index')];
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
