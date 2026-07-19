'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');

test('async skill discovery uses one interactive app-server process', async () => {
  const originalCodexHome = process.env.CODEX_HOME;
  const originalAppServerPath = process.env.CODEX_APP_SERVER_PATH;
  const originalSpawn = childProcess.spawn;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'async-skill-index-'));
  const appServerPath = path.join(codexHome, 'codex');
  const pluginSkillsRoot = path.join(
    codexHome, 'plugins', 'cache', 'openai-bundled', 'example', '1.0.0', 'skills'
  );
  fs.mkdirSync(pluginSkillsRoot, { recursive: true });
  fs.writeFileSync(appServerPath, '', 'utf8');

  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_APP_SERVER_PATH = appServerPath;
  delete require.cache[require.resolve('../src/codex-app-server-skills')];
  const requests = [];
  let spawnCount = 0;
  childProcess.spawn = () => {
    spawnCount += 1;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => true;
    child.stdin = {
      destroyed: false,
      end() { this.destroyed = true; },
      write(line) {
        const request = JSON.parse(String(line));
        requests.push(request);
        queueMicrotask(() => {
          let response = { id: request.id, result: {} };
          if (request.method === 'plugin/list') {
            response = {
              id: request.id,
              result: {
                marketplaces: [{
                  plugins: [{
                    id: 'example@openai-bundled',
                    localVersion: '1.0.0',
                    installed: true,
                    enabled: true,
                  }],
                }],
              },
            };
          } else if (request.method === 'skills/list') {
            response = {
              id: request.id,
              result: {
                data: [{ skills: [{
                  name: 'example:control',
                  description: 'Control the example runtime.',
                  path: path.join(pluginSkillsRoot, 'control', 'SKILL.md'),
                  scope: 'user',
                  enabled: true,
                }] }],
              },
            };
          }
          child.stdout.emit('data', Buffer.from(JSON.stringify(response) + '\n'));
        });
        return true;
      },
    };
    return child;
  };

  try {
    const appServerSkills = require('../src/codex-app-server-skills');
    const entries = await appServerSkills.buildEntriesFromAppServerAsync({ timeoutMs: 1000 });
    assert.equal(spawnCount, 1);
    assert.deepEqual(requests.map((request) => request.method), [
      'initialize',
      'plugin/list',
      'skills/extraRoots/set',
      'skills/list',
    ]);
    assert.deepEqual(requests[2].params.extraRoots, [pluginSkillsRoot]);
    assert.deepEqual(entries.map((entry) => entry.skill_name), ['example:control']);
    assert.equal(entries[0].plugin_name, 'example');
  } finally {
    childProcess.spawn = originalSpawn;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalAppServerPath === undefined) delete process.env.CODEX_APP_SERVER_PATH;
    else process.env.CODEX_APP_SERVER_PATH = originalAppServerPath;
    delete require.cache[require.resolve('../src/codex-app-server-skills')];
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});
