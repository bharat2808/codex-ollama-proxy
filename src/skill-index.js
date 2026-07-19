'use strict';

// skill_index.js
//
// Dynamically builds an index of the skills that are currently TURNED ON in
// this Codex installation, then ranks them by a weighted query match.
//
// Sources of skills (only enabled ones are indexed):
//   1. Plugin skills -> only from plugins enabled in ~/.codex/config.toml
//      ([plugins.name@set] enabled = true). The plugin name (from the
//      plugin plugin.json) is stored per skill.
//   2. User skills    -> ~/.codex/skills/<name>/SKILL.md (always on).
//   3. Agent skills   -> ~/.agents/skills/<name>/SKILL.md (always on unless disabled).
//   4. System skills  -> ~/.codex/skills/.system/<name>/SKILL.md (always on).
//
// Each index entry is { skill_name, plugin_name, description, path, scope }.
// Ranking weights (by design): plugin-name direct match is the highest signal,
// then skill-name, then description token overlap.

const fs = require('fs');
const path = require('path');
const codexAppServerSkills = require('./codex-app-server-skills');

const CODEX_DIR = process.env.CODEX_HOME || path.join(process.env.HOME, '.codex');
const SKILLS_DIR = path.join(CODEX_DIR, 'skills');
const SYSTEM_SKILLS_DIR = path.join(SKILLS_DIR, '.system');
const AGENTS_SKILLS_DIR = process.env.CODEX_AGENTS_SKILLS_DIR ||
  path.join(path.dirname(CODEX_DIR), '.agents', 'skills');
const PLUGINS_CACHE_DIR = path.join(CODEX_DIR, 'plugins', 'cache');
const CONFIG_TOML = path.join(CODEX_DIR, 'config.toml');

const CACHE_TTL_MS = 60000;
let _cache = null; // { entries, builtAt, configMtime }
let _backgroundRefresh = false;
let _refreshPromise = null;

function readTextSafe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function statMtimeSafe(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function listDirs(dir) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return ents.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(dir, e.name));
}

// Parse the YAML-ish frontmatter of a SKILL.md. We only need name and
// description, so a full YAML parser is overkill. Handles quoted values.
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let val = kv[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[kv[1]] = val;
  }
  return out;
}

function readSkill(skillMdPath) {
  const text = readTextSafe(skillMdPath);
  if (!text) return null;
  const fm = parseFrontmatter(text);
  const name = (fm.name || path.basename(path.dirname(skillMdPath))).trim();
  const description = (fm.description || '').trim();
  return { skill_name: name, description, path: skillMdPath };
}

// Parse config.toml just for top-level [plugins.name@set] blocks with
// enabled=true/false. Nested plugin tool config tables intentionally do not
// match this parser.
function parsePluginEnablement(tomlPath) {
  const raw = readTextSafe(tomlPath);
  if (!raw) return new Map();
  const states = new Map();
  const lines = raw.split(/\r?\n/);
  let current = null; // { id, enabled }
  for (const line of lines) {
    const hdr = /^\s*\[plugins\.(?:'([^']+)'|"([^"]+)"|([^\]]+))\]/.exec(line);
    if (hdr) {
      if (current && current.enabled != null) states.set(current.id, current.enabled);
      const id = hdr[1] || hdr[2] || hdr[3];
      current = id ? { id: id.trim(), enabled: null } : null;
      continue;
    }
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) {
      if (current && current.enabled != null) states.set(current.id, current.enabled);
      current = null;
      continue;
    }
    if (current) {
      const m = /^\s*enabled\s*=\s*(true|false)\b/i.exec(line);
      if (m) current.enabled = m[1].toLowerCase() === 'true';
    }
  }
  if (current && current.enabled != null) states.set(current.id, current.enabled);
  return states;
}

function parseEnabledPlugins(tomlPath) {
  return Array.from(parsePluginEnablement(tomlPath).entries())
    .filter(([, enabled]) => enabled === true)
    .map(([id]) => id);
}

