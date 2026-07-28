'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function installWithState(state) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launchd-home-'));
  const codexHome = path.join(home, '.codex');
  const runtimeDir = path.join(codexHome, 'codex-universal-proxy');
  const stubBin = path.join(home, 'bin');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(stubBin, { recursive: true });
  const launchctl = path.join(stubBin, 'launchctl');
  fs.writeFileSync(launchctl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (state) {
    fs.writeFileSync(path.join(runtimeDir, 'launcher-state.json'), JSON.stringify(state), 'utf8');
  }

  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'bin', 'codex-universal-proxy'),
    'install',
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      HOME: home,
      CODEX_HOME: codexHome,
      CODEX_PROXY_PLATFORM: 'darwin',
      PATH: `${stubBin}:${process.env.PATH}`,
    }),
  });
  return {
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
    codexHome,
    plist: path.join(home, 'Library', 'LaunchAgents', 'com.user.codex-universal-proxy.plist'),
    result,
  };
}

function platformFixture(platform, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `codex-${platform}-launcher-`));
  const home = path.join(root, 'User Home');
  const codexHome = options.customCodexHome ? path.join(root, 'Custom Codex Home') : path.join(home, '.codex');
  const stubBin = path.join(root, 'stub bin');
  const commandLog = path.join(root, 'commands.log');
  const preload = path.join(root, 'preload.js');
  fs.mkdirSync(path.join(codexHome, 'codex-universal-proxy'), { recursive: true });
  fs.mkdirSync(stubBin, { recursive: true });
  const preloadLines = [`require('os').homedir = () => process.env.TEST_HOME;`];
  if (process.platform === 'win32') {
    preloadLines.push(`
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const events = require('events');
const originalSpawnSync = childProcess.spawnSync;
const originalSpawn = childProcess.spawn;
const stubbedCommands = new Set(['cmd', 'reg', 'schtasks', 'netstat', 'powershell']);
childProcess.spawnSync = (command, args = [], options) => {
  const commandName = path.basename(command).replace(/\\.(?:cmd|exe)$/iu, '');
  if (!stubbedCommands.has(commandName)) return originalSpawnSync(command, args, options);
  fs.appendFileSync(process.env.COMMAND_LOG,
    commandName + args.map((arg) => \` <\${arg}>\`).join('') + '\\n');
  if (process.env.FAIL_SCHTASKS_CREATE === '1'
      && commandName === 'schtasks'
      && args.includes('/Create')) {
    return { error: undefined, status: 1, signal: null, stdout: '', stderr: 'ERROR: Access is denied.\\r\\n' };
  }
  return { error: undefined, status: 0, signal: null, stdout: '', stderr: '' };
};
childProcess.spawn = (command, args = [], options) => {
  const commandName = path.basename(command).replace(/\\.(?:cmd|exe)$/iu, '');
  if (!stubbedCommands.has(commandName)) return originalSpawn(command, args, options);
  fs.appendFileSync(process.env.COMMAND_LOG,
    commandName + args.map((arg) => \` <\${arg}>\`).join('') + '\\n');
  const child = new events.EventEmitter();
  child.pid = 12345;
  child.unref = () => {};
  return child;
};`);
  }
  fs.writeFileSync(preload, `${preloadLines.join('\n')}\n`, 'utf8');
  for (const command of ['systemctl', 'cmd', 'reg', 'schtasks', 'netstat', 'powershell']) {
    if (process.platform === 'win32') {
      const batch = '@echo off\r\nsetlocal EnableDelayedExpansion\r\nset "line=%~n0"\r\n:args\r\nif "%~1"=="" goto done\r\nset "line=!line! ^<%~1^>"\r\nshift\r\ngoto args\r\n:done\r\necho(!line!>>"%COMMAND_LOG%"\r\n';
      fs.writeFileSync(path.join(stubBin, `${command}.cmd`), batch, 'utf8');
    } else {
      fs.writeFileSync(path.join(stubBin, command), '#!/bin/sh\nprintf "%s" "$(basename "$0")" >> "$COMMAND_LOG"\nprintf " <%s>" "$@" >> "$COMMAND_LOG"\nprintf "\\n" >> "$COMMAND_LOG"\nexit 0\n', { mode: 0o755 });
    }
  }
  const env = Object.assign({}, process.env, {
    CODEX_HOME: codexHome,
    CODEX_PROXY_PLATFORM: platform,
    CODEX_PROXY_START_TIMEOUT_MS: '25',
    COMMAND_LOG: commandLog,
    NODE_OPTIONS: `--require=${preload}`,
    PATH: `${stubBin}:${process.env.PATH}`,
    TEST_HOME: home,
    USERPROFILE: home,
  });
  delete env.HOME;
  if (options.xdgConfigHome) env.XDG_CONFIG_HOME = path.join(root, 'xdg config');
  if (options.failSchtasksCreate) env.FAIL_SCHTASKS_CREATE = '1';

  function runCommand(command) {
    return spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'codex-universal-proxy'), command], {
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

test('CLI install creates default launcher state and renders its proxy port', {
  skip: process.platform !== 'darwin',
}, () => {
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

test('CLI install renders saved custom port and dedupe overrides', {
  skip: process.platform !== 'darwin',
}, () => {
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

test('Linux install and uninstall honor XDG_CONFIG_HOME and persist a custom CODEX_HOME with spaces', {
  skip: process.platform !== 'linux',
}, () => {
  const fixture = platformFixture('linux', {
    customCodexHome: true,
    xdgConfigHome: true,
  });
  try {
    const installed = fixture.runCommand('install');
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const unit = path.join(fixture.root, 'xdg config', 'systemd', 'user', 'codex-universal-proxy.service');
    assert.equal(fs.existsSync(unit), true);
    const unitText = fs.readFileSync(unit, 'utf8');
    const systemdCodexHome = fixture.codexHome.replace(/\\/gu, '\\\\');
    assert.equal(
      unitText.includes(`Environment="CODEX_HOME=${systemdCodexHome}"`),
      true
    );
    assert.match(fs.readFileSync(fixture.commandLog, 'utf8'), /systemctl <--user> <daemon-reload>\nsystemctl <--user> <enable> <--now> <codex-universal-proxy\.service>/u);

    const restarted = fixture.runCommand('restart');
    assert.equal(restarted.status, 1, 'stubbed systemd does not start a proxy, so the health check should fail');
    assert.match(fs.readFileSync(fixture.commandLog, 'utf8'), /systemctl <--user> <stop> <codex-universal-proxy\.service>.*systemctl <--user> <enable> <--now> <codex-universal-proxy\.service>/su);

    const uninstalled = fixture.runCommand('uninstall');
    assert.equal(uninstalled.status, 0, uninstalled.stderr || uninstalled.stdout);
    assert.equal(fs.existsSync(unit), false);
    assert.match(fs.readFileSync(fixture.commandLog, 'utf8'), /systemctl <--user> <stop> <codex-universal-proxy\.service>.*systemctl <--user> <disable> <codex-universal-proxy\.service>/su);
  } finally {
    fixture.cleanup();
  }
});

test('Windows install and uninstall work without HOME and persist USERPROFILE-based CODEX_HOME paths', {
  skip: process.platform !== 'win32',
}, () => {
  const fixture = platformFixture('win32');
  try {
    delete fixture.env.CODEX_HOME;
    const installed = fixture.runCommand('install');
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const commandFile = path.join(fixture.home, '.codex', 'codex-universal-proxy', 'start-proxy.cmd');
    assert.equal(fs.existsSync(commandFile), true);
    const command = fs.readFileSync(commandFile, 'utf8');
    assert.match(command, new RegExp(`set "CODEX_HOME=${path.join(fixture.home, '.codex').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'u'));
    assert.match(fs.readFileSync(fixture.commandLog, 'utf8'), /schtasks <\/Create> <\/TN> <Codex Universal Proxy> <\/SC> <ONLOGON> <\/TR> <cmd\.exe \/d \/c/u);

    const restarted = fixture.runCommand('restart');
    assert.equal(restarted.status, 1, 'stubbed Task Scheduler does not start a proxy, so the health check should fail');
    assert.match(fs.readFileSync(fixture.commandLog, 'utf8'), /netstat <-ano> <-p> <TCP>.*schtasks <\/Create>.*schtasks <\/Run> <\/TN> <Codex Universal Proxy>/su);

    const uninstalled = fixture.runCommand('uninstall');
    assert.equal(uninstalled.status, 0, uninstalled.stderr || uninstalled.stdout);
    assert.equal(fs.existsSync(commandFile), false);
    assert.match(fs.readFileSync(fixture.commandLog, 'utf8'), /schtasks <\/End> <\/TN> <Codex Universal Proxy>.*schtasks <\/Delete> <\/TN> <Codex Universal Proxy> <\/F>/su);
  } finally {
    fixture.cleanup();
  }
});

test('Windows install falls back to HKCU Run when Task Scheduler creation is denied', {
  skip: process.platform !== 'win32',
}, () => {
  const fixture = platformFixture('win32', { failSchtasksCreate: true });
  try {
    const installed = fixture.runCommand('install');
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    assert.match(installed.stderr, /Task Scheduler registration failed: Access is denied\./u);
    assert.match(installed.stdout, /startup=hkcu_run/u);
    const commandFile = path.join(fixture.codexHome, 'codex-universal-proxy', 'start-proxy.cmd');
    assert.equal(fs.existsSync(commandFile), true);
    assert.match(
      fs.readFileSync(fixture.commandLog, 'utf8'),
      /schtasks <\/Create>.*reg <ADD> <HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run>.*cmd <\/d> <\/c>/su
    );

    const uninstalled = fixture.runCommand('uninstall');
    assert.equal(uninstalled.status, 0, uninstalled.stderr || uninstalled.stdout);
    assert.equal(fs.existsSync(commandFile), false);
    assert.match(
      fs.readFileSync(fixture.commandLog, 'utf8'),
      /reg <DELETE> <HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run> <\/v> <Codex Universal Proxy> <\/f>/u
    );
  } finally {
    fixture.cleanup();
  }
});
