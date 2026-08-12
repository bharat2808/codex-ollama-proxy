'use strict';

const fs = require('node:fs');
const path = require('node:path');

function voiceModelCacheDirectory(codexDir) {
  return path.join(codexDir, 'codex-universal-proxy', 'voice-models');
}

function configureTransformersCache(transformers, cacheDir) {
  if (!transformers || !transformers.env) {
    throw new Error('Transformers.js runtime is unavailable');
  }
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  transformers.env.cacheDir = cacheDir;
  transformers.env.useFSCache = true;
  return transformers;
}

function resolvePackagedFfmpeg({
  loadPath = () => require('ffmpeg-static'),
  isExecutable = (candidate) => {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  },
} = {}) {
  let candidate;
  try {
    candidate = loadPath();
    if (typeof candidate !== 'string' || !candidate || !isExecutable(candidate)) {
      throw new Error('missing executable');
    }
  } catch {
    throw new Error('packaged FFmpeg is unavailable; reinstall codex-universal-proxy');
  }
  return candidate;
}

module.exports = {
  configureTransformersCache,
  resolvePackagedFfmpeg,
  voiceModelCacheDirectory,
};
