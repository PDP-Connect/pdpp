## 1. Contract and OpenSpec

- [x] 1.1 Capture prior-art and repo audit findings in `tmp/workstreams/canonical-read-contract-right-hand-report.md`.
- [x] 1.2 Add proposal, design, and spec delta for the canonical public read contract.
- [x] 1.3 Validate `canonicalize-public-read-contract` with `openspec validate canonicalize-public-read-contract --strict`.
- [x] 1.4 Classify overlapping active changes in their design/task files: `expose-connection-identity-on-public-read`, `expand-first-party-parent-child-relations`, `expose-per-stream-dataset-summary`, `clarify-public-read-contract-llm-hints`, `polish-assistant-query-api-discovery`, and `add-dashboard-records-explorer`. Classification posture lives in each change's `design.md` under "Classification under `canonicalize-public-read-contract`".

## 2. Reference Contract Schemas

- [x] 2.1 Add canonical envelope schema types for list, single-object, schema, search, warnings, links, and count metadata.
- [x] 2.2 Add public read input schemas for `fields`, `expand`, `expand_limit`, `filter`, `sort`, `cursor`, `limit`, `count`, `connection_id`, and deprecated `connector_instance_id` alias.
- [x] 2.3 Add generated contract descriptions that point callers to `/v1/schema` for field/operator/expand/sort/count capabilities.
- [x] 2.4 Ensure `connector_instance_id` is documented only as a deprecated compatibility alias.
- [x] 2.5 Run reference-contract generation and verification.

## 3. Public RS Runtime

