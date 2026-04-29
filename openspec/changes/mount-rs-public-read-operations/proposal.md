## Why

Two public RS read routes still implement AS/RS semantics inline in `reference-implementation/server/index.js`:

- `GET /v1/connectors` (`listConnectors`) builds a `{object: 'list', data: [...]}` envelope of connector discovery items inline.
- `GET /v1/streams/:stream/aggregate` (`aggregateStream`) parses query params into a `query.received` data block and invokes `aggregateRecords` inline.

Mounting these through canonical operation capsules brings them under the same boundary discipline that already covers `rs.streams.list`, `rs.streams.detail`, `rs.schema.get`, `rs.records.list`, `rs.records.detail`, `rs.search.{lexical,semantic,hybrid}`, `ref.dataset.summary`, `ref.connectors.{list,detail}`, and `ref.approvals.list`. It also reduces the size of the next route audit by removing two more public read routes from the route-local surface inventory.

`GET /v1/blobs/:blob_id` is intentionally left route-local in this change because mounting it would require a `BlobStore` capability that does not yet exist; see Impact and `design.md` for why.

## What Changes

- Add a canonical `rs.connectors.list` operation under `reference-implementation/operations/rs-connectors-list/` that owns the connector-discovery list envelope and the `connector_list` query-shape data block.
- Add a canonical `rs.streams.aggregate` operation under `reference-implementation/operations/rs-streams-aggregate/` that owns request parameter shaping into the `stream_aggregate` query-shape data block, the not-found error mapping for unknown streams, and the response passthrough.
- Switch the native Fastify `GET /v1/connectors` and `GET /v1/streams/:stream/aggregate` routes to mount the new operations. The host adapters retain auth, token/grant loading, request id / trace id, query-received and disclosure-served emission, and response writing.
- Add per-operation boundary tests that delegate to the shared `assertOperationBoundary` helper.
- Add operation-behavior tests that exercise the operation modules with stub dependencies.
- Do not migrate `GET /v1/blobs/:blob_id` in this change.
- Do not introduce a `BlobStore`, `RecordStore`, `Kysely`, or `StorageBackend` interface.
- Do not change durable response shapes for `/v1/connectors` or `/v1/streams/:stream/aggregate`.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: `rs.connectors.list` and `rs.streams.aggregate` become operation-owned reference behaviors. Two more public read routes drop their inline semantics.

## Impact

- Affected code: `reference-implementation/server/index.js` (two route handlers swapped to operation calls), two new operation modules under `reference-implementation/operations/`, and four new test files under `reference-implementation/test/` (two boundary, two operation-behavior).
- No public response shape change: `/v1/connectors` continues to return `{object: 'list', data: [...]}` with the same connector discovery items, and `/v1/streams/:stream/aggregate` continues to return whatever `aggregateRecords` produces today (verbatim passthrough).
- No new storage/search abstractions, no Postgres adapter, no Kysely usage, and no blob behavior change.
- `GET /v1/blobs/:blob_id` is **out of scope**: the route reads `blobs` and `blob_bindings` via raw SQL through `getDb()` and resolves visibility via per-binding `getRecord` calls. Capsuling it cleanly requires a `BlobStore` (or equivalent) capability per the `define-reference-operation-environments` decisions; that contract belongs in a separate change. The current route stays route-local until `add-blob-store-conformance-harness` (or a follow-up) lands the capability shape.
