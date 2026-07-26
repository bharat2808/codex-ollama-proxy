'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeCommandPreload(root) {
  const preload = path.join(root, 'command-preload.js');
  fs.writeFileSync(preload, `'use strict';
const fs = require('fs');
const path = require('path');
require('os').homedir = () => process.env.TEST_HOME;
if (typeof process.getuid !== 'function') process.getuid = () => 501;
require('child_process').spawnSync = (command, args = [], options = {}) => {
  if (process.env.COMMAND_LOG) {
    fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify({
      command: path.basename(String(command)),
      args: args.map(String),
    }) + '\\n');
  }
  const output = options.encoding ? '' : Buffer.alloc(0);
  return { pid: 123, status: 0, signal: null, stdout: output, stderr: output };
};
`, 'utf8');
  return preload;
}

function readCommands(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function includesCommand(commands, command, args) {
  return commands.some((entry) => entry.command === command && args.every((arg, index) => entry.args[index] === arg));
}

function installWithState(state) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launchd-home-'));
  const codexHome = path.join(home, '.codex');
  const runtimeDir = path.join(codexHome, 'ollama-shape-proxy');
  const commandLog = path.join(home, 'commands.log');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const preload = writeCommandPreload(home);
  if (state) {
    fs.writeFileSync(path.join(runtimeDir, 'launcher-state.json'), JSON.stringify(state), 'utf8');
  }

  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'),
    'install',
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      HOME: home,
      CODEX_HOME: codexHome,
      CODEX_PROXY_PLATFORM: 'darwin',
      COMMAND_LOG: commandLog,
      NODE_OPTIONS: `--require=${preload}`,
      TEST_HOME: home,
    }),
  });
  return {
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
    codexHome,
    plist: path.join(home, 'Library', 'LaunchAgents', 'com.user.codex-ollama-shape-proxy.plist'),
    result,
  };
}

function platformFixture(platform, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `codex-${platform}-launcher-`));
  const home = path.join(root, 'User Home');
  const codexHome = options.customCodexHome ? path.join(root, 'Custom Codex Home') : path.join(home, '.codex');
  const commandLog = path.join(root, 'commands.log');
  fs.mkdirSync(path.join(codexHome, 'ollama-shape-proxy'), { recursive: true });
  const preload = writeCommandPreload(root);
  const env = Object.assign({}, process.env, {
    CODEX_HOME: codexHome,
    CODEX_PROXY_PLATFORM: platform,
    CODEX_PROXY_START_TIMEOUT_MS: '25',
    COMMAND_LOG: commandLog,
    NODE_OPTIONS: `--require=${preload}`,
    TEST_HOME: home,
    USERPROFILE: home,
  });
  delete env.HOME;
  if (options.xdgConfigHome) env.XDG_CONFIG_HOME = path.join(root, 'xdg config');

  function runCommand(command) {
    return spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'codex-ollama-proxy'), command], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', env,
    });
  }
  return {
    codexHome,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    commandLog,
    env,
    home,
    root,
    runCommand,
  };
}

test('CLI install creates default launcher state and renders its proxy port', () => {
  const installed = installWithState(null);
  try {
    assert.equal(installed.result.status, 0, installed.result.stderr || installed.result.stdout);
    const plist = fs.readFileSync(installed.plist, 'utf8');
    assert.match(plist, /<key>PROXY_PORT<\/key>\s*<string>11436<\/string>/u);
    assert.match(plist, new RegExp(`<key>CODEX_HOME<\\/key>\\s*<string>${installed.codexHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/string>`, 'u'));
    assert.doesNotMatch(plist, /undefined/u);
  } finally {
    installed.cleanup();
  }
});

test('CLI install renders saved custom port and dedupe overrides', () => {
  const installed = installWithState({
    version: 1,
    adaptor: 'none',
    proxy_port: 61234,
    dedupe_large_input: false,
    dedupe_min_chars: 777,
  });
  try {
    assert.equal(installed.result.status, 0, installed.result.stderr || installed.result.stdout);
    const plist = fs.readFileSync(installed.plist, 'utf8');
    assert.match(plist, /<key>PROXY_PORT<\/key>\s*<string>61234<\/string>/u);
    assert.match(plist, /<string>--no-dedupe-large-input<\/string>/u);
    assert.match(plist, /<string>--dedupe-min-chars<\/string>\s*<string>777<\/string>/u);
  } finally {
    installed.cleanup();
  }
});

