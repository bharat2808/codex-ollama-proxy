'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  rightCommandPushToTalkEnabled,
} = require('../src/voice-agent/macos-interruption-key');

test('right-command push-to-talk starts only for enabled macOS manual voice', () => {
  const config = {
    voice_enabled: true,
    interruption_mode: 'manual',
    interruption_key: 'right-command',
  };
  assert.equal(rightCommandPushToTalkEnabled(config, 'darwin'), true);
  assert.equal(rightCommandPushToTalkEnabled(config, 'linux'), false);
  assert.equal(rightCommandPushToTalkEnabled({ ...config, interruption_mode: 'vad' }, 'darwin'), false);
  assert.equal(rightCommandPushToTalkEnabled({ ...config, interruption_key: 'none' }, 'darwin'), false);
});
