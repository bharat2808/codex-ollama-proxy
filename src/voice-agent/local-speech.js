'use strict';

const { execFile } = require('node:child_process');
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

async function* streamKokoroAudio({
  text,
  voice = 'af_heart',
  speed = 1,
  modelId = 'onnx-community/Kokoro-82M-v1.0-ONNX',
  dtype = 'q8',
  device = 'cpu',
  loadModel = loadKokoroModel,
}) {
  if (!text || typeof text !== 'string') throw new Error('Kokoro text is required');
  const tts = await loadModel(modelId, { dtype, device });
  const { TextSplitterStream } = require('kokoro-js');
  const splitter = new TextSplitterStream();
  const generated = tts.stream(splitter, { voice, speed });
  splitter.push(text);
  splitter.close();
  for await (const chunk of generated) {
    const raw = chunk && chunk.audio;
    if (
      !raw
      || !(raw.audio instanceof Float32Array)
      || !Number.isInteger(raw.sampling_rate)
      || raw.sampling_rate <= 0
    ) {
      throw new Error('Kokoro stream returned invalid audio');
    }
    const pcmView = Buffer.from(
      raw.audio.buffer,
      raw.audio.byteOffset,
      raw.audio.byteLength,
    );
    yield {
      text: String(chunk.text || ''),
      pcm: Buffer.from(pcmView),
      sampleRate: raw.sampling_rate,
    };
  }
}

module.exports = {
  streamKokoroAudio,
  transcribeAudio,
};
