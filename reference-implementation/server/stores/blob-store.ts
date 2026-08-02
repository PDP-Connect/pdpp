// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Production `BlobStore` interface and storage-backed implementation.
 *
 * Semantic store seam for `GET /v1/blobs/:blob_id` visibility evaluation:
 * the route adapter and the canonical `rs.blobs.read` operation depend on
 * this interface rather than reaching into raw `blobs` / `blob_bindings`
 * SQLite rows or registry queries themselves. The interface speaks blob
 * lookup: `loadContentAddressedBlobMetadata` returns metadata by id without
 * selecting `data`; `loadContentAddressedBlob` returns the row by id (or null)
 * and can ask the backend for one byte range;
 * `listBlobBindings` returns the union of `blob_bindings` rows and the
 * originating `blobs` row reduced to
 * `(connector_id, connector_instance_id, stream, record_key)`
 * tuples.
 *
 * Spec: openspec/changes/complete-reference-operation-refactor/specs/
 *       reference-implementation-architecture/spec.md
 */

import { getMany, getOne, referenceQueries } from "../../lib/db.ts";
import {
  postgresListBlobBindings,
  postgresLoadContentAddressedBlob,
  postgresLoadContentAddressedBlobMetadata,
} from "../postgres-records.ts";
import { isPostgresStorageBackend } from "../postgres-storage.ts";

export interface BlobByteRange {
  end: number;
  start: number;
}

export interface BlobMetadata {
  blob_id: string;
  mime_type: string;
  sha256: string;
  size_bytes: number | string;
}

/**
 * Visibility cannot be proven when a bounded binding read overflows. This is
 * deliberately a distinct error instead of treating the bounded page as the
 * complete candidate set.
 */
export class BlobVisibilityIncompleteError extends Error {
  readonly code = "blob_visibility_incomplete";

  constructor() {
    super("Blob visibility could not be established completely.");
    this.name = "BlobVisibilityIncompleteError";
  }
}

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
  listBlobBindings: (blobId: string, opts?: { limit?: number }) => MaybeAsync<readonly BlobBinding[]>;
  loadContentAddressedBlob: (blobId: string, range?: BlobByteRange) => MaybeAsync<BlobRow | null>;
  loadContentAddressedBlobMetadata: (blobId: string) => MaybeAsync<BlobMetadata | null>;
}

/**
 * Default cap for `listBlobBindings`. This is a defensive bounded probe, not
 * a claim about the schema's maximum number of references. Both backends
 * fetch one extra row and fail closed when the probe overflows, so an
 * ambiguity/visibility decision is never made from a silently truncated set.
 */
const DEFAULT_BINDING_LIMIT = 1024;

function completeBindingPage(rows: readonly BlobBinding[], limit: number): readonly BlobBinding[] {
  if (rows.length > limit) {
    throw new BlobVisibilityIncompleteError();
  }
  return rows;
}

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
      listBlobBindings(
        blobId: string,
        { limit = DEFAULT_BINDING_LIMIT }: { limit?: number } = {}
      ): MaybeAsync<readonly BlobBinding[]> {
        return postgresListBlobBindings(blobId, { limit }).then((rows) =>
          completeBindingPage(rows as unknown as readonly BlobBinding[], limit)
        );
      },
      loadContentAddressedBlob(blobId: string, range?: BlobByteRange): MaybeAsync<BlobRow | null> {
        return postgresLoadContentAddressedBlob(blobId, range) as unknown as Promise<BlobRow | null>;
      },
      loadContentAddressedBlobMetadata(blobId: string): MaybeAsync<BlobMetadata | null> {
        return postgresLoadContentAddressedBlobMetadata(blobId) as unknown as Promise<BlobMetadata | null>;
      },
    };
  }

  return {
    listBlobBindings(
      blobId: string,
      { limit = DEFAULT_BINDING_LIMIT }: { limit?: number } = {}
    ): readonly BlobBinding[] {
      const page = getMany<BlobBinding>(referenceQueries.blobsListBindingsById, [blobId, blobId], { limit });
      if (page.truncated) {
        throw new BlobVisibilityIncompleteError();
      }
      return page.rows;
    },
    loadContentAddressedBlob(blobId: string, range?: BlobByteRange): BlobRow | null {
      const row = getOne<BlobRow>(
        range ? referenceQueries.blobsGetRowByRange : referenceQueries.blobsGetRowById,
        range ? [range.start + 1, range.end - range.start + 1, blobId] : [blobId]
      );
      return row ?? null;
    },
    loadContentAddressedBlobMetadata(blobId: string): BlobMetadata | null {
      const row = getOne<BlobMetadata>(referenceQueries.blobsGetStoredById, [blobId]);
      return row ?? null;
    },
  };
}

export function createSqliteBlobStore(): BlobStore {
  return createBlobStore();
}
