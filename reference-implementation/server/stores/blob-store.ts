/**
 * Production `BlobStore` interface and storage-backed implementation.
 *
 * Semantic store seam for `GET /v1/blobs/:blob_id` visibility evaluation:
 * the route adapter and the canonical `rs.blobs.read` operation depend on
 * this interface rather than reaching into raw `blobs` / `blob_bindings`
 * SQLite rows or registry queries themselves. The interface speaks blob
 * lookup: `loadContentAddressedBlob` returns the row by id (or null);
 * `listBlobBindings` returns the union of `blob_bindings` rows and the
 * originating `blobs` row reduced to
 * `(connector_id, connector_instance_id, stream, record_key)`
 * tuples.
 *
 * Spec: openspec/changes/complete-reference-operation-refactor/specs/
 *       reference-implementation-architecture/spec.md
 */

import { getMany, getOne, referenceQueries } from "../../lib/db.ts";
import { postgresListBlobBindings, postgresLoadContentAddressedBlob } from "../postgres-records.js";
import { isPostgresStorageBackend } from "../postgres-storage.js";

/**
 * Row shape returned by `loadContentAddressedBlob`. The `data` field carries
 * the raw bytes; the route writes them inline in the response. All other
 * fields are denormalized from the originating ingest path.
 */
export interface BlobRow extends Record<string, unknown> {
  blob_id: string;
  connector_id: string;
  connector_instance_id: string;
  data: Buffer | Uint8Array | null;
  mime_type: string;
  record_key: string;
  sha256: string;
  size_bytes: number;
  stream: string;
}

/**
 * Binding tuple returned by `listBlobBindings`.
 */
export interface BlobBinding extends Record<string, unknown> {
  connector_id: string;
  connector_instance_id?: string | null;
  record_key: string;
  stream: string;
}

/**
 * Store methods resolve synchronously on the SQLite backend (bounded-statement
 * primitives return values directly) and asynchronously on the Postgres backend
 * (the `postgres-records` reads are `async`). Call sites `await` the result, so
 * both shapes are valid; the union captures that without changing runtime flow.
 */
type MaybeAsync<T> = T | Promise<T>;

export interface BlobStore {
  listBlobBindings(blobId: string, opts?: { limit?: number }): MaybeAsync<readonly BlobBinding[]>;
  loadContentAddressedBlob(blobId: string): MaybeAsync<BlobRow | null>;
}

/**
 * Default cap for `listBlobBindings`. Bindings per blob are domain-bounded
 * in practice (a content-addressed blob is referenced by the records that
 * emit those bytes — usually one, sometimes a small handful when the same
 * payload is shared across records). The cap is a defensive ceiling on the
 * `LIMIT ?` placeholder, not a paging boundary; if we ever need to page,
 * the call site should switch to a cursor-shaped read.
 */
const DEFAULT_BINDING_LIMIT = 1024;

/**
 * Construct the storage-backed `BlobStore`.
 *
 * No arguments: the underlying SQLite handle is owned by `server/db.js` and
 * the registry-bound query handles are owned by `server/queries/index.ts`.
 * The store calls into the bounded-statement primitives in `lib/db.ts`,
 * which is the only sanctioned path for production reads.
 */
export function createBlobStore(): BlobStore {
  if (isPostgresStorageBackend()) {
    return {
      loadContentAddressedBlob(blobId: string): MaybeAsync<BlobRow | null> {
        return postgresLoadContentAddressedBlob(blobId);
      },
      listBlobBindings(
        blobId: string,
        { limit = DEFAULT_BINDING_LIMIT }: { limit?: number } = {}
      ): MaybeAsync<readonly BlobBinding[]> {
        return postgresListBlobBindings(blobId, { limit });
      },
    };
  }

  return {
    loadContentAddressedBlob(blobId: string): BlobRow | null {
      const row = getOne<BlobRow>(referenceQueries.blobsGetRowById, [blobId]);
      return row ?? null;
    },
    listBlobBindings(
      blobId: string,
      { limit = DEFAULT_BINDING_LIMIT }: { limit?: number } = {}
    ): readonly BlobBinding[] {
      const { rows } = getMany<BlobBinding>(referenceQueries.blobsListBindingsById, [blobId, blobId], { limit });
      return rows;
    },
  };
}

export function createSqliteBlobStore(): BlobStore {
  return createBlobStore();
}
