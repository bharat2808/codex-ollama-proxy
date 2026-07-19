'use strict';

const fs = require('fs');
const path = require('path');
const pluginCompat = require('./plugin-compat');

function versionDirs(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .sort((a, b) => path.basename(b).localeCompare(path.basename(a), undefined, { numeric: true }));
}

function runtimeAt(plugin, pluginRoot) {
  const bootstrapPath = path.join(pluginRoot, ...plugin.bootstrapRelativePath);
  const sourceSkillPath = path.join(pluginRoot, ...plugin.sourceSkillRelativePath);
  if (!fs.existsSync(bootstrapPath) || !fs.existsSync(sourceSkillPath)) return null;
  return {
    pluginRoot: fs.realpathSync(pluginRoot),
    bootstrapPath: fs.realpathSync(bootstrapPath),
    sourceSkillPath: fs.realpathSync(sourceSkillPath),
  };
}

function resolvePluginRuntime(plugin, codexDir) {
  const roots = plugin.runtimeRoots.map((parts) => path.join(codexDir, ...parts));
  for (const root of roots) {
    const direct = runtimeAt(plugin, root);
    if (direct) return direct;
    for (const candidate of versionDirs(root)) {
      const runtime = runtimeAt(plugin, candidate);
      if (runtime) return runtime;
    }
  }
  return null;
}

function bridgeInstructions(plugin, bootstrapPath) {
  return `${plugin.generatedMarker}

## Local-model compatibility bridge

- \`${plugin.pluginId}\` is a plugin identifier, not a URL, plugin link, MCP server name, or callable tool.
- This plugin operates through the deferred \`${plugin.discoveryQuery}\` tool. If it is not callable yet, call \`tool_search\` with exactly \`{"query":${JSON.stringify(plugin.discoveryQuery)}}\`, then invoke the exact callable name returned by that search.
- Do not import \`${plugin.directImportPackage}\` directly and do not copy unresolved placeholder paths.
- Initialize each fresh \`${plugin.discoveryQuery}\` session with this resolved bootstrap:

\`\`\`js
if (!globalThis.${plugin.runtimeGlobal}) {
  const { ${plugin.bootstrapExport} } = await import(${JSON.stringify(bootstrapPath)});
  ${plugin.bootstrapCall}
}
\`\`\`
`;
}

function renderCompatibilitySkill(plugin, source, runtime) {
  let resolvedSource = String(source);
  const placeholders = plugin.sourceRootPlaceholders ||
    (plugin.sourceRootPlaceholder ? [plugin.sourceRootPlaceholder] : []);
  for (const placeholder of placeholders) {
    resolvedSource = resolvedSource.replaceAll(placeholder, runtime.pluginRoot);
  }
  const frontmatter = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/.exec(resolvedSource);
  if (!frontmatter) throw new Error(plugin.pluginId + ' SKILL.md has no valid frontmatter');
  return frontmatter[1] + '\n' + bridgeInstructions(plugin, runtime.bootstrapPath) + '\n' +
    resolvedSource.slice(frontmatter[1].length);
}

function installPluginSkill(plugin, options = {}) {
  const codexDir = path.resolve(options.codexDir || path.join(process.env.HOME, '.codex'));
  const runtime = resolvePluginRuntime(plugin, codexDir);
  if (!runtime) return { status: 'runtime_missing', pluginId: plugin.pluginId };

  const destination = path.join(codexDir, ...plugin.stableSkillRelativePath);
  let existing = null;
  try { existing = fs.readFileSync(destination, 'utf8'); } catch {}
  if (existing != null && !existing.includes(plugin.generatedMarker)) {
    return { status: 'conflict', pluginId: plugin.pluginId, destination, runtime };
  }

  const source = fs.readFileSync(runtime.sourceSkillPath, 'utf8');
  const rendered = renderCompatibilitySkill(plugin, source, runtime);
  if (existing === rendered) return { status: 'current', pluginId: plugin.pluginId, destination, runtime };

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, rendered, 'utf8');
  return {
    status: existing == null ? 'created' : 'updated',
    pluginId: plugin.pluginId,
    destination,
    runtime,
  };
}

function installCompatibilitySkills(options = {}) {
  return pluginCompat.PLUGINS
    .filter((plugin) => plugin.runtimeRoots && plugin.bootstrapRelativePath && plugin.sourceSkillRelativePath)
    .map((plugin) => installPluginSkill(plugin, options));
}

module.exports = {
  installCompatibilitySkills,
  installPluginSkill,
  renderCompatibilitySkill,
  resolvePluginRuntime,
};
