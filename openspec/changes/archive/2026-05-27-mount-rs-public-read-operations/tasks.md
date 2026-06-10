## 1. Baseline And Boundary

- [x] 1.1 Inventory current native `GET /v1/connectors` and `GET /v1/streams/:stream/aggregate` behavior, including owner/client branches, query/disclosure instrumentation, owner-branch manifest visibility check, `validateRequestedQueryFieldParams` invocation, and source-descriptor selection.
- [x] 1.2 Confirm operation module paths (`reference-implementation/operations/rs-connectors-list/index.ts` and `rs-streams-aggregate/index.ts`) and document why they satisfy the no-Fastify/no-Next/no-SQLite/no-process-env boundary.
- [x] 1.3 Confirm `GET /v1/blobs/:blob_id` is out of scope and why (no `BlobStore` capability exists yet; raw SQL through `getDb()`; per-binding `getRecord` visibility).

## 2. Operation Implementation

- [x] 2.1 Implement canonical `rs.connectors.list` operation with explicit input, output, and dependency contract. The operation owns the `{object: 'list', data}` envelope shape and the `query.received` / `disclosure.served` `connector_list` data block (including `connector_count` and `stream_count` totals); it delegates connector-item assembly to a `listConnectorItems()` capability and source-descriptor to `getSourceDescriptor()`.
- [x] 2.2 Implement canonical `rs.streams.aggregate` operation with explicit input, output, error, and dependency contract. The operation owns request-param shaping into the `stream_aggregate` query-shape data block, the owner-branch manifest-stream-not-found visibility error mapping, and the verbatim aggregate response passthrough; it delegates `validateRequestedQueryFieldParams` invocation and `aggregateRecords` invocation to capability dependencies.

## 3. Host Mounts

- [x] 3.1 Migrate native Fastify `GET /v1/connectors` to call `rs.connectors.list` while preserving auth, request id, trace id, query-received, disclosure-served, and the `{object: 'list', data}` envelope.
- [x] 3.2 Migrate native Fastify `GET /v1/streams/:stream/aggregate` to call `rs.streams.aggregate` while preserving auth, request id, trace id, query-received, disclosure-served, owner-branch manifest visibility (`not_found`), validator invocation, and verbatim aggregate response.

## 4. Boundary Tests

- [x] 4.1 Confirm the new operation modules are covered by the shared `operation-boundary.js` gate (`operations-boundary.test.js` discovers them automatically).
- [x] 4.2 Add per-operation boundary tests that pin no-`server/records.js`, no-`server/index.js` static imports.

## 5. Operation-Behavior Tests

- [x] 5.1 Add operation-behavior tests for `rs.connectors.list` covering envelope discriminator, dependency-order preservation, `connector_count` and `stream_count` totals, and the `connector_list` query-shape data block.
- [x] 5.2 Add operation-behavior tests for `rs.streams.aggregate` covering query-shape data block construction, owner-branch manifest-not-found error mapping, validator invocation order, and verbatim aggregate response passthrough.

## 6. Validation

- [x] 6.1 Run `node --test --test-force-exit reference-implementation/test/operations-boundary.test.js`.
- [x] 6.2 Run new boundary and operation tests.
- [x] 6.3 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [x] 6.4 Run `pnpm --filter pdpp-reference-implementation check`.
- [x] 6.5 Run `openspec validate mount-rs-public-read-operations --strict`.
- [x] 6.6 Run `openspec validate --all --strict`.
