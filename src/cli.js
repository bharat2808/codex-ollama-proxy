#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const presets = require('./presets');
const imagineConfig = require('./imagine-config');
const launcherState = require('./launcher-state');
const runtimePaths = require('./runtime-paths');
const { requireVerifiedProxyListeners } = require('./process-lifecycle');

const PACKAGE_DIR = path.resolve(__dirname, '..');
const HOME_DIR = runtimePaths.homeDir();
const CODEX_DIR = runtimePaths.codexDir();
const RUNTIME_DIR = path.join(CODEX_DIR, 'ollama-shape-proxy');
const ROUTE_CONFIG = path.join(RUNTIME_DIR, 'proxy-models.toml');
const IMAGINE_CONFIG = path.join(RUNTIME_DIR, 'imagine.toml');
const LAUNCHER_STATE = path.join(RUNTIME_DIR, 'launcher-state.json');
const DEFAULT_ROUTE_CONFIG = path.join(PACKAGE_DIR, 'config', 'proxy-models.default.toml');
const DEFAULT_MODEL_CATALOG = path.join(PACKAGE_DIR, 'config', 'model-catalogs', 'ollama-launch-models.default.json');
const MODEL_CATALOG = path.join(CODEX_DIR, 'ollama-launch-models-ollama-working.json');
const MODEL_CATALOG_COPY = path.join(CODEX_DIR, 'ollama-launch-models.json');
const PLIST = path.join(HOME_DIR, 'Library', 'LaunchAgents', 'com.user.codex-ollama-shape-proxy.plist');
const LABEL = 'com.user.codex-ollama-shape-proxy';
const PROXY_PORT = process.env.PROXY_PORT || String(launcherState.DEFAULT_PROXY_PORT);
const SERVICE_PLATFORM = process.env.CODEX_PROXY_PLATFORM || process.platform;
const SYSTEMD_UNIT = path.join(runtimePaths.systemdUserDir(), 'codex-ollama-proxy.service');
const WINDOWS_COMMAND = path.join(RUNTIME_DIR, 'start-proxy.cmd');
const WINDOWS_TASK = 'Codex Ollama Proxy';

function usage() {
  console.log(`Usage:
  codex-ollama-proxy init [--force]
  codex-ollama-proxy serve [--adaptor chat-completion|google] [--dedupe-large-input|--no-dedupe-large-input] [--dedupe-min-chars N]
  codex-ollama-proxy serve --preset NAME [--api-key KEY] [--replace]
  codex-ollama-proxy serve --adaptor chat-completion|google [--completion-model MODEL] [--adaptor-port PORT]
  codex-ollama-proxy preset add NAME [--provider PROVIDER] [--adaptor chat-completion|google|none] [--url URL] --models MODEL[,MODEL...] [--default-model MODEL] [--image-model MODEL] [--api-key KEY]
  codex-ollama-proxy preset add NAME --provider vertexai --project PROJECT --location LOCATION --models MODEL[,MODEL...] [--vertex-token TOKEN]
    [--auto-image|--no-auto-image] [--dedupe-large-input|--no-dedupe-large-input] [--dedupe-min-chars N]
    [--persist-images|--no-persist-images] [--image-retention-days DAYS]
    [--verbose-tools|--no-verbose-tools] [--log-upstream-body|--no-log-upstream-body]
    [--enable-find-skill|--no-enable-find-skill] [--stream-loop|--no-stream-loop]
  codex-ollama-proxy preset list
  codex-ollama-proxy preset show NAME
  codex-ollama-proxy preset use NAME [--api-key KEY] [--default-model MODEL] [--no-start]
  codex-ollama-proxy run NAME [--api-key KEY] [--default-model MODEL] [--adaptor-port PORT] [--replace] [--foreground]
  codex-ollama-proxy status
  codex-ollama-proxy switch openai
  codex-ollama-proxy switch ollama [--model MODEL] [--no-start]
  codex-ollama-proxy route --models MODEL[,MODEL...] [--default-model MODEL] [--image-model MODEL] [--auto-image|--no-auto-image]
                           [--persist-images|--no-persist-images] [--image-retention-days DAYS]
  codex-ollama-proxy upstream [--url URL] [--api-key KEY] [--status]
  codex-ollama-proxy logs [--tail N]
  codex-ollama-proxy install
  codex-ollama-proxy uninstall
  codex-ollama-proxy restart
  codex-ollama-proxy imagine [--enable|--disable] [--service gemini|openai|ollama --model MODEL]
  codex-ollama-proxy imagine [--base-url URL] [--api-key KEY]
  codex-ollama-proxy imagine [--quality fast|balanced|quality]
  codex-ollama-proxy imagine [--enhance|--no-enhance] [--aspect-ratio RATIO]
  codex-ollama-proxy imagine --status
  codex-ollama-proxy imagine --doctor`);
}

function die(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: options.stdio || 'inherit', encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0 && options.check !== false) process.exit(result.status ?? 1);
  return result;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parseProxyPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PROXY_PORT must be an integer from 1 to 65535');
  }
  return port;
}

function configuredProxyPort() {
  if (process.env.PROXY_PORT !== undefined) return parseProxyPort(process.env.PROXY_PORT);
  const state = launcherState.read(LAUNCHER_STATE);
  return state ? state.proxy_port : launcherState.DEFAULT_PROXY_PORT;
}