- [ ] 3.1 Thread `connection_id` and `display_name` onto every record-bearing records/search/blob response item. (Partial: search hits, records-list, records-detail, changes_since rows, aggregate-expanded child records, and Postgres-backed record reads now carry `connection_id` plus the deprecated `connector_instance_id` alias when the runtime knows the pinned storage binding. Records-list, records-detail, changes_since rows, aggregate-expanded child records, and Postgres-backed record reads also carry `display_name` when the connector-instance store has an owner-meaningful label; placeholder labels are omitted. Raw blob byte responses are not JSON record envelopes; blob identity must be obtained from the authorized record that references the blob. Remaining work: search hits need the same `display_name` projection once the search index/fan-in path can resolve labels without guessing.)
- [x] 3.2 Make search hits carry `(connection_id, stream, record_id)` without dashboard-side inference. Lexical / semantic / hybrid result items now emit `connection_id` and the deprecated `connector_instance_id` alias when the snapshot recorded the binding. Pre-identity snapshots are tolerated (fields omitted, not faked).
- [x] 3.3 Implement optional `connection_id` filtering and deprecated `connector_instance_id` alias conflict validation on public read routes. Canonical helper `validateConnectionAlias` is shared by `reference-implementation/server/records.js` (records list + detail + aggregate via `validateTopLevelQueryParams`) and the three search operations (`rs-search-lexical`, `rs-search-semantic`, `rs-search-hybrid`). Conflict tests live in `public-read-connection-alias.test.js`. (Filtering itself — narrowing storage to one `connection_id` when supplied — still requires the storage fan-in tranche to land. Today the alias is accepted, deprecated-equality is enforced, but the filter does not yet narrow storage on the records path.)
- [ ] 3.4 Normalize public read responses into the canonical envelope, preserving backward-compatible fields only where the contract allows. (Partial: `finalizeCanonicalEnvelope` at the route layer adds canonical `links.self`, `links.next` (list-shaped only), and defaults `meta.count = { kind: 'none' }` + `meta.warnings = []` for all public read responses while preserving backward-compat fields like `next_cursor`, `next_changes_since`, and `url`. List envelopes (records list, search, stream list) are canonical. Single-record envelopes (records detail) still wear the legacy bespoke shape `{ object: 'record', id, stream, data, ... }` instead of the canonical single-object `{ object, data: {...}, links, meta }` family; single-record canonicalization is intentionally deferred until consumer wiring (task 6.2) lands.)
- [ ] 3.5 Implement strict validation for unsupported parameters, fields, filter operators, sort fields, and expansion targets. (Partial: records/search reject unsupported top-level params, unsupported expand relations, conflicting aliases, and unsupported filter operators with typed errors. Canonical `sort` is now honored on **both** the SQLite reference path and the Postgres runtime path: the sign-prefix (`sort=-field` → DESC, `sort=field` → ASC) controls direction over the advertised cursor field, and a disagreement between `sort` and legacy `order` raises `invalid_sort` instead of silently picking one. Fields other than the advertised cursor field continue to be rejected with `invalid_sort` because the reference runtime only advertises the cursor field as sortable via `/v1/schema`. The Postgres path now also rejects unknown `count` values via the same canonical vocabulary as SQLite. Both records backends reject list-only `sort`, `count`, and `order` when the caller requests the version-ordered `changes_since` feed, avoiding accepted no-ops. Remaining work: surface every other advertised capability through `/v1/schema` and prove it is enforced (task 4.2).)
- [ ] 3.6 Implement structured `meta.warnings` for skipped-not-applicable sources, deprecated alias use, count downgrades, and partial/lossy outcomes. (Partial: records-list, aggregate, lexical, semantic, and hybrid search now emit `deprecated_alias_used` in `meta.warnings[]`; hybrid deduplicates warnings. `count_downgraded` is wired into the canonical warning vocabulary and the response plumbing, but the reference runtime never actually downgrades a count today, so no `count_downgraded` warning is emitted in practice — emitting one when an upgrade happens would be a wire-shape lie. Skipped-not-applicable and partial/lossy warnings remain.)
- [ ] 3.7 Implement graded count support (`none`, `estimated`, `exact`) backed by existing projections when possible. (Partial: `count=none` and `count=exact` are fully implemented on **both** the SQLite reference path and the Postgres runtime path via a visible-row scan over the same filter set the list path uses (mirrors `aggregateRecords` / `countVisibleRecordsForStream` on SQLite, and a `SELECT COUNT(*)` over the snapshotted filter-only WHERE clause on Postgres). `count=estimated` is honored by computing the exact value cheaply on the same scan; the response carries `meta.count.kind = 'exact'` and no warning, since returning a higher-fidelity grade than requested is an upgrade rather than a downgrade per the spec's "Requested count is downgraded" rule. A future `compatibility_fallback` warning is appropriate only when the runtime truly cannot honor the requested grade. Both backends reject unknown `count` values with `invalid_request`. Remaining work: `/v1/schema` capability surfacing for count modes (task 4.3) and search-path graded counts.)
- [x] 3.8 Keep one-hop inline expansion grant-safe and bounded by `expand_limit`.

## 4. Capability Document

- [ ] 4.1 Update `GET /v1/schema` to be the canonical capability document for streams, fields, operators, sortability, expansion, projection, search modes, pagination, counts, and granted connection identities. **Deferred (granted_connections only):** the operation layer already accepts arbitrary per-stream `[extra]` fields, but the host-side `buildConnectorSchemaItem` only knows about a single `storageBinding`. Listing all bindings under a grant per stream requires a new `listGrantedConnections(grant, streamName)` helper on the connector-instance-store and a matching reference-contract schema for `granted_connections: [{ connection_id, display_name }]`. None of those exist today; safe to add once the storage fan-in tranche lands.
- [ ] 4.2 Add conformance checks proving every advertised field/operator/sort/expand capability is either enforced or rejected clearly.
- [ ] 4.3 Add search-mode pagination and count-support metadata.

## 5. MCP Mirror

- [x] 5.1 Update `packages/mcp-server` input schemas to mirror the canonical public read arguments.
- [x] 5.2 Add `outputSchema` and canonical `structuredContent` envelopes for read tools.
- [x] 5.3 Ensure prose `content[]` is a concise summary only and not a second divergent JSON contract.
- [x] 5.4 Add tests proving MCP does not silently drop unsupported arguments that REST would reject.

## 6. Dashboard, Explorer, and CLI Consumers

- [ ] 6.1 Simplify Explorer search attribution once public search hits carry `connection_id`; remove sentinel or deduction code no longer needed. (Partial: stale comments now reflect that search hits carry `connection_id` when snapshots have it; fallback deduction remains for pre-identity snapshots.)
- [ ] 6.2 Update dashboard/console reads to consume canonical envelopes and warnings where available. (Partial: `read-envelope.ts` provides the tolerant canonical/legacy adapter and tests; callers are not fully wired through it yet.)
- [ ] 6.3 Update CLI read/owner commands to display connection identity and warnings consistently without inventing alternate response shapes. (Partial: `_ref connectors list/show` now render canonical `meta.warnings` to stderr without changing parseable stdout; future CLI read commands must reuse the helper.)

## 7. Conformance and Regression Tests

- [ ] 7.1 Extend public read conformance harness coverage for envelope shape, identity, strict validation, projection, expansion, filters, sort, pagination, counts, warnings, schema capabilities, and MCP mirroring. (Partial: search identity, alias validation, MCP mirroring, records identity decoration, deprecated-alias warnings, expansion rejection, graded counts (`none`/`estimated`/`exact`), and canonical sort direction (ASC + DESC + `sort`/`order` disagreement) all have targeted coverage on **both** the SQLite reference path (`public-read-connection-id-decoration.test.js`) and the Postgres runtime path (`postgres-runtime-storage.test.js` — env-gated on `PDPP_TEST_POSTGRES_URL`). `/v1/schema` capability truth and storage fan-in remain.)
- [ ] 7.2 Add multi-connection fixtures for records list, records detail, search, and blob read. (Partial: multi-connection lexical, semantic, and hybrid search fixtures exist; records-list/detail/blob multi-connection fixtures remain.)
- [ ] 7.3 Add regression tests for no silent filter/sort/expand no-ops. (Partial: unsupported params, filter operators, alias conflicts, unsupported expand targets, unsortable sort fields, and `changes_since` + list-only sort/count/order combinations are covered on **both** backends. Canonical `sort` direction is enforced and asserted on the SQLite reference path by `public-read-connection-id-decoration.test.js` and on the Postgres runtime path by `postgres-runtime-storage.test.js`: a `sort=-<cursor>` request that returned ascending order, or a `count=exact`/`estimated` that was silently dropped, would fail those tests on the dispatched backend. Per-capability conformance from `/v1/schema` still requires the capability document tranche.)
- [x] 7.4 Add token-efficiency regression checks for MCP tool output size and structuredContent availability.

## 8. Validation and Deployment

- [x] 8.1 Run targeted reference-implementation, reference-contract, MCP, dashboard, and CLI tests.
- [x] 8.2 Run relevant typechecks.
- [x] 8.3 Run `openspec validate canonicalize-public-read-contract --strict`.
- [x] 8.4 Run `openspec validate --all --strict` if the work touches existing active changes.
- [x] 8.5 Rebuild and restart local Docker when dashboard/API behavior changes.
