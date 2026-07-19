'use strict';

// skill_find.js
//
// Self-fulfillment loop for the synthetic `find_skill` tool, mirroring the
// pattern used by web_search.js: the proxy injects a plain `function` tool so
// the model can emit function_call{name:"find_skill"}; this loop fulfills those
// calls locally (via skill_index.searchSkills) and feeds the results back as
// function_call_output, then re-runs the model so it can act on the matched
// SKILL.md paths. web_search is intentionally NOT touched here.

const skillIndex = require('./skill-index');
const upstreamLib = require('./upstream');

const FIND_SKILL = 'find_skill';
const MAX_LOOPS = 4;

// Synthetic function-tool definition injected into request.tools so Ollama/GLM
// can call it. The proxy fulfills it; the app-server never sees a pending call.
const FIND_SKILL_FN = {
  type: 'function',
  name: FIND_SKILL,
  description: 'Find available Codex skills by keyword, summarize the enabled skill index, or list enabled skill entries. With action "search" (default), searches enabled skills by skill name, plugin name, and description, with plugin-name matches ranked highest, then skill name, then description. With action "summary", returns JSON counts for enabled skills by plugin and scope. With action "list", returns JSON skill entries with skill_name, plugin_name, scope, root, path, and description; filter by plugin, scope, or root. Call this when you need to locate a relevant skill before reading or invoking one, browse enabled skills, or inspect the skill inventory.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['search', 'summary', 'list'], description: '"search" to find matching skill paths (default), "summary" to return counts, or "list" to return enabled skill entries.' },
      query: { type: 'string', description: 'For action="search": what you are looking for, such as a plugin name, skill name, or topic. Plugin-name matches rank highest.' },
      plugin: { type: 'string', description: 'For action="list": filter by plugin name. Use "none" or "builtin" for skills with no plugin.' },
      scope: { type: 'string', description: 'For action="list": filter by scope, such as "user", "system", or "plugin" depending on the source index.' },
      root: { type: 'string', enum: ['user', 'system', 'agents', 'plugin', 'other'], description: 'For action="list": filter by filesystem/source root.' },
      limit: { type: 'number', description: 'For action="search": maximum matches to return (1-20), default 5. For action="list": maximum entries to return (1-500), default 200.' },
    },
  },
};

function hasFindSkillTool(body) {
  return !!(body && Array.isArray(body.tools) && body.tools.some((t) => t && (
    t.type === 'function' && t.name === FIND_SKILL
  )));
}

function parseArgs(v) {
  if (v == null) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch { return {}; }
}

function findSkillCalls(response) {
  const output = response && Array.isArray(response.output) ? response.output : [];
  return output.filter((item) => item && item.type === 'function_call' && item.name === FIND_SKILL);
}

async function postResponses(upstream, body) {
  return upstreamLib.requestJson(upstream, body);
}

// Fulfill one find_skill call: search the enabled-skill index and format paths.
function fulfillFindSkill(call, log) {
  const args = parseArgs(call.arguments);
  const action = String(args.action || 'search').trim().toLowerCase();
  if (action === 'summary') {
    try {
      const entries = skillIndex.getEntries();
      log && log('find_skill summary -> ' + entries.length + ' enabled skill(s)');
      return { call_id: call.call_id, output: skillIndex.formatSkillSummary(entries) };
    } catch (err) {
      log && log('find_skill summary failed: ' + err.message);
      return { call_id: call.call_id, output: '[find_skill error] ' + err.message };
    }
  }
  if (action === 'list') {
    const filters = {};
    if (args.plugin != null) filters.plugin = String(args.plugin);
    if (args.scope != null) filters.scope = String(args.scope);
    if (args.root != null) filters.root = String(args.root);
    if (args.limit != null) filters.limit = Number(args.limit);
    try {
      const entries = skillIndex.listSkills(filters);
      log && log('find_skill list -> ' + entries.length + ' enabled skill(s)');
      return { call_id: call.call_id, output: skillIndex.formatSkillList(entries, filters) };
    } catch (err) {
      log && log('find_skill list failed: ' + err.message);
      return { call_id: call.call_id, output: '[find_skill error] ' + err.message };
    }
  }

  const query = String(args.query || args.q || '').trim();
  if (!query) {
    return { call_id: call.call_id, output: '[find_skill error] query is required' };
  }
  const limit = Math.max(1, Math.min(20, Number(args.limit) || 5));
  try {
    const matches = skillIndex.searchSkills(query, { limit });
    log && log('find_skill query="' + query + '" limit=' + limit + ' -> ' + matches.length + ' match(es)');
    return { call_id: call.call_id, output: skillIndex.formatSkillMatches(matches) };
  } catch (err) {
    log && log('find_skill failed: ' + err.message);
    return { call_id: call.call_id, output: '[find_skill error] ' + err.message };
  }
}

function prewarmSkillIndex(log) {
  const started = Date.now();
  return skillIndex.prewarmEntries().then((entries) => {
    if (log) log('find_skill index ready: ' + entries.length + ' skill(s) in ' + (Date.now() - started) + 'ms');
    return entries;
  });
}

// Mirror of web_search.runResponsesLoop, but only for find_skill calls.
async function runFindSkillLoop(upstream, originalBody, options) {
  const log = options.log || (() => {});
  let body = JSON.parse(JSON.stringify(originalBody));
  body.stream = false;
  let fulfilled = false;

  for (let loop = 0; loop < MAX_LOOPS; loop += 1) {
    const response = await postResponses(upstream, body);
    const calls = findSkillCalls(response);
    if (calls.length === 0) return { response, fulfilled };

    fulfilled = true;
    log('find_skill loop: fulfilling ' + calls.length + ' call(s)');
    const outputs = calls.map((call) => {
      const r = fulfillFindSkill(call, log);
      return { type: 'function_call_output', call_id: r.call_id, output: r.output };
    });

    body = Object.assign({}, body, {
      input: [
        ...(Array.isArray(response.output) ? response.output : []),
        ...outputs,
      ],
      stream: false,
    });
  }

  throw new Error('find_skill loop exceeded ' + MAX_LOOPS + ' iterations');
}

module.exports = {
  FIND_SKILL,
  FIND_SKILL_FN,
  hasFindSkillTool,
  findSkillCalls,
  fulfillFindSkill,
  prewarmSkillIndex,
  runFindSkillLoop,
};
