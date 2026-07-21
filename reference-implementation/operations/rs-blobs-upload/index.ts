// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `rs.blobs.upload` operation.
 *
 * Owns the RS blob-upload semantics for `POST /v1/blobs`: query parameter
 * normalization (connector_id / stream / record_key), Content-Type
 * normalization, body-to-bytes coercion, manifest stream visibility, and the
 * `{ object: 'blob', blob_id, sha256, size_bytes, mime_type }` response
 * envelope. The Fastify host adapter wires auth, request id / trace id, the
 * concrete `persistBlob` capability (content-addressed write + binding insert
 * inside a transaction), and response writing.
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL
 *   handle, a generic repository, sandbox modules, the Fastify host module
 *   (`server/index.js`), the records module (`server/records.js`), or
 *   `process` / `process.env`.
 * - The persist capability flows in through dependencies; the host wires the
 *   existing `persistContentAddressedBlob` from `server/index.js`. Atomicity
 *   (blob row + binding insert under one transaction) remains the host
 *   capability's responsibility.
 */

export interface BlobsUploadRequestParams {
  readonly connector_id?: unknown;
  readonly stream?: unknown;
  readonly record_key?: unknown;
}

export interface BlobsUploadInput {
  /** Raw query parameters as received by the host. */
  readonly requestParams: BlobsUploadRequestParams;
  /** Raw `Content-Type` header value as received by the host. */
  readonly contentType: unknown;
  /** Raw request body as received by the host (Buffer / string / typed array). */
  readonly body: unknown;
}

export interface BlobsUploadPersistArgs {
  readonly connectorId: string;
  readonly stream: string;
  readonly recordKey: string;
  readonly mimeType: string;
  readonly data: Uint8Array;
}

export interface BlobsUploadPersistResult {
  readonly blob_id: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly mime_type: string;
}

export interface BlobsUploadDependencies {
  /**
   * Manifest visibility check. Returns true when the connector manifest
   * declares the named stream. Hosts wire the existing
   * `resolveRegisteredConnectorManifest(connectorId).streams[*].name` lookup.
   */
  hasManifestStream(connectorId: string, streamName: string): boolean | Promise<boolean>;
  /**
   * Persist the upload. Hosts wire the existing
   * `persistContentAddressedBlob`, which performs the content-addressed write
   * and the binding insert inside one transaction.
   */
  persistBlob(args: BlobsUploadPersistArgs): BlobsUploadPersistResult | Promise<BlobsUploadPersistResult>;
}

export interface BlobsUploadOutput {
  readonly envelope: {
    readonly object: "blob";
    readonly blob_id: string;
    readonly sha256: string;
    readonly size_bytes: number;
    readonly mime_type: string;
  };
}

/**
 * Error thrown when the manifest does not declare the requested stream. The
 * `code` matches the existing native error so the host adapter emits a
 * route-compatible response without translation.
 */
export class BlobsUploadStreamNotFoundError extends Error {
  readonly code: "not_found";

  constructor(message: string) {
    super(message);
    this.name = "BlobsUploadStreamNotFoundError";
    this.code = "not_found";
  }
}

/**
 * Error thrown for invalid request inputs (missing/invalid query params,
 * Content-Type header, or body). The `code` matches the existing native error
 * envelope so the host adapter emits a route-compatible 400 response.
 */
export class BlobsUploadInvalidRequestError extends Error {
  readonly code: "invalid_request";

  constructor(message: string) {
    super(message);
    this.name = "BlobsUploadInvalidRequestError";
    this.code = "invalid_request";
  }
}

function readSingleNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BlobsUploadInvalidRequestError(
      `${name} must be a single non-empty string`,
    );
  }
  return value.trim();
}

const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

function readContentType(value: unknown): string {
  if (typeof value !== "string") {
    throw new BlobsUploadInvalidRequestError(
      "Content-Type header is required",
    );
  }
  const mediaType = (value.split(";")[0] ?? "").trim().toLowerCase();
  if (!mediaType || !MEDIA_TYPE_PATTERN.test(mediaType)) {
    throw new BlobsUploadInvalidRequestError(
      "Content-Type header must be a valid media type",
    );
  }
  return mediaType;
}

function coerceBodyToBytes(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body === undefined || body === null) return new Uint8Array(0);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new BlobsUploadInvalidRequestError("Blob upload body must be bytes");
}

/**
 * Execute the canonical `rs.blobs.upload` operation.
 *
 * Order matches the previous native route:
 *   1. parse query params (connector_id, stream, record_key) — invalid_request.
 *   2. parse Content-Type header — invalid_request.
 *   3. resolve manifest stream — not_found if missing.
 *   4. coerce body to bytes — invalid_request on unsupported shapes.
 *   5. persist (host capability owns transactional atomicity).
 *   6. return the `{ object: 'blob', ... }` envelope.
 */
export async function executeBlobsUpload(
  input: BlobsUploadInput,
  dependencies: BlobsUploadDependencies,
): Promise<BlobsUploadOutput> {
  const connectorId = readSingleNonEmptyString(
    input.requestParams.connector_id,
    "connector_id",
  );
  const stream = readSingleNonEmptyString(input.requestParams.stream, "stream");
  const recordKey = readSingleNonEmptyString(
    input.requestParams.record_key,
    "record_key",
  );
  const mimeType = readContentType(input.contentType);

  const visible = await dependencies.hasManifestStream(connectorId, stream);
  if (!visible) {
    throw new BlobsUploadStreamNotFoundError(
      `Stream '${stream}' not found for connector ${connectorId}`,
    );
  }

  const data = coerceBodyToBytes(input.body);

  const result = await dependencies.persistBlob({
    connectorId,
    stream,
    recordKey,
    mimeType,
    data,
  });

  return {
    envelope: {
      object: "blob",
      blob_id: result.blob_id,
      sha256: result.sha256,
      size_bytes: result.size_bytes,
      mime_type: result.mime_type,
    },
  };
}
