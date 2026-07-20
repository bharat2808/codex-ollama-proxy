#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const presets = require('./presets');

const PACKAGE_DIR = path.resolve(__dirname, '..');
const CODEX_DIR = process.env.CODEX_HOME || path.join(process.env.HOME, '.codex');
const RUNTIME_DIR = path.join(CODEX_DIR, 'ollama-shape-proxy');
const ROUTE_CONFIG = path.join(RUNTIME_DIR, 'proxy-models.toml');
const DEFAULT_ROUTE_CONFIG = path.join(PACKAGE_DIR, 'config', 'proxy-models.default.toml');
const DEFAULT_MODEL_CATALOG = path.join(PACKAGE_DIR, 'config', 'model-catalogs', 'ollama-launch-models.default.json');
const MODEL_CATALOG = path.join(CODEX_DIR, 'ollama-launch-models-ollama-working.json');
const MODEL_CATALOG_COPY = path.join(CODEX_DIR, 'ollama-launch-models.json');
const PLIST = path.join(process.env.HOME, 'Library', 'LaunchAgents', 'com.user.codex-ollama-shape-proxy.plist');
const LABEL = 'com.user.codex-ollama-shape-proxy';
const PROXY_PORT = process.env.PROXY_PORT || '11436';

function usage() {
  console.log(`Usage:
  codex-ollama-proxy init [--force]
  codex-ollama-proxy serve [--adaptor chat-completion]
  codex-ollama-proxy serve --preset NAME [--api-key KEY] [--replace]
  codex-ollama-proxy serve --adaptor chat-completion [--completion-model MODEL] [--adaptor-port PORT]
  codex-ollama-proxy preset add NAME --adaptor chat-completion --url URL --text-model MODEL [--image-model MODEL] [--auto-image|--no-auto-image] [--imagine-enable|--imagine-disable]
  codex-ollama-proxy preset list
  codex-ollama-proxy preset show NAME
  codex-ollama-proxy preset use NAME [--api-key KEY]
  codex-ollama-proxy run NAME [--api-key KEY] [--adaptor-port PORT] [--replace] [--foreground]
  codex-ollama-proxy status
  codex-ollama-proxy switch openai
  codex-ollama-proxy switch ollama [--model MODEL]
  codex-ollama-proxy route --text-model MODEL --image-model MODEL [--auto-image|--no-auto-image]
  codex-ollama-proxy upstream [--url URL] [--api-key KEY] [--status]
  codex-ollama-proxy logs [--tail N]
  codex-ollama-proxy install
  codex-ollama-proxy uninstall
  codex-ollama-proxy restart
  codex-ollama-proxy imagine [--enable|--disable] [--service gemini|openai --model MODEL]
  codex-ollama-proxy imagine [--api-key KEY] [--quality fast|balanced|quality]
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
    else if (['force', 'auto-image', 'no-auto-image', 'imagine-enable', 'imagine-disable', 'enable', 'disable', 'enhance', 'no-enhance', 'doctor', 'status', 'no-refresh', 'no-backup', 'replace', 'foreground'].includes(arg.slice(2))) flags[key] = true;
    else flags[key] = argv[++i];
  }
  return { flags, rest };
}

function init(options = {}) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
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
  const rendered = typeof value === 'boolean' ? String(value) : `"${value}"`;
  const pattern = new RegExp(`^(\\s*${key}\\s*=\\s*)(?:\"[^\"]*\"|true|false).*`, 'm');
  if (pattern.test(text)) return text.replace(pattern, `$1${rendered}`);
  return `${text.replace(/\s+$/u, '')}\n${key} = ${rendered}\n`;
}

function applyPreset(name, flags = {}) {
  const preset = presets.readPreset(RUNTIME_DIR, name);
  switchMode('ollama', {
    model: preset.text_model,
    noRefresh: flags.noRefresh,
    noBackup: flags.noBackup,
  });
  let text = readRouteConfig();
  text = writeRouteValue(text, 'upstream_url', preset.upstream_url);
  const apiKey = flags.apiKey !== undefined ? flags.apiKey : preset.upstream_api_key;
  if (flags.apiKey === '') {
    die('Error: --api-key was passed but empty. Check your shell variable with: echo ${NVIDIA_API_KEY:+set}');
  }
  if (apiKey !== undefined) {
    text = writeRouteValue(text, 'upstream_api_key', apiKey || '');
  }
  text = writeRouteValue(text, 'text_model', preset.text_model);
  text = writeRouteValue(text, 'image_model', preset.image_model);
  text = writeRouteValue(text, 'auto_route_image', Boolean(preset.auto_route_image));
  if (preset.imagine_enabled !== undefined) {
    text = writeRouteValue(text, 'imagine_enabled', Boolean(preset.imagine_enabled));
  }
  fs.writeFileSync(ROUTE_CONFIG, text, 'utf8');
  console.log(`preset_applied=${name}`);
  console.log(`updated=${ROUTE_CONFIG}`);
  console.log(`adaptor=${preset.adaptor}`);
  if (flags.apiKey !== '') console.log(`api_key=${apiKey ? 'set' : 'unchanged_or_empty'}`);
  return preset;
}

function presetCmd(subcommand, argv) {
  if (!subcommand || subcommand === '-h' || subcommand === '--help') return usage();
  if (subcommand === 'list') return presets.listPresets(RUNTIME_DIR, console.log);
  const [name, ...tail] = argv;
  if (!name) die(`Error: preset ${subcommand} requires a name.`);
  const { flags } = parseFlags(tail);
  if (subcommand === 'add') return presets.addPreset(RUNTIME_DIR, name, flags, console.log);
  if (subcommand === 'show') return presets.showPreset(RUNTIME_DIR, name, console.log);
  if (subcommand === 'use') return applyPreset(name, flags);
  die('Error: preset command must be add, list, show, or use.');
}

function resetRouteForOllama(flags = {}) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  let text = fs.readFileSync(DEFAULT_ROUTE_CONFIG, 'utf8');
  if (flags.model) {
    text = writeRouteValue(text, 'text_model', flags.model);
    text = writeRouteValue(text, 'image_model', flags.model);
  }
  fs.writeFileSync(ROUTE_CONFIG, text, 'utf8');
  console.log(`route_reset=ollama (${ROUTE_CONFIG})`);
}

function route(flags) {
  let text = readRouteConfig();
  if (flags.textModel) text = writeRouteValue(text, 'text_model', flags.textModel);
  if (flags.imageModel) text = writeRouteValue(text, 'image_model', flags.imageModel);
  if (flags.autoImage) text = writeRouteValue(text, 'auto_route_image', true);
  if (flags.noAutoImage) text = writeRouteValue(text, 'auto_route_image', false);
  fs.writeFileSync(ROUTE_CONFIG, text, 'utf8');
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
  fs.writeFileSync(ROUTE_CONFIG, text, 'utf8');
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
  console.log('Restart Codex or open a fresh thread so provider discovery reloads.');
}

function status() {
  codexConfig(['status']);
  console.log('');
  console.log(redactSecrets(readRouteConfig()).trim());
  const req = http.get(`http://127.0.0.1:${PROXY_PORT}/v1/models`, { timeout: 2000 }, (res) => {
    res.resume();
    console.log(`\nproxy=http://127.0.0.1:${PROXY_PORT} status=${res.statusCode}`);
  });
  req.on('timeout', () => {
    req.destroy();
    console.log(`\nproxy=http://127.0.0.1:${PROXY_PORT} status=timeout`);
  });
  req.on('error', (e) => console.log(`\nproxy=http://127.0.0.1:${PROXY_PORT} status=unreachable (${e.message})`));
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
  const result = spawnSync('lsof', ['-nP', '-tiTCP:' + port, '-sTCP:LISTEN'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0 && !result.stdout) return [];
  return result.stdout.split(/\s+/u).filter(Boolean);
}

function describePortOwner(port) {
  const result = spawnSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.stdout ? result.stdout.trim() : '';
}

function stopListeningPort(port) {
  const pids = listeningPids(port).filter((pid) => pid !== String(process.pid));
  if (pids.length === 0) return true;
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGTERM');
    } catch {}
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (listeningPids(port).filter((pid) => pid !== String(process.pid)).length === 0) return true;
    sleepMs(100);
  }
  for (const pid of pids) {
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
      if (bootoutLaunchAgent()) console.log(`replace=stopped_launch_agent ${LABEL}`);
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
      if (bootoutLaunchAgent()) console.log(`replace=stopped_launch_agent ${LABEL}`);
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
  return template
    .replaceAll('__NODE__', process.execPath)
    .replaceAll('__BIN__', path.join(PACKAGE_DIR, 'bin', 'codex-ollama-proxy'))
    .replaceAll('__LOG__', path.join(RUNTIME_DIR, 'proxy.log'))
    .replaceAll('__PORT__', PROXY_PORT);
}

function install() {
  init();
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(PLIST, renderPlist(), 'utf8');
  run('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { check: false });
  bootstrapLaunchAgent();
  run('launchctl', ['enable', `gui/${process.getuid()}/${LABEL}`], { check: false });
  run('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LABEL}`], { check: false });
}

function uninstall() {
  bootoutLaunchAgent();
  if (fs.existsSync(PLIST)) fs.unlinkSync(PLIST);
  console.log(`removed=${PLIST}`);
}

function logs(flags) {
  const n = String(flags.tail || 100);
  run('tail', ['-n', n, path.join(RUNTIME_DIR, 'proxy.log')]);
}

async function serveCmd(flags = {}) {
  if (flags.preset) {
    const preset = applyPreset(flags.preset, flags);
    flags = Object.assign({}, flags, { adaptor: preset.adaptor });
  }
  if (!process.env.PROXY_PORT) process.env.PROXY_PORT = PROXY_PORT;
  const proxyPort = parseInt(process.env.PROXY_PORT || PROXY_PORT, 10);
  if (!await ensureProxyCanStart(flags, proxyPort)) return null;
  if (!flags.adaptor) return require('./proxy').startServer();
  if (flags.adaptor !== 'chat-completion') {
    die('Error: --adaptor must be "chat-completion".');
  }

  const routeConfig = readRouteConfig();
  const adaptorPort = String(flags.adaptorPort || process.env.CHAT_COMPLETION_ADAPTOR_PORT || process.env.COMPLETION_ADAPTOR_PORT || '8787');
  const providerUrl = readRouteValue(routeConfig, 'upstream_url');
  const providerApiKey = readRouteValue(routeConfig, 'upstream_api_key');
  const providerModel = flags.completionModel || readRouteValue(routeConfig, 'text_model');
  if (!providerUrl) die('Error: configure the chat-completion provider with: codex-ollama-proxy upstream --url URL [--api-key KEY]');

  const adaptor = require('../adaptor/completion-api-adaptor');
  const adaptorServer = adaptor.startServer({
    port: parseInt(adaptorPort, 10),
    baseUrl: providerUrl,
    apiKey: providerApiKey,
    defaultModel: providerModel,
  });

  process.env.PROXY_UPSTREAM_URL = `http://127.0.0.1:${adaptorPort}/v1`;
  process.env.PROXY_UPSTREAM_API_KEY = '';
  const proxyServer = require('./proxy').startServer();

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

async function runPreset(name, flags = {}) {
  if (!name) die('Error: run requires a preset name.');
  const preset = applyPreset(name, flags);
  if (flags.foreground) return serveCmd(Object.assign({}, flags, { adaptor: preset.adaptor }));

  if (!process.env.PROXY_PORT) process.env.PROXY_PORT = PROXY_PORT;
  const proxyPort = parseInt(process.env.PROXY_PORT || PROXY_PORT, 10);
  if (!await ensureProxyCanStart(flags, proxyPort)) return null;

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const logPath = path.join(RUNTIME_DIR, 'proxy.log');
  const out = fs.openSync(logPath, 'a');
  const err = fs.openSync(logPath, 'a');
  const args = [
    path.join(PACKAGE_DIR, 'bin', 'codex-ollama-proxy'),
    'serve',
    '--adaptor',
    preset.adaptor,
  ];
  if (flags.adaptorPort) args.push('--adaptor-port', String(flags.adaptorPort));
  if (flags.completionModel) args.push('--completion-model', String(flags.completionModel));

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

function imagineCmd(flags) {
  if (flags.doctor) {
    const imagine = require("./imagine");
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
    const text = readRouteConfig();
    const fields = ["imagine_enabled", "imagine_service", "imagine_api_key", "imagine_quality", "imagine_enhance", "imagine_aspect_ratio"];
    fields.splice(2, 0, "imagine_model");
    console.log("Image generation configuration:");
    for (const f of fields) {
      const m = text.match(new RegExp("^\\s*" + f + "\\s*=\\s*(.*)$", "m"));
      const val = m ? m[1] : "(not set)";
      const display = (f === "imagine_api_key" && val && val.length > 2) ? "(set)" : val;
      console.log("  " + f + " = " + display);
    }
    return;
  }
  let text = readRouteConfig();
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
  if (flags.enable) text = writeRouteValue(text, "imagine_enabled", true);
  if (flags.disable) text = writeRouteValue(text, "imagine_enabled", false);
  if (flags.service) text = writeRouteValue(text, "imagine_service", flags.service);
  if (flags.model) text = writeRouteValue(text, "imagine_model", flags.model);
  if (flags.apiKey) text = writeRouteValue(text, "imagine_api_key", flags.apiKey);
  if (flags.quality) text = writeRouteValue(text, "imagine_quality", flags.quality);
  if (flags.enhance) text = writeRouteValue(text, "imagine_enhance", true);
  if (flags.noEnhance) text = writeRouteValue(text, "imagine_enhance", false);
  if (flags.aspectRatio) text = writeRouteValue(text, "imagine_aspect_ratio", flags.aspectRatio);
  fs.writeFileSync(ROUTE_CONFIG, text, "utf8");
  console.log("updated=" + ROUTE_CONFIG);
}

function readImagineConfig() {
  const text = readRouteConfig();
  const cfg = { imagine_enabled: false, imagine_service: "gemini", imagine_model: "", imagine_api_key: "", imagine_quality: "fast", imagine_enhance: false, imagine_aspect_ratio: "1:1", text_model: null };
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_]+)\s*=\s*"([^"]*)"/);
    if (m && m[1] in cfg) cfg[m[1]] = m[2];
    const b = line.match(/^\s*([A-Za-z_]+)\s*=\s*(true|false)\b/);
    if (b && b[1] in cfg) cfg[b[1]] = b[2] === "true";
  }
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
  if (command === 'switch') return switchMode(subcommand, parsed.flags);
  if (command === 'route') return route(parseFlags(process.argv.slice(2)).flags);
  if (command === 'upstream') return upstreamCmd(parseFlags(process.argv.slice(2)).flags);
  if (command === 'logs') return logs(parsed.flags);
  if (command === 'install') return install();
  if (command === 'uninstall') return uninstall();
  if (command === 'imagine') return imagineCmd(parseFlags(process.argv.slice(2)).flags);
  if (command === 'restart') {
    uninstall();
    return install();
  }
  usage();
  process.exit(1);
}

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
