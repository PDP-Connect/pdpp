## 1. Harness Design

- [x] 1.1 Inventory existing blob query helpers (`blobsInsertBlob`, `blobsGetStoredById`, `blobsInsertBinding`) and the `persistContentAddressedBlob` caller.
- [x] 1.2 Define the test-only `BlobStoreDriver` shape with putBlob / getBlob / putBinding / listBindingsForRecord / listBindingsForBlob.
- [x] 1.3 Document backend identity required from every driver (backend kind, content-address algorithm, dedupe semantics, binding semantics).

## 2. Driver Implementation

- [x] 2.1 Implement a SQLite driver wrapping the existing canonical query helpers at the SQL helper level.
- [x] 2.2 Implement a memory driver with honest content-address dedupe and binding storage using nested maps.
- [x] 2.3 Implement a broken/falsifiability driver that violates content-address dedupe (silently overwrites) and binding idempotency.

## 3. Conformance Scenarios

- [x] 3.1 Cover backend identity advertisement (content-address kind, dedupe, binding kind).
- [x] 3.2 Cover put-then-get returning identical bytes and metadata.
- [x] 3.3 Cover content-address dedupe: duplicate put of identical bytes returns the same blob_id and does not corrupt stored metadata.
- [x] 3.4 Cover content-address collision detection: put of different bytes claiming the same blob_id is rejected.
- [x] 3.5 Cover binding idempotency: re-binding the same (blob, connector, stream, record_key) tuple does not duplicate.
- [x] 3.6 Cover binding fan-out: one blob can be bound by multiple distinct (connector, stream, record_key) tuples.
- [x] 3.7 Cover listing bindings by record key and by blob id.
- [x] 3.8 Cover get-missing returns null without throwing.
- [x] 3.9 Prove the broken driver fails at least one invariant.

## 4. Validation

- [x] 4.1 Run new blob-store conformance tests (sqlite, memory, falsifiability).
- [x] 4.2 Run existing query-contract tests (`/v1/blobs`).
- [x] 4.3 Run operation-boundary tests.
- [x] 4.4 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [x] 4.5 Run `pnpm --filter pdpp-reference-implementation check`.
- [x] 4.6 Run `openspec validate add-blob-store-conformance-harness --strict`.
- [x] 4.7 Run `openspec validate --all --strict`.
