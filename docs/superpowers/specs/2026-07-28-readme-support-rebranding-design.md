# README Support and Rebranding Update

## Goal

Make the README immediately explain the supported operating systems, built-in
provider integrations, custom-provider paths, and the migration from
`codex-ollama-proxy` to `codex-universal-proxy`.

## Structure

The beginning of the README will retain the existing introduction and canonical
installation commands, followed by three concise reference sections:

1. **Platform support** — macOS with launchd, Linux with a systemd user service,
   and Windows with Task Scheduler plus the existing per-user startup fallback.
2. **Supported providers** — a table of the built-in provider profiles and
   aliases from `src/provider-profiles.js`, including whether each uses direct
   Responses passthrough, the Chat Completions adaptor, or the Google adaptor.
   Custom Responses-compatible and Chat Completions-compatible providers will
   be documented separately because their discovery and model capabilities are
   provider-dependent.
3. **Rebranding and command compatibility** — a migration table covering the
   canonical npm package, executable, runtime directory, provider identity, and
   native service names. It will state that both npm packages currently expose
   both executable names, users should install only one package, and existing
   subcommands remain unchanged.

Detailed preset and feature examples will remain in place. Repeated platform,
provider, and migration explanations later in the README will be consolidated
where doing so avoids contradictory guidance.

## Explicit Removal

The current **Continuous Integration** section will be deleted completely. Its
workflow configuration, secrets, runner labels, and test policy will not be
relocated or summarized elsewhere in the README.

## Source of Truth

- Platform behavior: `src/cli.js` and `src/branding.js`
- Provider names, aliases, URLs, and adaptors: `src/provider-profiles.js`
- Discovery identities: `src/model-discovery/provider-registry.js`
- Command surface: the usage text and command dispatch in `src/cli.js`
- Migration guarantees: `src/branding.js` and the existing migration tests

## Verification

- Confirm every documented provider and alias exists in the provider profile.
- Confirm every documented command exists in CLI usage or dispatch.
- Confirm the Continuous Integration heading and its content are absent.
- Confirm legacy names appear only in migration or compatibility guidance.
- Run the repository documentation/static checks and inspect the final diff for
  broken links, duplicated headings, and stale package versions.