function launcherRuntimeOverrides(proxyPort) {
  const overrides = { proxy_port: parseProxyPort(proxyPort) };
  if (process.env.PROXY_DEDUPE_LARGE_INPUT === '1') overrides.dedupe_large_input = true;
  if (process.env.PROXY_DEDUPE_LARGE_INPUT === '0') overrides.dedupe_large_input = false;
  if (process.env.PROXY_DEDUPE_MIN_CHARS !== undefined) {
    overrides.dedupe_min_chars = process.env.PROXY_DEDUPE_MIN_CHARS;
  }
  return overrides;
}

function bootstrapLaunchAgent() {
  let lastResult = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    lastResult = run('launchctl', ['bootstrap', `gui/${process.getuid()}`, PLIST], {
      check: false,
      stdio: attempt === 5 ? 'inherit' : 'pipe',
    });
    if (lastResult.status === 0) return;
    if (attempt < 5) sleepMs(250);
  }
  process.exit(lastResult?.status ?? 1);
}

function bootoutLaunchAgent() {
  const result = spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

function stopPlatformService() {
  if (SERVICE_PLATFORM === 'darwin') return bootoutLaunchAgent();
  if (SERVICE_PLATFORM === 'linux') {
    return run('systemctl', ['--user', 'stop', 'codex-ollama-proxy.service'], { check: false, stdio: 'pipe' }).status === 0;
  }
  if (SERVICE_PLATFORM === 'win32') {
    return run('schtasks.exe', ['/End', '/TN', WINDOWS_TASK], { check: false, stdio: 'pipe' }).status === 0;
  }
  return false;
}

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const key = (eq >= 0 ? arg.slice(2, eq) : arg.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (eq >= 0) flags[key] = arg.slice(eq + 1);
    else if (['force', 'auto-image', 'no-auto-image', 'persist-images', 'no-persist-images', 'dedupe-large-input', 'no-dedupe-large-input', 'verbose-tools', 'no-verbose-tools', 'log-upstream-body', 'no-log-upstream-body', 'enable-find-skill', 'no-enable-find-skill', 'stream-loop', 'no-stream-loop', 'imagine-enable', 'imagine-disable', 'imagine-enhance', 'imagine-no-enhance', 'enable', 'disable', 'enhance', 'no-enhance', 'doctor', 'status', 'no-refresh', 'no-backup', 'no-start', 'replace', 'no-replace', 'foreground'].includes(arg.slice(2))) flags[key] = true;
    else flags[key] = argv[++i];
  }
  return { flags, rest };
}

function writePrivateText(file, text) {
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function init(options = {}) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  imagineConfig.ensure(IMAGINE_CONFIG);
  if (!fs.existsSync(ROUTE_CONFIG) || options.force) {
    fs.copyFileSync(DEFAULT_ROUTE_CONFIG, ROUTE_CONFIG);
    console.log(`created=${ROUTE_CONFIG}`);
  } else {
    console.log(`exists=${ROUTE_CONFIG}`);
  }
  if (!fs.existsSync(MODEL_CATALOG) || options.force) {
    fs.copyFileSync(DEFAULT_MODEL_CATALOG, MODEL_CATALOG);
    fs.copyFileSync(DEFAULT_MODEL_CATALOG, MODEL_CATALOG_COPY);
    console.log(`catalog_created=${MODEL_CATALOG}`);
    console.log(`catalog_copy=${MODEL_CATALOG_COPY}`);
  } else {
    console.log(`catalog_exists=${MODEL_CATALOG}`);
  }
  fs.chmodSync(ROUTE_CONFIG, 0o600);
}

