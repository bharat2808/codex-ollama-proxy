'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const voiceConfig = require('../voice-config');
const {
  streamKokoroAudio,
  transcribeAudio,
} = require('./local-speech');
const { pcm16ToWav } = require('./voice-audio');

function createLocalVoiceRuntime({
  configFile,
  readConfig = voiceConfig.read,
  transcribe = transcribeAudio,
  streamRender = streamKokoroAudio,
  allocatePath = (kind) => path.join(os.tmpdir(), `codex-local-voice-${kind}-${randomUUID()}.wav`),
  writeFile = fs.writeFile,
  unlink = fs.unlink,
} = {}) {
  if (!configFile) throw new Error('voice configFile is required');

  async function transcribePcm(pcm, context = {}) {
    const config = readConfig(configFile);
    if (!config.whisper_model) {
      throw new Error('Whisper model is not configured; run voice --whisper-model PATH');
    }
    const audioPath = allocatePath('input');
    try {
      await writeFile(audioPath, pcm16ToWav(pcm, {
        sampleRate: context.sampleRate || 16000,
      }));
      return await transcribe({
        audioPath,
        modelPath: config.whisper_model,
        whisperCommand: config.whisper_command || 'whisper-cli',
      });
    } finally {
      await unlink(audioPath).catch(() => {});
    }
  }

  async function* streamSpeech(text) {
    const config = readConfig(configFile);
    yield* streamRender({
      text,
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
