# Codex Universal Proxy

[npm package](https://www.npmjs.com/package/codex-universal-proxy)

Use Ollama, OpenRouter, and other OpenAI-compatible providers with Codex while preserving:

* Codex plugins
* MCP tools
* `tool_search`
* `apply_patch`
* Image generation tools

The proxy runs locally, translates Codex-specific tool formats into provider-compatible function calls, and converts the responses back into the format Codex expects.

> This project is unofficial and experimental. Codex tool formats may change between releases.

## Install

```bash
npm install -g codex-universal-proxy

codex-universal-proxy init
codex-universal-proxy install
```

Upgrading from `codex-ollama-proxy` is automatic. The first universal command
migrates `~/.codex/ollama-shape-proxy` to
`~/.codex/codex-universal-proxy`, copies legacy catalog/reference files
forward, and replaces legacy background-service registrations. If the old
runtime path is also a source checkout, only runtime-owned configuration,
presets, and discovery cache data are copied.

The old `codex-ollama-proxy` executable remains an alias for scripts and shell
history. Existing Codex tasks that name the legacy
`ollama-launch-codex-app` provider continue to work through a compatibility
provider entry. Existing attachment files remain at their original paths so
historical task JSONL references are not broken.

`install` uses the native per-user background service for the current platform:

* macOS: a launchd agent in `~/Library/LaunchAgents`
* Linux: a systemd user service in `~/.config/systemd/user`
* Windows: a Task Scheduler task that runs at sign-in

The `restart`, `uninstall`, and `logs` commands use the same cross-platform setup. On Linux,
the user systemd session must be available. To run without installing a background service,
use `codex-universal-proxy serve` in a terminal.

If `CODEX_HOME` is set during installation, the generated background service preserves that
directory for future starts. Linux installations also honor `XDG_CONFIG_HOME` when locating
the systemd user-unit directory.

The local proxy listens on:

```text
http://127.0.0.1:11436
```

## Continuous Integration

Pull requests run static checks, the complete Node test suite, and an `npm pack` installation
smoke test on Linux, Windows, and macOS. These checks do not receive provider credentials.

The `Codex Proxy Integration` workflow is manual and weekly. It installs the current Codex CLI,
starts the packed proxy in the foreground, and verifies real shell and `apply_patch` tool calls on
Linux and Windows. Configure its protected `proxy-live-test` environment with:

* Secret `PROXY_TEST_API_KEY`
* Variables `PROXY_TEST_URL` and `PROXY_TEST_MODEL`
* Optional variable `PROXY_TEST_ADAPTOR` for non-Responses providers

Require reviewers on that environment and use a dedicated, budget-limited provider credential.
The workflow is intentionally not triggered by pull requests and never uses `pull_request_target`.
Native service lifecycle checks are a separate manual workflow: Windows uses a hosted runner, while
Linux requires a self-hosted runner labeled `linux` and `codex-proxy-systemd` with a working systemd
user session.

## Recommended Workflow: Provider Presets

A preset saves your:

* Provider endpoint
* Text and image models
* API key
* Responses or Chat Completions adaptor
* Routing and compatibility options

Create each provider once, then start it by name:

```bash
codex-universal-proxy run PRESET_NAME
```

## Ollama Preset

Ollama exposes a local Responses-compatible API at `http://127.0.0.1:11434/v1`.

```bash
codex-universal-proxy preset add ollama \
  --url "http://127.0.0.1:11434/v1" \
  --text-model "MODEL"

codex-universal-proxy run ollama
```

Example:

```bash
codex-universal-proxy preset add glm \
  --url "http://127.0.0.1:11434/v1" \
  --text-model "z-ai/glm-5.2"

codex-universal-proxy run glm
```

GLM with Kimi auto-routing:

```bash
codex-universal-proxy preset add glm-kimi \
  --url "http://127.0.0.1:11434/v1" \
  --text-model "glm-5.2:cloud" \
  --image-model "kimi-k2.7-code:cloud" \
  --auto-image

codex-universal-proxy run glm-kimi
```

## OpenRouter Preset

Export your OpenRouter key:

```bash
export OPENROUTER_API_KEY="sk-or-..."
```

Create the preset:

```bash
codex-universal-proxy preset add openrouter \
  --provider openrouter \
  --text-model "PROVIDER/MODEL" \
  --api-key "$OPENROUTER_API_KEY"
```

Run it whenever you want to use OpenRouter:

```bash
codex-universal-proxy run openrouter
```

Example:

```bash
codex-universal-proxy preset add openrouter-glm \
  --url "https://openrouter.ai/api/v1" \
  --text-model "z-ai/glm-5.2" \
  --api-key "$OPENROUTER_API_KEY"

codex-universal-proxy run openrouter-glm
```

The selected OpenRouter model must support the required API and tool-calling behavior.

## Anthropic Preset

Anthropic is supported through its OpenAI-compatible Chat Completions API. The
proxy does not translate requests to the native Messages API.

```bash
export ANTHROPIC_API_KEY="..."

codex-universal-proxy preset add claude \
  --provider anthropic \
  --text-model "claude-sonnet-5" \
  --api-key "$ANTHROPIC_API_KEY"

codex-universal-proxy run claude
```

`--provider claude` is an alias for `--provider anthropic`. Authenticated model
discovery reads Anthropic's complete `/v1/models` inventory, including its
published capability and token-limit metadata. If discovery is unavailable,
the last successful cache or bundled Anthropic catalog is used. The bundled
catalog is generated from an authenticated 11-model inventory and enriches
exact documented model IDs with text output, OpenAI-compatible tool calling,
and the documented default `high` effort. Unknown future IDs remain
unenriched until Anthropic publishes their capabilities.

## OpenAI Preset

OpenAI uses direct Responses API passthrough:

```bash
export OPENAI_API_KEY="..."

codex-universal-proxy preset add openai \
  --provider openai \
  --text-model "gpt-5.6-sol" \
  --api-key "$OPENAI_API_KEY"

codex-universal-proxy run openai
```

OpenAI discovery retains every non-embedding model returned by the
authenticated `/v1/models` endpoint. Image, audio, moderation, fine-tuned,
legacy, and other non-embedding models remain available even when they may
not accept Codex Responses requests. The last successful discovery cache and
a bundled snapshot normalized from Codex's `models_cache.json` provide
fallbacks.

## Custom Responses API Preset

For any provider that exposes `POST /v1/responses`:

```bash
export PROVIDER_API_KEY="..."

codex-universal-proxy preset add custom-responses \
  --url "https://provider.example/v1" \
  --text-model "MODEL" \
  --api-key "$PROVIDER_API_KEY"

codex-universal-proxy run custom-responses
```

## Chat Completions Provider Preset

Some providers only expose:

```text
POST /v1/chat/completions
```

Use the built-in Chat Completions adaptor for these providers:

```bash
export PROVIDER_API_KEY="..."

codex-universal-proxy preset add custom-chat \
  --adaptor chat-completion \
  --url "https://provider.example/v1" \
  --text-model "MODEL" \
  --api-key "$PROVIDER_API_KEY"

codex-universal-proxy run custom-chat
```

The adaptor converts Codex Responses API traffic into Chat Completions requests.

### NVIDIA Example

```bash
export NVIDIA_API_KEY="nvapi-..."

codex-universal-proxy preset add nvidia \
  --provider nvidia \
  --text-model "z-ai/glm-5.2" \
  --image-model "thinkingmachines/inkling" \
  --auto-image \
  --api-key "$NVIDIA_API_KEY"

codex-universal-proxy run nvidia
```

## Avoid Storing API Keys

To save the provider configuration without storing its key:

```bash
codex-universal-proxy preset add openrouter \
  --provider openrouter \
  --text-model "PROVIDER/MODEL"
```

Supply the key when activating the preset:

```bash
codex-universal-proxy preset use openrouter \
  --api-key "$OPENROUTER_API_KEY"
```

Use `run PRESET_NAME` when the preset already contains its API key.

## Running Presets

Start a preset in the background:

```bash
codex-universal-proxy run openrouter
```

Show live logs in the current terminal:

```bash
codex-universal-proxy run openrouter --foreground
```

Apply a preset without starting the proxy:

```bash
codex-universal-proxy preset use openrouter --no-start
```

Both `run` and `preset use` configure the selected provider and start or restart the required local proxy processes unless `--no-start` is used.

After changing providers, restart Codex or open a new Codex thread.

### Windows Desktop Model Picker Workaround

The Windows Codex Desktop app may fail to load the proxy-generated model picker
catalog. When that happens, activate the preset with a hardcoded Codex model
override:

```bash
codex-universal-proxy run glm-kimi --model-override "glm-5.2:cloud"
```

`--model-override` writes the top-level `model = "..."` value in
`~/.codex/config.toml`, forcing every Codex request to that model. It does not
change the proxy route `default_model`, `image_model`, or the stored preset.
Use `--text-model` or `--default-model` only when you want to change proxy
routing instead.

## Text and Image Models

A preset can use separate text and image models:

```bash
codex-universal-proxy preset add multimodal \
  --url "https://provider.example/v1" \
  --text-model "TEXT_MODEL" \
  --image-model "IMAGE_MODEL" \
  --auto-image \
  --api-key "$PROVIDER_API_KEY"
```

Run it normally:

```bash
codex-universal-proxy run multimodal
```

With `--auto-image`, images in the current user turn or its tool outputs are routed to the image model.

Use the same model for both when the provider has one multimodal model:

```bash
codex-universal-proxy preset add multimodal \
  --url "https://provider.example/v1" \
  --text-model "MODEL" \
  --image-model "MODEL" \
  --auto-image \
  --api-key "$PROVIDER_API_KEY"
```

Set `persist_inline_images = true` in `proxy-models.toml` to cache inline images
under `~/.codex/attachments` and replace historical pixels with path references.
Generated images are stored in the same session cache instead of temporary
storage, so their saved paths remain usable across follow-up turns.
Persistence requires a stable session, thread, conversation, or prompt-cache
identifier; requests without one retain their inline images. Session caches
unused for 30 days are removed lazily by default. Configure
`inline_image_retention_days`, or set it to `0` to retain caches indefinitely.
The same settings can be changed without editing TOML directly:

```bash
codex-universal-proxy route --persist-images --image-retention-days 30
```

## Image Generation

Image generation is configured separately and applies across provider presets.

### Gemini

```bash
codex-universal-proxy imagine \
  --enable \
  --service gemini \
  --model "gemini-2.5-flash-image" \
  --api-key "$GEMINI_API_KEY"
```

### OpenAI

```bash
codex-universal-proxy imagine \
  --enable \
  --service openai \
  --model "gpt-image-2" \
  --api-key "$OPENAI_API_KEY"
```

### Ollama

```bash
codex-universal-proxy imagine \
  --enable \
  --service ollama \
  --model "x/z-image-turbo" \
  --base-url "http://127.0.0.1:11434"
```

Check the image-generation configuration:

```bash
codex-universal-proxy imagine --doctor
```

The proxy uses Codex's existing `generate_image` tool. It does not inspect ordinary prompts and automatically turn them into image requests.

## Advanced Preset Options

Presets can also save proxy compatibility options:

```bash
codex-universal-proxy preset add tuned \
  --url "https://provider.example/v1" \
  --text-model "MODEL" \
  --dedupe-large-input \
  --dedupe-min-chars 1024 \
  --verbose-tools \
  --enable-find-skill \
  --no-stream-loop
```

Available preset toggles include:

```text
--auto-image / --no-auto-image
--dedupe-large-input / --no-dedupe-large-input
--dedupe-min-chars N
--verbose-tools / --no-verbose-tools
--log-upstream-body / --no-log-upstream-body
--enable-find-skill / --no-enable-find-skill
--stream-loop / --no-stream-loop
```

Runtime options such as `--foreground` remain on the `run` or `serve` command rather than being stored in the preset.

## What the Proxy Fixes

Codex can send plugins and MCP tools using OpenAI-specific namespace, dynamic-tool, managed-tool, and freeform-tool formats.

Many custom providers reject these formats or fail with problems such as:

```text
unsupported call
MCP tools are visible but never invoked
tool_search aborts
namespace tools are rejected
apply_patch uses the wrong format
```

The proxy translates these tools into ordinary provider-callable functions and restores the original Codex format when calls are returned.

### Namespace and MCP Tools

A Codex tool such as:

```text
mcp__storefront_builder.list_storefront_build_sessions
```

can be exposed to the model as:

```text
mcp__storefront_builder__list_storefront_build_sessions
```

The returned call is translated back into the namespace and tool name expected by Codex.

### `tool_search`

When a provider cannot call Codex's native managed `tool_search` tool, the proxy exposes a regular function shim and maps the result back into a native `tool_search_call`.

Deferred tools discovered by `tool_search` are also made callable on the following request.

### `apply_patch`

Codex may expose `apply_patch` as a custom or freeform tool. The proxy preserves the format Codex requires while making the surrounding tool list compatible with custom providers.

## Supported Providers

* Ollama-compatible Responses API servers
* OpenRouter models with compatible API behavior
* Anthropic through its OpenAI-compatible Chat Completions API
* OpenAI through its native Responses API
* Custom providers exposing `POST /v1/responses`
* Chat Completions providers through the built-in adaptor
* Local Responses API shims

Image generation can independently use Gemini, OpenAI, or Ollama.

## Useful Commands

```bash
codex-universal-proxy status
codex-universal-proxy upstream --status
codex-universal-proxy logs --tail 100
codex-universal-proxy restart
codex-universal-proxy run PRESET_NAME
codex-universal-proxy run PRESET_NAME --foreground
codex-universal-proxy switch openai
```

## Codex Skill

Give Codex this skill URL:

```text
https://raw.githubusercontent.com/bharat2808/codex-universal-proxy/main/skills/codex-universal-proxy/SKILL.md
```

Then ask Codex:

```text
Install this skill and use it to set up codex-universal-proxy.
```

## Configuration Files

Runtime configuration and logs are stored under:

```text
~/.codex/codex-universal-proxy/proxy-models.toml
~/.codex/codex-universal-proxy/imagine.toml
~/.codex/codex-universal-proxy/proxy.log
```

Debug logging is disabled by default:

```toml
verbose_tools = false
log_upstream_body = false
```

Be careful when enabling request-body logging because it may include prompts, tool arguments, or other sensitive data.

## Known Limitations

* This package is not affiliated with OpenAI.
* Codex internal tool schemas may change.
* Compatibility depends on the selected provider and model.
* Models must support reliable tool calling for plugins and MCP tools to work well.
* Some providers expose only Chat Completions and require the adaptor.
* Web search falls back from Ollama cloud search, to local Ollama search, to DuckDuckGo HTML search.

## Install a Specific Version

```bash
npm install -g \
  https://registry.npmjs.org/codex-universal-proxy/-/codex-universal-proxy-0.3.3.tgz
```

## Uninstall

```bash
codex-universal-proxy switch openai
codex-universal-proxy uninstall
npm uninstall -g codex-universal-proxy
```
