'use strict';

const { execFile, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { resolveLocalCommand } = require('./local-command');

const execFileAsync = promisify(execFile);
const kokoroModels = new Map();

async function transcribeAudio({
  audioPath,
  modelPath,
  whisperCommand = 'whisper-cli',
  run = execFileAsync,
}) {
  if (!audioPath) throw new Error('audioPath is required');
  if (!modelPath) throw new Error('modelPath is required');
  const command = run === execFileAsync
    ? resolveLocalCommand(whisperCommand)
    : whisperCommand;
  const result = await run(command, [
    '--model', modelPath,
    '--file', audioPath,
    '--no-timestamps',
    '--no-prints',
  ]);
  const transcript = String(result.stdout || '').trim();
  if (!transcript) throw new Error('Whisper returned an empty transcript');
  return transcript;
}

async function loadKokoroModel(modelId, options) {
  const key = JSON.stringify([modelId, options]);
  if (!kokoroModels.has(key)) {
    const loading = Promise.resolve()
      .then(() => {
        // The CommonJS entry keeps kokoro-js's package-local __dirname, which
        // it uses to find bundled voice files such as voices/af_heart.bin.
        const { KokoroTTS } = require('kokoro-js');
        return KokoroTTS.from_pretrained(modelId, options);
      })
      .catch((error) => {
        kokoroModels.delete(key);
        throw error;
      });
    kokoroModels.set(key, loading);
  }
  return kokoroModels.get(key);
}

async function renderKokoroAudio({
  text,
  outputPath,
  voice = 'af_heart',
  speed = 1,
  modelId = 'onnx-community/Kokoro-82M-v1.0-ONNX',
  dtype = 'q8',
  device = 'cpu',
  loadModel = loadKokoroModel,
}) {
  if (!text || typeof text !== 'string') throw new Error('Kokoro text is required');
  if (!outputPath) throw new Error('Kokoro outputPath is required');
  const tts = await loadModel(modelId, { dtype, device });
  const audio = await tts.generate(text, { voice, speed });
  await audio.save(outputPath);
  return outputPath;
}

async function playAudio(audioPath, {
  command = 'afplay',
  run = execFileAsync,
} = {}) {
  if (!audioPath) throw new Error('audioPath is required');
  await run(command, [audioPath]);
}

async function waitForEnter({ signal } = {}) {
  const readline = require('node:readline/promises');
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    await terminal.question(
      'Recording… press Enter to stop.\n',
      signal ? { signal } : undefined,
    );
  } finally {
    terminal.close();
  }
}

async function recordMicrophoneAudio({
  outputPath,
  device = ':0',
  command = 'ffmpeg',
  spawnProcess = spawn,
  waitForStop = waitForEnter,
}) {
  if (!outputPath) throw new Error('recording outputPath is required');
  if (process.platform !== 'darwin' && spawnProcess === spawn) {
    throw new Error('the voice demo microphone recorder currently supports macOS only');
  }
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'avfoundation',
    '-i', device,
    '-ac', '1',
    '-ar', '16000',
    '-y', outputPath,
  ];
  const child = spawnProcess(command, args, {
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  const exited = new Promise((resolve) => {
    const onError = (error) => {
      child.off('exit', onExit);
      resolve({ error });
    };
    const onExit = (code, signal) => {
      child.off('error', onError);
      resolve({
        error: code === 0
          ? null
          : new Error(`ffmpeg recording failed (${signal || `exit ${code}`})`),
      });
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });

  const promptController = new AbortController();
  const prompt = Promise.resolve()
    .then(() => waitForStop({ signal: promptController.signal }))
    .then(
      () => ({ source: 'prompt', error: null }),
      (error) => ({ source: 'prompt', error }),
    );
  const childFinished = exited.then(({ error }) => ({ source: 'child', error }));
  const first = await Promise.race([prompt, childFinished]);
  if (first.source === 'child') {
    promptController.abort(first.error || new Error('ffmpeg recording stopped'));
    if (first.error) throw first.error;
    throw new Error('ffmpeg recording stopped before Enter was pressed');
  }

  let stopError = null;
  try {
    if (child.stdin && child.stdin.writable !== false) child.stdin.write('q\n');
    else if (typeof child.kill === 'function') child.kill('SIGTERM');
  } catch (error) {
    stopError = error;
    if (typeof child.kill === 'function') child.kill('SIGTERM');
  }
  const exitResult = await exited;
  if (first.error) throw first.error;
  if (stopError) throw stopError;
  if (exitResult.error) throw exitResult.error;
  return outputPath;
}

class KokoroSpeaker {
  constructor({
    render = renderKokoroAudio,
    play = playAudio,
    allocateOutputPath = () => path.join(os.tmpdir(), `codex-kokoro-${randomUUID()}.wav`),
    remove = (outputPath) => fs.unlink(outputPath),
    renderOptions = {},
  } = {}) {
    this.render = render;
    this.play = play;
    this.allocateOutputPath = allocateOutputPath;
    this.remove = remove;
    this.renderOptions = renderOptions;
    this.queue = Promise.resolve();
  }

  speak(text) {
    const job = this.queue.then(async () => {
      const outputPath = this.allocateOutputPath();
      try {
        await this.render({ ...this.renderOptions, text, outputPath });
        await this.play(outputPath);
      } finally {
        await this.remove(outputPath).catch(() => {});
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }
}

module.exports = {
  KokoroSpeaker,
  playAudio,
  recordMicrophoneAudio,
  renderKokoroAudio,
  transcribeAudio,
};
