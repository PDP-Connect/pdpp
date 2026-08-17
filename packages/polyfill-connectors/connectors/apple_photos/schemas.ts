// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Apple Photos stream records. Shape-check-before-emit per
 * docs/reference/connector-authoring-guide.md §3.
 *
 * Ground truth: `buildPhotoRecord` in parsers.ts — the only thing index.ts
 * passes to `emitRecord(...)`. Schemas mirror the *emitted* shape:
 *
 *   - `id` is `hashId(...)` → a 24-char lowercase hex digest (sha256 slice),
 *     same convention as apple_health. Derived from content_sha256 alone
 *     when bytes were readable (so duplicate copies across exports/albums
 *     dedupe to one record), falling back to a filename+size+mtime identity
 *     when hydration failed and no content hash exists.
 *   - `filename` is the basename of the exported file — a filesystem name
 *     the user chose/exported, so it goes through `pdppSafeText` rather
 *     than a bare `z.string()`.
 *   - `content_type` is a MIME type derived from the file extension (a
 *     structural token, not free text) — bounded `z.string()`.
 *   - `content_sha256`/`size_bytes` are nullable: null when hydration did
 *     not produce readable bytes (skipped_too_large or failed).
 *     hydration_status/hydration_error explain why, mirroring
 *     google_takeout's photos-stream shape and shared hydration module.
 *   - `blob_ref` is set when the runtime's blob-upload bindings are
 *     available and the upload succeeded; null otherwise (deferred/no
 *     upload target configured/failed).
 *   - `file_modified_at` is the file's mtime, ISO-8601. This is the cursor
 *     field (`last_modified` in state).
 *   - `taken_at`, `latitude`, `longitude`, `camera_make`, `camera_model`
 *     are always null in this cut — no EXIF/XMP parsing is implemented
 *     (see index.ts header comment). The fields exist in the schema so a
 *     future EXIF pass can populate them without a schema migration.
 */

import { pdppSafeText } from "@pdpp/collector-runtime/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const APPLE_PHOTOS_ID_RE = /^[0-9a-f]{24}$/; // hashId: 24-char sha256 hex slice
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
// isoDate-style ISO-8601 datetime (toISOString() shape).
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const HYDRATION_STATUS_RE = /^(failed|hydrated|skipped_too_large|unavailable)$/;

const applePhotosIdSchema = z.string().regex(APPLE_PHOTOS_ID_RE, "must be a 24-char hex Apple Photos record id");
const sha256HexSchema = z.string().regex(SHA256_HEX_RE, "must be a 64-char hex sha256 digest");
const isoDateTimeSchema = z.string().regex(ISO_DT_RE, "must be an ISO-8601 datetime");

const blobRefSchema = z
  .object({
    blob_id: z.string().min(1),
    mime_type: z.string().min(1),
    sha256: sha256HexSchema,
    size_bytes: z.number().int().min(0),
  })
  .nullable();

/**
 * photos stream: one record per discovered image/video file found under
 * APPLE_PHOTOS_EXPORT_DIR. Cursor: file_modified_at (last_modified).
 */
export const photosSchema = z.object({
  id: applePhotosIdSchema,
  filename: pdppSafeText.max(1024),
  content_type: z.string().min(1).max(200),
  size_bytes: z.number().int().min(0).nullable(),
  content_sha256: sha256HexSchema.nullable(),
  hydration_status: z.string().regex(HYDRATION_STATUS_RE),
  hydration_error: pdppSafeText.max(240).nullable(),
  blob_ref: blobRefSchema,
  taken_at: isoDateTimeSchema.nullable(),
  file_modified_at: isoDateTimeSchema,
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  camera_make: z.string().min(1).max(200).nullable(),
  camera_model: z.string().min(1).max(200).nullable(),
});

const coverageStatusSchema = z.enum(["collected", "inventory_only", "excluded", "deferred", "missing", "unsupported"]);

/**
 * coverage_diagnostics stream: one row per known local store (currently just
 * "export_dir") reporting whether it exists and is being collected. Shared
 * shape with claude_code/codex's coverage_diagnostics — see
 * src/local-source-inventory.ts's buildLocalSourceInventory, the emitter
 * both this connector and those use.
 */
export const coverageDiagnosticsSchema = z.object({
  id: pdppSafeText,
  store: pdppSafeText,
  stream: pdppSafeText.nullable(),
  status: coverageStatusSchema,
  reason: pdppSafeText.max(512),
});

/**
 * Stream → schema registry. Single source of truth for emitted streams.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  photos: photosSchema,
  coverage_diagnostics: coverageDiagnosticsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
