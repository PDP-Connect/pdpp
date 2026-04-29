## Why

Blob persistence is still backed directly by the SQLite `blobs` + `blob_bindings` tables and exercised end-to-end through `/v1/blobs` route tests. Before any future split between blob metadata (rows) and blob bytes (object storage), or any portability work that targets PostgreSQL, the reference needs a conformance harness that pins the durable blob-store contract independently of SQLite, route, and authorization wiring.

## What Changes

- Add a test-only blob-store conformance harness with SQLite, memory, and broken/falsifiability drivers.
- Require drivers to advertise content-address identity and bindings semantics, not policy.
- Do not extract a production `BlobStore` interface, change `/v1/blobs` wire behavior, or move bytes out of SQLite.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Tests only. No production code changes. The harness exercises existing canonical query helpers (`blobsInsertBlob`, `blobsGetStoredById`, `blobsInsertBinding`) at the SQL helper level, mirroring the established record-read / lexical-retrieval pattern.
- Out of scope: changing `/v1/blobs`, splitting metadata from bytes, introducing object storage, hydrating Gmail or other connector attachments, modifying dashboard/sandbox.
