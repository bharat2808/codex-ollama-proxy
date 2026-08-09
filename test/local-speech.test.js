'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  streamKokoroAudio,
  transcribeAudio,
} = require('../src/voice-agent/local-speech');

test('local transcription runs packaged Whisper on PCM without an external command', async () => {
  const calls = [];
  const transcript = await transcribeAudio({
    pcm: Buffer.from([0x00, 0x80, 0xff, 0x7f]),
    sampleRate: 16000,
    modelId: 'onnx-community/whisper-base.en',
    cacheDir: '/voice-models',
    loadPipeline: async (options) => {
      calls.push(options);
      return async (audio) => {
        calls.push(audio);
        return { text: '  check the build please  ' };
      };
    },
  });

  assert.deepEqual(calls[0], {
    modelId: 'onnx-community/whisper-base.en',
    cacheDir: '/voice-models',
    dtype: 'q8',
    device: 'cpu',
  });
  assert.equal(calls[1] instanceof Float32Array, true);
  assert.equal(calls[1].length, 2);
  assert.equal(calls[1][0], -1);
  assert.ok(calls[1][1] > 0.999 && calls[1][1] <= 1);
  assert.equal(transcript, 'check the build please');
});

test('Kokoro streaming yields sentence PCM before the complete text finishes', async () => {
  let releaseSecond;
  const secondReady = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  const stream = streamKokoroAudio({
    text: 'First sentence. Second sentence.',
    prebufferMs: 0,
    voice: 'af_heart',
    speed: 1.1,
    loadModel: async () => ({
      async *stream(sentences, generationOptions) {
        assert.deepEqual(generationOptions, { voice: 'af_heart', speed: 1.1 });
        let index = 0;
        for await (const sentence of sentences) {
          if (index === 1) await secondReady;
          yield {
            text: sentence,
            audio: {
              audio: new Float32Array([index + 0.25]),
              sampling_rate: 24000,
            },
          };
          index += 1;
        }
      },
    }),
  });

  const first = await stream.next();
  assert.equal(first.done, false);
  assert.equal(first.value.text, 'First sentence.');
  assert.equal(first.value.sampleRate, 24000);
  assert.equal(first.value.pcm.readFloatLE(0), 0.25);

  releaseSecond();
  const remaining = [];
  for await (const chunk of stream) remaining.push(chunk.text);
  assert.deepEqual(remaining, ['Second sentence.']);
});

test('Kokoro streaming builds an audio reserve before playback starts', async () => {
  let produced = 0;
  const stream = streamKokoroAudio({
    text: 'Short sentence. Much longer sentence.',
    prebufferMs: 3000,
    loadModel: async () => ({
      async *stream(sentences) {
        for await (const sentence of sentences) {
          produced += 1;
          const seconds = produced === 1 ? 1 : 3;
          yield {
            text: sentence,
            audio: {
              audio: new Float32Array(24000 * seconds),
              sampling_rate: 24000,
            },
          };
        }
      },
    }),
  });

  const first = await stream.next();

  assert.equal(first.done, false);
  assert.equal(first.value.text, 'Short sentence.');
  assert.equal(produced, 2, 'playback must not start with only one second reserved');
  const second = await stream.next();
  assert.equal(second.value.text, 'Much longer sentence.');
});
