'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pluginCompat = require('../src/plugin-compat');

test('registry resolves plugin identifiers and plugin links', () => {
  assert.equal(
    pluginCompat.findPlugin('plugin://computer-use@openai-bundled/').discoveryQuery,
    'node_repl'
  );
  assert.equal(pluginCompat.findPlugin('computer-use').pluginId, 'computer-use@openai-bundled');
});

test('plugin identifiers recover to their deferred tool search', () => {
  assert.deepEqual(
    pluginCompat.recoverToolCall('plugin://computer-use@openai-bundled/', new Set()),
    {
      kind: 'tool_search',
      pluginId: 'computer-use@openai-bundled',
      query: 'node_repl',
      message: 'Recovered plugin identifier plugin://computer-use@openai-bundled/; search for node_repl.',
    }
  );
});

test('dotted and unambiguous bare calls recover to exact callable names', () => {
  const names = new Set(['mcp__node_repl__js', 'mcp__browser__click']);

  assert.equal(
    pluginCompat.recoverToolCall('mcp__node_repl.js', names).name,
    'mcp__node_repl__js'
  );
  assert.equal(pluginCompat.recoverToolCall('click', names).name, 'mcp__browser__click');
});

test('ambiguous bare calls are not guessed', () => {
  const names = new Set(['mcp__one__list', 'mcp__two__list']);
  assert.equal(pluginCompat.recoverToolCall('list', names), null);
});

test('tool_search aliases normalize to registered discovery queries', () => {
  assert.equal(pluginCompat.normalizeDiscoveryQuery('computer use'), 'node_repl');
  assert.equal(
    pluginCompat.normalizeDiscoveryQuery('computer-use@openai-bundled'),
    'node_repl'
  );
  assert.equal(pluginCompat.normalizeDiscoveryQuery('calendar events'), 'calendar events');
});