function parseDisabledSkillConfig(tomlPath) {
  const raw = readTextSafe(tomlPath);
  const disabled = { names: new Set(), paths: new Set() };
  if (!raw) return disabled;
  const lines = raw.split(/\r?\n/);
  let current = null; // { name, path, enabled }
  const addCurrent = () => {
    if (!current || current.enabled !== false) return;
    if (current.name) disabled.names.add(current.name);
    if (current.path) disabled.paths.add(path.resolve(current.path));
  };
  for (const line of lines) {
    if (/^\s*\[\[skills\.config\]\]\s*$/.test(line)) {
      addCurrent();
      current = { name: null, path: null, enabled: null };
      continue;
    }
    if (/^\s*\[/.test(line) && !/^\s*\[\[skills\.config\]\]\s*$/.test(line)) {
      addCurrent();
      current = null;
      continue;
    }
    if (!current) continue;
    const name = /^\s*name\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/.exec(line);
    if (name) {
      current.name = (name[1] || name[2] || name[3] || '').trim();
      continue;
    }
    const skillPath = /^\s*path\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/.exec(line);
    if (skillPath) {
      current.path = (skillPath[1] || skillPath[2] || skillPath[3] || '').trim();
      continue;
    }
    const enabled = /^\s*enabled\s*=\s*(true|false)\b/i.exec(line);
    if (enabled) current.enabled = enabled[1].toLowerCase() === 'true';
  }
  addCurrent();
  return disabled;
}

function parseDisabledSkills(tomlPath) {
  return parseDisabledSkillConfig(tomlPath).names;
}

function splitPluginId(id) {
  const at = id.lastIndexOf('@');
  if (at <= 0) return { name: id, set: '' };
  return { name: id.slice(0, at), set: id.slice(at + 1) };
}

function readPluginManifest(pluginRoot) {
  const json = readTextSafe(path.join(pluginRoot, '.codex-plugin', 'plugin.json'));
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

// Loose version comparison (handles 0.1.0, 0.1.0+codex.2026..., 26.616).
function cmpVer(a, b) {
  const pa = String(a).split(/[.+]/);
  const pb = String(b).split(/[.+]/);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const na = parseInt(pa[i], 10);
    const nb = parseInt(pb[i], 10);
    const va = Number.isNaN(na) ? pa[i] : na;
    const vb = Number.isNaN(nb) ? pb[i] : nb;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return String(a).localeCompare(String(b));
}

function pickLatestVersionDir(setDir) {
  let ents = [];
  try { ents = fs.readdirSync(setDir, { withFileTypes: true }); } catch { return null; }
  const dirs = ents.filter((e) => e.isDirectory()).map((e) => e.name);
  if (dirs.length === 0) return null;
  dirs.sort((a, b) => cmpVer(b, a));
  return path.join(setDir, dirs[0]);
}

function discoverInstalledPluginIds() {
  const ids = new Set(parseEnabledPlugins(CONFIG_TOML));
  const explicitStates = parsePluginEnablement(CONFIG_TOML);
  let sets = [];
  try { sets = fs.readdirSync(PLUGINS_CACHE_DIR, { withFileTypes: true }); } catch { return Array.from(ids); }
  for (const setEnt of sets) {
    if (!setEnt.isDirectory()) continue;
    const setName = setEnt.name;
    const setDir = path.join(PLUGINS_CACHE_DIR, setName);
    let plugins = [];
    try { plugins = fs.readdirSync(setDir, { withFileTypes: true }); } catch { continue; }
    for (const pluginEnt of plugins) {
      if (!pluginEnt.isDirectory()) continue;
      const pluginName = pluginEnt.name;
      const id = pluginName + '@' + setName;
      if (explicitStates.get(id) === false) continue;
      const installMarker = path.join(setDir, pluginName, '.codex-remote-plugin-install.json');
      if (fs.existsSync(installMarker)) ids.add(id);
    }
  }
  return Array.from(ids);
}

function filterDisabledSkills(entries) {
  const disabled = parseDisabledSkillConfig(CONFIG_TOML);
  if (disabled.names.size === 0 && disabled.paths.size === 0) return entries;
  return entries.filter((entry) => {
    if (disabled.names.has(entry.skill_name)) return false;
    if (entry.path && disabled.paths.has(path.resolve(entry.path))) return false;
    return true;
  });
}

function indexSkillRoot(entries, skillsDir, scope) {
  for (const dir of listDirs(skillsDir)) {
    const s = readSkill(path.join(dir, 'SKILL.md'));
    if (!s) continue;
    entries.push({
      skill_name: s.skill_name, plugin_name: '', description: s.description,
      path: s.path, scope,
    });
  }
}

function indexUserSkills(entries) {
  indexSkillRoot(entries, SKILLS_DIR, 'user');
}

function indexAgentSkills(entries) {
  indexSkillRoot(entries, AGENTS_SKILLS_DIR, 'user');
}

function indexSystemSkills(entries) {
  indexSkillRoot(entries, SYSTEM_SKILLS_DIR, 'system');
}

function indexPluginSkills(entries) {
  const enabled = discoverInstalledPluginIds();
  for (const id of enabled) {
    const parts = splitPluginId(id);
    const pluginRoot = pickLatestVersionDir(path.join(PLUGINS_CACHE_DIR, parts.set, parts.name));
    if (!pluginRoot) continue;
    const manifest = readPluginManifest(pluginRoot) || {};
    const pluginName = (manifest.name || parts.name).trim();
    const skillsDir = path.join(pluginRoot, 'skills');
    for (const dir of listDirs(skillsDir)) {
      const s = readSkill(path.join(dir, 'SKILL.md'));
      if (!s) continue;
      const skillName = s.skill_name.includes(':') ? s.skill_name : pluginName + ':' + s.skill_name;
      entries.push({
        skill_name: skillName, plugin_name: pluginName, description: s.description,
        path: s.path, scope: 'plugin',
      });
    }
  }
}

function buildFallbackEntries() {
  const entries = [];
  indexUserSkills(entries);
  indexAgentSkills(entries);
  indexSystemSkills(entries);
  indexPluginSkills(entries);
  return filterDisabledSkills(entries);
}

function buildEntries() {
  const appServerEntries = codexAppServerSkills.buildEntriesFromAppServer();
  if (appServerEntries.length > 0) return appServerEntries;
  return buildFallbackEntries();
}

function cacheEntries(entries, source) {
  _cache = {
    entries,
    builtAt: Date.now(),
    configMtime: statMtimeSafe(CONFIG_TOML),
    source,
  };
  return entries;
}

function refreshEntriesInBackground() {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = codexAppServerSkills.buildEntriesFromAppServerAsync()
    .then((entries) => {
      if (Array.isArray(entries) && entries.length > 0) cacheEntries(entries, 'app_server');
      return _cache ? _cache.entries : [];
    })
    .catch(() => (_cache ? _cache.entries : []))
    .finally(() => { _refreshPromise = null; });
  return _refreshPromise;
}

// Seed a usable filesystem index immediately, then replace it with Codex's
// exact enabled-skill inventory without blocking request handling.
function prewarmEntries() {
  _backgroundRefresh = true;
  const cfgMtime = statMtimeSafe(CONFIG_TOML);
  if (!_cache || _cache.configMtime !== cfgMtime) cacheEntries(buildFallbackEntries(), 'filesystem');
  return refreshEntriesInBackground();
}

function getEntries(force) {
  const now = Date.now();
  const cfgMtime = statMtimeSafe(CONFIG_TOML);
  if (!force && _cache && _cache.entries &&
      now - _cache.builtAt < CACHE_TTL_MS &&
      _cache.configMtime === cfgMtime) {
    return _cache.entries;
  }
  if (_backgroundRefresh && !force) {
    if (!_cache || _cache.configMtime !== cfgMtime) cacheEntries(buildFallbackEntries(), 'filesystem');
    refreshEntriesInBackground();
    return _cache.entries;
  }
  const entries = buildEntries();
  return cacheEntries(entries, 'synchronous');
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'skill',
  'find', 'me', 'please', 'show', 'get', 'use', 'do',
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9._-]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

function scoreEntry(entry, queryTokens, queryNorm) {
  const pName = String(entry.plugin_name || '').toLowerCase();
  const sName = String(entry.skill_name || '').toLowerCase();
  const desc = String(entry.description || '').toLowerCase();
  const pTokens = new Set(tokenize(entry.plugin_name));
  const sTokens = new Set(tokenize(entry.skill_name));
  const dSet = new Set(tokenize(entry.description));
  let score = 0;

  // plugin name: highest weight
  if (entry.plugin_name && pName === queryNorm) score += 100;
  for (const qt of queryTokens) {
    if (pTokens.has(qt)) score += 40;
    else if (entry.plugin_name && (pName.includes(qt) || qt.includes(pName))) score += 15;
  }

  // skill name: next
  if (sName === queryNorm) score += 80;
  if (sName.startsWith(queryNorm) && queryNorm) score += 25;
  for (const qt of queryTokens) {
    if (sTokens.has(qt)) score += 30;
    else if (sName.includes(qt)) score += 12;
  }

  // description: lowest weight
  if (queryNorm && desc.includes(queryNorm)) score += 20;
  for (const qt of queryTokens) {
    if (dSet.has(qt)) score += 4;
  }

  return score;
}

function searchSkills(query, opts) {
  const limit = Math.max(1, Math.min(50, Number((opts && opts.limit) || 5)));
  const entries = getEntries(opts && opts.force);
  const queryTokens = tokenize(query);
  const queryNorm = String(query || '').toLowerCase().trim();
  const scored = entries
    .map((e) => ({ entry: e, score: scoreEntry(e, queryTokens, queryNorm) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.skill_name.localeCompare(b.entry.skill_name));
  return scored.slice(0, limit);
}

function skillRoot(entry) {
  const p = String(entry && entry.path || '');
  if (p.includes('/.codex/skills/.system/')) return 'system';
  if (p.includes('/.agents/skills/')) return 'agents';
  if (p.includes('/.codex/skills/')) return 'user';
  if (entry && entry.plugin_name) return 'plugin';
  return 'other';
}

function normalizePluginFilter(plugin) {
  const value = String(plugin || '').trim();
  if (!value || value === '*') return null;
  if (['none', 'builtin', 'built-in', 'local'].includes(value.toLowerCase())) return '';
  return value;
}

function listSkills(opts) {
  const entries = getEntries(opts && opts.force);
  const pluginFilter = normalizePluginFilter(opts && opts.plugin);
  const scopeFilter = String((opts && opts.scope) || '').trim();
  const rootFilter = String((opts && opts.root) || '').trim();
  const limitRaw = Number(opts && opts.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 200;

  return entries
    .filter((entry) => pluginFilter == null || String(entry.plugin_name || '') === pluginFilter)
    .filter((entry) => !scopeFilter || String(entry.scope || '') === scopeFilter)
    .filter((entry) => !rootFilter || skillRoot(entry) === rootFilter)
    .sort((a, b) => {
      const pa = String(a.plugin_name || '');
      const pb = String(b.plugin_name || '');
      return pa.localeCompare(pb) || String(a.skill_name || '').localeCompare(String(b.skill_name || ''));
    })
    .slice(0, limit);
}

function formatSkillMatches(matches) {
  if (!matches || matches.length === 0) return '[find_skill] No matching skills found.';
  const lines = ['[find_skill] top ' + matches.length + ' skill match(es):'];
  matches.forEach((m, i) => {
    const e = m.entry;
    const who = e.plugin_name ? ('plugin=' + e.plugin_name) : ('scope=' + e.scope);
    const desc = e.description ? (e.description.length > 240 ? e.description.slice(0, 240) + '...' : e.description) : '';
    lines.push(
      (i + 1) + '. ' + e.skill_name + ' (' + who + ', score=' + m.score + ')' +
      '\n   path: ' + e.path + (desc ? '\n   desc: ' + desc : '')
    );
  });
  return lines.join('\n');
}

function summarizeSkills(entries) {
  const summary = {
    type: 'skills_summary',
    total_enabled_skills: 0,
    by_plugin: {},
    by_scope: {},
  };
  for (const entry of entries || []) {
    summary.total_enabled_skills += 1;
    const plugin = entry.plugin_name || 'none';
    const scope = entry.scope || 'unknown';
    summary.by_plugin[plugin] = (summary.by_plugin[plugin] || 0) + 1;
    summary.by_scope[scope] = (summary.by_scope[scope] || 0) + 1;
  }
  summary.by_plugin = Object.fromEntries(
    Object.entries(summary.by_plugin).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  );
  summary.by_scope = Object.fromEntries(
    Object.entries(summary.by_scope).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  );
  return summary;
}

function formatSkillSummary(entries) {
  return JSON.stringify(summarizeSkills(entries), null, 2);
}

function formatSkillList(entries, filters) {
  const skills = (entries || []).map((entry) => ({
    skill_name: entry.skill_name,
    plugin_name: entry.plugin_name || '',
    scope: entry.scope || '',
    root: skillRoot(entry),
    path: entry.path,
    description: entry.description || '',
  }));
  return JSON.stringify({
    type: 'skills_list',
    total_enabled_skills: skills.length,
    filters: filters || {},
    skills,
  }, null, 2);
}

module.exports = {
  CODEX_DIR,
  AGENTS_SKILLS_DIR,
  getEntries,
  buildEntries,
  buildFallbackEntries,
  prewarmEntries,
  searchSkills,
  listSkills,
  formatSkillMatches,
  summarizeSkills,
  formatSkillSummary,
  formatSkillList,
  parseEnabledPlugins,
  parseDisabledSkillConfig,
  parseDisabledSkills,
};
