## 1. Baseline And Boundary

- [x] 1.1 Inventory current native `GET /v1/streams/:stream/records` and `GET /v1/streams/:stream/records/:id` behavior, including owner/client branches, query/disclosure instrumentation, view/fields mutual exclusion, view → fields resolution, and `expand`/`expand_limit` handling.
- [x] 1.2 Inventory current sandbox `GET /sandbox/v1/streams/:stream/records` and `GET /sandbox/v1/streams/:stream/records/:id` behavior, including pagination, `connector_id` filtering, and live envelope shape.
- [x] 1.3 Confirm operation module paths (`reference-implementation/operations/rs-records-list/index.ts` and `rs-records-detail/index.ts`) and document why they satisfy the no-Fastify/no-Next/no-SQLite/no-process-env boundary.

## 2. Operation Implementation

- [x] 2.1 Implement canonical `rs.records.list` and `rs.records.get` operations with explicit request, response, error, and dependency inputs. The operations own request normalization (view/fields mutual exclusion, view → fields resolution, field/filter validation, owner read-grant construction, manifest stream visibility, request-param threading) and output shape; they delegate cursor comparison, `changes_since`, projection, range, `expand[]`, and blob-ref byte access to capability dependencies.
- [x] 2.2 Add native dependencies that preserve existing owner-visible and grant-visible record-read semantics, including `queryRecords`/`getRecord` capability adapters and the existing `decorateRecordBlobRefs` post-processing.
- [x] 2.3 Add sandbox fixture dependencies in `apps/web/src/app/sandbox/_demo/operations-fixtures.ts` backed by deterministic demo data; no record builder lives in route files.
- [x] 2.4 Add operation-level tests for owner-shaped list/detail, manifest stream not-found, view/fields mutual exclusion, view-resolution-against-grant, and field projection.

## 3. Host Mounts

- [x] 3.1 Migrate native Fastify `GET /v1/streams/:stream/records` to call `rs.records.list` while preserving auth, request id, trace id, query-received, and disclosure-served behavior.
- [x] 3.2 Migrate native Fastify `GET /v1/streams/:stream/records/:id` to call `rs.records.get` while preserving auth, request id, trace id, query-received, and disclosure-served behavior.
- [x] 3.3 Migrate Next sandbox `GET /sandbox/v1/streams/:stream/records` and `GET /sandbox/v1/streams/:stream/records/:id` to call the same operations with sandbox fixture dependencies; preserve sandbox demo headers and 404 envelope shape.
- [x] 3.4 Delete `buildLiveRecordsList` and `buildLiveRecordDetail` so the public sandbox routes cannot import a parallel AS/RS builder.

## 4. Boundary Tests

- [x] 4.1 Extend boundary tests so the new operation modules are covered by the shared `operation-boundary.js` gate.
- [x] 4.2 Add per-operation boundary tests proving sandbox record-read routes do not statically import `buildLiveRecordsList` or `buildLiveRecordDetail`, and that `_demo/builders.ts` no longer exports them.

## 5. Validation

- [x] 5.1 Run `node --test --test-force-exit reference-implementation/test/operations-boundary.test.js`.
- [x] 5.2 Run `node --test --test-force-exit reference-implementation/test/record-read-conformance.test.js`.
- [x] 5.3 Run new operation tests for `rs.records.list` and `rs.records.get`.
- [x] 5.4 Run `pnpm --dir apps/web run types:check`.
- [x] 5.5 Run `pnpm --dir apps/web run check`.
- [x] 5.6 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [x] 5.7 Run `pnpm --filter pdpp-reference-implementation check`.
- [x] 5.8 Run `openspec validate mount-rs-record-read-operations --strict`.
- [x] 5.9 Run `openspec validate --all --strict`.
