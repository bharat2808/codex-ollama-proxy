# Proxy Behavior Testing Checklist

Last updated: 2026-07-24

This checklist tracks automated and live verification of the complete proxy
behavior. Never write API keys, bearer tokens, or raw preset contents into this
file or test output.

Status legend:

- `[ ]` Not tested
- `[x]` Passed
- `[!]` Blocked or failed; see evidence
- `[-]` Not applicable

## 1. Baseline automation

- [x] `npm run check` passes.
- [x] `node --test test/*.test.js` passes with zero failures.
- [x] `git diff --check` reports no errors.
- [x] Tests and logs do not print API keys or bearer tokens.

## 2. Presets and provider resolution

- [x] Presets can be listed without exposing credentials.
- [x] Every saved preset parses successfully.
- [x] Known providers resolve without an explicit base URL.
- [x] Unknown providers require an explicit URL.
- [x] Invalid provider/adaptor combinations are rejected.
- [x] Explicit model overrides work.
- [x] Presets containing credentials have private file permissions.
- [x] Starting one preset does not inherit stale settings from another.

Provider/adaptor combinations:

- [x] OpenRouter with the chat-completion adaptor.
- [x] xAI with the direct proxy.
- [x] Google AI Studio with the Google adaptor.
- [x] Vertex AI with the Google adaptor.
- [x] Cohere with the chat-completion adaptor.
- [x] Moonshot with the chat-completion adaptor.
- [x] Z.AI with the chat-completion adaptor.
- [x] DeepSeek with the chat-completion adaptor.
- [x] NVIDIA with the chat-completion adaptor.
- [x] Local Ollama with the direct proxy.

## 3. Model discovery and catalogs

For each configured provider:

- [x] Live model discovery succeeds with a valid credential.
- [x] Discovered model IDs are saved.
- [x] Display names are transported into the model cache.
- [x] Known input modalities are populated.
- [x] Known output modalities are populated.
- [x] Known context sizes are populated.
- [x] Known tool-calling capability is populated.
- [x] Known reasoning capability is populated.
- [x] Exact OpenRouter matches enrich missing metadata.
- [x] Similar but non-exact IDs are not enriched.
- [x] Bundled catalogs fill metadata missing from live discovery.
- [x] Bundled catalogs contain no OpenClaw-derived entries.
- [x] `/v1/models` exposes the projected catalog.

## 4. Ordinary text requests

- [x] Non-streaming text returns a valid Responses API response.
- [x] Streaming text emits ordered SSE lifecycle events.
- [x] Streaming emits exactly one `response.completed`.
- [x] EOF without `[DONE]` completes correctly.
- [x] Upstream failures produce a bounded `response.failed`.
- [x] Client disconnection aborts the upstream request.
- [x] System and developer instructions remain intact.
- [x] Long-input deduplication remains opt-in.
- [x] Prompt caching is not disrupted by default.
- [x] Text-only requests preserve the selected model.
- [x] Historical images alone do not activate image routing.

## 5. Tool calling

- [x] Function definitions are translated correctly.
- [x] Duplicate function definitions are removed.
- [x] Turn-local tool definitions override stale definitions.
- [x] Namespaced MCP tools retain full callable names.
- [x] Deferred `tool_search` tools become callable functions.
- [x] Tool-call arguments remain valid JSON.
- [x] Tool results retain the correct call ID.
- [x] Parallel tool calls retain ordering.
- [x] Google thought signatures survive tool continuations.
- [x] Native image-output requests remove incompatible tools.

## 6. Image input routing

- [x] A vision-capable selected model receives images directly.
- [x] A text-only model switches to `image_model` when auto-routing is enabled.
- [x] Disabling auto-routing preserves the selected model.
- [x] Historical images alone do not switch the model.
- [x] Current Computer Use screenshots count as active images.
- [x] Five current images retain their original order.
- [x] Google converts every current image to Gemini `inlineData`.
- [x] Chat-completion/OpenRouter converts every current image to `image_url`.
- [x] Provider payload-size failures return bounded errors.

## 7. Native image generation

For Google, OpenRouter, and xAI:

- [x] Catalog metadata identifies exact image-output models.
- [x] Output modalities are added only for exact capable models.
- [x] Text-only models do not enter native image generation.
- [x] Non-streaming images become `image_generation_call` items.
- [x] Streaming images become `image_generation_call` items.
- [x] Base64 image results are accepted.
- [x] HTTPS image-result URLs are downloaded safely.
- [x] Responses include a valid `saved_path`.
- [x] Cached files have valid PNG, JPEG, GIF, or WebP signatures.
- [x] Ordinary text output remains unchanged.