// Redact secret values in a TOML string so status() never leaks API keys.
function redactSecrets(text) {
  return text
    .replace(/^(\s*imagine_api_key\s*=\s*")([^"]*)(".*)$/m, (_m, a, value, b) => `${a}${value ? '***' : ''}${b}`)
    .replace(/^(\s*upstream_api_key\s*=\s*")([^"]*)(".*)$/m, (_m, a, value, b) => `${a}${value ? '***' : ''}${b}`);
}

function readRouteConfig() {
  if (!fs.existsSync(ROUTE_CONFIG)) init();
  return fs.readFileSync(ROUTE_CONFIG, 'utf8');
}

function readRouteValue(text, key, fallback = '') {
  const quoted = text.match(new RegExp('^\\s*' + key + '\\s*=\\s*"([^"]*)"', 'm'));
  if (quoted) return quoted[1];
  const bare = text.match(new RegExp('^\\s*' + key + '\\s*=\\s*([^\\s#]+)', 'm'));
  return bare ? bare[1] : fallback;
}

function writeRouteValue(text, key, value) {
  // Render booleans/numbers bare and strings quoted; match an existing
  // quoted-string, boolean, or bare-number assignment so numeric config keys
  // (e.g. duplicate_input_min_chars) are replaced in place rather than appended.
  const rendered = Array.isArray(value)
    ? `[${value.map((entry) => `"${String(entry).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`).join(', ')}]`
    : typeof value === 'boolean' ? String(value)
    : typeof value === 'number' ? String(value)
    : `"${value}"`;
  const pattern = new RegExp(`^(\\s*${key}\\s*=\\s*)(?:\\[[^\\]]*\\]|"[^"]*"|true|false|-?\\d+\\b).*`, 'm');
  if (pattern.test(text)) return text.replace(pattern, (_match, prefix) => prefix + rendered);
  return `${text.replace(/\s+$/u, '')}\n${key} = ${rendered}\n`;
}

function applyImagineConfigToText(text) {
  const values = imagineConfig.read(IMAGINE_CONFIG);
  for (const [key, value] of Object.entries(values)) {
    text = writeRouteValue(text, key, value);
  }
  return text;
}

function applyImagineConfigToRoute() {
  const text = applyImagineConfigToText(readRouteConfig());
  writePrivateText(ROUTE_CONFIG, text);
}

function applyPreset(name, flags = {}) {
  const preset = presets.readPreset(RUNTIME_DIR, name);
  // A preset is a saved partial proxy-models.toml. Apply is authoritative for
  // the keys it stores: switchMode resets the route to the template default,
  // then every stored key is overlaid. Keys the preset does not specify keep
  // the template default. --model/--api-key are run-only overrides layered on
  // top (the stored preset file is not modified), mirroring `switch ollama
  // --model`.
  const values = Object.assign({}, preset.values);
  if (flags.textModel) {
    values.models = [flags.textModel];
    values.default_model = flags.textModel;
    values.image_model = flags.textModel;
  }
  if (flags.defaultModel) {
    if (!values.models.includes(flags.defaultModel)) die('Error: --default-model must occur in the preset models.');
    values.default_model = flags.defaultModel;
  }
  if (flags.vertexToken !== undefined && flags.apiKey !== undefined) {
    die('Error: use either --vertex-token or --api-key, not both.');
  }
  if (flags.vertexToken === '') {
    die('Error: --vertex-token was passed but empty.');
  }
  if (flags.vertexToken !== undefined) {
    const presetUrl = values.upstream_url || '';
    if (preset.adaptor !== 'google'
      || !/^https:\/\/aiplatform\.googleapis\.com\/v1\/projects\/[^/]+\/locations\/[^/]+\/endpoints\/openapi\/?$/u.test(presetUrl)) {
      die('Error: --vertex-token can only be used with a Vertex AI preset.');
    }
  }
  if (flags.apiKey === '') {
    die('Error: --api-key was passed but empty. Check your shell variable with: echo ${NVIDIA_API_KEY:+set}');
  }
  const apiKey = flags.vertexToken !== undefined
    ? flags.vertexToken
    : flags.apiKey !== undefined ? flags.apiKey : values.upstream_api_key;
  if (apiKey !== undefined) values.upstream_api_key = apiKey || '';
  // Normalize Codex into proxy mode without refreshing yet. The preset route
  // must be written first so model discovery queries the preset provider
  // instead of the temporary local-Ollama defaults installed by switchMode.
  switchMode('ollama', {
    noRefresh: true,
    noBackup: flags.noBackup,
    noStart: true,
  });
  let text = readRouteConfig();
  for (const def of presets.PRESET_KEY_DEFS) {
    if (def.key in values) text = writeRouteValue(text, def.key, values[def.key]);
  }
  text = writeRouteValue(text, 'active_preset', name);
  text = applyImagineConfigToText(text);
  writePrivateText(ROUTE_CONFIG, text);
  if (!flags.noRefresh) codexConfig(['refresh']);
  launcherState.write(LAUNCHER_STATE, launcherState.fromPreset(preset, {
    proxy_port: configuredProxyPort(),
  }));
  console.log(`preset_applied=${name}`);
  console.log(`updated=${ROUTE_CONFIG}`);
  console.log(`adaptor=${preset.adaptor}`);
  if (flags.apiKey !== '') console.log(`api_key=${apiKey ? 'set' : 'unchanged_or_empty'}`);
  return preset;
}

async function presetCmd(subcommand, argv) {
  if (!subcommand || subcommand === '-h' || subcommand === '--help') return usage();
  if (subcommand === 'list') return presets.listPresets(RUNTIME_DIR, console.log);
  const [name, ...tail] = argv;
  if (!name) die(`Error: preset ${subcommand} requires a name.`);
  const { flags } = parseFlags(tail);
  if (subcommand === 'add') return presets.addPreset(RUNTIME_DIR, name, flags, console.log);
  if (subcommand === 'show') return presets.showPreset(RUNTIME_DIR, name, console.log);
  if (subcommand === 'use') {
    const preset = applyPreset(name, flags);
    if (flags.noStart) return preset;
    return startPresetServer(preset, Object.assign({}, flags, { replace: !flags.noReplace }));
  }
  die('Error: preset command must be add, list, show, or use.');
}

function resetRouteForOllama(flags = {}) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  let text = fs.readFileSync(DEFAULT_ROUTE_CONFIG, 'utf8');
  if (flags.model) {
    text = writeRouteValue(text, 'default_model', flags.model);
    text = writeRouteValue(text, 'image_model', flags.model);
  }
  text = applyImagineConfigToText(text);
  writePrivateText(ROUTE_CONFIG, text);
  console.log(`route_reset=ollama (${ROUTE_CONFIG})`);
}

function route(flags) {
  let text = readRouteConfig();
  const routedModels = flags.models
    ? String(flags.models).split(',').map((entry) => entry.trim()).filter(Boolean)
    : flags.textModel ? [flags.textModel] : null;
  if (routedModels) {
    text = writeRouteValue(text, 'models', [...new Set(routedModels)]);
    text = writeRouteValue(text, 'default_model', flags.defaultModel || routedModels[0]);
  } else if (flags.defaultModel) {
    text = writeRouteValue(text, 'default_model', flags.defaultModel);
  }
  if (flags.imageModel) text = writeRouteValue(text, 'image_model', flags.imageModel);
  if (flags.autoImage) text = writeRouteValue(text, 'auto_route_image', true);
  if (flags.noAutoImage) text = writeRouteValue(text, 'auto_route_image', false);
  if (flags.persistImages) text = writeRouteValue(text, 'persist_inline_images', true);
  if (flags.noPersistImages) text = writeRouteValue(text, 'persist_inline_images', false);
  if (flags.imageRetentionDays !== undefined) {
    const retentionDays = Number(flags.imageRetentionDays);
    if (!Number.isInteger(retentionDays) || retentionDays < 0) {
      die('Error: --image-retention-days must be a non-negative integer.');
    }
    text = writeRouteValue(text, 'inline_image_retention_days', retentionDays);
  }
  text = applyImagineConfigToText(text);
  writePrivateText(ROUTE_CONFIG, text);
  console.log(`updated=${ROUTE_CONFIG}`);
}

function upstreamCmd(flags) {
  if (flags.status) {
    const text = readRouteConfig();
    for (const field of ['upstream_url', 'upstream_api_key']) {
      const m = text.match(new RegExp('^\\s*' + field + '\\s*=\\s*(.*)$', 'm'));
      const val = m ? m[1] : '(not set)';
      const display = field === 'upstream_api_key' && val !== '""' && val !== '(not set)' ? '(set)' : val;
      console.log(field + ' = ' + display);
    }
    return;
  }
  let text = readRouteConfig();
  if (flags.url) {
    try {
      const url = new URL(flags.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('must use http or https');
    } catch (err) {
      die('Error: --url must be an absolute http(s) URL. ' + err.message);
    }
    text = writeRouteValue(text, 'upstream_url', flags.url);
  }
  if (flags.apiKey) text = writeRouteValue(text, 'upstream_api_key', flags.apiKey);
  if (!flags.url && !flags.apiKey) {
    die('Error: upstream requires --url, --api-key, or --status.');
  }
  writePrivateText(ROUTE_CONFIG, text);
  console.log(`updated=${ROUTE_CONFIG}`);
}

function codexConfig(args) {
  run(process.execPath, [path.join(PACKAGE_DIR, 'model_config.js'), ...args]);
}

function switchMode(mode, flags) {
  if (mode === 'openai') {
    codexConfig(['openai']);
    return;
  }
  if (mode !== 'ollama') die('switch mode must be "openai" or "ollama"');
  init();
  resetRouteForOllama(flags);
  const args = ['ollama'];
  if (flags.model) args.push('--model', flags.model);
  if (flags.noRefresh) args.push('--no-refresh');
  if (flags.noBackup) args.push('--no-backup');
  codexConfig(args);
  if (!flags.noStart) {
    const proxyPort = parseProxyPort(process.env.PROXY_PORT || PROXY_PORT);
    launcherState.write(LAUNCHER_STATE, {
      version: launcherState.VERSION,
      adaptor: 'none',
      proxy_port: proxyPort,
    });
    stopPlatformService();
    stopListeningPort(proxyPort);
    install();
    return waitForProxyResponse(proxyPort).then((probe) => {
      console.log(`proxy=http://127.0.0.1:${proxyPort} status=${probe.statusCode || 'unreachable'}`);
      if (probe.statusCode === 0) {
        console.log(`logs=${path.join(RUNTIME_DIR, 'proxy.log')}`);
      }
      console.log('Restart Codex or open a fresh thread so provider discovery reloads.');
    });
  }
  console.log('Restart Codex or open a fresh thread so provider discovery reloads.');
}

function status() {
  codexConfig(['status']);
  console.log('');
  console.log(redactSecrets(readRouteConfig()).trim());
  const proxyPort = configuredProxyPort();
  const req = http.get(`http://127.0.0.1:${proxyPort}/v1/models`, { timeout: 2000 }, (res) => {
    res.resume();
    console.log(`\nproxy=http://127.0.0.1:${proxyPort} status=${res.statusCode}`);
  });
  req.on('timeout', () => {
    req.destroy();
    console.log(`\nproxy=http://127.0.0.1:${proxyPort} status=timeout`);
  });
  req.on('error', (e) => console.log(`\nproxy=http://127.0.0.1:${proxyPort} status=unreachable (${e.message})`));
}

function probeJson(port, requestPath, timeoutMs = 750) {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: requestPath,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(raw); } catch {}
        resolve({ statusCode: res.statusCode || 0, body, raw });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ statusCode: 0, body: null, raw: '', error: 'timeout' });
    });
    req.on('error', (error) => resolve({ statusCode: 0, body: null, raw: '', error: error.message }));
  });
}

