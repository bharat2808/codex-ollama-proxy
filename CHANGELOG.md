# Changelog

## 0.4.0

Launcher state persistence, session-based inline image caching, schema-driven presets, stable streaming lifecycles, Ollama image generation, and faster nonblocking skill discovery.

- Preserved launcher settings across `install` and `restart` with a private, non-secret runtime state file, including preset-free Chat Completions starts, custom proxy and adaptor ports, explicit completion-model overrides, and run-only dedupe overrides, while keeping post-preset `proxy-models.toml` route overrides intact. `status` also follows the saved custom proxy port.
- Fixed `codex-ollama-proxy restart` to replace detached proxy listeners after verifying their process commands, while refusing to terminate unrelated or unverifiable processes that own the configured port.
- Added default-on, content-hashed persistence for GIF, JPEG, PNG, and WebP inline and generated images. Inline images are persisted when image auto-routing is enabled on loopback upstreams, replacing historical pixels with reusable path references while keeping active image-turn pixels inline. Generated images use the same session cache instead of temporary storage. Disabling image auto-routing bypasses inline-image persistence so manual model selection retains the complete image history. The proxy uses a dedicated cache below `~/.codex/attachments`, validates linked image signatures, limits decoded linked images to 20 MiB, requires a stable session identifier, and expires caches after 30 unused days by default without touching unrelated Codex attachments. Use `--no-persist-images` to opt out independently.
- Refactored presets from a fixed six-field schema into a saved partial `proxy-models.toml` driven by a single shared route-config schema (the keys the proxy already reads). Presets can now pin any non-imagine config toggle (`dedupe_large_input`, `duplicate_input_min_chars`, `verbose_tools`, `log_upstream_body`, `enable_find_skill`, `stream_proxy_loop`, `auto_route_image`) via paired `--flag`/`--no-flag` CLI flags; undeclared keys keep the template default at apply time. Adding a future toggle needs only one schema entry plus its flag — no per-toggle surgery in `renderPresetToml`/`normalizePreset`/`addPreset`/`applyPreset`. `preset use`/`run` is now authoritative for the keys a preset stores.
- Removed the multi-second cold `find_skill` stall by serving an immediate filesystem index while the exact Codex app-server inventory refreshes asynchronously.
- Replaced blocking app-server skill discovery during startup with one nonblocking interactive process.
- Removed duplicate function definitions before forwarding requests, with turn-local `additional_tools` definitions taking precedence over stale top-level schemas.
- Stabilized streamed Responses lifecycles so `[DONE]`, EOF, and upstream completion produce one ordered `response.completed` event.
- Upstream failures now produce a complete `response.created` → `response.in_progress` → `response.failed` lifecycle instead of closing silently.
- Client disconnects now cancel the active upstream stream, and proxy-fulfilled multi-turn streams preserve one lifecycle through the final assistant response.
- Fixed image auto-routing to honor `auto_route_image = false` and inspect only the active user turn, so current attachments and Computer Use screenshots use the vision model without historical images pinning later text-only turns.
- Added an explicit Ollama backend to the existing `generate_image` tool, using native `/api/generate` without prompt classification or chat rerouting.
- Kept Gemini and OpenAI image generation unchanged, and added an independent Ollama base URL so any supported Responses provider can remain configured for text.
- Fixed local Ollama capability discovery by querying `/api/show` with bounded concurrency when `/api/tags` omits capabilities, while preserving unknown results on lookup failures.

## 0.3.3

- Fixed newer Codex/Desktop `tool_search` exposure where the tool arrives as a native `type: "tool_search"` managed tool instead of a plain function definition.
- The proxy now rewrites native `tool_search` into a model-callable `function` tool named `tool_search`, then maps the model call back into Codex's native `tool_search_call` response item.
- The proxy also injects the `tool_search` function shim when Codex omits the native tool from a turn, matching the always-available behavior used for `web_search`.
- Added regression coverage for native `tool_search` request translation.

## 0.3.2

- Fixed deferred MCP/plugin tools discovered through `tool_search` so returned namespace tools are also exposed as callable top-level functions on the follow-up model request.
- Added regression coverage for Storefront Builder-style deferred namespace tools, preventing models from seeing a tool in `tool_search_output` but being unable to invoke it.

## 0.3.1

- Improved npm discoverability with a benefit-focused package description and search keywords.
- Reworked the README introduction around Codex plugin, MCP, `tool_search`, namespace tool, OpenRouter, and `apply_patch` compatibility use cases.
- Added provider, limitations, and troubleshooting-oriented README sections for search visibility.

## 0.3.0

- Added configurable upstream Responses API support via `upstream_url` and optional `upstream_api_key`.
- Added `codex-ollama-proxy upstream --url ...`, `--api-key ...`, and `--status` CLI commands.
- Updated proxy forwarding, streaming continuation loops, `find_skill`, `web_search`, and image-generation prompt enhancement to use the configured upstream.
- Documented the difference between Responses-compatible upstreams and Chat Completions-only APIs.

## 0.2.1

- Fixed `codex-ollama-proxy install` on macOS by retrying `launchctl bootstrap` briefly after `bootout`, avoiding transient `Bootstrap failed: 5: Input/output error` failures while launchd releases the previous job.
- Updated npm install instructions in the README.

## 0.2.0

- Added proxy-fulfilled image generation with Gemini/OpenAI backends, prompt enhancement, saved image outputs, and Codex UI image-generation markers.
- Fixed Gemini image generation aspect-ratio requests by using `generationConfig.imageConfig` and the current `gemini-3.1-flash-image` model.
- Added replay-safe request translation for Codex-native `image_generation_call` items so generated images do not break follow-up Ollama requests.
- Added `ollama_proxy_status` and expanded image-generation CLI configuration/status commands.
- Added `find_skill` summary/list support backed by Codex app-server skill discovery, with filesystem fallback for enabled plugin, user, system, and `.agents` skills.
- Added fallback skill disable handling by skill name and path, plus installed plugin marker discovery.
- Preserved fresh prompt/instruction fields from `models_cache.json` when refreshing the Ollama model catalog.
- Improved web search and skill discovery injection so local models can access those tools consistently.
- Added regression coverage for Gemini request shape, replayed image generation items, and skill index behavior.

## 0.1.0

- Initial publishable package layout.
- Added single `codex-ollama-proxy` CLI.
- Added launchd install/uninstall/restart commands.
- Added packaged route config and model catalog defaults.
- Kept compatibility wrappers for existing local Codex skill integrations.
- Distributed as a GitHub Release tarball.
