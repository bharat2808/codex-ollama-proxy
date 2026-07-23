'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  firstBoundedPositiveInteger,
  isUnavailableModelRow,
  normalizedStrings,
  record,
} = require('../src/model-discovery/model-row-utils');

test('shared model-row primitives normalize provider catalog values', () => {
  assert.deepEqual(record({ id: 'model' }), { id: 'model' });
  assert.equal(record([]), null);
  assert.equal(firstBoundedPositiveInteger(1000, null, 2048, 512), 512);
  assert.equal(firstBoundedPositiveInteger(1000, -1, '512'), null);
  assert.deepEqual(normalizedStrings([' Tools ', 4, 'REASONING']), ['tools', 'reasoning']);
});

test('shared model-row availability rejects provider lifecycle flags', () => {
  assert.equal(isUnavailableModelRow({ active: false }), true);
  assert.equal(isUnavailableModelRow({ deprecated: true }), true);
  assert.equal(isUnavailableModelRow({ enabled: true }), false);
  assert.equal(isUnavailableModelRow(null), true);
});
