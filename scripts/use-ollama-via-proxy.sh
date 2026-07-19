#!/usr/bin/env bash
# use-ollama-via-proxy.sh — switch Codex to the local Ollama model through the
# Responses-API shape proxy so `tool_search` works with Ollama-backed models,
# and enable native web_search (the proxy fulfills Ollama search calls).
#
# Flow (default / ollama mode):
#   1. Restart/start the shape proxy (launchd agent) on 127.0.0.1:11436.
#   2. Call the switch-codex-model-config skill (`ollama`).
#   3. Point the ollama provider base_url at the proxy in config.toml.
#   4. Set `web_search = "live"` so the proxy can fulfill web search.
#   5. Verify the proxy responds and print status.
#
# The model-config logic (catalog refresh + config.toml switching) lives in
# this directory as model_config.js. The older skill at
# skills/switch-codex-model-config/ is now a thin shim that execs it, so
# $switch-codex-model-config routing still works unchanged.
#
# Usage:
#   use-ollama-via-proxy.sh                       # switch to default ollama model
#   use-ollama-via-proxy.sh --model gemma4:31b-cloud
#   use-ollama-via-proxy.sh --setup               # one-time: make skill proxy-aware
#   use-ollama-via-proxy.sh status                # just print current status
#   use-ollama-via-proxy.sh refresh               # refresh ollama model catalog (re-syncs vision flags)
#   use-ollama-via-proxy.sh route                 # switch to configured text_model, or the default
#                                                  when metadata-driven overrides are empty
#   use-ollama-via-proxy.sh openai                # restore Codex App default profile
#
# proxy-models.toml can override text_model + image_model; empty values use
# request/provider metadata for per-request routing.
set -euo pipefail

CODEX_DIR="$HOME/.codex"
PROXY_DIR="$CODEX_DIR/ollama-shape-proxy"
PROXY_JS="$PROXY_DIR/proxy.js"
PLIST="$HOME/Library/LaunchAgents/com.user.codex-ollama-shape-proxy.plist"
LABEL="com.user.codex-ollama-shape-proxy"
PROXY_PORT="${PROXY_PORT:-11436}"
UPSTREAM_PORT="11434"
CONFIG="$CODEX_DIR/config.toml"
REFERENCE="$CODEX_DIR/config.toml.ollama-working"
SKILL="$PROXY_DIR/model_config.js"
DEFAULT_MODEL_REF="glm-5.2:cloud"
PROXY_URL="http://127.0.0.1:${PROXY_PORT}/v1/"
ROUTE_CFG_FILE="$PROXY_DIR/proxy-models.toml"

say() { printf '\033[1m[proxy-switch]\033[0m %s\n' "$*"; }
die() { printf '\033[1m[proxy-switch]\033[0m ERROR: %s\n' "$*" >&2; exit 1; }
listening() { nc -z 127.0.0.1 "$1" 2>/dev/null; }

# Read a key from proxy-models.toml (returns first quoted value for the key).
route_cfg_value() { # key
  local key="$1"
  [[ -f "$ROUTE_CFG_FILE" ]] || return 0
  node - "$ROUTE_CFG_FILE" "$key" <<'NODE'
const fs = require('fs');
const [file, key] = process.argv.slice(2);
const text = fs.readFileSync(file, 'utf8');
const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const match = text.match(new RegExp('^\\s*' + escaped + '\\s*=\\s*"([^"]*)"', 'm'));
console.log(match ? match[1] : '');
NODE
}

route_cfg_bool() { # key
  local key="$1"
  [[ -f "$ROUTE_CFG_FILE" ]] || return 0
  node - "$ROUTE_CFG_FILE" "$key" <<'NODE'
const fs = require('fs');
const [file, key] = process.argv.slice(2);
const text = fs.readFileSync(file, 'utf8');
const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const match = text.match(new RegExp('^\\s*' + escaped + '\\s*=\\s*(true|false)\\b', 'm'));
console.log(match ? match[1] : 'false');
NODE
}

# Resolve which model to switch config.toml to based on the routing config.
# $1 = "text" | "image". Falls back to skill default if config missing/empty.
resolve_route_model() { # which
  local which="$1" val=""
  case "$which" in
    text)  val="$(route_cfg_value text_model)";;
    image) val="$(route_cfg_value image_model)";;
  esac
  if [[ -z "$val" ]]; then
    say "route config has no ${which}_model; falling back to skill default ($DEFAULT_MODEL_REF)"
    printf '%s' "$DEFAULT_MODEL_REF"
    return 0
  fi
  printf '%s' "$val"
}

ensure_proxy_running() {
  [[ -f "$PROXY_JS" ]] || die "proxy.js missing at $PROXY_JS (reinstall the shape proxy first)."
  if listening "$PROXY_PORT"; then say "proxy already listening on :$PROXY_PORT"; return 0; fi
  [[ -f "$PLIST" ]] || die "launchd plist missing at $PLIST (reinstall the shape proxy first)."
  say "starting proxy via launchd..."
  uid=$(id -u)
  launchctl bootout "gui/$uid/$LABEL" 2>/dev/null || true
  if ! launchctl bootstrap "gui/$uid" "$PLIST"; then
    sleep 0.5
    launchctl bootstrap "gui/$uid" "$PLIST"
  fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if listening "$PROXY_PORT"; then say "proxy is up on :$PROXY_PORT"; return 0; fi
    sleep 0.5
  done
  die "proxy did not come up on :$PROXY_PORT (check $PROXY_DIR/proxy.log)."
}