## 8. Generated-image continuation

- [x] Every generated image is cached within its stable session.
- [x] A one-turn-later edit receives the cached image.
- [x] An edit after two intervening text turns still receives it.
- [x] Multiple generated images are rehydrated chronologically.
- [x] Existing inline images are not duplicated.
- [x] Expired provider URLs are unnecessary when `saved_path` exists.
- [x] Missing or invalid cached files are skipped safely.
- [x] Rehydration requires both image-input and image-output capability.
- [x] Text-only and image-input-only models do not receive generated history.

## 9. Five-image and provider-limit behavior

- [x] Google receives the historical chain and all five new images.
- [x] OpenRouter receives the historical chain and all five new images.
- [x] New user attachments follow historical generated images.
- [x] xAI receives exactly the newest three references.
- [x] With five new xAI attachments, references 3, 4, and 5 are selected.
- [x] Images omitted from an xAI request remain cached.
- [x] xAI uses `/v1/images/edits` when references exist.
- [x] xAI uses `/v1/images/generations` without references.

## 10. Cache safety and lifecycle

- [x] Cache writes require a stable conversation or prompt-cache identifier.
- [x] Sessions cannot read one another's cached paths.
- [x] Identical images within a session are deduplicated.
- [x] Cache directories use private permissions.
- [x] Cached files use private permissions.
- [x] Paths outside the proxy cache cannot be rehydrated.
- [x] Symlinks cannot escape the cache root.
- [x] Invalid and oversized images are rejected.
- [x] HTTP and private-network download URLs are rejected.
- [x] Redirects are bounded and revalidated.
- [x] Expired session directories are removed.
- [x] Unrelated Codex attachments are not deleted.

## 11. Google authentication

AI Studio:

- [x] A saved API key works without an explicit URL.
- [x] Image input and output work through the Google adaptor.

Vertex AI:

- [x] Explicit project and location produce the correct endpoint.
- [x] An explicit bearer token works.
- [x] An omitted token falls back to ADC.
- [x] ADC requests the Cloud Platform scope.
- [x] The `global` location works.
- [x] Missing ADC credentials produce a safe actionable error.
- [x] Project, location, and optional token survive preset reuse.

## 12. Live provider smoke matrix

| Provider | Discover | Text | Stream | Tools | Image input | Image output | Follow-up edit |
|---|---|---|---|---|---|---|---|
| OpenRouter | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| Google AI Studio | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| Vertex AI | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| xAI | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| Cohere | [x] | [x] | [x] | [x] | [x] | [-] | [-] |
| Moonshot | [x] | [!] | [!] | [!] | [!] | [-] | [-] |
| Z.AI | [!] | [!] | [!] | [!] | [!] | [!] | [!] |
| DeepSeek | [x] | [x] | [x] | [x] | [-] | [-] | [-] |
| NVIDIA | [x] | [x] | [x] | [x] | [-] | [-] | [-] |
| Ollama | [x] | [x] | [x] | [x] | [x] | [-] | [-] |

Use `[-]` when the selected provider/model catalog does not advertise the
capability. A provider's own payload, rate, billing, or image-count limits still
apply.

## Evidence log

Record the date, command or live flow, result, and any relevant limitation.
Never include credentials.

