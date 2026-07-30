'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createLocalVoiceRuntime } = require('../src/voice-agent/local-voice-runtime');

test('local voice runtime passes current Whisper configuration and cleans up its WAV', async () => {
  const writes = [];
  const removed = [];
  const calls = [];
  const runtime = createLocalVoiceRuntime({
    configFile: '/config/voice.toml',
    readConfig() {
      return {
        whisper_command: '/bin/whisper-cli',
        whisper_model: '/models/base.bin',
      };
    },
    allocatePath: () => '/tmp/input.wav',
    writeFile: async (file, data) => writes.push([file, data]),
    unlink: async (file) => removed.push(file),
    transcribe: async (options) => {
      calls.push(options);
      return 'hello Codex';
    },
  });

  const result = await runtime.transcribePcm(Buffer.from([1, 0, 2, 0]));

  assert.equal(result, 'hello Codex');
  assert.equal(writes[0][0], '/tmp/input.wav');
  assert.equal(writes[0][1].subarray(0, 4).toString('ascii'), 'RIFF');
  assert.deepEqual(calls, [{
    audioPath: '/tmp/input.wav',
    modelPath: '/models/base.bin',
    whisperCommand: '/bin/whisper-cli',
  }]);
  assert.deepEqual(removed, ['/tmp/input.wav']);
});

test('local voice runtime renders Kokoro with current configuration and returns WAV bytes', async () => {
  const calls = [];
  const runtime = createLocalVoiceRuntime({
    configFile: '/config/voice.toml',
    readConfig() {
      return {
        kokoro_model: 'local/kokoro',
        kokoro_voice: 'bf_emma',
        kokoro_dtype: 'fp32',
        kokoro_device: 'cpu',
        kokoro_speed: 1.2,
      };
    },
    allocatePath: () => '/tmp/output.wav',
    render: async (options) => calls.push(options),
    readFile: async () => Buffer.from('wav-data'),
    unlink: async () => {},
  });

  const audio = await runtime.synthesizeSpeech('I will check that.');

  assert.equal(audio.toString(), 'wav-data');
  assert.deepEqual(calls, [{
    text: 'I will check that.',
    outputPath: '/tmp/output.wav',
    modelId: 'local/kokoro',
    voice: 'bf_emma',
    dtype: 'fp32',
    device: 'cpu',
    speed: 1.2,
  }]);
});

test('local voice runtime still removes temporary files when speech tools fail', async () => {
  const removed = [];
  const runtime = createLocalVoiceRuntime({
    configFile: '/config/voice.toml',
    readConfig: () => ({ whisper_model: '/models/base.bin' }),
    allocatePath: () => '/tmp/input.wav',
    writeFile: async () => {},
    unlink: async (file) => removed.push(file),
    transcribe: async () => {
      throw new Error('Whisper failed');
    },
  });

  await assert.rejects(runtime.transcribePcm(Buffer.alloc(2)), /Whisper failed/u);
  assert.deepEqual(removed, ['/tmp/input.wav']);
});
