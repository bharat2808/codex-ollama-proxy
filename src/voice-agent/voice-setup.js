'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolvePackagedFfmpeg } = require('./voice-dependencies');
const { loadKokoroModel, loadWhisperPipeline } = require('./local-speech');

const execFileAsync = promisify(execFile);

async function inspectPackagedFfmpeg(command) {
  const result = await execFileAsync(command, ['-hide_banner', '-encoders'], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return String(result.stdout || '') + String(result.stderr || '');
}

async function prepareVoiceRuntime({
  config,
  cacheDir,
  resolveFfmpeg = resolvePackagedFfmpeg,
  inspectFfmpeg = inspectPackagedFfmpeg,
  loadWhisper = loadWhisperPipeline,
  loadKokoro = loadKokoroModel,
} = {}) {
  if (!config || typeof config !== 'object') throw new Error('voice configuration is required');
  if (!cacheDir) throw new Error('voice model cache is required');
  const ffmpeg = resolveFfmpeg();
  const encoders = await inspectFfmpeg(ffmpeg);
  if (!/\blibopus\b/u.test(String(encoders))) {
    throw new Error('packaged FFmpeg does not provide the required libopus encoder');
  }

  const whisperModel = String(config.whisper_model || '').trim();
  const kokoroModel = String(config.kokoro_model || '').trim();
  if (!whisperModel) throw new Error('Whisper model is not configured');
  if (!kokoroModel) throw new Error('Kokoro model is not configured');

  const transcribe = await loadWhisper({
    modelId: whisperModel,
    cacheDir,
    dtype: config.whisper_dtype || 'q8',
    device: config.whisper_device || 'cpu',
  });
  const transcription = await transcribe(new Float32Array(16000));
  if (!transcription || typeof transcription.text !== 'string') {
    throw new Error('packaged Whisper returned an invalid diagnostic result');
  }

  const kokoro = await loadKokoro(kokoroModel, {
    cacheDir,
    dtype: config.kokoro_dtype || 'q8',
    device: config.kokoro_device || 'cpu',
  });
  const synthesized = await kokoro.generate('Voice ready.', {
    voice: config.kokoro_voice || 'af_heart',
    speed: config.kokoro_speed || 1,
  });
  if (!synthesized || !(synthesized.audio instanceof Float32Array)
    || !Number.isInteger(synthesized.sampling_rate)) {
    throw new Error('packaged Kokoro returned invalid diagnostic audio');
  }

  return { cacheDir, ffmpeg, kokoroModel, whisperModel };
}

module.exports = {
  inspectPackagedFfmpeg,
  prepareVoiceRuntime,
};
