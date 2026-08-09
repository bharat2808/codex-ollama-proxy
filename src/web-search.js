'use strict';

const http = require('http');
const https = require('https');
const skillFind = require('./skill-find');
const upstreamLib = require('./upstream');

const SEARCH_TOOL_NAMES = new Set(['web_search']);
const DEFAULT_MAX_RESULTS = 5;
const MAX_WEB_LOOPS = 4;

function hasNativeWebSearchTool(body) {
  // The proxy rewrites the native type:"web_search" tool into a plain
  // function tool named "web_search" (so GLM can call it). Recognize either
  // shape so the self-fulfillment loop still runs.
  return !!(body && Array.isArray(body.tools) && body.tools.some((t) => t && (
    t.type === 'web_search' || (t.type === 'function' && t.name === 'web_search')
  )));
}

function hasToolSearchTool(body) {
  return !!(body && Array.isArray(body.tools) && body.tools.some((t) => t && t.type === 'tool_search'));
}

function findSearchCalls(response) {
  const output = response && Array.isArray(response.output) ? response.output : [];
  return output.filter((item) => item && item.type === 'function_call' && SEARCH_TOOL_NAMES.has(item.name));
}

// Delegate find_skill call detection + fulfillment to skill_find.js so the
// web_search loop can handle both tool types in a single pass. Without this,
// the web_search loop intercepts every request (because Codex always sends a
// web_search tool) and returns before the standalone find_skill loop in
// proxy.js ever runs, causing "unsupported call: find_skill" at the app-server.
function findSkillCalls(response) {
  return skillFind.findSkillCalls(response);
}

function fulfillSkillCall(call, log) {
  return skillFind.fulfillFindSkill(call, log);
}

function parseArgs(args) {
  if (args == null) return {};
  if (typeof args === 'object') return args;
  try { return JSON.parse(String(args)); } catch { return {}; }
}

function requestJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method: 'POST',
      headers: Object.assign({
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      }, headers),
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed == null ? data : parsed);
          return;
        }
        const msg = parsed && parsed.error ? parsed.error : (data || res.statusMessage);
        const err = new Error(`HTTP ${res.statusCode}: ${typeof msg === 'object' ? JSON.stringify(msg) : msg}`);
        err.statusCode = res.statusCode;
        reject(err);
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function requestText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method: 'GET',
      headers,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200) || res.statusMessage}`));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeDuckUrl(url) {
  try {
    // Mirror duckduckgo_mcp_server: decode &amp; entities, then unwrap the
    // //duckduckgo.com/l/?uddg=<enc>&... redirect to the real target URL.
    const clean = String(url).replace(/&amp;/g, '&');
    const u = new URL(clean, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : u.href;
  } catch {
    return url;
  }
}

// --- Mirror of the mcp/duckduckgo image (duckduckgo_mcp_server.server) ---
// SafeSearch kp values: STRICT=1, MODERATE=-1 (default), OFF=-2
const DDG_SAFE_SEARCH_MAP = { STRICT: '1', MODERATE: '-1', OFF: '-2' };
const DDG_SAFE_SEARCH = (process.env.DDG_SAFE_SEARCH || 'MODERATE').toUpperCase();
const DDG_KP = DDG_SAFE_SEARCH_MAP[DDG_SAFE_SEARCH] || DDG_SAFE_SEARCH_MAP.MODERATE;
const DDG_REGION = process.env.DDG_REGION || '';
const DDG_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};
const DDG_BASE_URL = 'https://html.duckduckgo.com/html/';

// Token-bucket rate limiters matching the MCP (search 30/min, fetch 20/min).
function makeRateLimiter(requestsPerMinute) {
  const state = { requests: [] };
  return {
    async acquire() {
      const now = Date.now();
      state.requests = state.requests.filter((t) => now - t < 60000);
      if (state.requests.length >= requestsPerMinute) {
        const wait = 60000 - (now - state.requests[0]);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      state.requests.push(Date.now());
    },
  };
}
const ddgSearchLimiter = makeRateLimiter(30);
const ddgFetchLimiter = makeRateLimiter(20);
const searchBackends = {
  requestJson,
  duckDuckGoSearch,
};

function requestPostForm(url, formData, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = new URLSearchParams(formData).toString();
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || undefined,
      path: u.pathname + u.search, method: 'POST',
      headers: Object.assign({
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(payload),
      }, headers),
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(requestText(res.headers.location, headers));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode}: ${(data || res.statusMessage).slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// GET with redirect following (mirrors httpx follow_redirects=True used by the MCP fetcher).
function fetchUrlText(url, headers = {}, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || undefined,
      path: u.pathname + u.search, method: 'GET', headers,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        res.resume();
        resolve(fetchUrlText(new URL(res.headers.location, url).href, headers, maxRedirects - 1));
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`)); return; }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end();
  });
}

