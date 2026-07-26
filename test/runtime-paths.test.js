'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const runtimePaths = require('../src/runtime-paths');

test('Codex directory resolution prefers CODEX_HOME and otherwise uses the native OS home', () => {
  const originalHomedir = os.homedir;
  os.homedir = () => path.join(path.sep, 'native home');
  try {
    assert.equal(runtimePaths.codexDir({
      HOME: '/git-bash/home',
      USERPROFILE: 'C:\\Users\\Native',
    }), path.join(path.sep, 'native home', '.codex'));
    assert.equal(runtimePaths.codexDir({ CODEX_HOME: path.join(path.sep, 'custom codex') }), path.join(path.sep, 'custom codex'));
  } finally {
    os.homedir = originalHomedir;
  }
});

test('systemd user directory honors XDG_CONFIG_HOME', () => {
  assert.equal(
    runtimePaths.systemdUserDir({ XDG_CONFIG_HOME: '/custom config' }),
    path.join('/custom config', 'systemd', 'user'),
  );
});
