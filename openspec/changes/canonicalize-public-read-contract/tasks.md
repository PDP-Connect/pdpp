## 1. Contract and OpenSpec

- [x] 1.1 Capture prior-art and repo audit findings in `tmp/workstreams/canonical-read-contract-right-hand-report.md`.
- [x] 1.2 Add proposal, design, and spec delta for the canonical public read contract.
- [x] 1.3 Validate `canonicalize-public-read-contract` with `openspec validate canonicalize-public-read-contract --strict`.
- [ ] 1.4 Classify overlapping active changes in their design/task files: `expose-connection-identity-on-public-read`, `expand-first-party-parent-child-relations`, `expose-per-stream-dataset-summary`, `clarify-public-read-contract-llm-hints`, `polish-assistant-query-api-discovery`, and `add-dashboard-records-explorer`.

## 2. Reference Contract Schemas

- [ ] 2.1 Add canonical envelope schema types for list, single-object, schema, search, warnings, links, and count metadata.
- [ ] 2.2 Add public read input schemas for `fields`, `expand`, `expand_limit`, `filter`, `sort`, `cursor`, `limit`, `count`, `connection_id`, and deprecated `connector_instance_id` alias.
- [ ] 2.3 Add generated contract descriptions that point callers to `/v1/schema` for field/operator/expand/sort/count capabilities.
- [ ] 2.4 Ensure `connector_instance_id` is documented only as a deprecated compatibility alias.
- [ ] 2.5 Run reference-contract generation and verification.

## 3. Public RS Runtime

- [ ] 3.1 Thread `connection_id` and `display_name` onto every record-bearing records/search/blob response item. (Partial: search hits now carry `connection_id` + deprecated `connector_instance_id` alias whenever the snapshot captured one — see `reference-implementation/test/search-connection-identity.test.js`. Records-list, records-detail, and blob-read item decoration still deferred to the broader storage fan-in tranche; `display_name` deferred until the connector-instance-store lookup helper lands.)
- [x] 3.2 Make search hits carry `(connection_id, stream, record_id)` without dashboard-side inference. Lexical / semantic / hybrid result items now emit `connection_id` and the deprecated `connector_instance_id` alias when the snapshot recorded the binding. Pre-identity snapshots are tolerated (fields omitted, not faked).
- [x] 3.3 Implement optional `connection_id` filtering and deprecated `connector_instance_id` alias conflict validation on public read routes. Canonical helper `validateConnectionAlias` is shared by `reference-implementation/server/records.js` (records list + detail + aggregate via `validateTopLevelQueryParams`) and the three search operations (`rs-search-lexical`, `rs-search-semantic`, `rs-search-hybrid`). Conflict tests live in `public-read-connection-alias.test.js`. (Filtering itself — narrowing storage to one `connection_id` when supplied — still requires the storage fan-in tranche to land. Today the alias is accepted, deprecated-equality is enforced, but the filter does not yet narrow storage on the records path.)
- [ ] 3.4 Normalize public read responses into the canonical envelope, preserving backward-compatible fields only where the contract allows.
- [ ] 3.5 Implement strict validation for unsupported parameters, fields, filter operators, sort fields, and expansion targets.
- [ ] 3.6 Implement structured `meta.warnings` for skipped-not-applicable sources, deprecated alias use, count downgrades, and partial/lossy outcomes.
- [ ] 3.7 Implement graded count support (`none`, `estimated`, `exact`) backed by existing projections when possible.
- [ ] 3.8 Keep one-hop inline expansion grant-safe and bounded by `expand_limit`.

## 4. Capability Document

- [ ] 4.1 Update `GET /v1/schema` to be the canonical capability document for streams, fields, operators, sortability, expansion, projection, search modes, pagination, counts, and granted connection identities. **Deferred (granted_connections only):** the operation layer already accepts arbitrary per-stream `[extra]` fields, but the host-side `buildConnectorSchemaItem` only knows about a single `storageBinding`. Listing all bindings under a grant per stream requires a new `listGrantedConnections(grant, streamName)` helper on the connector-instance-store and a matching reference-contract schema for `granted_connections: [{ connection_id, display_name }]`. None of those exist today; safe to add once the storage fan-in tranche lands.
- [ ] 4.2 Add conformance checks proving every advertised field/operator/sort/expand capability is either enforced or rejected clearly.
- [ ] 4.3 Add search-mode pagination and count-support metadata.

## 5. MCP Mirror

- [ ] 5.1 Update `packages/mcp-server` input schemas to mirror the canonical public read arguments.
- [ ] 5.2 Add `outputSchema` and canonical `structuredContent` envelopes for read tools.
- [ ] 5.3 Ensure prose `content[]` is a concise summary only and not a second divergent JSON contract.
- [ ] 5.4 Add tests proving MCP does not silently drop unsupported arguments that REST would reject.

## 6. Dashboard, Explorer, and CLI Consumers

- [ ] 6.1 Simplify Explorer search attribution once public search hits carry `connection_id`; remove sentinel or deduction code no longer needed.
- [ ] 6.2 Update dashboard/console reads to consume canonical envelopes and warnings where available.
- [ ] 6.3 Update CLI read/owner commands to display connection identity and warnings consistently without inventing alternate response shapes.

## 7. Conformance and Regression Tests

- [ ] 7.1 Extend public read conformance harness coverage for envelope shape, identity, strict validation, projection, expansion, filters, sort, pagination, counts, warnings, schema capabilities, and MCP mirroring.
- [ ] 7.2 Add multi-connection fixtures for records list, records detail, search, and blob read.
- [ ] 7.3 Add regression tests for no silent filter/sort/expand no-ops.
- [ ] 7.4 Add token-efficiency regression checks for MCP tool output size and structuredContent availability.

## 8. Validation and Deployment

- [ ] 8.1 Run targeted reference-implementation, reference-contract, MCP, dashboard, and CLI tests.
- [ ] 8.2 Run relevant typechecks.
- [ ] 8.3 Run `openspec validate canonicalize-public-read-contract --strict`.
- [ ] 8.4 Run `openspec validate --all --strict` if the work touches existing active changes.
- [ ] 8.5 Rebuild and restart local Docker when dashboard/API behavior changes.
