'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  streamKokoroAudio,
  transcribeAudio,
} = require('../src/voice-agent/local-speech');

test('local transcription invokes Whisper with the selected model', async () => {
  const calls = [];
  const transcript = await transcribeAudio({
    audioPath: '/tmp/input.wav',
    modelPath: '/models/ggml-base.en.bin',
    run: async (command, args) => {
      calls.push({ command, args });
      return { stdout: '  check the build please  \n' };
    },
  });

  assert.deepEqual(calls, [{
    command: 'whisper-cli',
    args: [
      '--model', '/models/ggml-base.en.bin',
      '--file', '/tmp/input.wav',
      '--no-timestamps',
      '--no-prints',
    ],
  }]);
  assert.equal(transcript, 'check the build please');
});

test('Kokoro streaming yields sentence PCM before the complete text finishes', async () => {
  let releaseSecond;
  const secondReady = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  const stream = streamKokoroAudio({
    text: 'First sentence. Second sentence.',
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
