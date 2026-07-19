#!/usr/bin/env bash
set -euo pipefail

PORT="${PROXY_PORT:-11436}"
MODEL="${MODEL:-$(node - <<'NODE'
const fs = require('fs');
const path = require('path');
const file = path.join(process.env.CODEX_HOME || path.join(process.env.HOME, '.codex'), 'ollama-shape-proxy', 'proxy-models.toml');
try {
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/^\s*text_model\s*=\s*"([^"]+)"/m);
  console.log(match && match[1] ? match[1] : 'glm-5.2:cloud');
} catch {
  console.log('glm-5.2:cloud');
}
NODE
)}"
curl -sS --max-time 8 "http://127.0.0.1:${PORT}/v1/models" >/dev/null
curl -sS --max-time 20 "http://127.0.0.1:${PORT}/v1/responses" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${MODEL}\",\"input\":\"Reply with exactly: ok\",\"stream\":false}" >/dev/null
echo "smoke=ok"
