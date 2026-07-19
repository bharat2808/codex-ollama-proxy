'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const CODEX_DIR = process.env.CODEX_HOME || path.join(process.env.HOME, '.codex');
const PLUGINS_CACHE_DIR = path.join(CODEX_DIR, 'plugins', 'cache');
const CODEX_APP_SERVER = process.env.CODEX_APP_SERVER_PATH ||
  '/Applications/ChatGPT.app/Contents/Resources/codex';

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

function splitPluginId(id) {
  const at = String(id || '').lastIndexOf('@');
  if (at <= 0) return { name: id, set: '' };
  return { name: id.slice(0, at), set: id.slice(at + 1) };
}

function getSkillCwds() {
  const raw = process.env.CODEX_SKILL_CWDS || process.env.CODEX_WORKSPACE_CWD || '';
  const configured = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (configured.length > 0) return configured;
  const cwd = process.cwd();
  return cwd && cwd !== '/' ? [cwd] : [];
}

function initializeRequest(id) {
  return {
    id,
    method: 'initialize',
    params: {
      clientInfo: {
        name: 'ollama-shape-proxy',
        title: null,
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    },
  };
}

function appServerRequestSync(requests) {
  if (!CODEX_APP_SERVER || !fs.existsSync(CODEX_APP_SERVER)) return null;
  const input = requests.map((request) => JSON.stringify(request)).join('\n') + '\n';
  let res;
  try {
    res = childProcess.spawnSync('/bin/sh', ['-lc',
      '{ printf %s "$CODEX_APP_SERVER_REQUEST"; sleep "${CODEX_APP_SERVER_STDIN_HOLD_SECONDS:-3}"; } | "$CODEX_APP_SERVER" app-server --stdio',
    ], {
      cwd: getSkillCwds()[0] || process.cwd(),
      env: {
        ...process.env,
        CODEX_APP_SERVER,
        CODEX_APP_SERVER_REQUEST: input,
      },
      timeout: 20000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  if (!res || res.error || res.status !== 0) return null;
  const stdout = Buffer.isBuffer(res.stdout) ? res.stdout.toString('utf8') : String(res.stdout || '');
  const messages = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { messages.push(JSON.parse(line)); } catch { /* ignore app-server noise */ }
  }
  return messages;
}

function getResponseResult(messages, id) {
  const msg = Array.isArray(messages) ? messages.find((m) => m && m.id === id) : null;
  if (!msg || msg.error) return null;
  return msg.result || {};
}

function enabledPluginSkillRoots(result) {
  if (!result) return [];
  const marketplaces = Array.isArray(result.marketplaces) ? result.marketplaces : [];
  const roots = [];
  const seen = new Set();
  for (const marketplace of marketplaces) {
    const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
    for (const plugin of plugins) {
      if (!plugin || plugin.installed !== true || plugin.enabled !== true) continue;
      const root = findPluginSkillRoot(plugin);
      if (!root || seen.has(root)) continue;
      seen.add(root);
      roots.push(root);
    }
  }
  return roots;
}

function findPluginSkillRoot(plugin) {
  if (!plugin || !plugin.id) return null;
  const parts = splitPluginId(plugin.id);
  if (!parts.name || !parts.set) return null;
  const base = path.join(PLUGINS_CACHE_DIR, parts.set, parts.name);
  const version = plugin.localVersion || plugin.version;
  const candidates = [];
  if (version) candidates.push(path.join(base, String(version)));
  const latest = pickLatestVersionDir(base);
  if (latest) candidates.push(latest);
  for (const root of candidates) {
    const skillsDir = path.join(root, 'skills');
    if (fs.existsSync(skillsDir)) return skillsDir;
  }
  return null;
}

function getEnabledPluginSkillRoots() {
  const messages = appServerRequestSync([
    initializeRequest(1),
    {
      id: 2,
      method: 'plugin/list',
      params: {
        cwds: getSkillCwds(),
        marketplaceKinds: null,
      },
    },
  ]);
  const result = getResponseResult(messages, 2);
  return enabledPluginSkillRoots(result);
}

function pluginNameFromSkill(skill) {
  const name = String(skill && skill.name || '');
  const colon = name.indexOf(':');
  if (colon > 0) return name.slice(0, colon);
  const marker = path.sep + 'plugins' + path.sep + 'cache' + path.sep;
  const skillPath = String(skill && skill.path || '');
  const idx = skillPath.indexOf(marker);
  if (idx < 0) return '';
  const rest = skillPath.slice(idx + marker.length).split(path.sep);
  return rest.length >= 2 ? rest[1] : '';
}

function entriesFromSkillsList(result) {
  const data = result && Array.isArray(result.data) ? result.data : [];
  const entries = [];
  const seen = new Set();
  for (const item of data) {
    const skills = item && Array.isArray(item.skills) ? item.skills : [];
    for (const skill of skills) {
      if (!skill || skill.enabled === false || !skill.name || !skill.path) continue;
      const key = String(skill.path);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        skill_name: String(skill.name),
        plugin_name: pluginNameFromSkill(skill),
        description: String(skill.description || ''),
        path: String(skill.path),
        scope: String(skill.scope || 'user'),
      });
    }
  }
  return entries;
}

function buildEntriesFromAppServer() {
  const roots = getEnabledPluginSkillRoots();
  const requests = [initializeRequest(1)];
  let listId = 2;
  if (roots.length > 0) {
    requests.push({
      id: 2,
      method: 'skills/extraRoots/set',
      params: { extraRoots: roots },
    });
    listId = 3;
  }
  requests.push({
    id: listId,
    method: 'skills/list',
    params: {
      cwds: getSkillCwds(),
      forceReload: true,
    },
  });
  const messages = appServerRequestSync(requests);
  return entriesFromSkillsList(getResponseResult(messages, listId));
}

// Query plugin state and skills through one live app-server process. Unlike the
// legacy synchronous helper, this does not use fixed sleeps and never blocks
// the proxy event loop while Codex builds its effective skill inventory.
function buildEntriesFromAppServerAsync(options = {}) {
  if (!CODEX_APP_SERVER || !fs.existsSync(CODEX_APP_SERVER)) return Promise.resolve([]);
  const configuredTimeout = Number(options.timeoutMs || process.env.CODEX_APP_SERVER_SKILLS_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 10000;

  return new Promise((resolve) => {
    let child;
    try {
      child = childProcess.spawn(CODEX_APP_SERVER, ['app-server', '--stdio'], {
        cwd: getSkillCwds()[0] || process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      resolve([]);
      return;
    }

    let settled = false;
    let stdout = '';
    let listId = null;
    const finish = (entries) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
      resolve(Array.isArray(entries) ? entries : []);
    };
    const send = (request) => {
      if (settled || !child.stdin || child.stdin.destroyed) return;
      try { child.stdin.write(JSON.stringify(request) + '\n'); } catch { finish([]); }
    };
    const requestSkills = (id) => {
      listId = id;
      send({
        id,
        method: 'skills/list',
        params: { cwds: getSkillCwds(), forceReload: true },
      });
    };
    const handleMessage = (message) => {
      if (!message || message.error) {
        if (message && (message.id === 2 || message.id === 3 || message.id === listId)) finish([]);
        return;
      }
      if (message.id === 2) {
        const roots = enabledPluginSkillRoots(message.result);
        if (roots.length === 0) {
          requestSkills(3);
        } else {
          send({ id: 3, method: 'skills/extraRoots/set', params: { extraRoots: roots } });
        }
        return;
      }
      if (message.id === 3 && listId === null) {
        requestSkills(4);
        return;
      }
      if (message.id === listId) finish(entriesFromSkillsList(message.result));
    };
    const consumeStdout = (chunk) => {
      stdout += chunk.toString('utf8');
      let newline;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        try { handleMessage(JSON.parse(line)); } catch { /* ignore app-server noise */ }
      }
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    child.once('error', () => finish([]));
    child.once('close', () => finish([]));
    if (child.stdin && typeof child.stdin.once === 'function') child.stdin.once('error', () => finish([]));
    if (child.stdout && typeof child.stdout.once === 'function') child.stdout.once('error', () => finish([]));
    child.stdout.on('data', consumeStdout);
    send(initializeRequest(1));
    send({
      id: 2,
      method: 'plugin/list',
      params: { cwds: getSkillCwds(), marketplaceKinds: null },
    });
  });
}

module.exports = {
  buildEntriesFromAppServer,
  buildEntriesFromAppServerAsync,
  getEnabledPluginSkillRoots,
};
