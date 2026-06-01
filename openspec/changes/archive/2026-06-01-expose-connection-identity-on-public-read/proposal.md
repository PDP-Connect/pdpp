## Why

PDPP's public read contract is keyed on stream name and has no public **connection** dimension. The read-only audit `tmp/workstreams/rh-item2-mcp-disambiguation-audit.md` (2026-05-24) found that every grant-authorized read endpoint — `rs-streams-list`, `rs-records-list`, `rs-streams-detail`, `rs-records-detail`, `rs-search-lexical`, `rs-search-semantic`, `rs-search-hybrid`, `rs-blobs-read` — addresses data by stream alone, and that consent UI carries no connection dimension either. The only user-reachable `ambiguous_connector_instance` error today is scheduler-side (`reference-implementation/runtime/controller.ts:1994`), not read-path.

That gap shows up as a real disambiguation problem for MCP/AI clients and consent UIs once an owner runs multiple **connections** for the same connector type — e.g. `peregrine Claude Code` and `vivid fish Claude Code`, two Gmail accounts, two Codex collectors. MCP consumers cannot tell those connections apart from a `list_streams` response, cannot constrain a `query_records` or `search` call to a specific connection, cannot receive a typed disambiguation error pointing them at the right argument, and cannot see per-connection labels on a consent card.

Per the standing principle in `define-connector-instances`, connection identity remains reference runtime/orchestrator identity unless and until a concrete interoperability need promotes it into a public protocol surface. The MCP read-path ambiguity meets that promotion trigger.

## Canonical noun

The canonical public/operator/LLM-facing noun is `connection`. A connection is an owner-configured concrete data source account/device/profile (e.g. `peregrine Claude Code`, `vivid fish Claude Code`, `Gmail account A`). The public contract uses `connection_id` and an owner-editable `display_name`.

`connector_instance_id` MAY remain an internal storage identifier and a temporary compatibility alias on the wire, but it is NOT the primary public contract noun. Public/agent/tool surfaces SHALL prefer `connection_id` and `display_name`. Existing implementation code in `reference-implementation/server/postgres-*.js`, `connector-instance-store.js`, and `runtime/controller.ts:1994` MAY continue to use `connector_instance_id` internally during the transition; the public contract MUST NOT.

## What Changes

- Add `connection_id` and an owner-editable `display_name` to each `rs.streams.list` response item. Single-connection deployments preserve their current shape with these fields populated from the sole active connection.
- Accept an optional `connection_id` filter on `rs.records.list`, `rs.streams.detail`, `rs.records.detail`, `rs.search.lexical`, `rs.search.semantic`, `rs.search.hybrid`, and `rs.blobs.read`.
- **Default behavior is fan-in.** When `connection_id` is omitted on an operation that can naturally fan in across granted connections (`rs.records.list`, the three `rs.search.*` operations, `rs.streams.list`, `rs.streams.detail`), the operation SHALL return the union of records/streams across all connections the grant authorizes for the addressed stream.
- **Ambiguous error only when fan-in is unsafe.** When the addressed operation references a specific record or blob (`rs.records.detail`, `rs.blobs.read`) and the underlying identifier resolves to multiple connections under the caller's grant, the operation SHALL fail with a typed `ambiguous_connection` error carrying `available_connections: [{ connection_id, display_name }]` and an instruction to retry with `connection_id`.
- **Exactly-one fallback.** If a grant authorizes exactly one matching connection for the addressed stream/identifier, omission of `connection_id` SHALL implicitly select that connection — no error, no per-call argument needed.
- Extend grant scope shape (`RecordsListGrant` and the search/blob-read peers) so a grant MAY restrict to a specific `connection_id` per stream entry. Grants without the field preserve current cross-connection (fan-in) semantics.
- Add an owner-authenticated mutation for `connection.display_name` so the protocol-surfaced label is owner-editable. Without it, the contract would freeze inherited labels onto a public surface.
- Render per-connection scope on the consent card (post-split: `apps/site/src/components/pdpp/consent-card.tsx`) and on the grant request flow (`apps/console/src/app/dashboard/grants/request/`), using `display_name` as the primary label.
- **Consent SHALL NOT leak `legacy`, `default_account`, or raw implementation names as the primary connection label.** A connection with no owner-supplied `display_name` SHALL render an owner-meaningful default derived from connector type plus a stable disambiguator (e.g. `Gmail · account 2`), never the storage-layer placeholder.
- Drop inherited user-visible `legacy`/`default_account` surface text (the string that shipped at `apps/web/src/app/dashboard/components/views/deployment-diagnostics-view.tsx:94`, now replaced with `"unknown (pre-header)"` in the post-split `apps/console` and `apps/site` copies of that view).
- Do NOT change the scheduler-side `ambiguous_connector_instance` behavior at `runtime/controller.ts:1994`; the new read-path error mirrors the spirit but uses the canonical noun and lives in a different surface.
- Coordinate the upstream hosted MCP gateway (out-of-repo) to advertise the new optional `connection_id` argument in tool descriptions for `list_streams`, `query_records`, `search`, `fetch`, `fetch_blob`, `schema`, `aggregate_records`.

## Compatibility for `connector_instance_id`

`connector_instance_id` remains the durable storage column and the orchestrator/runtime identifier. The reference server MAY:

- Continue to read/write `connector_instance_id` internally.
- Accept `connector_instance_id` as a request-time alias for `connection_id` on the affected read endpoints during a deprecation window, treating both as referring to the same connection.
- Emit `connector_instance_id` alongside `connection_id` on response envelopes during the deprecation window for clients that have not yet migrated.

The canonical, advertised, and documented public field name is `connection_id`. The deprecation window for the `connector_instance_id` request alias closes once downstream consumers (hosted MCP gateway, dashboard) have migrated.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: grant-authorized read operations gain a public `connection` dimension on inputs, outputs, grant evaluation, and typed errors; an owner-authenticated `display_name` mutation is added; consent surfaces gain a normative per-connection label requirement.

## Impact

- Additive change: existing consumers that omit `connection_id` SHALL continue to work. Where multiple connections are authorized, omitted `connection_id` SHALL fan in for list/search operations rather than erroring; record/blob identifiers that resolve ambiguously SHALL return the typed `ambiguous_connection` error instead of silently merging or picking arbitrarily.
- Grant issuance and consent UI gain an optional connection dimension; grants without a connection constraint SHALL preserve current cross-connection (fan-in) read semantics.
- The hosted MCP gateway (out-of-repo) needs a coordinated tool-description update; in-repo work does not block on it.
- No change to the scheduler-side `ambiguous_connector_instance` error, the manifest format, the active-run invariant, or core record envelope semantics.
- Does NOT stack on `remove-legacy-connector-instances` (purely storage-layer). This change opens off `main` after that lands.
