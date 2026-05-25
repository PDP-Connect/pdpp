## 1. Contract and OpenSpec

- [x] 1.1 Capture prior-art and repo audit findings in `tmp/workstreams/canonical-read-contract-right-hand-report.md`.
- [x] 1.2 Add proposal, design, and spec delta for the canonical public read contract.
- [x] 1.3 Validate `canonicalize-public-read-contract` with `openspec validate canonicalize-public-read-contract --strict`.
- [ ] 1.4 Classify overlapping active changes in their design/task files: `expose-connection-identity-on-public-read`, `expand-first-party-parent-child-relations`, `expose-per-stream-dataset-summary`, `clarify-public-read-contract-llm-hints`, `polish-assistant-query-api-discovery`, and `add-dashboard-records-explorer`.

## 2. Reference Contract Schemas

- [x] 2.1 Add canonical envelope schema types for list, single-object, schema, search, warnings, links, and count metadata.
- [x] 2.2 Add public read input schemas for `fields`, `expand`, `expand_limit`, `filter`, `sort`, `cursor`, `limit`, `count`, `connection_id`, and deprecated `connector_instance_id` alias.
- [ ] 2.3 Add generated contract descriptions that point callers to `/v1/schema` for field/operator/expand/sort/count capabilities.
- [ ] 2.4 Ensure `connector_instance_id` is documented only as a deprecated compatibility alias.
- [ ] 2.5 Run reference-contract generation and verification.

## 3. Public RS Runtime

- [ ] 3.1 Thread `connection_id` and `display_name` onto every record-bearing records/search/blob response item.
- [ ] 3.2 Make search hits carry `(connection_id, stream, record_id)` without dashboard-side inference.
- [ ] 3.3 Implement optional `connection_id` filtering and deprecated `connector_instance_id` alias conflict validation on public read routes.
- [ ] 3.4 Normalize public read responses into the canonical envelope, preserving backward-compatible fields only where the contract allows.
- [ ] 3.5 Implement strict validation for unsupported parameters, fields, filter operators, sort fields, and expansion targets.
- [ ] 3.6 Implement structured `meta.warnings` for skipped-not-applicable sources, deprecated alias use, count downgrades, and partial/lossy outcomes.
- [ ] 3.7 Implement graded count support (`none`, `estimated`, `exact`) backed by existing projections when possible.
- [ ] 3.8 Keep one-hop inline expansion grant-safe and bounded by `expand_limit`.

## 4. Capability Document

- [ ] 4.1 Update `GET /v1/schema` to be the canonical capability document for streams, fields, operators, sortability, expansion, projection, search modes, pagination, counts, and granted connection identities.
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
