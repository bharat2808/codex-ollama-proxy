# Codex Ollama Proxy

[npm package](https://www.npmjs.com/package/codex-ollama-proxy)

Use Ollama, OpenRouter, and other Responses API providers with Codex while preserving Codex plugins, MCP tools, `tool_search`, and `apply_patch`.

Codex normally sends plugins and MCP tools using OpenAI-specific namespace and dynamic-tool formats. Many custom providers reject or cannot interpret these formats, producing errors such as:

- `unsupported call`
- MCP tools are visible but never invoked
- `tool_search` aborts
- namespace tools are rejected
- `apply_patch` is returned in the wrong format

`codex-ollama-proxy` runs locally and translates these request and response shapes between Codex and the configured model provider.

This is unofficial and experimental. Codex internal tool formats can change, so the proxy may need updates as Codex changes.

## Quick Start

```bash
npm install -g codex-ollama-proxy
codex-ollama-proxy init
codex-ollama-proxy install
```

The proxy listens on `127.0.0.1:11436` and forwards to the configured upstream Responses API server. By default, the upstream is local Ollama at `http://127.0.0.1:11434/v1`.

To pin a specific release, install from the npm tarball:

```bash
npm install -g https://registry.npmjs.org/codex-ollama-proxy/-/codex-ollama-proxy-0.3.3.tgz
```

## Use Codex Plugins With Ollama

The default upstream is Ollama's local OpenAI-compatible Responses API:

```bash
codex-ollama-proxy upstream --url "http://127.0.0.1:11434/v1"
codex-ollama-proxy restart
```

The proxy flattens Codex namespace/plugin tools into model-callable functions, then maps the resulting calls back to the format Codex expects.

## Use Codex Plugins With OpenRouter

Point the upstream at a Responses-compatible OpenRouter endpoint and provide a bearer token:

```bash
codex-ollama-proxy upstream --url "https://openrouter.ai/api/v1" --api-key "KEY"
codex-ollama-proxy restart
```

The upstream must expose a compatible Responses API. Chat Completions-only APIs (`/v1/chat/completions`) need a separate adapter and are not supported by this setting alone.

## Use A Chat Completions Provider

For providers that expose `/v1/chat/completions` but not `/v1/responses`, keep
using the normal upstream configuration and start the built-in completion API
adaptor. Configure the chat-completion route after any `switch ollama` command,
because `switch ollama` resets the route back to local Ollama defaults.

```bash
codex-ollama-proxy upstream --url "https://provider.example/v1" --api-key "KEY"
codex-ollama-proxy route --text-model "MODEL" --image-model "MODEL" --auto-image
codex-ollama-proxy serve --adaptor chat-completion
```

The proxy starts a local adaptor and forwards Codex traffic through it. The
provider URL and key come from the existing `upstream` config, so there is no
separate API-key path for the adaptor.

You can save provider routes as presets:

```bash
codex-ollama-proxy preset add nvidia \
  --adaptor chat-completion \
  --url "https://integrate.api.nvidia.com/v1" \
  --text-model "z-ai/glm-5.2" \
  --image-model "thinkingmachines/inkling" \
  --auto-image \
  --imagine-enable

codex-ollama-proxy preset use nvidia --api-key "$NVIDIA_API_KEY"
codex-ollama-proxy serve --adaptor chat-completion
```

To store the key in the preset as well, pass it when creating the preset:

```bash
codex-ollama-proxy preset add nvidia \
  --adaptor chat-completion \
  --url "https://integrate.api.nvidia.com/v1" \
  --text-model "z-ai/glm-5.2" \
  --image-model "thinkingmachines/inkling" \
  --auto-image \
  --imagine-enable \
  --api-key "$NVIDIA_API_KEY"

codex-ollama-proxy run nvidia
```

`run` starts the proxy stack in the background, waits briefly for the local
proxy to respond, prints the PID and log path, and returns the terminal prompt.
Use `--foreground` when you want live server logs in the current terminal.

NVIDIA example:

```bash
export NVIDIA_API_KEY="nvapi-..."

codex-ollama-proxy switch ollama --model "z-ai/glm-5.2"

codex-ollama-proxy upstream \
  --url "https://integrate.api.nvidia.com/v1" \
  --api-key "$NVIDIA_API_KEY"

codex-ollama-proxy route \
  --text-model "z-ai/glm-5.2" \
  --image-model "thinkingmachines/inkling" \
  --auto-image

codex-ollama-proxy serve --adaptor chat-completion
```

## Configure Upstream Responses API

Set or inspect the upstream Responses API server:

```bash
codex-ollama-proxy upstream --url "https://example.com/v1" --api-key "KEY"
codex-ollama-proxy upstream --status
```

Separate text and image models:

```bash
codex-ollama-proxy route --text-model "TEXT_MODEL" --image-model "IMAGE_MODEL" --auto-image
codex-ollama-proxy switch ollama --model "TEXT_MODEL"
```

One model for both:

```bash
codex-ollama-proxy route --text-model "MODEL" --image-model "MODEL" --auto-image
codex-ollama-proxy switch ollama --model "MODEL"
```

After switching, restart Codex or open a fresh thread.

## Fix MCP Unsupported Call Errors In Codex

Codex app plugins and MCP tools can arrive as namespace tools or dynamically loaded tools. Local/custom providers often cannot invoke those shapes directly. The proxy rewrites those tools into ordinary function tools for the model, then restores the calls for Codex.

## Fix Codex Namespace Tool Compatibility

Namespace tools are flattened into names that model providers can call. For example, a namespace tool can be exposed as a function-like tool and then split back into the namespace/name pair expected by Codex.

## Fix tool_search With Custom Providers

The proxy keeps Codex `tool_search` flows usable by preserving deferred tool discovery and mapping returned tool calls back into Codex-compatible shapes.

Recent Codex/Desktop builds can expose `tool_search` as a native managed tool:

```json
{ "type": "tool_search", "execution": "client" }
```

Many custom providers do not treat that native item as callable. The proxy rewrites it into a normal function tool named `tool_search` for the model, then maps the model's `function_call` back into Codex's native `tool_search_call`.

If Codex omits the native `tool_search` item from a turn, the proxy still injects the same function shim so local/custom models can discover deferred tools consistently.

When `tool_search` returns deferred MCP/plugin namespace tools, the proxy also exposes those discovered tools as top-level callable functions on the follow-up model request. For example, a Storefront Builder tool returned by search as `mcp__storefront_builder.list_storefront_build_sessions` is made callable to the model as `mcp__storefront_builder__list_storefront_build_sessions`, then translated back to Codex as:

```json
{
  "type": "function_call",
  "namespace": "mcp__storefront_builder",
  "name": "list_storefront_build_sessions"
}
```

## How apply_patch Translation Works

Codex may expose `apply_patch` as a custom/freeform tool. The proxy preserves the freeform custom tool behavior for Codex while making the surrounding tool list easier for local or custom Responses API providers to handle.

## Supported Providers

- Ollama-compatible Responses API servers
- OpenRouter or other custom providers that expose a compatible Responses API
- Local shims that accept `POST /v1/responses`

Chat Completions-only providers are not supported by upstream URL configuration alone.

## Known Limitations

- This package is not affiliated with OpenAI.
- Codex internal tool schemas can change.
- Provider support depends on how closely the upstream matches the Responses API.
- Web search falls back from Ollama cloud search, to local Ollama search, to DuckDuckGo HTML search.

## Codex Skill

Copy this skill link into Codex:

```text
https://raw.githubusercontent.com/bharat2808/codex-ollama-proxy/main/skills/codex-ollama-proxy/SKILL.md
```

Then ask:

```text
Install this skill and use it to set up codex-ollama-proxy.
```

## Useful Commands

```bash
codex-ollama-proxy status
codex-ollama-proxy upstream --status
codex-ollama-proxy logs --tail 100
codex-ollama-proxy restart
codex-ollama-proxy switch openai
```

## Uninstall

```bash
codex-ollama-proxy switch openai
codex-ollama-proxy uninstall
npm uninstall -g codex-ollama-proxy
```

## Files

Runtime config and logs:

```text
~/.codex/ollama-shape-proxy/proxy-models.toml
~/.codex/ollama-shape-proxy/proxy.log
```

Debug flags are off by default:

```toml
verbose_tools = false
log_upstream_body = false
```
