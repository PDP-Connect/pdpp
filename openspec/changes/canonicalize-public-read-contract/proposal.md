## Why

The public read surface has accreted operation by operation: REST, MCP, CLI, dashboard, and the new Explorer now expose different assumptions about connection identity, parameter validation, pagination, counting, capability discovery, and non-fatal lossiness. That makes useful clients possible, but not correct by construction.

Prior-art review across JSON:API, OData, GraphQL Relay, FHIR, Stripe, Elasticsearch, PostgREST, and MCP shows the same lesson: a read API needs one canonical contract for identity, projection, expansion, filtering, sorting, pagination, counts, capabilities, warnings, and client envelopes, with all surfaces derived from it.

## What Changes

- Add a canonical public read contract for `/v1` read operations and MCP mirrors.
- Define the canonical record address as `(connection_id, stream, record_id)` and require record-bearing responses and search hits to carry connection identity.
- Define one uniform read envelope with `data`, `links`, `meta`, `has_more` for lists, and structured `meta.warnings` for non-fatal lossiness or compatibility behavior.
- Define a strict parameter-validation posture: unsupported parameters, fields, operators, sort fields, or expansion targets fail clearly rather than silently no-op.
- Define projection, one-hop inline expansion, filter, sort, opaque-cursor pagination, and graded count semantics as shared primitives.
- Define `/v1/schema` as the capability/introspection source for streams, fields, operators, sortability, expansion, search modes, pagination, count support, and granted connections.
- Define MCP tool output as a faithful mirror of the canonical envelope via `structuredContent`/`outputSchema`, with prose `content[]` only as a summary.
- Consolidate overlapping intent from existing changes without making Explorer-specific UI nouns into backend contracts.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: canonical public read contract requirements for identity, envelope, validation, projection, expansion, filters, sorting, pagination, counts, capabilities, warnings, search hits, and MCP mirroring.

## Impact

- Affects public `/v1` read operations, generated reference contract schemas, RS operation modules, MCP server tools, conformance harnesses, dashboard/Explorer consumers, and docs/cookbook guidance.
- Existing active changes remain useful implementation slices, especially `expose-connection-identity-on-public-read`, `expand-first-party-parent-child-relations`, `expose-per-stream-dataset-summary`, and the `mount-rs-*` operation changes.
- `polish-assistant-query-api-discovery` and `clarify-public-read-contract-llm-hints` are conceptually folded into this contract; their concrete docs/tooling edits can remain as implementation evidence.
- This change does not add a UI-specific Explorer backend contract, does not standardize arbitrary BI/facet features, and does not promote `_ref` operator diagnostics into the public PDPP read contract.
