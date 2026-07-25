'use strict';

const { boundedPositiveInteger } = require('./normalize');

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function firstBoundedPositiveInteger(maximum, ...values) {
  for (const value of values) {
    const parsed = boundedPositiveInteger(value, maximum);
    if (parsed !== null) return parsed;
  }
  return null;
}

function normalizedStrings(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string').map((entry) => entry.trim().toLowerCase())
    : [];
}

function isUnavailableModelRow(value) {
  const row = record(value);
  if (!row || row.active === false || row.enabled === false || row.available === false) return true;
  return row.archived === true || row.deprecated === true;
}

module.exports = {
  firstBoundedPositiveInteger,
  isUnavailableModelRow,
  normalizedStrings,
  record,
};
