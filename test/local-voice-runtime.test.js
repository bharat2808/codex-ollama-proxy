'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createLocalVoiceRuntime } = require('../src/voice-agent/local-voice-runtime');

test('local voice runtime passes PCM to packaged Whisper with the managed model cache', async () => {
  const calls = [];
  const runtime = createLocalVoiceRuntime({
    configFile: '/config/voice.toml',
    modelCacheDir: '/managed/voice-models',
    readConfig() {
      return {
        whisper_model: 'onnx-community/whisper-base.en',
        whisper_dtype: 'q8',
        whisper_device: 'cpu',
      };
    },
    transcribe: async (options) => {
      calls.push(options);
      return 'hello Codex';
    },
  });

  const result = await runtime.transcribePcm(
    Buffer.from([1, 0, 2, 0]),
    { sampleRate: 24000 },
  );

  assert.equal(result, 'hello Codex');
  assert.deepEqual(calls, [{
    pcm: Buffer.from([1, 0, 2, 0]),
    sampleRate: 24000,
    modelId: 'onnx-community/whisper-base.en',
    cacheDir: '/managed/voice-models',
    dtype: 'q8',
    device: 'cpu',
  }]);
});

test('local voice runtime streams Kokoro sentence PCM using current configuration', async () => {
  const calls = [];
  const runtime = createLocalVoiceRuntime({
    configFile: '/config/voice.toml',
    modelCacheDir: '/managed/voice-models',
    readConfig() {
      return {
        kokoro_model: 'local/kokoro',
        kokoro_voice: 'bf_emma',
        kokoro_dtype: 'fp32',
        kokoro_device: 'cpu',
        kokoro_speed: 1.2,
      };
    },
    streamRender: async function* (options) {
      calls.push(options);
      yield { text: 'First.', pcm: Buffer.from('first'), sampleRate: 24000 };
      yield { text: 'Second.', pcm: Buffer.from('second'), sampleRate: 24000 };
    },
  });

  const chunks = [];
  for await (const chunk of runtime.streamSpeech('First. Second.')) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks.map((chunk) => chunk.pcm.toString()), ['first', 'second']);
  assert.deepEqual(calls, [{
    text: 'First. Second.',
    cacheDir: '/managed/voice-models',
    modelId: 'local/kokoro',
    voice: 'bf_emma',
    dtype: 'fp32',
    device: 'cpu',
    speed: 1.2,
  }]);
});

test('local voice runtime surfaces packaged Whisper failures', async () => {
  const runtime = createLocalVoiceRuntime({
    configFile: '/config/voice.toml',
    modelCacheDir: '/managed/voice-models',
    readConfig: () => ({ whisper_model: 'onnx-community/whisper-base.en' }),
    transcribe: async () => {
      throw new Error('Whisper failed');
    },
  });

  await assert.rejects(runtime.transcribePcm(Buffer.alloc(2)), /Whisper failed/u);
});
