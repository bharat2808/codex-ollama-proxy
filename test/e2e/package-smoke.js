'use strict';

if (!process.env.NODE_TEST_CONTEXT) {

const fs = require('fs');
const path = require('path');
const {
  REPO_ROOT,
  executable,
  freshDirectory,
  installTarball,
  installedProxyCommand,
  run,
} = require('./helpers');

const temporary = freshDirectory('codex-proxy-package-');
let tarball = null;
try {
  const packed = run(executable('npm'), ['pack', '--json']);
  const metadata = JSON.parse(packed.stdout);
  if (!Array.isArray(metadata) || !metadata[0]?.filename) throw new Error('npm pack did not report a package filename.');
  tarball = path.resolve(REPO_ROOT, metadata[0].filename);

  const prefix = path.join(temporary, 'Install Prefix');
  installTarball(tarball, { global: true, prefix });
  const proxy = installedProxyCommand(prefix);
  const help = run(proxy, ['--help']);
  if (!help.stdout.includes('codex-ollama-proxy init')) throw new Error('Installed CLI did not print the expected help text.');

  const codexHome = path.join(temporary, 'Fresh Codex Home');
  run(proxy, ['init'], { env: { ...process.env, CODEX_HOME: codexHome } });
  if (!fs.existsSync(path.join(codexHome, 'ollama-shape-proxy', 'proxy-models.toml'))) {
    throw new Error('Installed CLI did not initialize its route configuration.');
  }
  console.log(`package_smoke=ok platform=${process.platform}`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
  if (tarball) fs.rmSync(tarball, { force: true });
}
}
