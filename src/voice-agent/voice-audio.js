'use strict';

const { spawn } = require('node:child_process');
const dgram = require('node:dgram');
const { randomInt } = require('node:crypto');
const { once } = require('node:events');
const { RtpPacket } = require('werift');
const { resolvePackagedFfmpeg } = require('./voice-dependencies');

function pcmRms(buffer) {
  const sampleCount = Math.floor(buffer.length / 2);
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    const sample = buffer.readInt16LE(offset);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

class PcmSpeechSegmenter {
  constructor({
    sampleRate = 16000,
    speechThreshold = 500,
    minimumSpeechMs = 200,
    trailingSilenceMs = 600,
    maximumSpeechMs = 30000,
    onSpeechStart = () => {},
    onSpeech,
  } = {}) {
    if (typeof onSpeech !== 'function') throw new Error('onSpeech is required');
    this.sampleRate = sampleRate;
    this.speechThreshold = speechThreshold;
    this.minimumSpeechSamples = Math.round(sampleRate * minimumSpeechMs / 1000);
    this.trailingSilenceSamples = Math.round(sampleRate * trailingSilenceMs / 1000);
    this.maximumSpeechSamples = Math.round(sampleRate * maximumSpeechMs / 1000);
    this.onSpeechStart = onSpeechStart;
    this.onSpeech = onSpeech;
    this.reset();
  }

  reset() {
    this.chunks = [];
    this.recordedSamples = 0;
    this.speechSamples = 0;
    this.silenceSamples = 0;
    this.started = false;
  }

  async flush() {
    if (!this.started) return;
    const audio = Buffer.concat(this.chunks);
    const shouldEmit = this.speechSamples >= this.minimumSpeechSamples;
    this.reset();
    if (shouldEmit) await this.onSpeech(audio);
  }

  async push(chunk) {
    if (!Buffer.isBuffer(chunk) || chunk.length < 2) return;
    const evenLength = chunk.length - (chunk.length % 2);
    const pcm = evenLength === chunk.length ? chunk : chunk.subarray(0, evenLength);
    const samples = pcm.length / 2;
    const isSpeech = pcmRms(pcm) >= this.speechThreshold;

    if (!this.started) {
      if (!isSpeech) return;
      this.started = true;
      this.onSpeechStart();
    }

    this.chunks.push(pcm);
    this.recordedSamples += samples;
    if (isSpeech) {
      this.speechSamples += samples;
      this.silenceSamples = 0;
    } else {
      this.silenceSamples += samples;
    }

    if (
      this.silenceSamples >= this.trailingSilenceSamples
      || this.recordedSamples >= this.maximumSpeechSamples
    ) {
      await this.flush();
    }
  }
}

class PcmPushToTalkSegmenter {
  constructor({
    sampleRate = 16000,
    minimumSpeechMs = 100,
    maximumSpeechMs = 30000,
    onSpeechEnd = () => {},
    onSpeechStart = () => {},
    onSpeech,
  } = {}) {
    if (typeof onSpeech !== 'function') throw new Error('onSpeech is required');
    this.minimumSamples = Math.round(sampleRate * minimumSpeechMs / 1000);
    this.maximumSamples = Math.round(sampleRate * maximumSpeechMs / 1000);
    this.onSpeechEnd = onSpeechEnd;
    this.onSpeechStart = onSpeechStart;
    this.onSpeech = onSpeech;
    this.active = false;
    this.chunks = [];
    this.recordedSamples = 0;
  }

  start() {
    this.cancel();
    this.active = true;
    this.onSpeechStart();
  }

  cancel() {
    const wasActive = this.active;
    this.active = false;
    this.chunks = [];
    this.recordedSamples = 0;
    if (wasActive) this.onSpeechEnd();
  }

  async commit() {
    if (!this.active) return;
    const chunks = this.chunks;
    const recordedSamples = this.recordedSamples;
    this.active = false;
    this.chunks = [];
    this.recordedSamples = 0;
    if (recordedSamples >= this.minimumSamples) {
      await this.onSpeech(Buffer.concat(chunks));
    } else {
      this.onSpeechEnd();
    }
  }

  async push(chunk) {
    if (!this.active || !Buffer.isBuffer(chunk) || chunk.length < 2) return;
    const evenLength = chunk.length - (chunk.length % 2);
    const pcm = evenLength === chunk.length ? chunk : chunk.subarray(0, evenLength);
    const remainingSamples = this.maximumSamples - this.recordedSamples;
    if (remainingSamples <= 0) return;
    const accepted = pcm.subarray(0, Math.min(pcm.length, remainingSamples * 2));
    this.chunks.push(accepted);
    this.recordedSamples += accepted.length / 2;
    if (this.recordedSamples >= this.maximumSamples) await this.commit();
  }
}

function pcm16ToWav(pcm, {
  sampleRate = 16000,
  channels = 1,
} = {}) {
  if (!Buffer.isBuffer(pcm)) throw new Error('PCM audio must be a Buffer');
  const header = Buffer.alloc(44);
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function bindUdpSocket(socket = dgram.createSocket('udp4')) {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      socket.off('error', reject);
      resolve(socket);
    });
  });
}

