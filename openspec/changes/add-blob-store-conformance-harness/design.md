## Context

Record-read, record-mutation, lexical-retrieval, disclosure-spine, consent, device-auth, and connector-state/scheduler seams now have conformance patterns. Blob persistence does not. The reference still routes `/v1/blobs` through `persistContentAddressedBlob`, which calls the SQLite-backed `blobsInsertBlob` / `blobsGetStoredById` / `blobsInsertBinding` helpers directly. Before any future split between blob metadata (rows) and blob bytes (object storage), or any portability work targeting PostgreSQL, the durable contract needs to be pinned independently of SQLite, route, and authorization wiring.

This change creates the missing evidence without changing runtime architecture. It deliberately excludes a production `BlobStore` interface — that decision belongs to a later proposal that has the body to weigh storage layout (bytes-in-row vs. bytes-in-object-store), garbage-collection, and lifecycle.

## Decision

Add a test-only `BlobStoreDriver` conformance harness. The harness SHALL test semantic obligations that are portable across blob backends:

- content-addressed put: storing bytes returns a deterministic blob_id derived from the bytes;
- content-address dedupe: two puts of byte-identical content collapse to one logical blob without corrupting the stored row;
- content-address collision rejection: a put that claims an existing blob_id but carries different bytes is rejected;
- binding idempotency: re-binding the same `(blob_id, connector_id, stream, record_key)` tuple is a no-op;
- binding fan-out: one blob can be bound by many distinct record tuples;
- binding lookup: bindings are queryable by record key and by blob id;
- get-missing returns null, not an exception;
- backend identity advertised honestly (content-address algorithm, dedupe semantics, binding semantics).

The memory driver SHALL be deliberately simple: a `Map<blob_id, { bytes, mime_type, size_bytes, sha256 }>` and a `Set` of binding tuples. It SHALL declare its backend identity (`memory-content-addressed`) rather than impersonate SQLite. The harness focuses on portable obligations; the choice between BLOB-in-row, BLOB-on-disk, or BLOB-in-object-store is intentionally not pinned.

## Stop Conditions

Stop for owner review if the implementation:

- introduces or exports a production `BlobStore` interface;
- changes `/v1/blobs` public wire behavior (request shape, response shape, status codes, content-type handling);
- moves blob bytes out of SQLite or introduces an object-storage backend;
- requires changes to `blobs` / `blob_bindings` schema beyond what already exists;
- couples the harness to authorization or grant scoping (those are tested separately at the route level).

## Acceptance Checks

- SQLite, memory, and falsifiability drivers all run through the same blob-store conformance suite.
- The broken driver fails at least one semantic invariant.
- Existing `/v1/blobs` query-contract tests remain green.
- Operation boundary tests remain green.
