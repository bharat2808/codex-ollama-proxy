'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  configureTransformersCache,
  resolvePackagedFfmpeg,
  voiceModelCacheDirectory,
} = require('../src/voice-agent/voice-dependencies');

test('voice models use a proxy-owned cache below CODEX_HOME', () => {
  assert.equal(
    voiceModelCacheDirectory('/users/example/.codex'),
    '/users/example/.codex/codex-universal-proxy/voice-models',
  );
});

test('packaged FFmpeg resolution does not consult the host PATH', () => {
  assert.equal(resolvePackagedFfmpeg({
    loadPath: () => '/package/node_modules/ffmpeg-static/ffmpeg',
    isExecutable: (candidate) => candidate === '/package/node_modules/ffmpeg-static/ffmpeg',
  }), '/package/node_modules/ffmpeg-static/ffmpeg');
});

test('packaged FFmpeg resolution rejects a missing installation', () => {
  assert.throws(() => resolvePackagedFfmpeg({
    loadPath: () => null,
  }), /packaged FFmpeg is unavailable/u);
});

test('Transformers.js uses the proxy-owned filesystem cache', () => {
  const transformers = { env: {} };
  const cacheDir = path.join(os.tmpdir(), 'codex-voice-dependency-test-cache');
  configureTransformersCache(transformers, cacheDir);
  assert.equal(transformers.env.cacheDir, cacheDir);
  assert.equal(transformers.env.useFSCache, true);
});