function listeningPids(port) {
  if (SERVICE_PLATFORM === 'win32') {
    const result = spawnSync('netstat.exe', ['-ano', '-p', 'TCP'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return [...new Set(String(result.stdout || '').split(/\r?\n/u).flatMap((line) => {
      const fields = line.trim().split(/\s+/u);
      return fields.length >= 5 && fields[1].endsWith(`:${port}`) && fields[3] === 'LISTENING' ? [fields[4]] : [];
    }))];
  }
  const result = spawnSync('lsof', ['-nP', '-tiTCP:' + port, '-sTCP:LISTEN'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error && result.error.code === 'ENOENT') {
    const ss = spawnSync('ss', ['-ltnp', `sport = :${port}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return [...new Set([...String(ss.stdout || '').matchAll(/pid=(\d+)/gu)].map((match) => match[1]))];
  }
  if (result.status !== 0 && !result.stdout) return [];
  return result.stdout.split(/\s+/u).filter(Boolean);
}

function describePortOwner(port) {
  if (SERVICE_PLATFORM === 'win32') {
    const result = spawnSync('netstat.exe', ['-ano', '-p', 'TCP'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return String(result.stdout || '').split(/\r?\n/u)
      .filter((line) => line.trim().split(/\s+/u)[1]?.endsWith(`:${port}`)).join('\n').trim();
  }
  const result = spawnSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.stdout ? result.stdout.trim() : '';
}

function processCommand(pid) {
  if (SERVICE_PLATFORM === 'win32') {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}").CommandLine`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return result.status === 0 && result.stdout ? result.stdout.trim() : '';
  }
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 && result.stdout ? result.stdout.trim() : '';
}

function stopListeningPort(port, allowedPids = null) {
  const allowed = allowedPids ? new Set(allowedPids.map(String)) : null;
  let pids = listeningPids(port).filter((pid) => pid !== String(process.pid));
  if (allowed && pids.some((pid) => !allowed.has(pid))) return false;
  if (pids.length === 0) return true;
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGTERM');
    } catch {}
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    pids = listeningPids(port).filter((pid) => pid !== String(process.pid));
    if (pids.length === 0) return true;
    if (allowed && pids.some((pid) => !allowed.has(pid))) return false;
    sleepMs(100);
  }
  for (const pid of pids.filter((pid) => !allowed || allowed.has(pid))) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {}
  }
  sleepMs(100);
  return listeningPids(port).filter((pid) => pid !== String(process.pid)).length === 0;
}

function isHealthyProxyModelsResponse(probe) {
  if (!probe || probe.statusCode < 200 || probe.statusCode >= 500 || !probe.body) return false;
  if (probe.body.object === 'list' && Array.isArray(probe.body.data)) return true;
  if (Array.isArray(probe.body.models) || Array.isArray(probe.body.data)) return true;
  return false;
}

async function ensureProxyCanStart(flags, proxyPort) {
  const existingProxy = await probeJson(proxyPort, '/v1/models');
  if (isHealthyProxyModelsResponse(existingProxy)) {
    if (flags.replace) {
      console.log(`replace=stopping_existing_listener port=${proxyPort}`);
      if (stopPlatformService()) console.log('replace=stopped_background_service');
      if (!stopListeningPort(proxyPort)) die(`Error: could not stop existing listener on 127.0.0.1:${proxyPort}.`);
      return true;
    }
    console.log(`already_running=http://127.0.0.1:${proxyPort}`);
    console.log('Use `codex-ollama-proxy status` to inspect it, or stop the existing process before restarting.');
    return false;
  }
  const occupiedPids = listeningPids(proxyPort);
  if (existingProxy.statusCode > 0 || occupiedPids.length > 0) {
    if (flags.replace) {
      console.log(`replace=stopping_existing_listener port=${proxyPort}`);
      if (stopPlatformService()) console.log('replace=stopped_background_service');
      if (!stopListeningPort(proxyPort)) die(`Error: could not stop existing listener on 127.0.0.1:${proxyPort}.`);
      return true;
    }
    console.log(`already_running_unhealthy=http://127.0.0.1:${proxyPort} status=${existingProxy.statusCode || 'unknown'}`);
    const owner = describePortOwner(proxyPort);
    if (owner) console.log(owner);
    console.log('Run again with --replace to stop that listener and start this preset, or stop it yourself first.');
    return false;
  }
  return true;
}

async function waitForProxyResponse(port, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await probeJson(port, '/v1/models', 500);
    if (probe.statusCode > 0) return probe;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { statusCode: 0, body: null, raw: '', error: 'timeout' };
}

function renderPlist() {
  const template = fs.readFileSync(path.join(PACKAGE_DIR, 'config', 'launchd.plist.template'), 'utf8');
  let state = launcherState.read(LAUNCHER_STATE);
  if (!state) {
    const activePreset = readRouteValue(readRouteConfig(), 'active_preset', '');
    state = activePreset
      ? launcherState.fromPreset(presets.readPreset(RUNTIME_DIR, activePreset))
      : { version: launcherState.VERSION, adaptor: 'none' };
    state = launcherState.write(LAUNCHER_STATE, state);
  }
  if (process.env.PROXY_PORT !== undefined && parseProxyPort(process.env.PROXY_PORT) !== state.proxy_port) {
    state = launcherState.write(LAUNCHER_STATE, {
      ...state,
      proxy_port: parseProxyPort(process.env.PROXY_PORT),
    });
  }
  return template
    .replaceAll('__PROGRAM_ARGUMENTS__', launcherState.renderProgramArgumentsXml(
      state,
      process.execPath,
      path.join(PACKAGE_DIR, 'bin', 'codex-ollama-proxy'),
    ))
    .replaceAll('__LOG__', path.join(RUNTIME_DIR, 'proxy.log'))
    .replaceAll('__CODEX_HOME__', launcherState.escapeXml(CODEX_DIR))
    .replaceAll('__PORT__', String(state.proxy_port));
}

function launcherStateForInstall() {
  let state = launcherState.read(LAUNCHER_STATE);
  if (!state) {
    const activePreset = readRouteValue(readRouteConfig(), 'active_preset', '');
    state = activePreset
      ? launcherState.fromPreset(presets.readPreset(RUNTIME_DIR, activePreset))
      : { version: launcherState.VERSION, adaptor: 'none' };
    state = launcherState.write(LAUNCHER_STATE, state);
  }
  if (process.env.PROXY_PORT !== undefined && parseProxyPort(process.env.PROXY_PORT) !== state.proxy_port) {
    state = launcherState.write(LAUNCHER_STATE, { ...state, proxy_port: parseProxyPort(process.env.PROXY_PORT) });
  }
  return state;
}

function install() {
  init();
  const state = launcherStateForInstall();
  if (SERVICE_PLATFORM === 'darwin') {
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    fs.writeFileSync(PLIST, renderPlist(), 'utf8');
    bootoutLaunchAgent();
    bootstrapLaunchAgent();
    run('launchctl', ['enable', `gui/${process.getuid()}/${LABEL}`], { check: false });
    run('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LABEL}`], { check: false });
    return;
  }
  if (SERVICE_PLATFORM === 'linux') {
    fs.mkdirSync(path.dirname(SYSTEMD_UNIT), { recursive: true });
    fs.writeFileSync(SYSTEMD_UNIT, launcherState.renderSystemdUnit(state, process.execPath,
      path.join(PACKAGE_DIR, 'bin', 'codex-ollama-proxy'), path.join(RUNTIME_DIR, 'proxy.log'), CODEX_DIR), 'utf8');
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', 'codex-ollama-proxy.service']);
    console.log(`installed=${SYSTEMD_UNIT}`);
    return;
  }
  if (SERVICE_PLATFORM === 'win32') {
    fs.writeFileSync(WINDOWS_COMMAND, launcherState.renderWindowsCommand(state, process.execPath,
      path.join(PACKAGE_DIR, 'bin', 'codex-ollama-proxy'), path.join(RUNTIME_DIR, 'proxy.log'), CODEX_DIR), 'utf8');
    stopPlatformService();
    const taskCommand = `cmd.exe /d /c ""${WINDOWS_COMMAND}""`;
    run('schtasks.exe', ['/Create', '/TN', WINDOWS_TASK, '/SC', 'ONLOGON', '/TR', taskCommand, '/F']);
    run('schtasks.exe', ['/Run', '/TN', WINDOWS_TASK]);
    console.log(`installed=${WINDOWS_COMMAND}`);
    return;
  }
  die(`Error: background installation is not supported on ${SERVICE_PLATFORM}. Use codex-ollama-proxy serve.`);
}

function uninstall() {
  stopPlatformService();
  let serviceFile = PLIST;
  if (SERVICE_PLATFORM === 'linux') {
    run('systemctl', ['--user', 'disable', 'codex-ollama-proxy.service'], { check: false });
    serviceFile = SYSTEMD_UNIT;
  } else if (SERVICE_PLATFORM === 'win32') {
    run('schtasks.exe', ['/Delete', '/TN', WINDOWS_TASK, '/F'], { check: false });
    serviceFile = WINDOWS_COMMAND;
  }
  if (fs.existsSync(serviceFile)) fs.unlinkSync(serviceFile);
  if (SERVICE_PLATFORM === 'linux') run('systemctl', ['--user', 'daemon-reload'], { check: false });
  console.log(`removed=${serviceFile}`);
}

async function restart() {
  const proxyPort = configuredProxyPort();
  stopPlatformService();

  const listeners = listeningPids(proxyPort).filter((pid) => pid !== String(process.pid));
  let verifiedPids;
  try {
    verifiedPids = requireVerifiedProxyListeners(listeners, processCommand);
  } catch (error) {
    const owner = describePortOwner(proxyPort);
    if (owner) console.error(owner);
    die(`Error: ${error.message}`);
  }

  if (verifiedPids.length > 0) {
    console.log(`restart=stopping_verified_proxy pids=${verifiedPids.join(',')} port=${proxyPort}`);
    if (!stopListeningPort(proxyPort, verifiedPids)) {
      die(`Error: listener ownership changed while restarting 127.0.0.1:${proxyPort}; no unverified process was stopped.`);
    }
  }

  install();
  const startupTimeout = Number(process.env.CODEX_PROXY_START_TIMEOUT_MS || 6000);
  const probe = await waitForProxyResponse(proxyPort, startupTimeout);
  if (!isHealthyProxyModelsResponse(probe)) {
    die(`Error: replacement proxy did not become healthy on 127.0.0.1:${proxyPort}. Check logs: codex-ollama-proxy logs --tail 100`);
  }
  console.log(`restarted=http://127.0.0.1:${proxyPort} status=${probe.statusCode}`);
}

function logs(flags) {
  const n = Number(flags.tail || 100);
  if (!Number.isInteger(n) || n < 0) die('Error: --tail must be a non-negative integer.');
  const logPath = path.join(RUNTIME_DIR, 'proxy.log');
  if (!fs.existsSync(logPath)) die(`Error: log file does not exist: ${logPath}`);
  if (n === 0) return;
  const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  console.log(lines.slice(-n).join('\n'));
}

async function serveCmd(flags = {}) {
  // Runtime opt-in for the large-input dedupe filter. Default is off (see
  // proxy.js) to avoid breaking provider implicit caching; these set the env
  // vars the proxy reads at module load, so they must be set before the proxy
  // is required below.
  if (flags.dedupeLargeInput) process.env.PROXY_DEDUPE_LARGE_INPUT = '1';
  if (flags.noDedupeLargeInput) process.env.PROXY_DEDUPE_LARGE_INPUT = '0';
  if (flags.dedupeMinChars !== undefined) process.env.PROXY_DEDUPE_MIN_CHARS = String(flags.dedupeMinChars);
  if (flags.preset) {
    const preset = applyPreset(flags.preset, flags);
    flags = Object.assign({}, flags, { adaptor: preset.adaptor });
  }
  if (!process.env.PROXY_PORT) process.env.PROXY_PORT = PROXY_PORT;
  const proxyPort = parseProxyPort(process.env.PROXY_PORT || PROXY_PORT);
  const runtimeOverrides = launcherRuntimeOverrides(proxyPort);
  if (!await ensureProxyCanStart(flags, proxyPort)) return null;
  // "none" (or no --adaptor) means a direct Responses-API upstream (local
  // Ollama or a hosted Responses endpoint) — no adaptor process is started.
  if (!flags.adaptor || flags.adaptor === 'none') {
    const proxyServer = require('./proxy').startServer();
    await launcherState.writeWhenListening(
      LAUNCHER_STATE,
      launcherState.normalize({
        version: launcherState.VERSION,
        adaptor: 'none',
        ...runtimeOverrides,
      }),
      [proxyServer],
    );
    return proxyServer;
  }
  if (!['chat-completion', 'google'].includes(flags.adaptor)) {
    die('Error: --adaptor must be "chat-completion", "google", or "none".');
  }

  const routeConfig = readRouteConfig();
  const adaptorPort = String(flags.adaptorPort || process.env.CHAT_COMPLETION_ADAPTOR_PORT || process.env.COMPLETION_ADAPTOR_PORT || '8787');
  const providerUrl = readRouteValue(routeConfig, 'upstream_url');
  const providerApiKey = readRouteValue(routeConfig, 'upstream_api_key');
  const providerModel = flags.completionModel || readRouteValue(routeConfig, 'default_model');
  if (!providerUrl) die('Error: configure the chat-completion provider with: codex-ollama-proxy upstream --url URL [--api-key KEY]');

  const savedLauncherState = {
    version: launcherState.VERSION,
    adaptor: flags.adaptor,
    adaptor_port: parseInt(adaptorPort, 10),
    ...runtimeOverrides,
  };
  if (flags.completionModel) savedLauncherState.completion_model = String(flags.completionModel);
  const adaptor = flags.adaptor === 'google'
    ? require('../adaptor/google-api-adaptor')
    : require('../adaptor/completion-api-adaptor');
  const adaptorServer = adaptor.startServer({
    port: parseInt(adaptorPort, 10),
    baseUrl: providerUrl,
    apiKey: providerApiKey,
    defaultModel: providerModel,
  });

  process.env.PROXY_UPSTREAM_URL = `http://127.0.0.1:${adaptorPort}/v1`;
  process.env.PROXY_UPSTREAM_API_KEY = '';
  const proxyServer = require('./proxy').startServer();
  await launcherState.writeWhenListening(LAUNCHER_STATE, savedLauncherState, [adaptorServer, proxyServer]);

  function closeServer(server) {
    try {
      if (server && server.listening) server.close(() => {});
    } catch {}
  }
  adaptorServer.once('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
      closeServer(proxyServer);
    }
  });
  proxyServer.once('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
      closeServer(adaptorServer);
    }
  });

  function shutdown() {
    closeServer(proxyServer);
    closeServer(adaptorServer);
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return proxyServer;
}

