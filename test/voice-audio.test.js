'use strict';

const assert = require('node:assert/strict');
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

function sinePcm(sampleRate, durationMs, frequency = 440, amplitude = 8000) {
  const samples = Math.round(sampleRate * durationMs / 1000);
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(amplitude * Math.sin(2 * Math.PI * frequency * index / sampleRate));
    buffer.writeInt16LE(value, index * 2);
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

test('ffmpeg RTP bridge packetizes WAV output and decodes it back to 16 kHz PCM', async () => {
  const {
    createFfmpegRtpDecoder,
    createFfmpegRtpPlayer,
    pcm16ToWav,
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

  try {
    const wav = pcm16ToWav(sinePcm(24000, 400), {
      sampleRate: 24000,
      channels: 1,
    });
    await player.playAudio(wav);
    const deadline = Date.now() + 3000;
    while (decoded.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.ok(decoded.length > 0);
    assert.ok(pcmRms(Buffer.concat(decoded)) > 1000);
  } finally {
    await player.close();
    await decoder.close();
  }
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
