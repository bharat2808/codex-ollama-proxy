'use strict';

const fs = require('node:fs');
const path = require('node:path');

function resolveLocalCommand(command, {
  envPath = process.env.PATH || '',
  platform = process.platform,
  isExecutable = (candidate) => {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  },
} = {}) {
  const value = String(command || '').trim();
  if (!value) throw new Error('local command is required');
  if (value.includes('/') || value.includes('\\')) return value;
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const candidates = envPath.split(platformPath.delimiter).filter(Boolean);
  if (platform === 'darwin') {
    candidates.push('/opt/homebrew/bin', '/usr/local/bin');
  }
  candidates.push('/usr/bin', '/bin');
  for (const directory of [...new Set(candidates)]) {
    const candidate = platformPath.join(directory, value);
    try {
      if (isExecutable(candidate)) return candidate;
    } catch {
      // Continue through the deterministic executable search path.
    }
  }
  return value;
}

module.exports = {
  resolveLocalCommand,
};