restart_proxy() {
  [[ -f "$PROXY_JS" ]] || die "proxy.js missing at $PROXY_JS (reinstall the shape proxy first)."
  [[ -f "$PLIST" ]] || die "launchd plist missing at $PLIST (reinstall the shape proxy first)."
  local uid
  uid=$(id -u)
  if listening "$PROXY_PORT"; then
    say "restarting proxy on :$PROXY_PORT to reload proxy-models.toml"
  else
    say "starting proxy on :$PROXY_PORT"
  fi
  launchctl bootout "gui/$uid/$LABEL" 2>/dev/null || true
  if ! launchctl bootstrap "gui/$uid" "$PLIST"; then
    sleep 0.5
    launchctl bootstrap "gui/$uid" "$PLIST"
  fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if listening "$PROXY_PORT"; then say "proxy is up on :$PROXY_PORT"; return 0; fi
    sleep 0.5
  done
  die "proxy did not come up on :$PROXY_PORT (check $PROXY_DIR/proxy.log)."
}

set_base_url() { # file url
  local file="$1" url="$2"
  [[ -f "$file" ]] || return 0
  node - "$file" "$url" <<'NODE'
const fs = require('fs');
const [file, url] = process.argv.slice(2);
const text = fs.readFileSync(file, 'utf8');
const next = text.replace(/^(\s*base_url\s*=\s*)"[^"]*"/m, `$1"${url}"`);
if (next !== text) {
  fs.writeFileSync(file, next, 'utf8');
  console.log(`patched ${file}`);
}
NODE
}

# Enable native web_search. Removes any existing web_search= lines first
# (any quote style / value) to avoid duplicate top-level keys, then inserts
# one clean live line before the first [table].
set_web_search_live() {
  [[ -f "$CONFIG" ]] || return 0
  node - "$CONFIG" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const text = fs.readFileSync(file, 'utf8');
const withoutExisting = text.replace(/^web_search\s*=\s*['"][^'"]*['"][^\n]*\n/gm, '');
const tableIndex = withoutExisting.search(/^\s*\[/m);
const insertAt = tableIndex >= 0 ? tableIndex : withoutExisting.replace(/\n+$/u, '').length + 1;
const next =
  withoutExisting.slice(0, insertAt) +
  'web_search = "live"  # ollama: proxy fulfills via Ollama web search\n' +
  withoutExisting.slice(insertAt);
if (next !== text) {
  fs.writeFileSync(file, next, 'utf8');
  console.log('web_search live (normalized to single line)');
} else {
  console.log('web_search already live');
}
NODE
}

verify_proxy() {
  say "verifying proxy -> upstream Ollama..."
  command -v curl >/dev/null || die "curl not found"
  local body
  body=$(curl -s --max-time 5 "$PROXY_URL"models || true)
  [[ -n "$body" ]] || die "proxy /v1/models returned nothing (is Ollama on :$UPSTREAM_PORT running?)."
  say "proxy OK ($(printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);console.log((j.data||[]).length,"models")}catch{console.log("models visible")}})' 2>/dev/null || echo models visible))"
}

do_setup() {
  say "one-time setup: making switch-codex-model-config skill proxy-aware..."
  [[ -f "$REFERENCE" ]] || die "reference config missing: $REFERENCE"
  set_base_url "$REFERENCE" "$PROXY_URL"
  say "reference config base_url -> $PROXY_URL"
  ensure_proxy_running
  say "setup done. Future 'skill ollama' switches will emit the proxy URL."
}

MODE="ollama"
MODEL_ARGS=()
EXPLICIT_MODEL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --setup) MODE="setup"; shift;;
    --model) MODEL_ARGS+=(--model "$2"); EXPLICIT_MODEL=1; shift 2;;
    --model=*) MODEL_ARGS+=(--model "${1#--model=}"); EXPLICIT_MODEL=1; shift;;
    status|refresh|openai|ollama|route|text) MODE="$1"; shift;;
    *) die "unknown argument: $1";;
  esac
done

case "$MODE" in
  setup) do_setup; exit 0;;
  status) "$SKILL" status; exit 0;;
  refresh) "$SKILL" refresh; exit 0;;
  openai)
    say "switching Codex to the normal OpenAI profile via model_config.js..."
    "$SKILL" openai
    say "done. Restart Codex to apply."
    exit 0
    ;;
  route|text)
    say "route mode: switching config.toml to the configured or default text model..."
    MODEL_SLUG="$(resolve_route_model text)"
    MODEL_ARGS=(--model "$MODEL_SLUG")
    say "text model -> $MODEL_SLUG (proxy auto-selects a unique image model when auto_route_image=true)"
    ;;
esac

if [[ "$MODE" == "ollama" && "$EXPLICIT_MODEL" -eq 0 && "$(route_cfg_bool auto_route_image)" == "true" ]]; then
  MODEL_SLUG="$(resolve_route_model text)"
  MODEL_ARGS=(--model "$MODEL_SLUG")
  say "auto_route_image=true; config.toml active model -> $MODEL_SLUG"
fi

ensure_proxy_running
say "calling switch-codex-model-config skill: ollama ${MODEL_ARGS[*]-}"
"$SKILL" ollama "${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"}"
say "ensuring config.toml base_url -> $PROXY_URL"
set_base_url "$CONFIG" "$PROXY_URL"
say "enabling native web_search through proxy (ollama mode)"
set_web_search_live
restart_proxy
verify_proxy
say "status:"
"$SKILL" status
echo
say "Done. Restart Codex (or open a fresh thread) so the provider + tool discovery reload."
say "tool_search works via the shape proxy; web search is fulfilled by Ollama direct/local with DuckDuckGo fallback."
