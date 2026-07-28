'use strict';

if (!process.env.NODE_TEST_CONTEXT) {

const fs = require('fs');
const path = require('path');
const {
  REPO_ROOT,
  collectDiagnostics,
  executable,
  freshDirectory,
  installTarball,
  newestTarball,
  requiredEnvironment,
  run,
  waitForModels,
} = require('./helpers');

const PORT = 21436;
const artifactsDir = path.join(REPO_ROOT, 'integration-artifacts');
const temporary = freshDirectory('codex-proxy-service-');
const codexHome = path.join(temporary, 'Fresh Codex Home');
let proxyCommand = null;
let env = null;

async function main() {
  if (!['linux', 'win32'].includes(process.platform)) {
    throw new Error(`Native service integration is not supported on ${process.platform}.`);
  }
  const variables = requiredEnvironment(['PROXY_TEST_API_KEY', 'PROXY_TEST_URL', 'PROXY_TEST_MODEL']);
  fs.rmSync(artifactsDir, { recursive: true, force: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '', 'utf8');
  installTarball(newestTarball(), { global: true });
  proxyCommand = executable('codex-universal-proxy');
  env = { ...process.env, CODEX_HOME: codexHome, PROXY_PORT: String(PORT) };

  run(proxyCommand, ['init'], { env });
  const presetArgs = [
    'preset', 'add', 'ci-provider',
    '--url', variables.PROXY_TEST_URL,
    '--text-model', variables.PROXY_TEST_MODEL,
    '--api-key', variables.PROXY_TEST_API_KEY,
  ];
  if (process.env.PROXY_TEST_ADAPTOR) presetArgs.push('--adaptor', process.env.PROXY_TEST_ADAPTOR);
  run(proxyCommand, presetArgs, { env });
  run(proxyCommand, ['preset', 'use', 'ci-provider', '--no-start', '--no-refresh'], { env });
  run(proxyCommand, ['install'], { env });

  if (process.platform === 'win32') {
    run('schtasks.exe', ['/Query', '/TN', 'Codex Universal Proxy'], { env });
  } else {
    run('systemctl', ['--user', 'status', 'codex-universal-proxy.service', '--no-pager'], { env });
  }
  await waitForModels(PORT);
  run(proxyCommand, ['restart'], { env });
  await waitForModels(PORT);
  console.log(`native_service=ok platform=${process.platform}`);
}

(async () => {
  let failure = null;
  try {
    await main();
  } catch (error) {
    failure = error;
  } finally {
    if (proxyCommand && env) run(proxyCommand, ['uninstall'], { env, allowFailure: true });
    collectDiagnostics({
      artifactsDir,
      codexHome,
      secrets: [process.env.PROXY_TEST_API_KEY],
    });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  if (failure) throw failure;
})().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
}
