'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveLocalCommand } = require('../src/voice-agent/local-command');

test('macOS service command lookup includes Homebrew when launchd PATH omits it', () => {
  assert.equal(
    resolveLocalCommand('ffmpeg', {
      envPath: '/usr/bin:/bin',
      platform: 'darwin',
      isExecutable: (candidate) => candidate === '/opt/homebrew/bin/ffmpeg',
    }),
    '/opt/homebrew/bin/ffmpeg',
  );
});

test('explicit local command paths are preserved', () => {
  assert.equal(
    resolveLocalCommand('/custom/bin/whisper-cli', {
      envPath: '',
      platform: 'darwin',
    }),
    '/custom/bin/whisper-cli',
  );
});
