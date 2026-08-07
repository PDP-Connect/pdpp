// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared types for the Apple Photos connector. Kept out of index.ts so the
// pure parsers in parsers.ts can import them without pulling in the
// runtime entry point or the directory walker.

import type { MediaHydrationStatus, ReferenceBlobRef } from "../../src/local-media-blob-hydration.ts";

export interface ApplePhotosState {
  last_modified?: string;
}

/** A single file discovered under the export directory. */
export interface DiscoveredFile {
  /** mtime as an ISO-8601 datetime string. */
  mtimeIso: string;
  /** Absolute path on disk. */
  path: string;
  /** File size in bytes. */
  sizeBytes: number;
}

/**
 * Shape emitted on the `photos` stream. `id` is derived from content_sha256
 * alone (see parsers.ts buildPhotoRecord) so two files with identical bytes
 * — e.g. the same photo present in both an album export and a "Favorites"
 * export, or a duplicate Photos.app export run — collapse to the same
 * record id and the same blob, rather than being stored twice.
 */
export interface PhotoRecordOut {
  blob_ref: ReferenceBlobRef | null;
  camera_make: string | null;
  camera_model: string | null;
  content_sha256: string | null;
  content_type: string;
  file_modified_at: string;
  filename: string;
  hydration_error: string | null;
  hydration_status: MediaHydrationStatus;
  id: string;
  latitude: number | null;
  longitude: number | null;
  size_bytes: number | null;
  taken_at: string | null;
}
