# codex-ollama-proxy

`codex-ollama-proxy` is an unofficial, experimental local compatibility tool for testing Ollama-compatible Responses API shapes with a local Codex configuration.

It depends on local Codex configuration behavior that may change.

It is designed to be installed as one CLI:

```bash
codex-ollama-proxy
```

## What It Does

- Runs a local proxy on `127.0.0.1:11436`.
- Forwards to Ollama on `127.0.0.1:11434`.
- Updates local Codex config for an experimental Ollama/proxy workflow and can restore the normal local config afterward.
- Rewrites Codex tool and response shapes for Ollama-compatible models.
- Can route text requests to one model and image requests to another.
- Can also use a single model for both text and image.
- Ships default route config and model catalog files for first-run setup.

## Requirements

- macOS for `install`, `uninstall`, and `restart` launchd commands.
- Node.js 18 or newer.
- Codex config under `~/.codex`.
- Ollama or an Ollama-compatible server listening on `127.0.0.1:11434`.
- The models you configure must exist on the Ollama-compatible server.

## Install

From the GitHub release tarball:

```bash
npm install -g https://github.com/bharat2808/codex-ollama-proxy/releases/download/v0.1.0/codex-ollama-proxy-0.1.0.tgz
```

From a local checkout:

```bash
npm link
```

Verify:

```bash
codex-ollama-proxy --help
```

## Install Through Codex Skill

This repo also ships a Codex skill that lets a user hand Codex one link and ask it to install/configure the proxy for them.

Skill path in this repo:

```text
skills/codex-ollama-proxy/SKILL.md
```

After publishing the repo, copy the raw GitHub URL for that file, for example:

```text
https://raw.githubusercontent.com/bharat2808/codex-ollama-proxy/main/skills/codex-ollama-proxy/SKILL.md
```

Then ask Codex:

```text
Install this Codex skill and use it to set up codex-ollama-proxy:
https://raw.githubusercontent.com/bharat2808/codex-ollama-proxy/main/skills/codex-ollama-proxy/SKILL.md
```

Once the skill is installed, users can ask:

```text
Use the codex-ollama-proxy skill to install the local compatibility proxy, configure my text model as "TEXT_MODEL", configure my image model as "IMAGE_MODEL", and enable the experimental Ollama/proxy workflow.
```

For a single model:

```text
Use the codex-ollama-proxy skill to install the proxy and configure "MODEL" for both text and image.
```

## First Run

Initialize user-owned runtime files:

```bash
codex-ollama-proxy init
```

`init` creates or preserves:

```text
~/.codex/ollama-shape-proxy/proxy-models.toml
~/.codex/ollama-launch-models-ollama-working.json
~/.codex/ollama-launch-models.json
```

It uses packaged defaults from:

```text
config/proxy-models.default.toml
config/model-catalogs/ollama-launch-models.default.json
```

It does not overwrite existing user files unless you pass:

```bash
codex-ollama-proxy init --force
```

## Common Setup

Use one model for normal text work and another for image requests:

```bash
codex-ollama-proxy init
codex-ollama-proxy route \
  --text-model "glm-5.2:cloud" \
  --image-model "kimi-k2.7-code:cloud" \
  --auto-image
codex-ollama-proxy install
codex-ollama-proxy switch ollama
codex-ollama-proxy status
```

After `switch ollama`, restart Codex or open a fresh thread so local provider and tool discovery reload.

## Single Model Setup

If one model should handle both text and image requests, set both route slots to the same model:

```bash
codex-ollama-proxy route \
  --text-model "your-vision-model" \
  --image-model "your-vision-model" \
  --auto-image

codex-ollama-proxy switch ollama --model "your-vision-model"
```

If you do not want the proxy to rewrite image requests at all:

```bash
codex-ollama-proxy route \
  --text-model "your-model" \
  --image-model "your-model" \
  --no-auto-image

codex-ollama-proxy switch ollama --model "your-model"
```

For image inputs, the active model still needs image capability in the model catalog and upstream Ollama-compatible server.

## Switching Back

Restore the normal local OpenAI/Codex profile:

```bash
codex-ollama-proxy switch openai
```

Restart Codex or open a fresh thread after switching.

## Uninstall

Stop and remove the launchd service:

```bash
codex-ollama-proxy switch openai
codex-ollama-proxy uninstall
```

Remove the globally installed package:

```bash
npm uninstall -g codex-ollama-proxy
```

If installed with `npm link`, use:

```bash
npm unlink -g codex-ollama-proxy
```

Optional local cleanup:

```bash
rm -rf ~/.codex/ollama-shape-proxy
```

Only remove the runtime folder if you do not want to keep route config or logs.

## Commands

```bash
codex-ollama-proxy init [--force]
```

Create user-owned config and model catalog files if missing.

```bash
codex-ollama-proxy serve
```

Run the proxy in the foreground.

```bash
codex-ollama-proxy install
```

Install and start the macOS launchd service.

```bash
codex-ollama-proxy uninstall
```

Stop and remove the macOS launchd service.

```bash
codex-ollama-proxy restart
```

Reinstall and restart the launchd service.

```bash
codex-ollama-proxy status
```

Show Codex mode, configured models, route config, and proxy health.

```bash
codex-ollama-proxy switch ollama [--model MODEL]
```

Switch Codex to Ollama/proxy mode. If `--model` is omitted, the existing config/default is used.

```bash
codex-ollama-proxy switch openai
```

Switch Codex back to the normal OpenAI/Codex profile.

```bash
codex-ollama-proxy route --text-model MODEL --image-model MODEL [--auto-image|--no-auto-image]
```

Update the live route config at `~/.codex/ollama-shape-proxy/proxy-models.toml`.

```bash
codex-ollama-proxy logs [--tail N]
```

Show recent proxy logs.

## Smoke Test

From a source checkout:

```bash
npm run smoke
```

Or directly:

```bash
scripts/smoke-test.sh
```

Set a model explicitly if needed:

```bash
MODEL="your-model" scripts/smoke-test.sh
```

## Config Files

Package defaults:

```text
config/proxy-models.default.toml
config/model-catalogs/ollama-launch-models.default.json
config/model-catalogs/models-cache.example.json
```

User-owned runtime files:

```text
~/.codex/ollama-shape-proxy/proxy-models.toml
~/.codex/ollama-shape-proxy/proxy.log
~/.codex/ollama-shape-proxy/upstream-bodies.jsonl
~/.codex/ollama-launch-models-ollama-working.json
~/.codex/ollama-launch-models.json
```

`upstream-bodies.jsonl` is created only when body logging is enabled.

## Logging And Privacy

Normal proxy logs go to:

```text
~/.codex/ollama-shape-proxy/proxy.log
```

Sensitive debug logging is disabled by default in `proxy-models.toml`:

```toml
verbose_tools = false
log_upstream_body = false
```

Only enable these while debugging. They may include prompts, tool arguments, shell commands, search queries, patch contents, file paths, or other sensitive context.

## Troubleshooting

Check proxy health:

```bash
codex-ollama-proxy status
```

Check logs:

```bash
codex-ollama-proxy logs --tail 100
```

Restart the service:

```bash
codex-ollama-proxy restart
```

Verify Ollama-compatible models are visible:

```bash
curl http://127.0.0.1:11434/v1/models
```

If switching modes does not appear to take effect, restart Codex or open a fresh thread so local provider and tool discovery reload.
