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

Install from npm:

```bash
npm install -g codex-ollama-proxy
codex-ollama-proxy init
codex-ollama-proxy install
codex-ollama-proxy status
```

To pin a specific release:

```bash
npm install -g https://registry.npmjs.org/codex-ollama-proxy/-/codex-ollama-proxy-0.3.3.tgz
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

Use the model selected by Codex and auto-select a unique discovered image model:

```bash
codex-ollama-proxy route --auto-models --auto-image
codex-ollama-proxy switch ollama --model "TEXT_MODEL"
```

If more than one image model is available, select it explicitly:

```bash
codex-ollama-proxy route --image-model "IMAGE_MODEL" --auto-image
codex-ollama-proxy switch ollama --model "TEXT_MODEL"
```

Single model:

```bash
codex-ollama-proxy route --text-model "MODEL" --image-model "MODEL" --auto-image
codex-ollama-proxy switch ollama --model "MODEL"
```

After switching, tell the user to restart Codex or open a fresh thread.

## Image Generation (imagine)

The proxy can inject a synthetic `generate_image` function tool that lets the model generate or edit images via cloud APIs (Gemini or OpenAI). No separate MCP server needed — the proxy fulfills image generation calls locally, same as web_search and find_skill.

### Enable

```bash
codex-ollama-proxy imagine --service gemini --model gemini-3-pro-image-preview --api-key "..."
codex-ollama-proxy restart
```

### Configuration

The `--service` and `--model` flags must always be set together as a pair. This prevents mismatched combinations (e.g. a Gemini model with `imagine_service = "openai"`). If either flag is provided without the other, the CLI will error.

Common provider/model pairs:

| Provider | Model | Example |
|----------|-------|---------|
| `openai` | `gpt-image-2` | `codex-ollama-proxy imagine --service openai --model gpt-image-2 --api-key "sk-..."` |
| `gemini` | `gemini-3-pro-image-preview` | `codex-ollama-proxy imagine --service gemini --model gemini-3-pro-image-preview --api-key "..."` |
| `gemini` | `gemini-3.1-flash-image` | `codex-ollama-proxy imagine --service gemini --model gemini-3.1-flash-image --api-key "..."` |

If `imagine_model` is empty, the provider's built-in default is used (quality-dependent for Gemini, `gpt-image-2` for OpenAI).

Inspect image generation settings:

```bash
codex-ollama-proxy imagine --status
```

### Runtime Tools

When image generation is enabled, the proxy injects two synthetic function tools:

- **generate_image** — Generate a new image from a text prompt, or edit an existing image (image-to-image). Parameters: prompt, inputImagePath (optional), aspectRatio, quality.
- **ollama_proxy_status** — Check the current image generation configuration at runtime. Returns active provider, quality, enhancement status, and API key status.

The model can call `ollama_proxy_status` to check the configuration before generating images. The model can also run `codex-ollama-proxy imagine --status` or `--doctor` via shell commands.

### Config Fields (proxy-models.toml)

```toml
imagine_enabled = true
imagine_service = "gemini"
imagine_model = "gemini-3-pro-image-preview"
imagine_quality = "quality"
imagine_aspect_ratio = "16:9"
imagine_enhance = false
```

### Disable

```bash
codex-ollama-proxy imagine --disable
codex-ollama-proxy restart
```

## Deferred MCP Tools

The proxy supports Codex `tool_search` flows. When Codex exposes `tool_search` as a native managed tool, the proxy rewrites it into a normal model-callable function tool named `tool_search`, then maps the model's call back into Codex's native `tool_search_call` item. If Codex omits native `tool_search` from a turn, the proxy injects the same function shim so deferred tool discovery remains available.

When `tool_search` returns deferred MCP or plugin namespace tools, the proxy exposes those discovered tools as callable function tools on the follow-up model request, then maps the model's flattened tool call back into Codex's `namespace` and `name` fields.

## Uninstall

```bash
codex-ollama-proxy switch openai
codex-ollama-proxy uninstall
npm uninstall -g codex-ollama-proxy
```
