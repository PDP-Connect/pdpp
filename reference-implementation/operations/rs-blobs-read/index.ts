/**
 * Canonical `rs.blobs.read` operation.
 *
 * Owns the RS blob-read visibility semantics for `GET /v1/blobs/:blob_id`:
 *
 * - lookup the blob row by blob_id (`blob_not_found` when absent);
 * - enumerate the blob's bindings (the union of `blob_bindings` and the
 *   originating `blobs` row);
 * - for each binding whose connector matches the actor's resolved storage
 *   binding, attempt to read the bound record under the actor's grant;
 * - if any visible record exposes the requested blob via `data.blob_ref.blob_id`,
 *   return the blob row;
 * - otherwise raise `blob_not_found`.
 *
 * Per-binding visibility is preserved exactly: a blob is only readable when a
 * record the actor can see references it. The host adapter wires the actor's
 * `storageBinding` and `manifest`, and the per-binding `getVisibleRecord`
 * capability with the actor-appropriate grant already applied.
 *
 * Boundary rules:
 * - This module SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL
 *   handle, a generic repository, sandbox modules, the Fastify host module
 *   (`server/index.js`), the records module (`server/records.js`), or
 *   `process` / `process.env`.
 */

export interface BlobsReadBlobRow {
  readonly blob_id: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly data: Uint8Array | Buffer | null | undefined;
  readonly [extra: string]: unknown;
}

export interface BlobsReadBinding {
  readonly connector_id: string;
  readonly stream: string;
  readonly record_key: string;
}

export interface BlobsReadVisibleRecord {
  readonly data?: {
    readonly blob_ref?: {
      readonly blob_id?: string;
    } | null;
  } | null;
  readonly [extra: string]: unknown;
}

export interface BlobsReadDependencies {
  /** Look up the raw blob row by id. Returns null when the blob is absent. */
  loadBlob(blobId: string): BlobsReadBlobRow | null | Promise<BlobsReadBlobRow | null>;
  /** Enumerate bindings for the blob (union of blob_bindings and the originating blobs row). */
  loadBindings(blobId: string): readonly BlobsReadBinding[] | Promise<readonly BlobsReadBinding[]>;
  /**
   * Connector id of the actor's resolved storage binding. The operation only
   * inspects bindings whose `connector_id` matches this value. May be null
   * when no storage binding is resolved (e.g., misconfigured native scope);
   * in that case no binding can match and the operation raises `blob_not_found`.
   */
  getActorConnectorId(): string | null;
  /**
   * Read the bound record under the actor's grant. Hosts wire the existing
   * `getRecord(storageBinding, stream, recordKey, grant, manifest)` with
   * those bindings already applied. Throws are swallowed by the operation —
   * a single binding failure must not leak through other binding paths.
   */
  getVisibleRecord(binding: BlobsReadBinding): BlobsReadVisibleRecord | null | undefined | Promise<BlobsReadVisibleRecord | null | undefined>;
}

export interface BlobsReadInput {
  readonly blobId: string;
}

export interface BlobsReadOutput {
  readonly blob: BlobsReadBlobRow;
}

/**
 * Error thrown when the requested blob is absent or no visible record exposes
 * it under the actor's grant. The `code` matches the existing native error so
 * the host adapter emits a route-compatible response without translation.
 */
export class BlobsReadNotFoundError extends Error {
  readonly code: "blob_not_found";

  constructor(message = "Blob not found") {
    super(message);
    this.name = "BlobsReadNotFoundError";
    this.code = "blob_not_found";
  }
}

/**
 * Execute the canonical `rs.blobs.read` operation.
 *
 * Visibility ordering matches the previous native route. The operation does
 * not short-circuit on the first binding that matches the connector — it
 * continues iterating until a visible record exposes the requested blob.
 * Errors thrown by `getVisibleRecord` for one binding are swallowed so other
 * bindings can still satisfy the visibility check.
 */
export async function executeBlobsRead(
  input: BlobsReadInput,
  dependencies: BlobsReadDependencies,
): Promise<BlobsReadOutput> {
  const blob = await dependencies.loadBlob(input.blobId);
  if (!blob) {
    throw new BlobsReadNotFoundError();
  }

  const bindings = await dependencies.loadBindings(input.blobId);
  const actorConnectorId = dependencies.getActorConnectorId();

  for (const binding of bindings) {
    if (!actorConnectorId || binding.connector_id !== actorConnectorId) continue;
    let visibleRecord: BlobsReadVisibleRecord | null | undefined = null;
    try {
      visibleRecord = await dependencies.getVisibleRecord(binding);
    } catch {
      // Try the next binding; callers only learn whether any visible record
      // exposes the requested blob reference.
      continue;
    }
    if (visibleRecord?.data?.blob_ref?.blob_id === input.blobId) {
      return { blob };
    }
  }

  throw new BlobsReadNotFoundError();
}
