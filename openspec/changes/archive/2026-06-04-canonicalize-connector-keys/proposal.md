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

## Residual Risks

The canonical-key contract, the storage/runtime/forms/docs requirements, the migration tooling (`inspect` / `write --apply`), the data-agnostic production verifier, the synthetic restore→migrate→verify(SQL)→verify(HTTP) harness (38/38 SQL + 15/15 HTTP + 17/17 data-agnostic + idempotency), and the live-proven Claude MCP flow are implemented and validated; the durable requirements are folded into `reference-connector-instances`, `reference-implementation-architecture`, `agent-consent-bundling`, and `mcp-adapter`. The remaining work is owner-only live verification that this lane cannot perform, preserved here per the AGENTS.md residual-risk rule (was tasks 3.4 / 5.2):

- **Production-backup restore cycle (owner-only).** The harness proves the migration against the *real reference schema* with author-controlled synthetic data. The one remaining data step is to run the same restore→migrate→verify cycle against a restore of the operator's own production backup. The exact runbook, env vars, before-snapshot capture, inspect→write→verify→idempotency sequence, and acceptance bar are in `docs/operator/canonical-connector-keys-production-restore-packet.md` (indexed from `docs/operator/live-proof-packet.md` Gate 7). No production-backup restore cycle has run in this lane.
- **ChatGPT MCP flow live-proof (owner-only).** The Claude MCP flow is live-proven (multi-connection approval, stream/schema inspection, readable record query, canonical-key disambiguation, full event-subscription lifecycle, all without URL-shaped connector ids). The ChatGPT MCP equivalent — specifically the `create/list/get/send-test/delete` event-subscription lifecycle — has not been driven end-to-end, so the "create event subscriptions" clause is unproven for ChatGPT and must not be claimed. The mechanical owner-run proof and pass/fail bar are in `docs/operator/chatgpt-mcp-canonical-proof-packet.md` (indexed from `docs/operator/live-proof-packet.md` Gate 2).

### Open product question (informative, not blocking this change)

The `design.md` Open Questions note two product questions left open intentionally and explicitly out of scope for this change: (1) whether the root PDPP Core spec should eventually rename `connector_id`→`connector_key` (this change keeps root specs untouched, Decision 10), and (2) whether third-party custom keys need a namespace rule beyond slug uniqueness. Neither blocks the reference-implementation behavior this change delivers; both are recorded for a future proposal.
