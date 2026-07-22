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
  const failDigest = (reason: unknown): void => {
    if (settled) {
      return;
    }
    settled = true;
    rejectDigest(reason);
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
        failDigest(err);
        controller.error(err);
      }
    },
    async cancel(reason) {
      failDigest(reason);
      if (typeof iterator.return === "function") {
        await iterator.return();
      }
    },
  });
  return { body, digest };
}

export function runtimeBlobUploadAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean((env.PDPP_RS_URL || env.RS_URL) && env.PDPP_OWNER_TOKEN);
}

export function makeReferenceBlobUploader(args: {
  connectorInstanceId?: string | null;
  ownerToken: string;
  rsUrl: string;
}): ReferenceBlobUploadFn {
  return async ({ connectorId, connectorInstanceId, content, mimeType, recordKey, stream }) => {
    const upload = createHashingUploadBody(content);
    const requestInit: StreamingRequestInit = {
      body: upload.body,
      duplex: "half",
      headers: {
        Authorization: `Bearer ${args.ownerToken}`,
        "Content-Type": mimeType,
      },
      method: "POST",
    };
    const response = await fetch(
      makeBlobUploadUrl({
        connectorId,
        connectorInstanceId: connectorInstanceId ?? args.connectorInstanceId ?? null,
        recordKey,
        rsUrl: args.rsUrl,
        stream,
      }),
      requestInit
    );
    const body = (await response.json().catch((): unknown => null)) as unknown;
    if (!response.ok) {
      const message =
        body && typeof body === "object" && !Array.isArray(body)
          ? String((body as Record<string, unknown>).error ?? response.statusText)
          : response.statusText;
      throw new Error(`blob upload failed (${response.status}): ${message}`);
    }
    if (!isBlobUploadResponse(body)) {
      throw new Error("blob upload returned an invalid response");
    }
    const localHash = await upload.digest;
    if (body.sha256 !== localHash.sha256 || body.size_bytes !== localHash.sizeBytes) {
      throw new Error("blob upload hash/size mismatch");
    }
    return {
      blob_id: body.blob_id,
      mime_type: body.mime_type,
      sha256: body.sha256,
      size_bytes: body.size_bytes,
    };
  };
}
