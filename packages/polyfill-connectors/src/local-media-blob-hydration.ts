// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared local-media blob hydration: bounded local file read, content
 * hashing, MIME-by-extension guessing, and blob upload via the runtime's
 * reference-blob-uploader — extracted from google_takeout's photos stream so
 * every filesystem-bound connector emitting media bytes (google_takeout,
 * apple_photos, and future ones) hydrates through one code path rather than
 * re-implementing the same read/hash/upload/error-sanitize logic per
 * connector. Hydration status vocabulary and size-cap semantics originate
 * here; connector-specific record shape stays out of this module.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { ReferenceBlobRef } from "./reference-blob-uploader.ts";
import { makeReferenceBlobUploader, runtimeBlobUploadAvailable } from "./reference-blob-uploader.ts";

export type { ReferenceBlobRef } from "./reference-blob-uploader.ts";

// Same cap family as gmail's DEFAULT_MAX_ATTACHMENT_BYTES / iMessage's
// DEFAULT_MAX_ATTACHMENT_BYTES: bound local-file reads so one oversized item
// can't blow memory or dominate a run.
export const DEFAULT_MAX_MEDIA_BYTES = 25 * 1024 * 1024;
// Diagnostic text must never carry a local filesystem path or filename
// (standing PDPP PII rule: diagnostics carry hashed/structural info, not raw
// paths or user text).
const HYDRATION_ERROR_MAX_CHARS = 240;
const PATH_SHAPED_RE = /(?:[A-Za-z]:)?[/\\][^\s"']*/g;

const EXTENSION_MIME_MAP: readonly [string, string][] = [
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
  [".webp", "image/webp"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
  [".mts", "video/mp2t"],
  [".m4v", "video/x-m4v"],
  [".3gp", "video/3gpp"],
  [".3g2", "video/3gpp2"],
  [".wmv", "video/x-ms-wmv"],
  [".avi", "video/x-msvideo"],
  [".mkv", "video/x-matroska"],
  [".flv", "video/x-flv"],
  [".webm", "video/webm"],
];

/** Guesses a MIME type from a filename's extension; unknown extensions fall back to a generic binary type. */
export function contentTypeForFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  for (const [ext, mime] of EXTENSION_MIME_MAP) {
    if (lower.endsWith(ext)) {
      return mime;
    }
  }
  return "application/octet-stream";
}

/** Strips path-shaped substrings and caps length so a diagnostic never leaks a local filesystem location. */
export function sanitizeHydrationError(message: string): string {
  const noPaths = message.replace(PATH_SHAPED_RE, "<path>");
  return noPaths.slice(0, HYDRATION_ERROR_MAX_CHARS);
}

export function resolveMaxMediaBytes(envVar: string, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[envVar];
  if (!raw) {
    return DEFAULT_MAX_MEDIA_BYTES;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_MEDIA_BYTES;
}

/**
 * Reads a media file's bytes bounded by maxBytes. Stats first so an
 * oversized file is never fully read into memory; only files at or under the
 * cap are hashed and returned.
 */
export async function readBoundedMediaBytes(
  path: string,
  maxBytes: number
): Promise<{ bytes: Buffer | null; sizeBytes: number; tooLarge: boolean }> {
  const stats = await stat(path);
  if (stats.size > maxBytes) {
    return { bytes: null, sizeBytes: stats.size, tooLarge: true };
  }
  const bytes = await readFile(path);
  return { bytes, sizeBytes: bytes.byteLength, tooLarge: false };
}

export function uploadMediaBlob(args: {
  bytes: Buffer;
  connectorId: string;
  mimeType: string;
  recordKey: string;
  stream: string;
}): Promise<ReferenceBlobRef | null> {
  const rsUrl = process.env.PDPP_RS_URL || process.env.RS_URL;
  const ownerToken = process.env.PDPP_OWNER_TOKEN;
  if (!(runtimeBlobUploadAvailable(process.env) && rsUrl && ownerToken)) {
    return Promise.resolve(null);
  }
  const uploader = makeReferenceBlobUploader({
    connectorInstanceId: process.env.PDPP_CONNECTOR_INSTANCE_ID || null,
    ownerToken,
    rsUrl,
  });
  return uploader({
    connectorId: args.connectorId,
    content: [args.bytes],
    mimeType: args.mimeType,
    recordKey: args.recordKey,
    stream: args.stream,
  });
}

export type MediaHydrationStatus = "failed" | "hydrated" | "skipped_too_large" | "unavailable";

export interface MediaHydrationResult {
  blobRef: ReferenceBlobRef | null;
  contentSha256: string | null;
  hydrationError: string | null;
  hydrationStatus: MediaHydrationStatus;
  sizeBytes: number | null;
}

/**
 * Read, hash, and attempt blob upload for a local media file within the size
 * cap. Never throws — unreadable/oversized files return a hydration_status
 * describing why bytes are absent, so a caller's stream never fabricates a
 * deletion or silently drops a discovered file.
 */
export async function hydrateMediaBytes(args: {
  connectorId: string;
  filePath: string;
  fileName: string;
  maxBytes: number;
  stream: string;
}): Promise<MediaHydrationResult> {
  try {
    const { bytes, sizeBytes, tooLarge } = await readBoundedMediaBytes(args.filePath, args.maxBytes);
    if (tooLarge || !bytes) {
      return {
        blobRef: null,
        contentSha256: null,
        hydrationError: null,
        hydrationStatus: "skipped_too_large",
        sizeBytes,
      };
    }
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    try {
      const blobRef = await uploadMediaBlob({
        bytes,
        connectorId: args.connectorId,
        mimeType: contentTypeForFileName(args.fileName),
        recordKey: contentSha256,
        stream: args.stream,
      });
      return {
        blobRef,
        contentSha256,
        hydrationError: null,
        hydrationStatus: blobRef ? "hydrated" : "unavailable",
        sizeBytes,
      };
    } catch (err) {
      return {
        blobRef: null,
        contentSha256,
        hydrationError: sanitizeHydrationError(err instanceof Error ? err.message : String(err)),
        hydrationStatus: "failed",
        sizeBytes,
      };
    }
  } catch (err) {
    return {
      blobRef: null,
      contentSha256: null,
      hydrationError: sanitizeHydrationError(err instanceof Error ? err.message : String(err)),
      hydrationStatus: "failed",
      sizeBytes: null,
    };
  }
}