async function allocateUdpPort() {
  const socket = await bindUdpSocket();
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function childExit(child, label, stderrChunks) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 || signal === 'SIGTERM') {
        resolve();
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      reject(new Error(`${label} failed (${signal || `exit ${code}`}): ${stderr}`));
    });
  });
}

async function createFfmpegRtpDecoder({
  onPcm,
  ffmpegCommand = resolvePackagedFfmpeg(),
  spawnProcess = spawn,
  payloadType = 111,
} = {}) {
  if (typeof onPcm !== 'function') throw new Error('onPcm is required');
  const port = await allocateUdpPort();
  const sender = dgram.createSocket('udp4');
  const stderrChunks = [];
  const command = ffmpegCommand;
  const child = spawnProcess(command, [
    '-hide_banner', '-loglevel', 'error',
    '-protocol_whitelist', 'file,pipe,udp,rtp',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-probesize', '32',
    '-analyzeduration', '0',
    '-max_delay', '0',
    '-reorder_queue_size', '0',
    '-f', 'sdp',
    '-i', 'pipe:0',
    '-map', '0:a:0',
    '-ac', '1',
    '-ar', '16000',
    '-f', 's16le',
    'pipe:1',
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
  child.stdout.on('data', onPcm);
  const exited = childExit(child, 'ffmpeg RTP decoder', stderrChunks);
  const sdp = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=Codex local voice',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    `m=audio ${port} RTP/AVP ${payloadType}`,
    `a=rtpmap:${payloadType} opus/48000/2`,
    '',
  ].join('\r\n');
  child.stdin.end(sdp);

  return {
    port,
    pushRtp(packet) {
      const normalized = Buffer.isBuffer(packet)
        ? RtpPacket.deSerialize(packet)
        : packet.clone();
      normalized.header.payloadType = payloadType;
      sender.send(normalized.serialize(), port, '127.0.0.1');
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      sender.close();
      await exited.catch(() => {});
    },
  };
}

async function createFfmpegRtpPlayer({
  track,
  ffmpegCommand = resolvePackagedFfmpeg(),
  spawnProcess = spawn,
  payloadType = 111,
} = {}) {
  if (!track || typeof track.writeRtp !== 'function') {
    throw new Error('an RTP output track is required');
  }
  const receiver = await bindUdpSocket();
  const port = receiver.address().port;
  let sequenceNumber = randomInt(0x10000);
  let timestamp = randomInt(0x100000000);
  // FFmpeg 6's RTP muxer accepts SSRC as a signed 32-bit option even though
  // RTP serializes it as uint32. Staying in the positive signed range keeps
  // the packaged binary and newer system builds interoperable.
  const ssrc = randomInt(1, 0x80000000);
  let currentJob = null;
  let activeIterator = null;
  let activeCancel = null;
  let encoder = null;
  let playbackGeneration = 0;
  let packetTimer = null;
  let lastPacketSentAt = 0;
  const packetQueue = [];

  function settleEncoderWaiters(active) {
    for (const waiter of [...active.waiters]) {
      if (active.emittedSamples < waiter.target) continue;
      active.waiters.delete(waiter);
      waiter.resolve();
    }
  }

  function schedulePacket() {
    if (packetTimer || packetQueue.length === 0) return;
    const elapsed = Date.now() - lastPacketSentAt;
    const delay = lastPacketSentAt === 0 ? 0 : Math.max(0, 20 - elapsed);
    packetTimer = setTimeout(() => {
      packetTimer = null;
      const queued = packetQueue.shift();
      if (!queued || queued.active !== encoder) {
        schedulePacket();
        return;
      }
      const { active, packet, relativeTimestamp } = queued;
      packet.header.payloadType = payloadType;
      packet.header.sequenceNumber = sequenceNumber;
      packet.header.timestamp = (active.outputTimestamp + relativeTimestamp) >>> 0;
      packet.header.ssrc = ssrc;
      sequenceNumber = (sequenceNumber + 1) & 0xffff;
      timestamp = (packet.header.timestamp + 960) >>> 0;
      lastPacketSentAt = Date.now();
      track.writeRtp(packet);
      active.emittedSamples = Math.max(active.emittedSamples, relativeTimestamp + 960);
      settleEncoderWaiters(active);
      schedulePacket();
    }, delay);
  }

  receiver.on('message', (message) => {
    let packet;
    try {
      packet = RtpPacket.deSerialize(message);
    } catch {
      return;
    }
    const active = encoder;
    if (!active) return;
    if (packet.header.ssrc !== active.sourceSsrc) return;
    if (active.sourceTimestamp === null) active.sourceTimestamp = packet.header.timestamp;
    const relativeTimestamp = (packet.header.timestamp - active.sourceTimestamp) >>> 0;
    packetQueue.push({ active, packet, relativeTimestamp });
    schedulePacket();
  });

  function finishEncoderWaiters(active, error = null) {
    for (const waiter of active.waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
    active.waiters.clear();
  }

  function startEncoder(sampleRate) {
    const stderrChunks = [];
    const sourceSsrc = randomInt(1, 0x80000000);
    const command = ffmpegCommand;
    const child = spawnProcess(command, [
      '-hide_banner', '-loglevel', 'error',
      '-re',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-probesize', '32',
      '-analyzeduration', '0',
      '-f', 'f32le',
      '-ac', '1',
      '-ar', String(sampleRate),
      '-blocksize', '4096',
      '-i', 'pipe:0',
      '-ac', '2',
      '-ar', '48000',
      '-c:a', 'libopus',
      '-threads', '1',
      '-application', 'voip',
      '-frame_duration', '20',
      '-payload_type', String(payloadType),
      '-ssrc', String(sourceSsrc),
      '-flush_packets', '1',
      '-muxdelay', '0',
      '-f', 'rtp',
      `rtp://127.0.0.1:${port}?pkt_size=1200`,
    ], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    const active = {
      child,
      emittedSamples: 0,
      intentionalStop: false,
      outputTimestamp: timestamp,
      queuedSamples: 0,
      sampleRate,
      sourceSsrc,
      sourceTimestamp: null,
      waiters: new Set(),
    };
    active.exited = childExit(child, 'ffmpeg streaming RTP player', stderrChunks)
      .then(() => {
        if (!active.intentionalStop) {
          finishEncoderWaiters(active, new Error('ffmpeg streaming RTP player stopped unexpectedly'));
        }
      })
      .catch((error) => {
        if (!active.intentionalStop) finishEncoderWaiters(active, error);
        throw error;
      })
      .finally(() => {
        if (encoder === active) encoder = null;
      });
    active.exited.catch(() => {});
    encoder = active;
    return active;
  }

  function waitForEncoderSamples(active, target) {
    if (active.emittedSamples >= target) return Promise.resolve();
    return new Promise((resolve, reject) => {
      active.waiters.add({ target, resolve, reject });
    });
  }

  async function stopEncoder() {
    const active = encoder;
    if (!active) return;
    encoder = null;
    for (let index = packetQueue.length - 1; index >= 0; index -= 1) {
      if (packetQueue[index].active === active) packetQueue.splice(index, 1);
    }
    if (packetQueue.length === 0 && packetTimer) {
      clearTimeout(packetTimer);
      packetTimer = null;
    }
    active.intentionalStop = true;
    finishEncoderWaiters(active);
    active.child.stdin.destroy();
    if (active.child.exitCode === null && active.child.signalCode === null) {
      active.child.kill('SIGTERM');
    }
    await active.exited.catch(() => {});
  }

  async function playAudioStream(chunks) {
    if (!chunks || typeof chunks[Symbol.asyncIterator] !== 'function') {
      throw new Error('synthesized audio stream must be async iterable');
    }
    const generation = playbackGeneration;
    if (currentJob) await currentJob;
    if (generation !== playbackGeneration) return;
    const iterator = chunks[Symbol.asyncIterator]();
    let cancelPlayback;
    const cancelled = new Promise((resolve) => {
      cancelPlayback = resolve;
    });
    activeCancel = cancelPlayback;
    activeIterator = iterator;
    const nextChunk = () => Promise.race([
      iterator.next(),
      cancelled.then(() => ({ done: true, cancelled: true })),
    ]);
    const first = await nextChunk();
    if (first.done || generation !== playbackGeneration) {
      if (activeIterator === iterator) activeIterator = null;
      if (activeCancel === cancelPlayback) activeCancel = null;
      if (typeof iterator.return === 'function') {
        Promise.resolve(iterator.return()).catch(() => {});
      }
      return;
    }
    const sampleRate = first.value && first.value.sampleRate;
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new Error('synthesized PCM sampleRate must be a positive integer');
    }
    const active = encoder || startEncoder(sampleRate);
    if (active.sampleRate !== sampleRate) {
      throw new Error('synthesized audio sample rate changed during a voice call');
    }
    let inputSamples = 0;

    async function writePcm(buffer) {
      if (generation !== playbackGeneration || active.intentionalStop) return false;
      if (active.child.stdin.write(buffer)) return true;
      const drained = await Promise.race([
        once(active.child.stdin, 'drain').then(() => true),
        cancelled.then(() => false),
        active.exited.then(() => false),
      ]);
      return drained && generation === playbackGeneration && !active.intentionalStop;
    }

    async function writeChunk(chunk) {
      if (
        !chunk
        || !Buffer.isBuffer(chunk.pcm)
        || chunk.pcm.length % 4 !== 0
        || chunk.sampleRate !== sampleRate
      ) {
        throw new Error('synthesized audio chunks must be float32 PCM at one sample rate');
      }
      inputSamples += chunk.pcm.length / 4;
      return writePcm(chunk.pcm);
    }

    const writing = (async () => {
      try {
        if (!await writeChunk(first.value)) return null;
        for (;;) {
          const next = await nextChunk();
          if (next.done || generation !== playbackGeneration) break;
          if (!await writeChunk(next.value)) return null;
        }
        if (generation !== playbackGeneration) return null;
        const frameSamples = Math.round(sampleRate / 50);
        const remainder = inputSamples % frameSamples;
        if (remainder !== 0) {
          const paddingSamples = frameSamples - remainder;
          inputSamples += paddingSamples;
          const padding = Buffer.alloc(paddingSamples * 4);
          if (!await writePcm(padding)) return null;
        }
        const outputSamples = Math.round(inputSamples * 48000 / sampleRate);
        const target = active.queuedSamples + outputSamples;
        // FFmpeg/libopus retains up to five 20 ms frames while its stdin stays
        // open. Feeding a short silent tail flushes the spoken samples without
        // ending the call-wide encoder and doubles as a boundary prebuffer.
        const drainFrames = 5;
        const drainAudio = Buffer.alloc(frameSamples * 4 * drainFrames);
        if (!await writePcm(drainAudio)) return null;
        active.queuedSamples = target + (960 * drainFrames);
        return target;
      } catch (error) {
        active.child.stdin.destroy(error);
        if (active.child.exitCode === null && active.child.signalCode === null) {
          active.child.kill('SIGTERM');
        }
        throw error;
      }
    })();
    const job = writing.then((target) => (
      target === null ? undefined : waitForEncoderSamples(active, target)
    ));
    const running = job.finally(() => {
      if (currentJob === running) currentJob = null;
      if (activeIterator === iterator) activeIterator = null;
      if (activeCancel === cancelPlayback) activeCancel = null;
    });
    currentJob = running;
    try {
      await currentJob;
    } catch (error) {
      if (generation === playbackGeneration) throw error;
    }
  }

  async function stopAudio() {
    const interruptedJob = currentJob;
    playbackGeneration += 1;
    const cancel = activeCancel;
    activeCancel = null;
    if (cancel) cancel();
    const iterator = activeIterator;
    activeIterator = null;
    if (iterator && typeof iterator.return === 'function') {
      Promise.resolve(iterator.return()).catch(() => {});
    }
    await stopEncoder();
    if (interruptedJob) await interruptedJob.catch(() => {});
  }

  return {
    playAudioStream,
    stopAudio,
    async close() {
      await stopAudio();
      await new Promise((resolve) => receiver.close(resolve));
    },
  };
}

module.exports = {
  PcmPushToTalkSegmenter,
  PcmSpeechSegmenter,
  createFfmpegRtpDecoder,
  createFfmpegRtpPlayer,
  pcm16ToWav,
  pcmRms,
};