| Date | Area | Evidence | Result |
|---|---|---|---|
| 2026-07-24 | Checklist | Initial checklist added before executing this verification run. | In progress |
| 2026-07-24 | Baseline | Initial run: `npm run check` exited 0; `git diff --check` exited 0; `node --test test/*.test.js` passed 215/215. | Passed |
| 2026-07-24 | Credential hygiene | Compared every saved preset credential against baseline logs; no credential value was present. | Passed |
| 2026-07-24 | Presets | Parsed all 9 presets. Corrected legacy `deepseek` and `openrouter` preset modes from `0644` to `0600`; re-audit found zero credential permission failures. | Passed after correction |
| 2026-07-24 | Bundled catalogs | Audited 8 provider catalogs and 418 model rows; every row had input/output modalities and there were zero OpenClaw references. | Passed |
| 2026-07-24 | Five-image routing | Local assertion passed: Google and chat-completion each retained 7 ordered references (2 historical + 5 current); xAI selected current references 3, 4, and 5. | Passed |
| 2026-07-24 | Cache confinement | Local assertions rejected both an outside-cache path and an in-cache symlink escaping to that path. | Passed |
| 2026-07-24 | Live discovery | AI Studio, Cohere, DeepSeek, Moonshot, NVIDIA, OpenRouter, and xAI returned live inventories. Vertex used its explicit supplied-model path. Local Ollama returned 7 live models with native inspection. | Passed except Z.AI, which has no saved direct credential |
| 2026-07-24 | Live text and stream | AI Studio, Cohere, DeepSeek, NVIDIA, OpenRouter, Vertex, xAI, and local Ollama returned successful non-streaming responses and terminal `response.completed` streaming events. | Passed |
| 2026-07-24 | Live tool calling | AI Studio, Cohere, DeepSeek, NVIDIA, OpenRouter, Vertex, xAI, and Ollama through `kimi-k2.7-code:cloud` returned `function_call` output. Cohere and DeepSeek required automatic rather than forced tool selection. | Passed |
| 2026-07-24 | Live image generation and continuation | AI Studio, OpenRouter, Vertex, and xAI generated and cached an initial image, then accepted it after intervening turns and returned a separately cached edit. | Passed |
| 2026-07-24 | Live image input | AI Studio, xAI, Ollama through `kimi-k2.7-code:cloud`, and Cohere `command-a-vision-07-2025` accepted a valid 32×32 PNG. | Passed |
| 2026-07-24 | Toolless-model regression | Cohere Vision rejected the proxy's injected tools. Added exact `toolCalling: false` metadata, transported it as `supports_tools: false`, and suppressed tools only for exact unsupported models. Regression tests passed and the original live request returned 200. | Passed after fix |
| 2026-07-24 | Provider blockers | Moonshot discovery works, but inference returns HTTP 429 for insufficient balance. No direct Z.AI credential is saved; `glm-kimi` is an Ollama-cloud preset, not a Z.AI API preset. | Blocked |
| 2026-07-24 | xAI reference retention | Five cached image files remained present while the xAI bridge sent only the newest three references. A redirect to a private address was rejected before a second fetch. | Passed |
| 2026-07-24 | Final regression | After the toolless-model fix, `npm run check` exited 0, `git diff --check` exited 0, and the full suite passed 217/217 with zero failures. | Passed |
| 2026-07-24 | Focused live Grok image generation | Ran the saved xAI credential through an isolated direct proxy using `grok-imagine-image`. The Responses request returned HTTP 200 with a completed `image_generation_call`, the proxy added `saved_path`, and the cached 149,075-byte JPEG opened as the requested waving blue robot. Focused bridge/cache tests passed 12/12. | Passed |
| 2026-07-24 | Saved xAI preset | Added `grok-imagine-image` alongside the `grok-4.3` text default, enabled automatic image routing and inline-image persistence, preserved the saved credential, and verified parser/render round-trip validity with mode `0600`. | Passed |
| 2026-07-24 | Codex xAI chat compatibility | Provider discovery had copied `video` into the Codex-facing modality enum, preventing chat creation. Restricted the Codex projection to `text`, `image`, and `audio`, omitted video-output-only models without altering rich provider catalogs, and converted Codex `custom` tools to provider-compatible functions. The actual Codex CLI created a `grok-4.3` chat and returned `catalog-ok`. | Passed after fix |
| 2026-07-24 | xAI fixed-reasoning compatibility | Codex globally sent `reasoning.effort = "none"` even though `grok-4.20-0309-reasoning` advertises no selectable reasoning levels and xAI rejects that parameter. Confirmed live that summary-only requests succeed, removed only effort for the two exact fixed-reasoning variants, and completed an actual Codex CLI turn with the affected model. | Passed after fix |
| 2026-07-24 | xAI custom-tool normalization | Replaced the provider-incompatible `custom` transport with a generic function wrapper for every custom tool. Text formats remain unconstrained; Lark and regex formats carry their exact grammar definition. Calls and outputs restore by original tool name. Also removed xAI-incompatible null fields from replayed reasoning items. An actual streamed Codex `grok-4.3` run invoked `apply_patch`, created the expected file, consumed the tool result, and completed with `done`. | Passed after fix |
| 2026-07-24 | Final regression | `npm run check` and `git diff --check` exited 0; the full suite passed 224/224, including Google adaptor, completion adaptor, provider discovery, routing, text, image, and generic custom-tool translation coverage. | Passed |
