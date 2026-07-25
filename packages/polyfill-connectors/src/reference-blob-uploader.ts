// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export interface ReferenceBlobRef {
  blob_id: string;
  mime_type: string;
  sha256: string;
  size_bytes: number;
}

export type ReferenceBlobUploadContent =
  | AsyncIterable<Buffer | Uint8Array | string>
  | Iterable<Buffer | Uint8Array | string>;

export type ReferenceBlobUploadFn = (args: {
  connectorId: string;
  connectorInstanceId?: string | null;
  content: ReferenceBlobUploadContent;
  mimeType: string;
  recordKey: string;
  stream: string;
}) => Promise<ReferenceBlobRef>;

/**
 * Sanitized failure classes from the blob-upload boundary. The class carries
 * only the operation family; callers must not retain a status, URL, or body
 * as telemetry.
 */
export type ReferenceBlobUploadFailureKind =
  | "http_4xx"
  | "http_5xx"
  | "integrity_mismatch"
  | "invalid_response"
  | "source_content_failed"
  | "transport";

export class ReferenceBlobUploadFailure extends Error {
  readonly kind: ReferenceBlobUploadFailureKind;

  constructor(kind: ReferenceBlobUploadFailureKind, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ReferenceBlobUploadFailure";
    this.kind = kind;
  }
}

interface BlobUploadResponse {
  blob_id: string;
  mime_type: string;
  object: "blob";
  sha256: string;
  size_bytes: number;
}

interface HashingUploadBody {
  body: ReadableStream<Uint8Array>;
  digest: Promise<{ sha256: string; sizeBytes: number }>;
  sourceFailure: () => { failed: boolean; reason: unknown };
}

interface StreamingRequestInit extends Omit<RequestInit, "body"> {
  body: ReadableStream<Uint8Array>;
  duplex: "half";
}

function isBlobUploadResponse(value: unknown): value is BlobUploadResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.object === "blob" &&
    typeof record.blob_id === "string" &&
    typeof record.mime_type === "string" &&
    typeof record.sha256 === "string" &&
    typeof record.size_bytes === "number"
  );
}

function makeBlobUploadUrl(args: {
  connectorId: string;
  connectorInstanceId?: string | null;
  recordKey: string;
  rsUrl: string;
  stream: string;
}): URL {
  const url = new URL("/v1/blobs", args.rsUrl);
  url.searchParams.set("connector_id", args.connectorId);
  if (args.connectorInstanceId) {
    url.searchParams.set("connector_instance_id", args.connectorInstanceId);
  }
  url.searchParams.set("stream", args.stream);
  url.searchParams.set("record_key", args.recordKey);
  return url;
}

function toUploadChunk(chunk: Buffer | Uint8Array | string): Uint8Array {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function getUploadIterator(content: ReferenceBlobUploadContent): AsyncIterator<Buffer | Uint8Array | string> {
  if (Symbol.asyncIterator in content) {
    return content[Symbol.asyncIterator]();
  }
  const iterator = content[Symbol.iterator]();
  return {
    next: () => Promise.resolve(iterator.next()),
    return: (value?: unknown) => {
      if (typeof iterator.return === "function") {
        return Promise.resolve(iterator.return(value as never));
      }
      return Promise.resolve({ done: true, value: value as Buffer | Uint8Array | string });
    },
  };
}

function createHashingUploadBody(content: ReferenceBlobUploadContent): HashingUploadBody {
  const hash = createHash("sha256");
  const iterator = getUploadIterator(content);
  let sizeBytes = 0;
  let settled = false;
  let sourceFailure: unknown;
  let sourceFailed = false;
  let resolveDigest: (value: { sha256: string; sizeBytes: number }) => void = () => undefined;
  let rejectDigest: (reason?: unknown) => void = () => undefined;
  const digest = new Promise<{ sha256: string; sizeBytes: number }>((resolve, reject) => {
    resolveDigest = resolve;
    rejectDigest = reject;
  });
  const settleDigest = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    resolveDigest({ sha256: hash.digest("hex"), sizeBytes });
  };
  const failSourceDigest = (reason: unknown): void => {
    if (settled) {
      return;
    }
    settled = true;
    sourceFailed = true;
    sourceFailure = reason;
    rejectDigest(reason);
  };
  const failTransportDigest = (reason: unknown): void => {
    if (settled) {
      return;
    }
    settled = true;
    rejectDigest(new ReferenceBlobUploadFailure("transport", errorMessage(reason), reason));
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          settleDigest();
          controller.close();
          return;
        }
        const chunk = toUploadChunk(next.value);
        hash.update(chunk);
        sizeBytes += chunk.byteLength;
        controller.enqueue(chunk);
      } catch (err) {
        failSourceDigest(err);
        controller.error(err);
      }
    },
    async cancel(reason) {
      // A cancelled request never represents a complete upload, even when a
      // fetch implementation later returns a matching partial 2xx response.
      failTransportDigest(reason);
      if (typeof iterator.return === "function") {
        try {
          await iterator.return();
        } catch {
          // A consumer cancelled the upload. Its teardown must not be
          // represented as a source download failure.
        }
      }
    },
  });
  // The uploader may return on fetch rejection before awaiting this promise.
  // Attach an observer now so a later source-pull rejection is never unhandled.
  digest.catch(() => undefined);
  return { body, digest, sourceFailure: () => ({ failed: sourceFailed, reason: sourceFailure }) };
}

