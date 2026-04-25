## Why

The assistant feedback shows the query layer is now powerful but still hard to self-discover: a capable client can use range filters, search filters, aggregations, blobs, and `changes_since`, but too much of the correct shape is learned by trial-and-error.

## What Changes

- Add a one-shot schema/capability discovery surface for the reference RS so agents can discover connectors, streams, schemas, filterability, aggregation support, expansion support, blob affordances, and freshness without out-of-band connector IDs.
- Tighten public/reference docs and generated cookbook examples for `streams[]` search filters, `changes_since=beginning`, `GET /v1/streams/:stream/aggregate`, `blob_ref.fetch_url`, and unsupported endpoint shapes.
- Improve error messages where a caller uses the wrong endpoint or wrong parameter spelling, without broadening the protocol.
- Keep existing per-stream metadata as the source of truth; the new discovery surface aggregates it rather than inventing a second capability model.

## Capabilities

### New Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: add a reference RS discovery requirement for schema/capability enumeration and self-service query guidance.

## Impact

- `reference-implementation/server/index.js`
- `reference-implementation/server/records.js`
- `reference-implementation/test/query-contract.test.js`
- `packages/reference-contract/src/public/index.ts`
- generated OpenAPI/docs artifacts
- `apps/web/content/docs/spec-data-query-api.md`
- `apps/web/content/docs/spec-core.md`
