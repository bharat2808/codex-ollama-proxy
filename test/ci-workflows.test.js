'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const workflows = path.join(__dirname, '..', '.github', 'workflows');

function read(name) {
  return fs.readFileSync(path.join(workflows, name), 'utf8');
}

test('secret-free CI covers Linux, Windows, macOS, tests, and packed-package startup', () => {
  const workflow = read('ci.yml');
  for (const runner of ['ubuntu-latest', 'windows-latest', 'macos-latest']) assert.match(workflow, new RegExp(runner, 'u'));
  for (const command of ['npm run check', 'node --test', 'node test/e2e/package-smoke.js']) {
    assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
  assert.doesNotMatch(workflow, /secrets\./u);
  assert.doesNotMatch(workflow, /pull_request_target/u);
});

test('live Codex workflow is protected, scheduled or manual only, and scopes its provider secret to one step', () => {
  const workflow = read('codex-live.yml');
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /schedule:/u);
  assert.doesNotMatch(workflow, /pull_request(?:_target)?:/u);
  assert.match(workflow, /environment: proxy-live-test/u);
  assert.match(workflow, /permissions:\n  contents: read/u);
  assert.match(workflow, /npm install --global @openai\/codex@latest/u);
  assert.match(workflow, /node test\/e2e\/codex-live\.js/u);
  assert.equal((workflow.match(/secrets\.PROXY_TEST_API_KEY/gu) || []).length, 1);
});

test('native services run separately on Windows and a labeled self-hosted Linux runner', () => {
  const workflow = read('native-services.yml');
  assert.match(workflow, /runs-on: windows-latest/u);
  assert.match(workflow, /- self-hosted\n      - linux\n      - codex-proxy-systemd/u);
  assert.match(workflow, /node test\/e2e\/native-service\.js/gu);
  assert.doesNotMatch(workflow, /pull_request(?:_target)?:/u);
});