async function startPresetServer(preset, flags = {}) {
  if (!process.env.PROXY_PORT) process.env.PROXY_PORT = PROXY_PORT;
  const proxyPort = parseProxyPort(process.env.PROXY_PORT || PROXY_PORT);
  if (!await ensureProxyCanStart(flags, proxyPort)) return null;

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const logPath = path.join(RUNTIME_DIR, 'proxy.log');
  const out = fs.openSync(logPath, 'a');
  const err = fs.openSync(logPath, 'a');
  const args = [
    path.join(PACKAGE_DIR, 'bin', 'codex-ollama-proxy'),
    'serve',
  ];
  // Direct presets (adaptor "none") talk straight to the configured
  // upstream_url — no adaptor process. Adapted presets spawn their selected adaptor.
  if (preset.adaptor && preset.adaptor !== 'none') {
    args.push('--adaptor', preset.adaptor);
  }
  if (flags.adaptorPort) args.push('--adaptor-port', String(flags.adaptorPort));
  if (flags.completionModel) args.push('--completion-model', String(flags.completionModel));
  // Forward the dedupe opt-in to the detached serve child.
  if (flags.dedupeLargeInput) args.push('--dedupe-large-input');
  if (flags.noDedupeLargeInput) args.push('--no-dedupe-large-input');
  if (flags.dedupeMinChars !== undefined) args.push('--dedupe-min-chars', String(flags.dedupeMinChars));

  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    detached: true,
    env: Object.assign({}, process.env, { PROXY_PORT: String(proxyPort) }),
    stdio: ['ignore', out, err],
  });
  child.unref();

  await new Promise((resolve) => setTimeout(resolve, 250));
  if (child.exitCode !== null) {
    die(`Error: preset server exited during startup. Check logs: codex-ollama-proxy logs --tail 100`);
  }
  const probe = await waitForProxyResponse(proxyPort);
  if (probe.statusCode === 0) {
    console.log(`started_pid=${child.pid}`);
    console.log(`proxy=http://127.0.0.1:${proxyPort} status=starting`);
    console.log(`logs=${logPath}`);
    return child;
  }
  console.log(`started_pid=${child.pid}`);
  console.log(`proxy=http://127.0.0.1:${proxyPort} status=${probe.statusCode}`);
  console.log(`logs=${logPath}`);
  return child;
}

