## Why

ChatGPT scheduled collection regressed after an upstream password reset because the reference stored credential stayed `active` after the provider rejected it. Scheduled/manual runs could keep reusing stale credential material, while browser-session repair could create a usable session without rotating the stored secret.

Prior-art research in `docs/research/connector-credential-session-repair-prior-art-2026-07-01.md` points to a connection-level repair lifecycle: definitive provider rejection invalidates the credential, background retries stop using it, and owner repair clears the state only through a verified session or explicit credential rotation.

## What Changes

- Add a first-class `rejected` stored-credential state for provider-rejected connection-scoped secrets.
- Preserve typed credential-rejection evidence from connector `DONE.error` through runtime terminal data and run results.
- Mark connection-scoped stored credentials rejected only when a run actually used that stored credential and the connector reports definitive rejection.
- Let browser-session repair proceed without silently storing passwords typed into the secure browser.
- Keep automatic ChatGPT runs session-reuse-only: no background password submission or repeated owner prompts.
- Suppress repeated scheduled launches after stored-credential recovery reaches a provider-repair lifecycle state.

## Capabilities

Modified:
- `reference-connection-health`
- `reference-run-assistance`
- `polyfill-runtime`

## Impact

- Storage migration for `connector_instance_credentials` status and non-secret rejection metadata.
- Runtime protocol widens failed `DONE.error` with bounded optional code metadata.
- ChatGPT auto-login emits a typed stored-credential rejection on definitive invalid-password UI.
- Owner UI copy clarifies that browser repair captures session state, not passwords typed into the browser.
- Scheduled runs treat rejected, revoked, or missing stored credentials as owner-repair skips rather than connector failures.
