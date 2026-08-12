'use strict';

const voiceConfig = require('../voice-config');
const {
  streamKokoroAudio,
  transcribeAudio,
} = require('./local-speech');

function createLocalVoiceRuntime({
  configFile,
  modelCacheDir,
  readConfig = voiceConfig.read,
  transcribe = transcribeAudio,
  streamRender = streamKokoroAudio,
} = {}) {
  if (!configFile) throw new Error('voice configFile is required');
  if (!modelCacheDir) throw new Error('voice modelCacheDir is required');

  async function transcribePcm(pcm, context = {}) {
    const config = readConfig(configFile);
    if (!config.whisper_model) {
      throw new Error('Whisper model is not configured; run voice --whisper-model PATH');
    }
    return transcribe({
      pcm,
      sampleRate: context.sampleRate || 16000,
      modelId: config.whisper_model,
      cacheDir: modelCacheDir,
      dtype: config.whisper_dtype || 'q8',
      device: config.whisper_device || 'cpu',
    });
  }

  async function* streamSpeech(text) {
    const config = readConfig(configFile);
    yield* streamRender({
      text,
      cacheDir: modelCacheDir,
      modelId: config.kokoro_model,
      voice: config.kokoro_voice,
      dtype: config.kokoro_dtype,
      device: config.kokoro_device,
      speed: config.kokoro_speed,
    });
  }

  return {
    streamSpeech,
    transcribePcm,
  };
}

module.exports = {
  createLocalVoiceRuntime,
};
