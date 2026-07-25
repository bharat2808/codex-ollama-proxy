'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  adapterResult,
} = require('../src/model-discovery/adapter-result');

test('adapter result has one validated provider-facing contract', () => {
  const fallback = { state: 'bundled', warnings: ['offline'] };
  const result = adapterResult({
    models: [{ id: 'model-a' }],
    warnings: ['warning'],
    origin: 'bundled',
    complete: false,
    fallback,
  });

  assert.deepEqual(result, {
    models: [{ id: 'model-a' }],
    warnings: ['warning'],
    origin: 'bundled',
    complete: false,
    fallback,
  });
});

test('adapter result requires explicit origin and completeness', () => {
  assert.throws(
    () => adapterResult({ models: [], warnings: [], complete: true }),
    /origin/i,
  );
  assert.throws(
    () => adapterResult({ models: [], warnings: [], origin: 'live' }),
    /complete/i,
  );
  assert.throws(
    () => adapterResult({ models: [], warnings: [], origin: 'invented', complete: true }),
    /origin/i,
  );
});