function hasMatchingCause(err: unknown, cause: unknown): boolean {
  if (err === cause) {
    return true;
  }
  return err instanceof Error && err.cause === cause;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function uploadRequestInit(ownerToken: string, mimeType: string, upload: HashingUploadBody): StreamingRequestInit {
  return {
    body: upload.body,
    duplex: "half",
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "Content-Type": mimeType,
    },
    method: "POST",
  };
}

function httpFailureKind(status: number): ReferenceBlobUploadFailureKind {
  if (status >= 400 && status < 500) {
    return "http_4xx";
  }
  if (status >= 500 && status < 600) {
    return "http_5xx";
  }
  return "transport";
}

async function fetchUploadResponse(args: {
  fetchFn: typeof fetch;
  requestInit: StreamingRequestInit;
  upload: HashingUploadBody;
  url: URL;
}): Promise<Response> {
  try {
    return await args.fetchFn(args.url, args.requestInit);
  } catch (err) {
    const sourceFailure = args.upload.sourceFailure();
    if (sourceFailure.failed && hasMatchingCause(err, sourceFailure.reason)) {
      // biome-ignore lint/style/useErrorCause: ReferenceBlobUploadFailure's 3rd constructor arg forwards to super(message, { cause })
      throw new ReferenceBlobUploadFailure(
        "source_content_failed",
        errorMessage(sourceFailure.reason),
        sourceFailure.reason
      );
    }
    // biome-ignore lint/style/useErrorCause: ReferenceBlobUploadFailure's 3rd constructor arg forwards to super(message, { cause })
    throw new ReferenceBlobUploadFailure("transport", errorMessage(err), err);
  }
}

async function validatedBlobUploadResponse(response: Response, upload: HashingUploadBody): Promise<ReferenceBlobRef> {
  const body = (await response.json().catch((): unknown => null)) as unknown;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && !Array.isArray(body)
        ? String((body as Record<string, unknown>).error ?? response.statusText)
        : response.statusText;
    throw new ReferenceBlobUploadFailure(
      httpFailureKind(response.status),
      `blob upload failed (${response.status}): ${message}`
    );
  }
  if (!isBlobUploadResponse(body)) {
    throw new ReferenceBlobUploadFailure("invalid_response", "blob upload returned an invalid response");
  }
  let localHash: { sha256: string; sizeBytes: number };
  try {
    localHash = await upload.digest;
  } catch (err) {
    if (err instanceof ReferenceBlobUploadFailure) {
      throw err;
    }
    // biome-ignore lint/style/useErrorCause: ReferenceBlobUploadFailure's 3rd constructor arg forwards to super(message, { cause })
    throw new ReferenceBlobUploadFailure("source_content_failed", errorMessage(err), err);
  }
  if (body.sha256 !== localHash.sha256 || body.size_bytes !== localHash.sizeBytes) {
    throw new ReferenceBlobUploadFailure("integrity_mismatch", "blob upload hash/size mismatch");
  }
  return {
    blob_id: body.blob_id,
    mime_type: body.mime_type,
    sha256: body.sha256,
    size_bytes: body.size_bytes,
  };
}

export function runtimeBlobUploadAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean((env.PDPP_RS_URL || env.RS_URL) && env.PDPP_OWNER_TOKEN);
}

export function makeReferenceBlobUploader(args: {
  connectorInstanceId?: string | null;
  fetchFn?: typeof fetch;
  ownerToken: string;
  rsUrl: string;
}): ReferenceBlobUploadFn {
  return async ({ connectorId, connectorInstanceId, content, mimeType, recordKey, stream }) => {
    const upload = createHashingUploadBody(content);
    const response = await fetchUploadResponse({
      fetchFn: args.fetchFn ?? fetch,
      requestInit: uploadRequestInit(args.ownerToken, mimeType, upload),
      upload,
      url: makeBlobUploadUrl({
        connectorId,
        connectorInstanceId: connectorInstanceId ?? args.connectorInstanceId ?? null,
        recordKey,
        rsUrl: args.rsUrl,
        stream,
      }),
    });
    return validatedBlobUploadResponse(response, upload);
  };
}
