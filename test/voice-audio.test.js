'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');

function loadVoiceAudio() {
  try {
    return require('../src/voice-agent/voice-audio');
  } catch (error) {
    assert.fail(`voice audio module is unavailable: ${error.message}`);
  }
}

function pcm(samples, amplitude) {
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(amplitude, index * 2);
  }
  return buffer;
}

function sineFloat32Pcm(sampleRate, durationMs, frequency = 440, amplitude = 0.5) {
  const samples = Math.round(sampleRate * durationMs / 1000);
  const buffer = Buffer.alloc(samples * 4);
  for (let index = 0; index < samples; index += 1) {
    const value = amplitude * Math.sin(2 * Math.PI * frequency * index / sampleRate);
    buffer.writeFloatLE(value, index * 4);
  }
  return buffer;
}

test('PCM speech segmenter emits one utterance after sustained trailing silence', async () => {
  const { PcmSpeechSegmenter } = loadVoiceAudio();
  const utterances = [];
  const segmenter = new PcmSpeechSegmenter({
    sampleRate: 16000,
    speechThreshold: 500,
    minimumSpeechMs: 200,
    trailingSilenceMs: 600,
    onSpeech: async (audio) => utterances.push(audio),
  });

  await segmenter.push(pcm(1600, 0));
  await segmenter.push(pcm(4800, 3000));
  await segmenter.push(pcm(4800, 0));
  assert.equal(utterances.length, 0);
  await segmenter.push(pcm(4800, 0));

  assert.equal(utterances.length, 1);
  assert.ok(utterances[0].length >= 4800 * 2);
  assert.ok(utterances[0].includes(pcm(16, 3000)));
});

test('PCM speech segmenter reports each speech onset before the utterance completes', async () => {
  const { PcmSpeechSegmenter } = loadVoiceAudio();
  const events = [];
  const segmenter = new PcmSpeechSegmenter({
    sampleRate: 16000,
    speechThreshold: 500,
    minimumSpeechMs: 100,
    trailingSilenceMs: 100,
    onSpeechStart: () => events.push('start'),
    onSpeech: async () => events.push('complete'),
  });

  await segmenter.push(pcm(1600, 3000));
  assert.deepEqual(events, ['start']);
  await segmenter.push(pcm(1600, 0));
  assert.deepEqual(events, ['start', 'complete']);
  await segmenter.push(pcm(1600, 3000));

  assert.deepEqual(events, ['start', 'complete', 'start']);
});

test('push-to-talk records only between start and commit', async () => {
  const { PcmPushToTalkSegmenter } = loadVoiceAudio();
  const utterances = [];
  const segmenter = new PcmPushToTalkSegmenter({
    sampleRate: 16000,
    minimumSpeechMs: 100,
    onSpeech: async (audio) => utterances.push(audio),
  });

  await segmenter.push(pcm(3200, 1000));
  segmenter.start();
  await segmenter.push(pcm(3200, 2000));
  await segmenter.commit();
  await segmenter.push(pcm(3200, 3000));

  assert.equal(utterances.length, 1);
  assert.deepEqual(utterances[0], pcm(3200, 2000));
});

test('push-to-talk ends a too-short recording without sending it to Whisper', async () => {
  const { PcmPushToTalkSegmenter } = loadVoiceAudio();
  let ended = 0;
  let utterances = 0;
  const segmenter = new PcmPushToTalkSegmenter({
    sampleRate: 16000,
    minimumSpeechMs: 100,
    onSpeechEnd: () => { ended += 1; },
    onSpeech: async () => { utterances += 1; },
  });

  segmenter.start();
  await segmenter.push(pcm(800, 2000));
  await segmenter.commit();

  assert.equal(utterances, 0);
  assert.equal(ended, 1);
});

test('Whisper WAV encoding writes mono 16-bit PCM with the correct sizes', () => {
  const { pcm16ToWav } = loadVoiceAudio();
  const samples = pcm(320, 1234);
  const wav = pcm16ToWav(samples, { sampleRate: 16000, channels: 1 });

  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.readUInt32LE(4), 36 + samples.length);
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.subarray(36, 40).toString('ascii'), 'data');
  assert.equal(wav.readUInt32LE(40), samples.length);
  assert.deepEqual(wav.subarray(44), samples);
});

