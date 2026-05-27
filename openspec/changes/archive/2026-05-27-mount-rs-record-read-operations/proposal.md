## Why

The `define-reference-operation-environments` proof sequence has landed `rs.streams.list`, `rs.streams.detail`, and `rs.schema.get` as canonical reference operations mounted from both the native Fastify host and the Next sandbox host. The remaining sandbox `/sandbox/v1/streams/:stream/records*` routes still construct their public response by importing website-local AS/RS builders (`buildLiveRecordsList`, `buildLiveRecordDetail`) — the same drift class the architecture work is meant to remove.

Record-read operations are the next-lowest-risk extraction because the `add-record-read-conformance-harness`, `harden-record-ingest-atomicity`, and `harden-record-delete-atomicity` changes have already pinned cursor, projection, range, and atomicity semantics. This change does not extract a production `RecordStore`, does not change cursor/projection/`changes_since`/range/view/`expand[]`/blob-ref semantics, and does not introduce Postgres. It only mounts the existing record-read behavior through canonical operation capsules so Fastify and the Next sandbox call the same implementation.

## What Changes

- Introduce canonical `rs.records.list` and `rs.records.get` operation implementations that own the host-independent slice of record-read behavior: input normalization, view/fields mutual exclusion, view → fields resolution, manifest stream visibility, field/filter validation, owner read-grant construction, and output shape.
- Mount those operations from the native Fastify reference server (`GET /v1/streams/:stream/records`, `GET /v1/streams/:stream/records/:id`) and from the Next sandbox routes (`/sandbox/v1/streams/:stream/records`, `/sandbox/v1/streams/:stream/records/:id`).
- Add sandbox fixture dependencies to `apps/web/src/app/sandbox/_demo/operations-fixtures.ts` so the sandbox routes resolve record-read capabilities through the same dependency shape the operation requires.
- Delete or demote the public `buildLiveRecordsList` and `buildLiveRecordDetail` sandbox builders so the sandbox routes cannot import a parallel AS/RS builder.
- Extend boundary tests so the new operation modules are gated by the shared operation boundary helper and the sandbox routes cannot reimport the deleted record builders.
- Do not migrate aggregate, search, blobs, runs, traces, or `_ref` routes in this slice.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: `rs.records.list` and `rs.records.get` become operation-owned, joining `rs.streams.list`, `rs.streams.detail`, and `rs.schema.get` as canonical operation capsules.
- `reference-web-bridge-contract`: `/sandbox/v1/streams/:stream/records` and `/sandbox/v1/streams/:stream/records/:id` SHALL mount the canonical record-read operations through the sandbox fixture environment instead of constructing live-shaped record envelopes through website-local builders.

## Impact

- Affected code: `reference-implementation/operations/rs-records-list/**`, `reference-implementation/operations/rs-records-detail/**`, `reference-implementation/server/index.js` (record-read routes only), `apps/web/src/app/sandbox/v1/streams/[stream]/records/route.ts`, `apps/web/src/app/sandbox/v1/streams/[stream]/records/[recordId]/route.ts`, `apps/web/src/app/sandbox/_demo/operations-fixtures.ts`, `apps/web/src/app/sandbox/_demo/builders.ts`, `reference-implementation/package.json` (operation exports), and tests.
- No public API shape change: `/v1/streams/:stream/records`, `/v1/streams/:stream/records/:id`, `/sandbox/v1/streams/:stream/records`, and `/sandbox/v1/streams/:stream/records/:id` continue to return their existing JSON envelopes. Cursor, `changes_since`, projection, range filter, view, `expand[]`, and blob-ref decoration semantics are preserved by passing the existing `queryRecords`/`getRecord` capabilities into the operation as dependencies.
- No production `RecordStore` is extracted, no Postgres adapter is introduced, no search behavior is touched, and no `server/index.js` rewrite outside the two record-read routes is performed.
