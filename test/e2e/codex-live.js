'use strict';

if (!process.env.NODE_TEST_CONTEXT) {

const crypto = require('crypto');
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
  startCaptured,
  stopChild,
  waitForModels,
} = require('./helpers');

const PORT = 21436;
const artifactsDir = path.join(REPO_ROOT, 'integration-artifacts');
const temporary = freshDirectory('codex-proxy-live-');
const codexHome = path.join(temporary, 'Fresh Codex Home');
const workspace = path.join(temporary, 'Disposable Repository');
const proxyCapture = path.join(temporary, 'proxy-foreground.log');
const driverCapture = path.join(temporary, 'driver.log');
let proxy = null;

async function main() {
  const variables = requiredEnvironment(['PROXY_TEST_API_KEY', 'PROXY_TEST_URL', 'PROXY_TEST_MODEL']);
  fs.rmSync(artifactsDir, { recursive: true, force: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '', { flag: 'a' });

  installTarball(newestTarball(), { global: true });
  const proxyCommand = executable('codex-universal-proxy');
  const codexCommand = executable('codex');
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    PROXY_PORT: String(PORT),
  };

  run(proxyCommand, ['init'], { env });
  const presetArgs = [
    'preset', 'add', 'ci-provider',
    '--url', variables.PROXY_TEST_URL,
    '--text-model', variables.PROXY_TEST_MODEL,
    '--api-key', variables.PROXY_TEST_API_KEY,
  ];
  if (process.env.PROXY_TEST_ADAPTOR) presetArgs.push('--adaptor', process.env.PROXY_TEST_ADAPTOR);
  run(proxyCommand, presetArgs, { env });

  proxy = startCaptured(proxyCommand, ['run', 'ci-provider', '--foreground', '--no-refresh'], {
    cwd: workspace,
    env,
    logFile: proxyCapture,
  });
  await waitForModels(PORT);

  run(executable('git'), ['init'], { cwd: workspace, env });
  const secretValue = `SHELL_PROXY_OK_${crypto.randomBytes(12).toString('hex')}`;
  fs.writeFileSync(path.join(workspace, 'secret-value.txt'), secretValue + '\n', 'utf8');

  const codexEnv = { ...env, CODEX_API_KEY: process.env.CODEX_API_KEY || 'codex-proxy-ci-placeholder' };
  const basicResult = path.join(workspace, 'basic-result.txt');
  const basic = run(codexCommand, [
    'exec', '--model', variables.PROXY_TEST_MODEL,
    '--sandbox', 'read-only',
    '-o', basicResult,
    'Use the shell tool to read secret-value.txt. Return only the exact file contents.',
  ], { cwd: workspace, env: codexEnv });
  fs.appendFileSync(driverCapture, `basic stdout:\n${basic.stdout}\nbasic stderr:\n${basic.stderr}\n`, 'utf8');
  if (fs.readFileSync(basicResult, 'utf8').trim() !== secretValue) {
    throw new Error('Codex shell-tool result did not exactly match secret-value.txt.');
  }

  const patchResult = path.join(workspace, 'patch-result.txt');
  const patch = run(codexCommand, [
    'exec', '--model', variables.PROXY_TEST_MODEL,
    '--sandbox', 'workspace-write',
    '-o', patchResult,
    'Use apply_patch to create proxy-result.txt containing exactly APPLY_PATCH_PROXY_OK.',
  ], { cwd: workspace, env: codexEnv });
  fs.appendFileSync(driverCapture, `patch stdout:\n${patch.stdout}\npatch stderr:\n${patch.stderr}\n`, 'utf8');
  if (!/apply_patch/iu.test(`${patch.stdout}\n${patch.stderr}`)) {
    throw new Error('Codex output did not show the required apply_patch tool invocation.');
  }
  const created = path.join(workspace, 'proxy-result.txt');
  if (!fs.existsSync(created) || fs.readFileSync(created, 'utf8').trim() !== 'APPLY_PATCH_PROXY_OK') {
    throw new Error('Codex did not create the expected proxy-result.txt through apply_patch.');
  }
  console.log(`codex_live=ok platform=${process.platform}`);
}

(async () => {
  let failure = null;
  try {
    await main();
  } catch (error) {
    failure = error;
  } finally {
    await stopChild(proxy);
    collectDiagnostics({
      artifactsDir,
      codexHome,
      extraFiles: [proxyCapture, driverCapture],
      secrets: [process.env.PROXY_TEST_API_KEY, process.env.CODEX_API_KEY],
    });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  if (failure) throw failure;
})().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
}