test('Linux install and uninstall honor XDG_CONFIG_HOME and persist a custom CODEX_HOME with spaces', () => {
  const fixture = platformFixture('linux', {
    customCodexHome: true,
    xdgConfigHome: true,
  });
  try {
    const installed = fixture.runCommand('install');
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const unit = path.join(fixture.root, 'xdg config', 'systemd', 'user', 'codex-ollama-proxy.service');
    assert.equal(fs.existsSync(unit), true);
    assert.match(fs.readFileSync(unit, 'utf8'), new RegExp(`Environment="CODEX_HOME=${fixture.codexHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'u'));
    let commands = readCommands(fixture.commandLog);
    assert.equal(includesCommand(commands, 'systemctl', ['--user', 'daemon-reload']), true);
    assert.equal(includesCommand(commands, 'systemctl', ['--user', 'enable', '--now', 'codex-ollama-proxy.service']), true);

    const restarted = fixture.runCommand('restart');
    assert.equal(restarted.status, 1, 'stubbed systemd does not start a proxy, so the health check should fail');
    commands = readCommands(fixture.commandLog);
    assert.equal(includesCommand(commands, 'systemctl', ['--user', 'stop', 'codex-ollama-proxy.service']), true);
    assert.equal(includesCommand(commands, 'systemctl', ['--user', 'enable', '--now', 'codex-ollama-proxy.service']), true);

    const uninstalled = fixture.runCommand('uninstall');
    assert.equal(uninstalled.status, 0, uninstalled.stderr || uninstalled.stdout);
    assert.equal(fs.existsSync(unit), false);
    commands = readCommands(fixture.commandLog);
    assert.equal(includesCommand(commands, 'systemctl', ['--user', 'disable', 'codex-ollama-proxy.service']), true);
  } finally {
    fixture.cleanup();
  }
});

test('Windows install and uninstall work without HOME and persist USERPROFILE-based CODEX_HOME paths', () => {
  const fixture = platformFixture('win32');
  try {
    delete fixture.env.CODEX_HOME;
    const installed = fixture.runCommand('install');
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const commandFile = path.join(fixture.home, '.codex', 'ollama-shape-proxy', 'start-proxy.cmd');
    assert.equal(fs.existsSync(commandFile), true);
    const command = fs.readFileSync(commandFile, 'utf8');
    assert.match(command, new RegExp(`set "CODEX_HOME=${path.join(fixture.home, '.codex').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'u'));
    let commands = readCommands(fixture.commandLog);
    assert.equal(includesCommand(commands, 'schtasks.exe', ['/Create', '/TN', 'Codex Ollama Proxy', '/SC', 'ONLOGON']), true);

    const restarted = fixture.runCommand('restart');
    assert.equal(restarted.status, 1, 'stubbed Task Scheduler does not start a proxy, so the health check should fail');
    commands = readCommands(fixture.commandLog);
    assert.equal(includesCommand(commands, 'netstat.exe', ['-ano', '-p', 'TCP']), true);
    assert.equal(includesCommand(commands, 'schtasks.exe', ['/Run', '/TN', 'Codex Ollama Proxy']), true);

    const uninstalled = fixture.runCommand('uninstall');
    assert.equal(uninstalled.status, 0, uninstalled.stderr || uninstalled.stdout);
    assert.equal(fs.existsSync(commandFile), false);
    commands = readCommands(fixture.commandLog);
    assert.equal(includesCommand(commands, 'schtasks.exe', ['/End', '/TN', 'Codex Ollama Proxy']), true);
    assert.equal(includesCommand(commands, 'schtasks.exe', ['/Delete', '/TN', 'Codex Ollama Proxy', '/F']), true);
  } finally {
    fixture.cleanup();
  }
});
