'use strict';

// Model-facing compatibility facts for bundled plugins whose identifier,
// discovery tool, and runtime package have different names. Add future plugin
// bridges here instead of scattering one-off prompt text through the proxy.
const PLUGINS = Object.freeze([Object.freeze({
  pluginId: 'computer-use@openai-bundled',
  aliases: Object.freeze(['computer-use', 'computer-use@openai']),
  discoveryQuery: 'node_repl',
  callablePattern: /(^|__)node_repl($|__)/,
  skillName: 'computer-use',
  runtimeRoots: Object.freeze([
    Object.freeze(['skills', '.system', 'computer-use']),
    Object.freeze(['plugins', 'cache', 'openai-bundled', 'computer-use']),
  ]),
  bootstrapRelativePath: Object.freeze(['scripts', 'computer-use-client.mjs']),
  sourceSkillRelativePath: Object.freeze(['skills', 'computer-use', 'SKILL.md']),
  stableSkillRelativePath: Object.freeze(['skills', 'computer-use', 'SKILL.md']),
  directImportPackage: '@oai/sky',
  sourceRootPlaceholder: '<plugin root>',
})]);

function normalizePluginReference(value) {
  return String(value || '')
    .trim()
    .replace(/^plugin:\/\//i, '')
    .replace(/\/+$/u, '')
    .toLowerCase();
}

function findPlugin(value) {
  const normalized = normalizePluginReference(value);
  if (!normalized) return null;
  return PLUGINS.find((plugin) =>
    normalized === plugin.pluginId.toLowerCase() ||
    plugin.aliases.some((alias) => normalized === alias.toLowerCase())
  ) || null;
}

function toolSearchGuidance() {
  return PLUGINS.map((plugin) =>
    `${plugin.pluginId} is a plugin identifier, not a URL, plugin link, MCP server name, or callable tool. ` +
    `Discover its runtime with exactly {"query":${JSON.stringify(plugin.discoveryQuery)}} and invoke the exact callable name returned by the search.`
  ).join(' ');
}

function discoveredGuidance(callableNames) {
  const names = Array.from(callableNames || []);
  const messages = [];
  for (const plugin of PLUGINS) {
    const matches = names.filter((name) => plugin.callablePattern.test(name));
    if (matches.length) {
      messages.push(
        `${plugin.pluginId} compatibility: ${plugin.discoveryQuery} is now callable. ` +
        `Invoke its exact returned name: ${matches.join(', ')}. Do not invoke ${plugin.pluginId}; it is only a plugin identifier.`
      );
    }
  }
  return messages.join('\n');
}

function recoverToolCall(name, callableNames) {
  const plugin = findPlugin(name);
  if (plugin) {
    return {
      kind: 'tool_search',
      pluginId: plugin.pluginId,
      query: plugin.discoveryQuery,
      message: `Recovered plugin identifier ${name}; search for ${plugin.discoveryQuery}.`,
    };
  }

  const original = String(name || '').trim();
  if (!original) return null;
  const available = Array.from(callableNames || []).filter(Boolean);
  if (available.includes(original)) return null;

  const dotted = original.replaceAll('.', '__');
  if (dotted !== original && available.includes(dotted)) {
    return { kind: 'callable', name: dotted, message: `Use exact callable name ${dotted}.` };
  }

  const bareMatches = available.filter((candidate) =>
    candidate.endsWith('__' + original) || candidate.split('__').at(-1) === original
  );
  if (bareMatches.length === 1) {
    return {
      kind: 'callable',
      name: bareMatches[0],
      message: `Recovered bare tool name ${original}; use exact callable name ${bareMatches[0]}.`,
    };
  }
  return null;
}

module.exports = {
  PLUGINS,
  discoveredGuidance,
  findPlugin,
  recoverToolCall,
  toolSearchGuidance,
};
