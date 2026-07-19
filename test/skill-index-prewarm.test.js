'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('prewarm serves the filesystem index while exact discovery runs', async () => {
  const originalCodexHome = process.env.CODEX_HOME;
  const originalAppServerPath = process.env.CODEX_APP_SERVER_PATH;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-prewarm-'));
  const skillDir = path.join(codexHome, 'skills', 'fallback-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
    '---',
    'name: fallback-skill',
    'description: Available immediately.',
    '---',
  ].join('\n'), 'utf8');

  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_APP_SERVER_PATH = path.join(codexHome, 'codex');
  delete require.cache[require.resolve('../src/codex-app-server-skills')];
  delete require.cache[require.resolve('../src/skill-index')];
  const appServerSkills = require('../src/codex-app-server-skills');
  let resolveExact;
  appServerSkills.buildEntriesFromAppServer = () => {
    throw new Error('synchronous app-server lookup must not run during prewarm');
  };
  appServerSkills.buildEntriesFromAppServerAsync = () => new Promise((resolve) => {
    resolveExact = resolve;
  });
  const skillIndex = require('../src/skill-index');

  try {
    const warming = skillIndex.prewarmEntries();
    assert.deepEqual(skillIndex.getEntries().map((entry) => entry.skill_name), ['fallback-skill']);

    resolveExact([{
      skill_name: 'exact-skill',
      plugin_name: 'example',
      description: 'Returned by Codex.',
      path: path.join(codexHome, 'plugins', 'exact', 'SKILL.md'),
      scope: 'plugin',
    }]);
    await warming;
    assert.deepEqual(skillIndex.getEntries().map((entry) => entry.skill_name), ['exact-skill']);
  } finally {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalAppServerPath === undefined) delete process.env.CODEX_APP_SERVER_PATH;
    else process.env.CODEX_APP_SERVER_PATH = originalAppServerPath;
    delete require.cache[require.resolve('../src/codex-app-server-skills')];
    delete require.cache[require.resolve('../src/skill-index')];
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});
