## Why

Clients can now discover connectors and stream metadata, but they still have to reverse-engineer which fields are exact-filterable, range-filterable, searchable, or expandable from several separate manifest fragments. Agent consumers need a single field-level capability shape so they can plan queries without trial-and-error.

## What Changes

- Add a normalized `field_capabilities` object to stream metadata.
- Derive capability entries from existing manifest/schema declarations: schema properties, `query.range_filters`, `query.search.lexical_fields`, `query.search.semantic_fields`, `relationships[]`, and `query.expand[]`.
- Preserve existing metadata fields for backward compatibility.
- Keep this as discovery only; it does not add new filter operators, ranking behavior, or aggregation semantics.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: Adds a durable reference metadata requirement for field-level query capability declarations.

## Impact

- Affected public APIs: `GET /v1/streams/:stream` and generated reference docs/OpenAPI.
- Affected implementation areas: stream metadata builders, manifest-derived query capability helpers, and query-contract tests.
- No new dependencies or storage tables.
