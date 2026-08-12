'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { markdownToPlainText } = require('../src/voice-agent/markdown-to-plain-text');

test('markdownToPlainText removes visual formatting while preserving readable content', () => {
  assert.equal(
    markdownToPlainText([
      '## **Result**',
      '',
      '- Use *manual mode* with [Right Command](https://example.test).',
      '- Keep `voice_enabled` set to **true**.',
    ].join('\n')),
    [
      'Result',
      '',
      'Use manual mode with Right Command.',
      'Keep voice_enabled set to true.',
    ].join('\n'),
  );
});

test('markdownToPlainText preserves fenced code content but removes its fence', () => {
  assert.equal(
    markdownToPlainText('```js\nconst ready = true;\n```'),
    'const ready = true;',
  );
});
