# Provider Discovery Simplification Design

## Goal

Reduce the model-provider and discovery architecture's complexity without
removing Ollama-specific behavior. Ollama remains a first-class special case,
but its detection, inventory, inspection, and capability interpretation have
one implementation and one normalized result consumed by the rest of the
proxy.

## Scope

This refactor will:

- make standalone model discovery the single source of native model
  capabilities;
- expose provider-level traits alongside normalized models;
- remove duplicate Ollama `/api/tags` and `/api/show` probes from Codex catalog
  refresh;
- centralize Ollama endpoint normalization and native HTTP operations;
- allow presets to persist an optional explicit provider identity while
  retaining URL detection for existing configurations;
- keep Codex-specific catalog projection separate from upstream discovery; and
- consolidate thin OpenAI-compatible provider adapters around declarative
  definitions where that does not erase provider-specific behavior.

It will not change request/response translation, image-generation routing,
managed-tool compatibility, or the semantics of lazy Ollama Cloud pulling.

## Architecture

The resulting data flow is:

```text
preset/config provider hint
        |
        v
resolve provider (explicit hint, canonical URL, local probe, custom fallback)
        |
        v
provider adapter discovers inventory and native capabilities
        |
        v
normalize and cache models + return provider traits
        |
        v
project normalized metadata into the Codex model catalog
```

### Discovery result

`discoverModels()` will return the existing fields plus a `traits` object:

```js
{
  provider,
  providerResolution,
  traits: {
    local: false,
    nativeInspection: false,
    supportsCloudPull: false,
  },
  source,
  cacheStatus,
  discoverySkipped,
  models,
  warnings,
}
```

Traits describe provider behavior, not model capabilities. Model capabilities
remain on each normalized model. Every return path supplies the same trait
shape so consumers do not infer behavior from URLs.

### Ollama boundary

The Ollama implementation will own:

- normalization of `/v1` and native API base URLs;
- `/api/tags`, `/api/show`, and `/api/pull` endpoint construction;
- local Ollama identification;
- bounded-concurrency inspection;
- interpretation of context, vision, reasoning, and tool capabilities; and
- Ollama Cloud inventory augmentation.

Shared HTTP safety remains in `model-discovery/live-catalog.js`. Lazy cloud
pulling remains a separate request-time concern, but it reuses the same Ollama
endpoint helpers rather than reimplementing them.

### Codex catalog projection

`codex-config.js` will no longer call `/api/tags` or `/api/show` after
`discoverModels()`. It will derive:

- Ollama identity from `discovery.provider` or its traits;
- native vision support from `model.inputModalities`;
- native tool support from `model.toolCalling`; and
- context and reasoning metadata from the normalized discovery model.

Codex presentation policy remains separate. In particular,
`auto_route_image` may advertise image support to Codex even when the native
model is not vision-capable; the native discovery metadata remains unchanged.

### Explicit provider identity

The route configuration gains an optional `provider` string. New or rewritten
built-in presets persist it. Existing presets without the field continue to
work through canonical URL matching and local Ollama detection. Invalid
explicit provider names fail through the existing provider-resolution
validation rather than silently falling back.

### Compatible provider consolidation

Providers implemented solely as parameterization of
`discoverCompatible()` will use a small declarative factory or definition
table. Providers with distinct parsing, authentication, suppression, or
fallback behavior remain dedicated modules. Consolidation must not change the
public adapter keys or discovery result ordering.

## Error and fallback behavior

Existing cancellation, timeout, redirect, response-size, credential-scope,
cache-version, stale-cache, bundled-catalog, and supplied-model fallback
semantics remain unchanged.

Ollama inspection failure remains model-local: the model is retained with
unknown metadata and a warning. Provider detection failure still falls through
to custom-provider behavior when the URL is valid.

## Compatibility

- Existing `proxy-models.toml` and preset files remain valid.
- The public adapter names and aliases remain unchanged.
- Existing cache documents remain readable.
- No new runtime dependency is introduced.
- Node.js 18 remains the minimum supported runtime.

## Testing

Tests will prove:

1. every discovery result has stable provider traits;
2. explicit provider hints take precedence while legacy URL resolution remains;
3. one Ollama tags response and one show request per model supply all native
   catalog capabilities;
4. Codex catalog refresh performs no duplicate Ollama probes;
5. Codex projection preserves native context, reasoning, tools, and modalities;
6. auto image routing remains a presentation policy;
7. compatible-provider consolidation preserves adapter behavior; and
8. the complete existing test and syntax-check suites remain green.

Tests will be written and observed failing before each production change.