// Same shape as ollama_local: { results: [{title, url, content}], source }.
// Mirrors DuckDuckGoSearcher.search: POST form {q,b,kl,kp} to html.duckduckgo.com/html,
// parse .result__a (title+link) and .result__snippet, skip ad (y.js) links, unwrap uddg.
async function duckDuckGoSearch(query, maxResults) {
  await ddgSearchLimiter.acquire();
  const form = { q: query, b: '', kl: DDG_REGION, kp: DDG_KP };
  const html = await requestPostForm(DDG_BASE_URL, form, DDG_HEADERS);
  const titleRe = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const titles = [];
  let m;
  while ((m = titleRe.exec(html))) {
    let link = m[1];
    if (link.includes('y.js')) continue; // skip ad results, like the MCP
    titles.push({ title: stripTags(m[2]), url: decodeDuckUrl(link) });
  }
  const snippets = [];
  while ((m = snipRe.exec(html))) snippets.push(stripTags(m[1]));
  const results = [];
  for (let i = 0; i < titles.length && results.length < maxResults; i++) {
    results.push({ title: titles[i].title, url: titles[i].url, content: snippets[i] || '' });
  }
  if (results.length === 0) throw new Error('DuckDuckGo returned no parseable results');
  return { results, source: 'duckduckgo' };
}

// Mirror of WebContentFetcher.fetch_and_parse (the MCP `fetch_content` tool):
// GET the page, strip script/style/nav/header/footer, collapse whitespace, paginate,
// append a [Content info: ...] footer. Returned in the same shape as ollama_local.
function htmlToReadableText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchPageContent(url, startIndex, maxLength) {
  await ddgFetchLimiter.acquire();
  startIndex = Math.max(0, Number(startIndex) || 0);
  maxLength = Math.max(1, Number(maxLength) || 8000);
  const html = await fetchUrlText(url, DDG_HEADERS);
  let text = htmlToReadableText(html);
  const totalLength = text.length;
  const slice = text.slice(startIndex, startIndex + maxLength);
  const isTruncated = startIndex + maxLength < totalLength;
  let meta = `\n\n---\n[Content info: Showing characters ${startIndex}-${startIndex + slice.length} of ${totalLength} total`;
  if (isTruncated) meta += `. Use start_index=${startIndex + maxLength} to see more`;
  meta += ']';
  // Same shape as ollama_local: one result whose content is the fetched page text.
  return { results: [{ title: url, url, content: slice + meta }], source: 'duckduckgo_page' };
}

