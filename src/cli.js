#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const pluginSkillBridge = require('./plugin-skill-bridge');

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
  codex-ollama-proxy serve
  codex-ollama-proxy status
  codex-ollama-proxy switch openai
  codex-ollama-proxy switch ollama [--model MODEL]
  codex-ollama-proxy route --text-model MODEL --image-model MODEL [--output-dir PATH] [--auto-image|--no-auto-image]
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
    else if (['force', 'auto-image', 'no-auto-image', 'enable', 'disable', 'enhance', 'no-enhance', 'doctor', 'status'].includes(arg.slice(2))) flags[key] = true;
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
  reportPluginSkillBridges(pluginSkillBridge.installCompatibilitySkills({ codexDir: CODEX_DIR }));
}

function reportPluginSkillBridges(results) {
  for (const result of results) {
    const label = result.pluginId.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase();
    if (result.status === 'created' || result.status === 'updated') {
      console.log(`${label}_skill_${result.status}=${result.destination}`);
    } else if (result.status === 'conflict') {
      console.log(`${label}_skill_preserved=${result.destination}`);
    } else if (result.status === 'error') {
      console.error(`${label}_skill_error=${result.error}`);
    }
  }
}

// Redact secret values in a TOML string so status() never leaks API keys.
function redactSecrets(text) {
  return text
    .replace(/^(\s*imagine_api_key\s*=\s*").*(".*)$/m, '$1***$2')
    .replace(/^(\s*upstream_api_key\s*=\s*").*(".*)$/m, '$1***$2');
}

function readRouteConfig() {
  if (!fs.existsSync(ROUTE_CONFIG)) init();
  return fs.readFileSync(ROUTE_CONFIG, 'utf8');
}

function writeRouteValue(text, key, value) {
  const rendered = typeof value === 'boolean' ? String(value) : `"${value}"`;
  const pattern = new RegExp(`^(\\s*${key}\\s*=\\s*)(?:\"[^\"]*\"|true|false).*`, 'm');
  if (pattern.test(text)) return text.replace(pattern, `$1${rendered}`);
  return `${text.replace(/\s+$/u, '')}\n${key} = ${rendered}\n`;
}

function route(flags) {
  let text = readRouteConfig();
  if (flags.textModel) text = writeRouteValue(text, 'text_model', flags.textModel);
  if (flags.imageModel) text = writeRouteValue(text, 'image_model', flags.imageModel);
  if (flags.outputDir) text = writeRouteValue(text, 'image_output_dir', flags.outputDir);
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
  const args = ['ollama'];
  if (flags.model) args.push('--model', flags.model);
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
  run('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { check: false });
  if (fs.existsSync(PLIST)) fs.unlinkSync(PLIST);
  console.log(`removed=${PLIST}`);
}

function logs(flags) {
  const n = String(flags.tail || 100);
  run('tail', ['-n', n, path.join(RUNTIME_DIR, 'proxy.log')]);
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
function main() {
  const [command, subcommand, ...tail] = process.argv.slice(2);
  const parsed = parseFlags(command === 'switch' ? tail : process.argv.slice(3));
  if (!command || command === '-h' || command === '--help') return usage();
  if (command === 'init') return init(parseFlags(process.argv.slice(3)).flags);
  if (command === 'serve') {
    reportPluginSkillBridges(pluginSkillBridge.installCompatibilitySkills({ codexDir: CODEX_DIR }));
    return require('./proxy').startServer();
  }
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

main();
