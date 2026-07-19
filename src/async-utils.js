'use strict';

async function mapLimit(values, limit, mapper) {
  const output = new Array(values.length);
  let next = 0;

  async function worker() {
    while (next < values.length) {
      const index = next++;
      output[index] = await mapper(values[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output;
}

module.exports = { mapLimit };
