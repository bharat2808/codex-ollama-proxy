# Changelog

## Unreleased

- Added an explicit Ollama backend to the existing `generate_image` tool, using native `/api/generate` without prompt classification or chat rerouting.
- Kept Gemini and OpenAI image generation unchanged, and added an independent Ollama base URL so any supported Responses provider can remain configured for text.

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