test('ffmpeg RTP bridge plays the first Kokoro PCM chunk before later synthesis completes', async () => {
  const {
    createFfmpegRtpDecoder,
    createFfmpegRtpPlayer,
    pcmRms,
  } = loadVoiceAudio();
  const decoded = [];
  const decoder = await createFfmpegRtpDecoder({
    onPcm: (chunk) => decoded.push(Buffer.from(chunk)),
  });
  const player = await createFfmpegRtpPlayer({
    track: {
      writeRtp(packet) {
        decoder.pushRtp(packet);
      },
    },
  });
  let releaseSecond;
  const secondReady = new Promise((resolve) => {
    releaseSecond = resolve;
  });

  try {
    async function* chunks() {
      yield {
        pcm: sineFloat32Pcm(24000, 300),
        sampleRate: 24000,
      };
      await secondReady;
      yield {
        pcm: sineFloat32Pcm(24000, 300, 660),
        sampleRate: 24000,
      };
    }

    const playback = player.playAudioStream(chunks());
    const deadline = Date.now() + 3000;
    while (decoded.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(decoded.length > 0, 'expected RTP playback before the second PCM chunk');

    releaseSecond();
    await playback;
    assert.ok(pcmRms(Buffer.concat(decoded)) > 1000);
  } finally {
    releaseSecond();
    await player.close();
    await decoder.close();
  }
});

test('ffmpeg RTP bridge stops streamed playback while synthesis is still pending', async () => {
  const {
    createFfmpegRtpPlayer,
  } = loadVoiceAudio();
  const player = await createFfmpegRtpPlayer({
    track: {
      writeRtp() {},
    },
  });
  let releaseSynthesis;
  const synthesisGate = new Promise((resolve) => {
    releaseSynthesis = resolve;
  });

  try {
    async function* chunks() {
      yield {
        pcm: sineFloat32Pcm(24000, 300),
        sampleRate: 24000,
      };
      await synthesisGate;
      yield {
        pcm: sineFloat32Pcm(24000, 300, 660),
        sampleRate: 24000,
      };
    }

    const playback = player.playAudioStream(chunks());
    await new Promise((resolve) => setTimeout(resolve, 30));
    let timeout;
    try {
      await Promise.race([
        player.stopAudio(),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('playback interruption timed out')),
            500,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    await playback;
  } finally {
    releaseSynthesis();
    await player.close();
  }
});

test('ffmpeg RTP bridge keeps one encoder across consecutive speech phrases', async () => {
  const { createFfmpegRtpPlayer } = loadVoiceAudio();
  let spawnCount = 0;
  const timestamps = [];
  const packetTimes = [];
  const player = await createFfmpegRtpPlayer({
    track: {
      writeRtp(packet) {
        timestamps.push(packet.header.timestamp);
        packetTimes.push(Date.now());
      },
    },
    spawnProcess(command, args, options) {
      spawnCount += 1;
      return spawn(command, args, options);
    },
  });

  async function* phrase(frequency) {
    yield {
      pcm: sineFloat32Pcm(24000, 120, frequency),
      sampleRate: 24000,
    };
  }

  try {
    await player.playAudioStream(phrase(440));
    await player.playAudioStream(phrase(660));
    assert.equal(spawnCount, 1);
    assert.ok(timestamps.length > 2);
    for (let index = 1; index < timestamps.length; index += 1) {
      assert.equal((timestamps[index] - timestamps[index - 1]) >>> 0, 960);
      assert.ok(
        packetTimes[index] - packetTimes[index - 1] >= 10,
        'RTP packets must be paced instead of emitted in bursts',
      );
    }

    await player.stopAudio();
    await player.playAudioStream(phrase(880));
    assert.equal(spawnCount, 2);
  } finally {
    await player.close();
  }
});

test('ffmpeg RTP bridge cannot let a stale cancellation block replacement speech', async () => {
  const { createFfmpegRtpPlayer } = loadVoiceAudio();
  const player = await createFfmpegRtpPlayer({
    track: {
      writeRtp() {},
    },
  });
  let releaseOld;
  const oldGate = new Promise((resolve) => {
    releaseOld = resolve;
  });
  let releaseReplacement;
  const replacementGate = new Promise((resolve) => {
    releaseReplacement = resolve;
  });

  async function within(promise, milliseconds, message) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function* oldSpeech() {
    yield { pcm: sineFloat32Pcm(24000, 200), sampleRate: 24000 };
    await oldGate;
  }

  async function* replacementSpeech() {
    yield { pcm: sineFloat32Pcm(24000, 200, 660), sampleRate: 24000 };
    await replacementGate;
    yield { pcm: sineFloat32Pcm(24000, 100, 880), sampleRate: 24000 };
  }

  try {
    const oldPlayback = player.playAudioStream(oldSpeech());
    await new Promise((resolve) => setTimeout(resolve, 30));
    const stopping = player.stopAudio();
    const replacement = player.playAudioStream(replacementSpeech());

    await within(
      stopping,
      500,
      'stale stopAudio waited on replacement speech',
    );
    releaseOld();
    releaseReplacement();
    await oldPlayback;
    await within(
      replacement,
      2000,
      'replacement speech remained blocked after cancellation',
    );
  } finally {
    releaseOld();
    releaseReplacement();
    await player.close();
  }
});

test('ffmpeg RTP bridge cancellation releases an encoder stdin blocked on backpressure', async () => {
  const { createFfmpegRtpPlayer } = loadVoiceAudio();
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough({ highWaterMark: 1 });
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit('exit', null, signal));
    return true;
  };
  const player = await createFfmpegRtpPlayer({
    track: { writeRtp() {} },
    spawnProcess: () => child,
  });

  async function* speech() {
    yield { pcm: sineFloat32Pcm(24000, 200), sampleRate: 24000 };
  }

  let timer;
  try {
    const playback = player.playAudioStream(speech());
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.race([
      player.stopAudio(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('backpressured playback cancellation timed out')),
          500,
        );
      }),
    ]);
    await playback;
  } finally {
    clearTimeout(timer);
    await player.close();
  }
});
