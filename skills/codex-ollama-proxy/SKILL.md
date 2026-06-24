---
name: codex-ollama-proxy
description: Install and manage the unofficial codex-ollama-proxy local compatibility tool. Use when the user wants Codex to install it from npm, clone/download the repo, configure model routing, start/restart/inspect the proxy, switch the local experimental Ollama/proxy workflow on or off, or uninstall it.
---

# Codex Ollama Proxy

This is an unofficial, experimental local compatibility tool. It is not affiliated with, endorsed by, or supported by OpenAI, and it depends on local Codex configuration behavior that may change.

Use the project README as the source of truth:

```text
https://github.com/bharat2808/codex-ollama-proxy
```

## Minimal Install

Prefer npm:

```bash
npm install -g codex-ollama-proxy
codex-ollama-proxy init
codex-ollama-proxy install
codex-ollama-proxy status
```

Or from a cloned repo:

```bash
git clone https://github.com/bharat2808/codex-ollama-proxy.git
cd codex-ollama-proxy
npm link
codex-ollama-proxy init
codex-ollama-proxy install
codex-ollama-proxy status
```

## Minimal Model Setup

Separate text/image models:

```bash
codex-ollama-proxy route --text-model "TEXT_MODEL" --image-model "IMAGE_MODEL" --auto-image
codex-ollama-proxy switch ollama --model "TEXT_MODEL"
```

Single model:

```bash
codex-ollama-proxy route --text-model "MODEL" --image-model "MODEL" --auto-image
codex-ollama-proxy switch ollama --model "MODEL"
```

After switching, tell the user to restart Codex or open a fresh thread.

## Uninstall

```bash
codex-ollama-proxy switch openai
codex-ollama-proxy uninstall
npm uninstall -g codex-ollama-proxy
```
