'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function executable(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function npmCliPath() {
  const nodeDirectory = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const npmCli = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!npmCli) throw new Error(`Could not locate npm-cli.js relative to ${process.execPath}.`);
  return npmCli;
}

function requiresWindowsShell(command, platform = process.platform) {
  return platform === 'win32' && /\.(?:bat|cmd)$/iu.test(command);
}

function commandForSpawn(command, platform = process.platform) {
  if (requiresWindowsShell(command, platform) && /\s/u.test(command)) return `"${command}"`;
  return command;
}

function run(command, args, options = {}) {
  const result = spawnSync(commandForSpawn(command), args, {
    cwd: options.cwd || REPO_ROOT,
    encoding: 'utf8',
    env: options.env || process.env,
    maxBuffer: 20 * 1024 * 1024,
    shell: requiresWindowsShell(command),
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${path.basename(command)} failed with exit code ${result.status}${output ? `:\n${output}` : ''}`);
  }
  return result;
}

function runNpm(args, options) {
  return run(process.execPath, [npmCliPath(), ...args], options);
}

function requiredEnvironment(names) {
  const values = {};
  for (const name of names) {
    const value = process.env[name];
    if (!value) throw new Error(`Required environment variable ${name} is not set.`);
    values[name] = value;
  }
  return values;
}

function newestTarball(directory = REPO_ROOT) {
  const candidates = fs.readdirSync(directory)
    .filter((name) => /^codex-ollama-proxy-.*\.tgz$/u.test(name))
    .map((name) => ({ file: path.join(directory, name), modified: fs.statSync(path.join(directory, name)).mtimeMs }))
    .sort((a, b) => b.modified - a.modified);
  if (!candidates.length) throw new Error(`No codex-ollama-proxy tarball found in ${directory}. Run npm pack first.`);
  return candidates[0].file;
}

function installTarball(tarball, options = {}) {
  const args = ['install'];
  if (options.global) args.push('--global');
  if (options.prefix) args.push('--prefix', options.prefix);
  args.push(tarball);
  runNpm(args);
}

function installedProxyCommand(prefix) {
  if (!prefix) return executable('codex-ollama-proxy');
  return process.platform === 'win32'
    ? path.join(prefix, 'codex-ollama-proxy.cmd')
    : path.join(prefix, 'bin', 'codex-ollama-proxy');
}

function waitForModels(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function probe() {
      const req = http.get({ host: '127.0.0.1', port, path: '/v1/models', timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) return resolve(res.statusCode);
        retry(`HTTP ${res.statusCode || 0}`);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (error) => retry(error.message));
    }
    function retry(lastError) {
      if (Date.now() >= deadline) return reject(new Error(`Proxy did not become ready on port ${port}: ${lastError}`));
      setTimeout(probe, 200);
    }
    probe();
  });
}

function startCaptured(command, args, options) {
  fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
  const output = fs.openSync(options.logFile, 'a');
  const child = spawn(commandForSpawn(command), args, {
    cwd: options.cwd || REPO_ROOT,
    env: options.env,
    shell: requiresWindowsShell(command),
    stdio: ['ignore', output, output],
    windowsHide: true,
  });
  child.once('exit', () => {
    try { fs.closeSync(output); } catch {}
  });
  return child;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { allowFailure: true });
  } else {
    try { child.kill('SIGTERM'); } catch {}
  }
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function redact(text, secrets) {
  let result = String(text || '');
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[REDACTED]');
  return result;
}

function copySanitizedText(source, destination, secrets) {
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, redact(fs.readFileSync(source, 'utf8'), secrets), 'utf8');
}

function collectDiagnostics({ artifactsDir, codexHome, extraFiles = [], secrets = [] }) {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const proxyLog = path.join(codexHome, 'ollama-shape-proxy', 'proxy.log');
  copySanitizedText(proxyLog, path.join(artifactsDir, 'proxy.log'), secrets);
  const codexLogDir = path.join(codexHome, 'log');
  if (fs.existsSync(codexLogDir)) {
    for (const file of fs.readdirSync(codexLogDir)) {
      copySanitizedText(path.join(codexLogDir, file), path.join(artifactsDir, 'codex-log', file), secrets);
    }
  }
  for (const file of extraFiles) {
    copySanitizedText(file, path.join(artifactsDir, path.basename(file)), secrets);
  }
}

function freshDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

module.exports = {
  REPO_ROOT,
  collectDiagnostics,
  executable,
  freshDirectory,
  installTarball,
  installedProxyCommand,
  newestTarball,
  commandForSpawn,
  redact,
  requiredEnvironment,
  run,
  runNpm,
  startCaptured,
  stopChild,
  waitForModels,
};
