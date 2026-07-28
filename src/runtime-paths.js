'use strict';

const os = require('os');
const path = require('path');

function homeDir() {
  return os.homedir();
}

function codexDir(env = process.env) {
  return env.CODEX_HOME || path.join(homeDir(), '.codex');
}

function systemdUserDir(env = process.env) {
  const configHome = env.XDG_CONFIG_HOME || path.join(homeDir(), '.config');
  return path.join(configHome, 'systemd', 'user');
}

module.exports = {
  codexDir,
  homeDir,
  systemdUserDir,
};
