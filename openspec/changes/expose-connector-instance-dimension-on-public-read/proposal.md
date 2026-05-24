## Why

PDPP's public read contract is keyed on stream name and has no `connector_instance_id` dimension. The read-only audit `tmp/workstreams/rh-item2-mcp-disambiguation-audit.md` (2026-05-24) found that every grant-authorized read endpoint — `rs-streams-list`, `rs-records-list`, `rs-streams-detail`, `rs-records-detail`, `rs-search-lexical`, `rs-search-semantic`, `rs-search-hybrid`, `rs-blobs-read` — addresses data by stream alone, and that consent UI carries no instance dimension either. The only user-reachable `ambiguous_connector_instance` error today is scheduler-side (`reference-implementation/runtime/controller.ts:1994`), not read-path.

That gap shows up as a real disambiguation problem for MCP/AI clients and consent UIs once an owner runs multiple instances of the same connector type — e.g. two Claude Code devices, two Codex collectors, or two Gmail accounts. MCP consumers cannot tell those instances apart from a `list_streams` response, cannot constrain a `query_records` or `search` call to a specific instance, cannot receive a typed disambiguation error pointing them at the right argument, and cannot see per-instance labels on a consent card.

Per the standing principle in `define-connector-instances`, connector instance identity remains reference runtime/orchestrator identity unless and until a concrete interoperability need promotes it into a public protocol surface. The MCP read-path ambiguity meets that promotion trigger.

## What Changes

- Add `connector_instance_id` and an owner-editable `display_name` to each `rs.streams.list` response item.
- Accept an optional `connector_instance_id` filter on `rs.records.list`, `rs.streams.detail`, `rs.records.detail`, `rs.search.lexical`, `rs.search.semantic`, `rs.search.hybrid`, and `rs.blobs.read`.
- Extend grant scope shape (`RecordsListGrant` and the search/blob-read peers) so a grant MAY restrict to a specific `connector_instance_id` per stream entry.
- Add a typed read-path error `ambiguous_connector_instance` that lists `available_instances: [{ connector_instance_id, display_name }]` when a multi-instance read is unconstrained.
- Add an owner-authenticated mutation for `connector_instance.display_name` so the protocol-surfaced label is owner-editable (currently only readable through `ref-connectors-list`).
- Render per-instance scope on the consent card (`apps/web/src/components/pdpp/consent-card.tsx`) and on the grant request flow, using `display_name` rather than connector-type-only labels.
- Drop inherited user-visible `legacy`/`default_account` surface text (notably `apps/web/src/app/dashboard/components/views/deployment-diagnostics-view.tsx:94`).
- Do NOT change the scheduler-side `ambiguous_connector_instance` behavior at `runtime/controller.ts:1994`; the new read-path error mirrors but does not replace it.
- Coordinate the upstream hosted MCP gateway (out-of-repo) to advertise the new optional argument in tool descriptions for `list_streams`, `query_records`, `search`, `fetch`, `fetch_blob`, `schema`, `aggregate_records`.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: read-path operations gain a `connector_instance_id` dimension on inputs, outputs, grant evaluation, and typed errors; an owner-authenticated `display_name` mutation is added.

## Impact

- Additive change: existing consumers that omit `connector_instance_id` SHALL continue to work against single-instance deployments. Multi-instance reads without the filter SHALL receive the new typed `ambiguous_connector_instance` error instead of silently merging instances.
- Grant issuance and consent UI gain an optional instance dimension; grants without an instance constraint SHALL preserve current cross-instance read semantics.
- The hosted MCP gateway (out-of-repo) needs a coordinated tool-description update; in-repo work does not block on it.
- No change to the scheduler-side `ambiguous_connector_instance` error, the manifest format, the active-run invariant, or core record envelope semantics.
- Does NOT stack on `remove-legacy-connector-instances` (purely storage-layer). This change opens off `main` after that lands.
