## Context

Recent MCP, dashboard, CLI, and Explorer work exposed table-stakes gaps in the public read substrate:

- Search hits do not reliably carry concrete connection identity, forcing UI-side reconstruction and ambiguity.
- Capability metadata has sometimes over-promised behavior, such as filters or expansions that were not enforced end to end.
- Tool descriptions, REST parameters, dashboard calls, and CLI paths have drifted because each surface owns too much of the read contract itself.
- Count, aggregation, expansion, and query validation have improved, but the shape is still spread across separate changes and code paths.

The prior-art audit in `tmp/workstreams/canonical-read-contract-right-hand-report.md` and `tmp/workstreams/right-hand-prior-art.md` compared JSON:API, OData, GraphQL Relay/global node, FHIR search, Stripe, Elasticsearch, PostgREST, and MCP. The design below adopts the parts that support PDPP's goals without inheriting their incidental complexity.

## Prior-Art Conclusions

- JSON:API validates the value of one envelope with `data`, `links`, `meta`, sparse fieldsets, and relationship inclusion, but intentionally leaves filter semantics unspecified. PDPP should copy the envelope discipline, not the filter ambiguity. Source: https://jsonapi.org/format/
- OData proves the value of machine-readable metadata, `$select`, `$expand`, `$orderby`, `$count`, and opaque server-driven next links, but its `$filter` expression language is too broad for a small, agent-friendly PDPP contract. Sources: https://docs.oasis-open.org/odata/odata/v4.01/odata-v4.01-part2-url-conventions.html and https://docs.oasis-open.org/odata/odata/v4.01/odata-v4.01-part1-protocol.html
- GraphQL Relay/global object identification shows the importance of schema introspection, opaque cursors, and refetchable object identity, but `totalCount` is deliberately outside the core connection spec and should not be retrofitted everywhere. Sources: https://relay.dev/graphql/connections.htm and https://graphql.org/learn/global-object-identification/
- FHIR search is the strongest precedent for a standards-grade portability API that advertises searchable parameters and includes structured non-fatal outcomes instead of silently dropping behavior. PDPP should adapt that "outcome" discipline as `meta.warnings`. Source: https://www.hl7.org/fhir/search.html
- Stripe's list envelope and `expand[]` are pragmatic and agent-friendly; PDPP should keep one-hop inline expansion rather than sidecar `included` data. Sources: https://docs.stripe.com/api/expanding_objects and https://docs.stripe.com/api/pagination
- Elasticsearch/OpenSearch aggregations show how to expose approximate counts/facets honestly, but the full search DSL and arbitrary aggregation tree are out of scope for this tranche. Sources: https://www.elastic.co/guide/en/elasticsearch/reference/current/paginate-search-results.html and https://www.elastic.co/guide/en/elasticsearch/reference/current/search-aggregations.html
- PostgREST offers the best cost-shape for counts (`Prefer: count=none|planned|estimated|exact`) and compact operator filters. PDPP should adopt graded counts and a small machine-readable operator vocabulary, not a large SQL-like DSL. Sources: https://postgrest.org/en/stable/references/api/tables_views.html and https://postgrest.org/en/stable/references/api/pagination_count.html
- MCP is a carrier, not the contract. Tool `inputSchema`, `outputSchema`, `structuredContent`, and `readOnlyHint` should mirror the PDPP read contract rather than redefine it per tool. Sources: https://modelcontextprotocol.io/specification/2025-06-18/server/tools and https://modelcontextprotocol.io/specification/2025-06-18/server/resources

## Design

### Canonical Record Address

Every record-bearing public read result is addressable as `(connection_id, stream, record_id)`.

`connection_id` is the public canonical noun for a concrete owner-configured account/device/profile. `connector_id` remains the connector/manifest type. `display_name` is the owner-facing label. `connector_instance_id` remains an internal storage/runtime identifier and a temporary request/response compatibility alias during migration.

This folds in the essential parts of `expose-connection-identity-on-public-read`.

### Uniform Envelope

Every public read operation returns one canonical envelope family:

```json
{
  "object": "list",
  "data": [],
  "has_more": false,
  "links": {
    "self": "/v1/streams/messages/records?...",
    "next": null
  },
  "meta": {
    "count": { "kind": "none" },
    "warnings": []
  }
}
```

Single-record, schema, and stream responses use the same `object`, `data`, `links`, and `meta` vocabulary without `has_more` unless the response is list-like.

`links.self` round-trips the effective request. `links.next` is server-built and opaque to clients. `meta.warnings` is the structured place for non-fatal lossiness: deprecated alias use, omitted capabilities, skipped sources, approximate counts, or compatibility behavior. Fatal errors remain typed errors.

### Strict Validation

Unknown query parameters, fields, filter operators, sort fields, and expansion targets are rejected with typed errors by default. The server does not silently ignore unsupported behavior. If a temporary migration path accepts a deprecated alias or ignores a parameter for compatibility, it must emit a structured warning.

