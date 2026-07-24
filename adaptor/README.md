# Completion API Adaptor

This adaptor exposes a minimal OpenAI Responses-compatible local server and
forwards model calls to any OpenAI-compatible Chat Completions API.

It is useful for providers that support:

```bash
POST /v1/chat/completions
```

but do not support:

```bash
POST /v1/responses
```

## Run With The Proxy

Configure the provider exactly like a normal upstream:

```bash
codex-ollama-proxy switch ollama --model "provider/model"

codex-ollama-proxy upstream \
  --url "https://provider.example/v1" \
  --api-key "$PROVIDER_API_KEY"

codex-ollama-proxy serve --adaptor chat-completion
```

Or save the provider route as a preset:

```bash
codex-ollama-proxy preset add nvidia \
  --adaptor chat-completion \
  --url "https://integrate.api.nvidia.com/v1" \
  --text-model "z-ai/glm-5.2" \
  --image-model "thinkingmachines/inkling" \
  --auto-image \
  --api-key "$NVIDIA_API_KEY"

codex-ollama-proxy run nvidia
```

Image generation is configured independently from presets with
`codex-ollama-proxy imagine`; it is stored in
`~/.codex/ollama-shape-proxy/imagine.toml` and composed into the active route.

`preset use` and `run` start or restart the proxy and adaptor in the background
and return your terminal. Use `codex-ollama-proxy logs --tail 100` to inspect
it, or pass `--foreground` to `run` for live logs.

The proxy will start both local servers:

```text
Codex -> codex-ollama-proxy -> completion-api-adaptor -> provider /chat/completions
```

Optional variables for running the adaptor file directly without the proxy:

```bash
CHAT_COMPLETION_BASE_URL="https://provider.example/v1"
CHAT_COMPLETION_API_KEY="$PROVIDER_API_KEY"
CHAT_COMPLETION_MODEL="provider/model"
CHAT_COMPLETION_ADAPTOR_PORT=8787
CHAT_COMPLETION_MAX_TOKENS=16384
```

Optional proxy CLI flags:

```bash
--completion-model "provider/model"
--adaptor-port 8787
```

## NVIDIA API Example

NVIDIA's hosted API is Chat Completions-compatible, so run:

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

The adaptor receives the API key from the existing proxy upstream config. Do not
commit API keys into this folder.

## Google Gemini and Vertex AI

Use the Google adaptor for Gemini's native `generateContent` protocol. It
translates Responses text, images, supported inline/URI files, function tools,
reasoning controls, streaming output, and generated images.

Gemini Developer API preset:

```bash
codex-ollama-proxy preset add gemini \
  --provider aistudio \
  --models "gemini-2.5-flash,gemini-3.1-flash-image" \
  --default-model "gemini-2.5-flash" \
  --api-key "$GEMINI_API_KEY"
```

Vertex AI preset:

```bash
codex-ollama-proxy preset add vertex-gemini \
  --provider vertexai \
  --project "$PROJECT_ID" \
  --location global \
  --models "google/gemini-2.5-flash,google/gemini-3.1-flash-image" \
  --default-model "google/gemini-2.5-flash"
```

Vertex uses Application Default Credentials when no token is supplied. For
local development, configure ADC with `gcloud auth application-default login`.
To use a short-lived token explicitly, add `--vertex-token "$GOOGLE_ACCESS_TOKEN"`
when creating or running the preset.
