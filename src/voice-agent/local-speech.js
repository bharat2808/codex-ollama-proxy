'use strict';

const { configureTransformersCache } = require('./voice-dependencies');

const kokoroModels = new Map();
const whisperPipelines = new Map();

function pcm16ToFloat32(pcm, sampleRate, targetSampleRate = 16000) {
  if (!Buffer.isBuffer(pcm) || pcm.length < 2) throw new Error('Whisper PCM audio is required');
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error('Whisper sample rate is invalid');
  const sourceLength = Math.floor(pcm.length / 2);
  const source = new Float32Array(sourceLength);
  for (let index = 0; index < sourceLength; index += 1) {
    const sample = pcm.readInt16LE(index * 2);
    source[index] = sample < 0 ? sample / 32768 : sample / 32767;
  }
  if (sampleRate === targetSampleRate) return source;
  const targetLength = Math.max(1, Math.round(sourceLength * targetSampleRate / sampleRate));
  const output = new Float32Array(targetLength);
  const scale = sampleRate / targetSampleRate;
  for (let index = 0; index < targetLength; index += 1) {
    const position = index * scale;
    const left = Math.min(sourceLength - 1, Math.floor(position));
    const right = Math.min(sourceLength - 1, left + 1);
    const mix = position - left;
    output[index] = source[left] + ((source[right] - source[left]) * mix);
  }
  return output;
}

async function loadWhisperPipeline({ modelId, cacheDir, dtype, device }) {
  const key = JSON.stringify([modelId, cacheDir, dtype, device]);
  if (!whisperPipelines.has(key)) {
    const loading = Promise.resolve().then(() => {
      const transformers = configureTransformersCache(require('@huggingface/transformers'), cacheDir);
      return transformers.pipeline('automatic-speech-recognition', modelId, { dtype, device });
    }).catch((error) => {
      whisperPipelines.delete(key);
      throw error;
    });
    whisperPipelines.set(key, loading);
  }
  return whisperPipelines.get(key);
}

async function transcribeAudio({
  pcm,
  sampleRate = 16000,
  modelId,
  cacheDir,
  dtype = 'q8',
  device = 'cpu',
  loadPipeline = loadWhisperPipeline,
}) {
  if (!modelId) throw new Error('Whisper model is required');
  if (!cacheDir) throw new Error('Whisper model cache is required');
  const transcriber = await loadPipeline({ modelId, cacheDir, dtype, device });
  const result = await transcriber(pcm16ToFloat32(pcm, sampleRate));
  const transcript = String(result && result.text || '').trim();
  if (!transcript) throw new Error('Whisper returned an empty transcript');
  return transcript;
}

async function loadKokoroModel(modelId, options) {
  const { cacheDir, ...modelOptions } = options;
  const key = JSON.stringify([modelId, modelOptions, cacheDir]);
  if (!kokoroModels.has(key)) {
    const loading = Promise.resolve()
      .then(() => {
        configureTransformersCache(require('@huggingface/transformers'), cacheDir);
        // The CommonJS entry keeps kokoro-js's package-local __dirname, which
        // it uses to find bundled voice files such as voices/af_heart.bin.
        const { KokoroTTS } = require('kokoro-js');
        return KokoroTTS.from_pretrained(modelId, modelOptions);
      })
      .catch((error) => {
        kokoroModels.delete(key);
        throw error;
      });
    kokoroModels.set(key, loading);
  }
  return kokoroModels.get(key);
}

async function* streamKokoroAudio({
  text,
  voice = 'af_heart',
  speed = 1,
  prebufferMs = 4000,
  modelId = 'onnx-community/Kokoro-82M-v1.0-ONNX',
  dtype = 'q8',
  device = 'cpu',
  cacheDir,
  loadModel = loadKokoroModel,
}) {
  if (!text || typeof text !== 'string') throw new Error('Kokoro text is required');
  const tts = await loadModel(modelId, { dtype, device, cacheDir });
  const { TextSplitterStream } = require('kokoro-js');
  const splitter = new TextSplitterStream();
  const generated = tts.stream(splitter, { voice, speed });
  splitter.push(text);
  splitter.close();

  async function nextChunk() {
    const next = await generated.next();
    if (next.done) return null;
    const chunk = next.value;
    const raw = chunk && chunk.audio;
    if (
      !raw
      || !(raw.audio instanceof Float32Array)
      || !Number.isInteger(raw.sampling_rate)
      || raw.sampling_rate <= 0
    ) {
      throw new Error('Kokoro stream returned invalid audio');
    }
    const pcmView = Buffer.from(
      raw.audio.buffer,
      raw.audio.byteOffset,
      raw.audio.byteLength,
    );
    return {
      text: String(chunk.text || ''),
      pcm: Buffer.from(pcmView),
      sampleRate: raw.sampling_rate,
    };
  }

  const buffered = [];
  let bufferedAudioMs = 0;
  while (bufferedAudioMs < prebufferMs) {
    const chunk = await nextChunk();
    if (!chunk) break;
    buffered.push(chunk);
    bufferedAudioMs += chunk.pcm.length / 4 / chunk.sampleRate * 1000;
  }
  for (const chunk of buffered) yield chunk;
  for (;;) {
    const chunk = await nextChunk();
    if (!chunk) break;
    yield chunk;
  }
}

module.exports = {
  loadKokoroModel,
  loadWhisperPipeline,
  pcm16ToFloat32,
  streamKokoroAudio,
  transcribeAudio,
};
