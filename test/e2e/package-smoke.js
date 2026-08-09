'use strict';

if (!process.env.NODE_TEST_CONTEXT) {

const fs = require('fs');
const path = require('path');
const {
  REPO_ROOT,
  freshDirectory,
  installTarball,
  installedProxyCommand,
  run,
  runNpm,
} = require('./helpers');

const temporary = freshDirectory('codex-proxy-package-');
let tarball = null;
try {
  const packed = runNpm(['pack', '--json']);
  const metadata = JSON.parse(packed.stdout);
  if (!Array.isArray(metadata) || !metadata[0]?.filename) throw new Error('npm pack did not report a package filename.');
  tarball = path.resolve(REPO_ROOT, metadata[0].filename);

  const prefix = path.join(temporary, 'Install Prefix');
  installTarball(tarball, { global: true, prefix });
  const proxy = installedProxyCommand(prefix);
  const help = run(proxy, ['--help']);
  if (!help.stdout.includes('codex-universal-proxy init')) throw new Error('Installed CLI did not print the expected help text.');
  const legacyProxy = installedProxyCommand(prefix, 'codex-ollama-proxy');
  const legacyHelp = run(legacyProxy, ['--help']);
  if (!legacyHelp.stdout.includes('codex-universal-proxy init')) throw new Error('Legacy CLI alias did not invoke the universal proxy.');

  const packageDirectory = process.platform === 'win32'
    ? path.join(prefix, 'node_modules', 'codex-universal-proxy')
    : path.join(prefix, 'lib', 'node_modules', 'codex-universal-proxy');
  const packagedVoice = run(process.execPath, ['-e', [
    "const { execFileSync } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const { createRequire } = require('node:module');",
    "const os = require('node:os');",
    "const path = require('node:path');",
    "const root = process.argv[1];",
    "const packageRequire = createRequire(path.join(root, 'package.json'));",
    "const { resolvePackagedFfmpeg } = require(path.join(root, 'src/voice-agent/voice-dependencies'));",
    "const ffmpeg = resolvePackagedFfmpeg();",
    "const encoders = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });",
    "if (!/\\blibopus\\b/u.test(encoders)) throw new Error('packaged FFmpeg lacks libopus');",
    "packageRequire('@huggingface/transformers');",
    "packageRequire('kokoro-js');",
    "const { buildHelper } = require(path.join(root, 'src/voice-agent/macos-interruption-key'));",
    "const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-voice-helper-'));",
    "try {",
    "  const helper = buildHelper(helperDir, { compile: (_command, args) => { fs.copyFileSync(args[0], args[2]); return { status: 0 }; } });",
    "  if (!helper || !fs.existsSync(helper)) throw new Error('packaged push-to-talk helper did not build');",
    "} finally { fs.rmSync(helperDir, { recursive: true, force: true }); }",
    "console.log('packaged_voice=ok');",
  ].join(''), packageDirectory], {
    env: { ...process.env, PATH: '' },
  });
  if (!packagedVoice.stdout.includes('packaged_voice=ok')) {
    throw new Error('Packaged voice dependencies did not load with a clean PATH.');
  }

  const codexHome = path.join(temporary, 'Fresh Codex Home');
  run(proxy, ['init'], { env: { ...process.env, CODEX_HOME: codexHome } });
  if (!fs.existsSync(path.join(codexHome, 'codex-universal-proxy', 'proxy-models.toml'))) {
    throw new Error('Installed CLI did not initialize its route configuration.');
  }
  const voiceStatus = run(process.execPath, [proxy, 'voice', '--status'], {
    env: { ...process.env, CODEX_HOME: codexHome, PATH: '' },
  });
  if (!voiceStatus.stdout.includes('whisper_model = "onnx-community/whisper-base.en"')) {
    throw new Error('Fresh package did not configure managed Whisper.');
  }
  console.log(`package_smoke=ok platform=${process.platform}`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
  if (tarball) fs.rmSync(tarball, { force: true });
}
}
