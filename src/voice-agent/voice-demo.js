'use strict';

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const branding = require('../branding');
const launcherState = require('../launcher-state');
const runtimePaths = require('../runtime-paths');
const { JsonLineRpcClient } = require('./json-line-rpc');
const {
  KokoroSpeaker,
  recordMicrophoneAudio,
  transcribeAudio,
} = require('./local-speech');
const {
  SpeakableAgentMessages,
  VoiceAgentSession,
} = require('./voice-agent-session');

function parseVoiceArgs(argv) {
  const values = {};
  const names = {
    '--thread': 'threadId',
    '--audio': 'audioPath',
    '--whisper-model': 'whisperModel',
    '--voice': 'voice',
    '--kokoro-dtype': 'kokoroDtype',
    '--audio-device': 'audioDevice',
    '--cwd': 'cwd',
    '--codex-command': 'codexCommand',
    '--proxy-port': 'proxyPort',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = names[argv[index]];
    if (!name) throw new Error(`unknown voice demo option: ${argv[index]}`);
    const value = argv[++index];
    if (!value) throw new Error(`${argv[index - 1]} requires a value`);
    values[name] = value;
  }
  return values;
}

async function runVoiceDemo(options, dependencies = {}) {
  const rpc = dependencies.rpc;
  if (!rpc) throw new Error('rpc is required');
  const transcribe = dependencies.transcribe || transcribeAudio;
  const speaker = dependencies.speaker || new KokoroSpeaker({
    renderOptions: {
      voice: options.voice || 'af_heart',
      dtype: options.kokoroDtype || 'q8',
    },
  });
  const log = dependencies.log || console.log;
  const transcript = await transcribe({
    audioPath: options.audioPath,
    modelPath: options.whisperModel,
  });
  log(`transcript=${transcript}`);

  const collector = new SpeakableAgentMessages();
  const speech = [];
  const session = new VoiceAgentSession({ rpc });
  const result = await session.runTurn({
    threadId: options.threadId,
    cwd: options.cwd,
    transcript,
    onNotification(notification) {
      for (const text of collector.accept(notification)) {
        log(`codex=${text}`);
        speech.push(speaker.speak(text));
      }
    },
  });
  await Promise.all(speech);
  return result;
}

function appServerArgs({ proxyPort, modelCatalogPath }) {
  const baseUrl = `http://127.0.0.1:${proxyPort}/v1/`;
  return [
    'app-server',
    '--stdio',
    '-c', 'model_provider="codex-universal-proxy"',
    '-c', `model_catalog_json=${JSON.stringify(modelCatalogPath)}`,
    '-c', 'model_providers.codex-universal-proxy.name="Codex Universal Proxy"',
    '-c', `model_providers.codex-universal-proxy.base_url=${JSON.stringify(baseUrl)}`,
    '-c', 'model_providers.codex-universal-proxy.wire_api="responses"',
    '-c', 'model_providers.codex-universal-proxy.requires_openai_auth=true',
  ];
}

function activeProxySettings(options = {}) {
  const codexDir = runtimePaths.codexDir();
  const runtimeDir = branding.resolveRuntimeDirectory(codexDir);
  const state = launcherState.read(path.join(runtimeDir, 'launcher-state.json'));
  const proxyPort = Number(options.proxyPort || process.env.PROXY_PORT
    || (state && state.proxy_port) || launcherState.DEFAULT_PROXY_PORT);
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    throw new Error('voice demo proxy port must be an integer from 1 to 65535');
  }
  return {
    proxyPort,
    modelCatalogPath: path.join(codexDir, branding.MODEL_CATALOG_WORKING_FILENAME),
  };
}

function startAppServer(command = 'codex', options = {}) {
  const spawnProcess = options.spawnProcess || spawn;
  const child = spawnProcess(command, appServerArgs(activeProxySettings(options)), {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const rpc = new JsonLineRpcClient({
    input: child.stdout,
    output: child.stdin,
  });
  child.once('error', (error) => rpc.close(error));
  child.once('exit', (code, signal) => {
    const detail = signal ? `signal ${signal}` : `exit ${code}`;
    rpc.close(new Error(`Codex app-server closed (${detail})`));
  });
  return {
    child,
    rpc,
    close() {
      rpc.close();
      if (!child.killed) child.kill('SIGTERM');
    },
  };
}

function usage() {
  return [
    'Usage:',
    '  codex-voice-demo --whisper-model MODEL [--audio FILE] [--audio-device :0]',
    '                   [--thread ID] [--cwd PATH] [--voice af_heart] [--kokoro-dtype q8]',
    '',
    'When --audio is omitted, recording starts immediately and stops when Enter is pressed.',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return;
  }
  const options = parseVoiceArgs(argv);
  if (!options.whisperModel) throw new Error('--whisper-model is required');
  let recordedAudio = null;
  if (!options.audioPath) {
    recordedAudio = path.join(os.tmpdir(), `codex-voice-input-${randomUUID()}.wav`);
    options.audioPath = await recordMicrophoneAudio({
      outputPath: recordedAudio,
      device: options.audioDevice || ':0',
    });
  }
  const appServer = startAppServer(options.codexCommand, options);
  try {
    const result = await runVoiceDemo(options, { rpc: appServer.rpc });
    console.log(`thread_id=${result.threadId}`);
    console.log(`turn_status=${result.turn.status}`);
  } finally {
    appServer.close();
    if (recordedAudio) await fs.unlink(recordedAudio).catch(() => {});
  }
}

module.exports = {
  activeProxySettings,
  appServerArgs,
  main,
  parseVoiceArgs,
  runVoiceDemo,
  startAppServer,
  usage,
};
