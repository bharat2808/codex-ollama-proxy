'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { prepareVoiceRuntime } = require('../src/voice-agent/voice-setup');

test('voice setup verifies packaged FFmpeg and warms both managed speech models', async () => {
  const calls = [];
  const result = await prepareVoiceRuntime({
    config: {
      whisper_model: 'onnx-community/whisper-base.en',
      whisper_dtype: 'q8',
      whisper_device: 'cpu',
      kokoro_model: 'onnx-community/Kokoro-82M-v1.0-ONNX',
      kokoro_voice: 'af_heart',
      kokoro_dtype: 'q8',
      kokoro_device: 'cpu',
      kokoro_speed: 1,
    },
    cacheDir: '/managed/voice-models',
    resolveFfmpeg: () => '/package/ffmpeg',
    inspectFfmpeg: async (command) => {
      calls.push(['ffmpeg', command]);
      return 'A....D libopus libopus Opus';
    },
    loadWhisper: async (options) => {
      calls.push(['whisper', options]);
      return async (audio) => {
        calls.push(['transcribe', audio.length]);
        return { text: '' };
      };
    },
    loadKokoro: async (modelId, options) => {
      calls.push(['kokoro', modelId, options]);
      return {
        async generate(text, options) {
          calls.push(['synthesize', text, options]);
          return { audio: new Float32Array([0]), sampling_rate: 24000 };
        },
      };
    },
  });

  assert.deepEqual(result, {
    cacheDir: '/managed/voice-models',
    ffmpeg: '/package/ffmpeg',
    kokoroModel: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    whisperModel: 'onnx-community/whisper-base.en',
  });
  assert.deepEqual(calls, [
    ['ffmpeg', '/package/ffmpeg'],
    ['whisper', {
      modelId: 'onnx-community/whisper-base.en',
      cacheDir: '/managed/voice-models',
      dtype: 'q8',
      device: 'cpu',
    }],
    ['transcribe', 16000],
    ['kokoro', 'onnx-community/Kokoro-82M-v1.0-ONNX', {
      cacheDir: '/managed/voice-models',
      dtype: 'q8',
      device: 'cpu',
    }],
    ['synthesize', 'Voice ready.', { voice: 'af_heart', speed: 1 }],
  ]);
});

test('voice setup rejects a packaged FFmpeg build without libopus', async () => {
  await assert.rejects(prepareVoiceRuntime({
    config: {},
    cacheDir: '/managed/voice-models',
    resolveFfmpeg: () => '/package/ffmpeg',
    inspectFfmpeg: async () => 'A....D opus Opus',
  }), /does not provide the required libopus encoder/u);
});
