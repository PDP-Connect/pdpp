// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the Apple Photos connector. Kept free of Node I/O beyond
// hashing so they can be unit-tested in isolation (see parsers.test.ts). The
// directory walker and hydration driver live in index.ts.

import { createHash } from "node:crypto";
import { extname } from "node:path";
import type { MediaHydrationResult } from "../../src/local-media-blob-hydration.ts";
import type { DiscoveredFile, PhotoRecordOut } from "./types.ts";

// Record ID length (hex). 24 chars = 96 bits of entropy — safe for a user's
// personal photo-library file set. Mirrors apple_health's hashId convention.
const RECORD_ID_HASH_LENGTH = 24;

// Extension → MIME type. Detection is by file extension only — this
// connector does not sniff magic bytes, so an unrecognized/renamed
// extension falls back to a generic octet-stream type.
const EXTENSION_MIME_MAP: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".gif": "image/gif",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".bmp": "image/bmp",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
};

const DEFAULT_MIME_TYPE = "application/octet-stream";

/** File extensions this connector will pick up when walking the export dir. */
export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(EXTENSION_MIME_MAP));

export function hashId(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, RECORD_ID_HASH_LENGTH);
}

/** Detects MIME type by file extension. Case-insensitive. */
export function detectMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return EXTENSION_MIME_MAP[ext] ?? DEFAULT_MIME_TYPE;
}

/**
 * Build a single `photos`-stream record from a discovered file and its
 * hydration result (bytes read/hashed/uploaded within the size cap — see
 * hydrateMediaBytes in src/local-media-blob-hydration.ts, shared with
 * google_takeout's photos stream).
 *
 * `id` is derived from content_sha256 ALONE (not filename/size/mtime) —
 * two files with byte-identical content (the same photo present in two
 * different Photos.app exports, or a re-export of the same album) collapse
 * to the same record id and the same underlying blob, so re-running this
 * connector against overlapping exports does not create duplicate photo
 * records or duplicate blob uploads. When content bytes could not be read
 * at all (hydration_status is "failed" with no contentSha256), the id falls
 * back to a filename+size+mtime identity so the file is still represented
 * rather than silently dropped — that fallback path cannot dedupe across
 * copies, which is an acceptable and expected consequence of not having
 * readable bytes to hash.
 *
 * No EXIF/XMP parsing is performed — taken_at, latitude, longitude,
 * camera_make, and camera_model are always null in this cut. See the header
 * comment in index.ts for why this is a bounded, explicit omission (no
 * EXIF-parsing dependency exists elsewhere in this package, and it was
 * judged out of scope for hand-rolling safely in a first pass) — this
 * connector does not and must not claim to reproduce full Apple Photos
 * metadata (people/album/face tags, edit history, EXIF/XMP), only what a
 * Photos.app "Export Unmodified Originals" run plus file-level metadata and
 * content hashing can honestly provide.
 */
export function buildPhotoRecord(
  file: DiscoveredFile,
  filename: string,
  hydration: MediaHydrationResult
): PhotoRecordOut {
  const contentSha256 = hydration.blobRef?.sha256 ?? hydration.contentSha256;
  const id = contentSha256
    ? hashId(`photo|${contentSha256}`)
    : hashId(`photo|${filename}|${file.sizeBytes}|${file.mtimeIso}`);
  return {
    blob_ref: hydration.blobRef,
    camera_make: null,
    camera_model: null,
    content_sha256: contentSha256,
    content_type: detectMimeType(filename),
    file_modified_at: file.mtimeIso,
    filename,
    hydration_error: hydration.hydrationError,
    hydration_status: hydration.hydrationStatus,
    id,
    latitude: null,
    longitude: null,
    size_bytes: hydration.blobRef?.size_bytes ?? hydration.sizeBytes,
    taken_at: null,
  };
}

// ─── Cursor / watermark helpers ────────────────────────────────────────

/**
 * Return true if `modifiedAt` falls on or before the incremental cursor
 * `since`. index.ts uses this to skip already-emitted files.
 */
export function isBeforeCursor(modifiedAt: string, since: string | undefined): boolean {
  return Boolean(since && modifiedAt <= since);
}

/** Monotonic max of an existing cursor and a new ISO date string. */
export function advanceCursor(prev: string | undefined, next: string): string {
  if (!prev || next > prev) {
    return next;
  }
  return prev;
}
