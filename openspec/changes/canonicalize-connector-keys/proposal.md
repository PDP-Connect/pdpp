## Why

The reference implementation still treats URL-shaped connector manifest identifiers as operational connector ids in storage, consent forms, MCP grant-package selection, route parameters, and owner-facing labels. That creates real bugs (for example, `https://...` values split as `https` in hosted MCP package forms), keeps obsolete `legacy` aliases alive, and contradicts the current connection-first model.

This change makes connector type identity one ideal shape in the reference implementation: a short canonical `connector_key` for runtime and contract use, with the registry/manifest URI preserved only as manifest metadata.

## What Changes

- **BREAKING**: Stop accepting URL-shaped connector ids as active reference connector identity after a one-time migration. Existing deployments are migrated to canonical connector keys without dropping records, grants, state, blobs, search rows, schedules, event subscriptions, timelines, or diagnostics.
- Add `connector_key` as the canonical reference connector type identity and `manifest_uri` as the metadata field for registry/document identity.
- Update first-party manifests and manifest registration so `connector_key` is the operational id and URL-shaped identifiers move to `manifest_uri`.
- Update storage bindings, source bindings, grants, grant packages, MCP selection, consent UI, owner dashboards, search/read URLs, local-collector configuration, and connector runtime state to key by `connector_key` plus `connection_id`.
- Remove user-visible and active-code reliance on `legacy`, `legacy_default`, URL aliases, stale local-collector aliases, and delimiter parsing of raw connector identifiers.
- Use structured selection values or opaque connection/package ids in consent and MCP package forms instead of concatenating `connector_id` and `connection_id` with `:`.
- Update public docs and reference docs so examples do not teach URL-shaped connector ids as the reference implementation's active operational key.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-connector-instances`: connector type identity becomes a canonical key plus manifest URI metadata, and connector instances bind to canonical keys only.
- `reference-implementation-architecture`: storage, runtime, owner surfaces, read URLs, indexes, migrations, and manifest registration stop using URL-shaped connector ids as operational keys.
- `agent-consent-bundling`: hosted MCP package selection uses connection-scoped structured selections and canonical connector keys, not URL aliases or delimiter-parsed connector ids.
- `mcp-adapter`: MCP tool input/output source identity uses canonical connector keys and connection ids, with no URL-shaped connector ids or deprecated connector-instance aliases advertised.

## Impact

- Affects first-party manifest JSON, manifest registration, connector stores, Postgres and any remaining SQLite compatibility reads, grant and pending-consent storage, MCP package authorization, dashboard connection picker UI, local-collector setup/config, record/search/blob URL generation, and docs examples.
- Requires a data migration for current deployments that rewrites URL-shaped connector ids and stale alias rows to canonical connector keys while preserving `connection_id` and all record-bearing data.
- Requires regression tests proving `https://registry...` never appears as an active connector id in owner/MCP/consent surfaces and that migrated deployments retain data and grants.
