'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');

function assertPrivateFileMode(file) {
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
}

function assertPrivateDirectoryMode(directory) {
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
}

module.exports = { assertPrivateDirectoryMode, assertPrivateFileMode };