async function searchWeb(args, log) {
  // action: "search" (default) or "open_page". open_page mirrors the MCP
  // fetch_content tool and returns fetched page text in the ollama_local shape.
  const action = String(args.action || 'search').trim();
  if (action === 'open_page' || action === 'open') {
    const url = String(args.url || '').trim();
    if (!url) throw new Error('web_search open_page requires a url');
    return fetchPageContent(url, args.start_index, args.max_length);
  }
  const query = String(args.query || args.q || '').trim();
  if (!query) throw new Error('web_search query is required');
  const maxResults = Math.max(1, Math.min(10, Number(args.max_results || args.limit || DEFAULT_MAX_RESULTS) || DEFAULT_MAX_RESULTS));

  const directKey = process.env.OLLAMA_API_KEY;
  if (directKey) {
    try {
      const data = await searchBackends.requestJson('https://ollama.com/api/web_search', {
        query,
        max_results: maxResults,
      }, { authorization: `Bearer ${directKey}` });
      return Object.assign({ source: 'ollama_direct' }, data);
    } catch (err) {
      log && log(`ollama direct web_search failed: ${err.message}`);
    }
  }

  try {
    const data = await searchBackends.requestJson('http://127.0.0.1:11434/api/experimental/web_search', {
      query,
      max_results: maxResults,
    });
    return Object.assign({ source: 'ollama_local' }, data);
  } catch (err) {
    log && log(`ollama local web_search failed: ${err.message}`);
  }

  return searchBackends.duckDuckGoSearch(query, maxResults);
}

function formatSearchResult(search) {
  const source = search.source || 'unknown';
  const results = Array.isArray(search.results) ? search.results : [];
  if (results.length === 0) return `[web_search source=${source}]\nNo results found.`;
  return [
    `[web_search source=${source}]`,
    ...results.map((r, i) => [
      `${i + 1}. ${r.title || '(untitled)'}`,
      `URL: ${r.url || ''}`,
      `Content: ${r.content || ''}`,
    ].join('\n')),
  ].join('\n\n');
}

async function postResponses(upstream, body) {
  return upstreamLib.requestJson(upstream, body);
}

async function runResponsesLoop(upstream, originalBody, options = {}) {
  const log = options.log || (() => {});
  const verboseTools = !!options.verboseTools;
  let body = JSON.parse(JSON.stringify(originalBody));
  body.stream = false;
  const continuationInput = upstreamLib.responsesInputItems(body.input);
  let fulfilledWebSearch = false;

  for (let loop = 0; loop < MAX_WEB_LOOPS; loop += 1) {
    const response = await postResponses(upstream, body);
    const calls = findSearchCalls(response);
    const skillCalls = findSkillCalls(response);
    if (calls.length === 0 && skillCalls.length === 0) return { response, fulfilledWebSearch };

    if (calls.length > 0) fulfilledWebSearch = true;
    log(`proxy loop: fulfilling ${calls.length} web_search call(s), ${skillCalls.length} find_skill call(s)`);
    const outputs = [];
    for (const call of calls) {
      if (verboseTools) log('[verbose-tools] web_search loop function_call: ' + JSON.stringify(call));
      const args = parseArgs(call.arguments);
      try {
        const search = await searchWeb(args, log);
        log && log(`web_search source: ${search.source || 'unknown'}`);
        outputs.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: formatSearchResult(search),
        });
      } catch (err) {
        outputs.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: `[web_search error]\n${err.message}`,
        });
      }
    }
    for (const call of skillCalls) {
      if (verboseTools) log('[verbose-tools] find_skill loop function_call: ' + JSON.stringify(call));
      const r = fulfillSkillCall(call, log);
      outputs.push({
        type: 'function_call_output',
        call_id: r.call_id,
        output: r.output,
      });
    }

    continuationInput.push(
      ...(Array.isArray(response.output) ? response.output : []),
      ...outputs,
    );
    body = Object.assign({}, body, {
      input: [...continuationInput],
      stream: false,
    });
  }

  throw new Error(`proxy loop exceeded ${MAX_WEB_LOOPS} iterations`);
}

module.exports = {
  hasNativeWebSearchTool,
  hasToolSearchTool,
  runResponsesLoop,
  findSearchCalls,
  searchWeb,
  formatSearchResult,
  __setSearchBackendsForTest(overrides) {
    if (overrides.requestJson) searchBackends.requestJson = overrides.requestJson;
    if (overrides.duckDuckGoSearch) searchBackends.duckDuckGoSearch = overrides.duckDuckGoSearch;
  },
  __resetSearchBackendsForTest() {
    searchBackends.requestJson = requestJson;
    searchBackends.duckDuckGoSearch = duckDuckGoSearch;
  },
};