async function runPreset(name, flags = {}) {
  if (!name) die('Error: run requires a preset name.');
  const preset = applyPreset(name, flags);
  const serverFlags = Object.assign({}, flags, { replace: !flags.noReplace });
  if (flags.foreground) return serveCmd(Object.assign({}, serverFlags, { adaptor: preset.adaptor }));
  return startPresetServer(preset, serverFlags);
}

async function imagineCmd(flags) {
  const imagine = require('./imagine');
  if (flags.doctor) {
    const config = readImagineConfig();
    console.log("Image generation provider health check:");
    imagine.checkHealth(config).then((results) => {
      for (const [name, r] of Object.entries(results)) {
        const status = r.ready ? "READY" : "FAIL";
        const detail = r.error || (r.models ? r.models + " models" : "ok");
        console.log("  " + name + ": " + status + " (" + detail + ")");
      }
    }).catch((e) => console.log("health check failed: " + e.message));
    return;
  }
  if (flags.status) {
    const config = imagineConfig.read(IMAGINE_CONFIG);
    const fields = ["imagine_enabled", "imagine_service", "imagine_model", "imagine_base_url", "imagine_api_key", "imagine_quality", "imagine_enhance", "imagine_aspect_ratio"];
    console.log("Image generation configuration:");
    for (const f of fields) {
      const val = config[f];
      const display = f === "imagine_api_key" && val ? "(set)" : JSON.stringify(val);
      console.log("  " + f + " = " + display);
    }
    return;
  }
  if (flags.service && !imagine.SUPPORTED_IMAGE_SERVICES.includes(flags.service)) {
    die('Error: --service must be one of: ' + imagine.SUPPORTED_IMAGE_SERVICES.join(', '));
  }
  // --service and --model must always be updated as a pair to prevent
  // mismatched provider/model combinations (e.g. a Gemini model with OpenAI service).
  if (flags.service && !flags.model) {
    die('Error: --service must be used together with --model.\n'
      + 'Example: codex-ollama-proxy imagine --service openai --model gpt-image-2 --api-key "KEY"');
  }
  if (flags.model && !flags.service) {
    die('Error: --model must be used together with --service.\n'
      + 'Example: codex-ollama-proxy imagine --service openai --model gpt-image-2 --api-key "KEY"');
  }
  const updates = {};
  if (flags.enable) updates.imagine_enabled = true;
  if (flags.disable) updates.imagine_enabled = false;
  if (flags.service) updates.imagine_service = flags.service;
  if (flags.model) updates.imagine_model = flags.model;
  if (flags.baseUrl) {
    try {
      const url = new URL(flags.baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('must use http or https');
    } catch (err) {
      die('Error: --base-url must be an absolute http(s) URL. ' + err.message);
    }
    updates.imagine_base_url = flags.baseUrl;
  }
  if (flags.apiKey) updates.imagine_api_key = flags.apiKey;
  if (flags.quality) updates.imagine_quality = flags.quality;
  if (flags.enhance) updates.imagine_enhance = true;
  if (flags.noEnhance) updates.imagine_enhance = false;
  if (flags.aspectRatio) updates.imagine_aspect_ratio = flags.aspectRatio;
  imagineConfig.update(IMAGINE_CONFIG, updates);
  applyImagineConfigToRoute();
  console.log("updated=" + IMAGINE_CONFIG);
  console.log("route_updated=" + ROUTE_CONFIG);
  const activePreset = readRouteValue(readRouteConfig(), 'active_preset', '');
  if (activePreset) {
    if (!flags.noStart) {
      await startPresetServer(presets.readPreset(RUNTIME_DIR, activePreset), { replace: true });
    }
  }
}

function readImagineConfig() {
  const cfg = imagineConfig.read(IMAGINE_CONFIG);
  cfg.default_model = readRouteValue(readRouteConfig(), 'default_model', null);
  return cfg;
}
async function main() {
  const [command, subcommand, ...tail] = process.argv.slice(2);
  const parsed = parseFlags(command === 'switch' ? tail : process.argv.slice(3));
  if (!command || command === '-h' || command === '--help') return usage();
  if (command === 'init') return init(parseFlags(process.argv.slice(3)).flags);
  if (command === 'serve') return await serveCmd(parseFlags(process.argv.slice(2)).flags);
  if (command === 'preset') return presetCmd(subcommand, tail);
  if (command === 'run') return await runPreset(subcommand, parsed.flags);
  if (command === 'status') return status();
  if (command === 'switch') return await switchMode(subcommand, parsed.flags);
  if (command === 'route') return route(parseFlags(process.argv.slice(2)).flags);
  if (command === 'upstream') return upstreamCmd(parseFlags(process.argv.slice(2)).flags);
  if (command === 'logs') return logs(parsed.flags);
  if (command === 'install') return install();
  if (command === 'uninstall') return uninstall();
  if (command === 'imagine') return await imagineCmd(parseFlags(process.argv.slice(2)).flags);
  if (command === 'restart') return await restart();
  usage();
  process.exit(1);
}

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
