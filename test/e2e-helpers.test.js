'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectDiagnostics, redact } = require('./e2e/helpers');

test('live-test diagnostics redact credentials from captured proxy and Codex logs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proxy-diagnostics-'));
  const codexHome = path.join(root, 'Fresh Codex Home');
  const artifactsDir = path.join(root, 'artifacts');
  const secret = 'provider-secret-value';
  const proxyLog = path.join(codexHome, 'ollama-shape-proxy', 'proxy.log');
  const codexLog = path.join(codexHome, 'log', 'codex.log');
  fs.mkdirSync(path.dirname(proxyLog), { recursive: true });
  fs.mkdirSync(path.dirname(codexLog), { recursive: true });
  fs.writeFileSync(proxyLog, `authorization=${secret}\n`, 'utf8');
  fs.writeFileSync(codexLog, `token=${secret}\n`, 'utf8');
  try {
    assert.equal(redact(`before ${secret} after`, [secret]), 'before [REDACTED] after');
    collectDiagnostics({ artifactsDir, codexHome, secrets: [secret] });
    for (const output of [path.join(artifactsDir, 'proxy.log'), path.join(artifactsDir, 'codex-log', 'codex.log')]) {
      const text = fs.readFileSync(output, 'utf8');
      assert.doesNotMatch(text, new RegExp(secret, 'u'));
      assert.match(text, /\[REDACTED\]/u);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
