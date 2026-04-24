## Why

Assistant clients currently fetch broad record pages and aggregate locally for common questions like counts by sender, spend by payee, or records per day. That is inefficient and makes least-privilege grants harder to use well.

## What Changes

- Add a grant-safe public aggregation surface for single-stream record data.
- Start with a narrow set of operations: `count`, numeric `sum`, numeric/date `min`/`max`, and optional `group_by` over declared scalar fields.
- Reuse existing exact and range filter grammar.
- Reject undeclared, unauthorized, non-scalar, cross-stream, and unbounded/high-cardinality requests.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: Adds public reference requirements for grant-safe query aggregations.

## Impact

- Affected public APIs: likely a new `GET /v1/streams/:stream/aggregate` endpoint and stream metadata capability declarations.
- Affected implementation areas: record filters, grant projection, route contracts, generated docs/OpenAPI, and query tests.
- No new dependency is expected; storage/indexing improvements may be a later performance tranche.