This is the correction for prior over-promised capability metadata and per-client drift.

### Projection

The canonical projection primitive is `fields`, expressed as a comma-separated or array field allowlist with dotted paths when needed. It applies to top-level records and expanded child records. Named projection profiles may exist later, but they are sugar over this primitive and must be advertised through `/v1/schema`.

FHIR-style `_summary` plus `_elements` is intentionally not adopted because two projection mechanisms create incidental complexity.

### Expansion

The canonical expansion primitive is one-hop inline `expand[]` for manifest-declared parent-to-child relations. Expansion is grant-safe, depth-capped at one, and bounded by `expand_limit` for has-many children.

Reverse joins, arbitrary belongs-to relations, nested expansion, and general graph traversal remain out of scope. `expand-first-party-parent-child-relations` is the current implementation slice for safe first-party relationships.

### Filters

The canonical filter vocabulary is small and machine-readable:

- exact equality: `filter[field]=value`
- operator filter: `filter[field][op]=value`

Allowed operators are per-field capabilities from `/v1/schema`; the initial operator family is limited to equality/range/membership/string operators already implemented or intentionally added by the reference. No OData-style boolean expression DSL is adopted in this tranche.

### Sort

The canonical sort primitive is sign-prefix sorting, e.g. `sort=-emitted_at,name`, over fields advertised as sortable in `/v1/schema`. If a stream supports only cursor-field ordering, the capability document must say so.

### Pagination

Canonical pagination uses `limit`, opaque `cursor`, `has_more`, and `links.next`. Cursor contents are not client contract. Offset pagination remains legacy/sandbox-only and must not be advertised as the canonical surface.

### Counts

Counts are opt-in and cost-graded:

- default: no count
- estimated: uses maintained read models or planner-style estimates
- exact: computes an exact count when supported and safe

The HTTP spelling is `Prefer: count=none|estimated|exact`; generated clients and MCP tools may expose an equivalent `count` argument but must map to the same semantics. Responses carry `meta.count = { kind, value? }` and a warning if the server downgrades a requested count kind.

This extends the value of `expose-per-stream-dataset-summary` without making retained-size internals public protocol facts.

### Capability Document

`GET /v1/schema` is the canonical introspection surface. It must describe:

- streams and their record fields
- filterable fields and allowed operators per field
- sortable fields and default/cursor sort
- expandable fields and `expand_limit` behavior
- projection support
- search modes and whether cursor pagination is supported per mode
- count support and cost class
- granted connections visible to the caller, including `connection_id`, `connector_id`, and `display_name`

Tool descriptions and docs can summarize this information, but they do not become a second source of truth.

### Search As Records

Search results carry the same identity as record reads: `connection_id`, `connector_id`, `stream`, and `record_id`. Search may include scores/snippets, but hit identity is not optional. Dashboard Explorer and MCP should not reconstruct it from connector type.

### MCP Mirror

The in-repo MCP server and hosted MCP gateway must mirror the canonical contract:

- tool input schemas expose the same public arguments as REST
- tool output schemas match the canonical envelope
- `structuredContent` carries the canonical response body
- prose `content[]` is a concise summary only
- tools remain read-only where appropriate through MCP annotations

MCP must not solve ambiguities differently from REST.

## Existing Change Mapping

- Keep `expose-connection-identity-on-public-read` as the identity implementation slice, but treat its core invariant as part of this canonical contract.
- Keep `expand-first-party-parent-child-relations` as the expansion implementation slice.
- Keep `expose-per-stream-dataset-summary` as a reference-only read model that can back estimated counts and freshness metadata.
- Keep `add-dashboard-records-explorer` as a consumer and diagnostic surface; it must simplify after search hits carry connection identity.
- Keep `make-reference-queries-inspectable` and `_ref` operation changes separate; `_ref` is an operator surface, not the public read contract.
- Fold the contract-level intent of `polish-assistant-query-api-discovery` and `clarify-public-read-contract-llm-hints` into this change; their concrete docs/tooling work may remain as implementation evidence.

## Non-Goals

- No OData `$filter` expression language.
- No JSON:API sidecar `included` model.
- No FHIR `_summary` plus `_elements` split.
- No arbitrary aggregation/facet tree in this tranche.
- No reverse/belongs-to joins or nested graph traversal.
- No public protocol surfacing of `_ref` operator diagnostics such as retained byte projections.
- No Explorer-specific backend identifiers, peek keys, or UI tabs as public contract nouns.
- No new standalone CLI read surface.

## Acceptance

- OpenSpec validates strictly.
- Existing active changes can be classified as implementation slices, supersedes, or separate operator work without contradiction.
- A conformance harness can test every advertised capability against runtime behavior.
- REST, MCP, CLI, dashboard, and Explorer can consume the same envelope and identity model without per-surface reconstruction.
- The contract provides an explicit place for approximation and non-fatal lossiness instead of silent no-ops.
