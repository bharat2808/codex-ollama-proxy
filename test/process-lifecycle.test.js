'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyProxyListeners,
  isVerifiedProxyCommand,
  requireVerifiedProxyListeners,
} = require('../src/process-lifecycle');

const INSTALLED_PROXY = '/opt/homebrew/lib/node_modules/codex-ollama-proxy/bin/codex-ollama-proxy';
const INSTALLED_UNIVERSAL_PROXY = '/opt/homebrew/lib/node_modules/codex-universal-proxy/bin/codex-universal-proxy';

test('recognizes both universal and legacy proxy entrypoints during migration', () => {
  assert.equal(
    isVerifiedProxyCommand(
      `/opt/homebrew/bin/node ${INSTALLED_UNIVERSAL_PROXY} serve`,
      [INSTALLED_UNIVERSAL_PROXY, INSTALLED_PROXY],
    ),
    true,
  );
  assert.equal(
    isVerifiedProxyCommand(
      `/opt/homebrew/bin/node ${INSTALLED_PROXY} serve`,
      [INSTALLED_UNIVERSAL_PROXY, INSTALLED_PROXY],
    ),
    true,
  );
});

test('recognizes installed codex-ollama-proxy serve commands', () => {
  assert.equal(
    isVerifiedProxyCommand('/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/codex-ollama-proxy/bin/codex-ollama-proxy serve', INSTALLED_PROXY),
    true,
  );
  assert.equal(
    isVerifiedProxyCommand(INSTALLED_PROXY + ' serve --preset glm-kimi', INSTALLED_PROXY),
    true,
  );
  assert.equal(
    isVerifiedProxyCommand('/usr/bin/node "/Users/Example/My Tools/node_modules/codex-ollama-proxy/bin/codex-ollama-proxy" serve', '/Users/Example/My Tools/node_modules/codex-ollama-proxy/bin/codex-ollama-proxy'),
    true,
  );
});

test('rejects unrelated or ambiguous process commands', () => {
  assert.equal(isVerifiedProxyCommand('/usr/bin/node /tmp/server.js serve'), false);
  assert.equal(isVerifiedProxyCommand('/usr/bin/python server.py codex-ollama-proxy serve'), false);
  assert.equal(
    isVerifiedProxyCommand('/usr/bin/node /tmp/node_modules/codex-ollama-proxy/bin/codex-ollama-proxy serve', INSTALLED_PROXY),
    false,
  );
  assert.equal(
    isVerifiedProxyCommand('/usr/bin/node /opt/homebrew/lib/node_modules/codex-ollama-proxy/bin/codex-ollama-proxy status', INSTALLED_PROXY),
    false,
  );
  assert.equal(isVerifiedProxyCommand(''), false);
});

test('classifies every listener before restart can replace it', () => {
  const commands = new Map([
    ['101', '/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/codex-ollama-proxy/bin/codex-ollama-proxy serve'],
    ['202', '/usr/bin/node /tmp/unrelated-server.js'],
  ]);

  assert.deepEqual(
    classifyProxyListeners(['101', '202'], (pid) => commands.get(pid) || '', INSTALLED_PROXY),
    {
      verified: [{ pid: '101', command: commands.get('101') }],
      unverified: [{ pid: '202', command: commands.get('202') }],
    },
  );
});

test('restart safety gate refuses the whole listener set when any owner is unverified', () => {
  const commands = new Map([
    ['101', '/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/codex-ollama-proxy/bin/codex-ollama-proxy serve'],
    ['202', '/usr/bin/node /tmp/unrelated-server.js'],
  ]);

  assert.throws(
    () => requireVerifiedProxyListeners(['101', '202'], (pid) => commands.get(pid) || '', INSTALLED_PROXY),
    /Refusing to stop unverified listener PID 202: \/usr\/bin\/node \/tmp\/unrelated-server\.js/u,
  );
  assert.deepEqual(
    requireVerifiedProxyListeners(['101'], (pid) => commands.get(pid) || '', INSTALLED_PROXY),
    ['101'],
  );
});
