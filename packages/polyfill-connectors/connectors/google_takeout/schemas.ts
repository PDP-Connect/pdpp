// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Google Takeout stream records. Shape-check-before-emit
 * per docs/reference/connector-authoring-guide.md §3: a record that doesn't match
 * becomes a SKIP_RESULT instead of a RECORD, so the RS never receives
 * archive data that looks right but isn't.
 *
 * Ground truth: the record builders in parsers.ts (`buildLocationRecord`,
 * `buildWatchHistoryRecord`, `buildSearchRecord`) and the LocationRecord /
 * WatchHistoryRecord / SearchRecord interfaces in types.ts. Schemas here
 * mirror the *emitted* shapes, not the manifest's aspirational JSON Schema:
 *
 *   - `id` is a 24-hex-char sha256 slice (hashId in parsers.ts).
 *   - timestamps are ISO-8601 strings (`new Date(...).toISOString()` for
 *     location; the platform's own ISO `time` for watch/search history).
 *   - lat/lon/accuracy/velocity/altitude are raw Google numerics — accuracy
 *     and altitude are NOT integers (the manifest says integer for accuracy,
 *     but the parser passes the source value through unchanged, which is a
 *     float in practice), so they are validated as `number().nullable()`.
 *
 * Free-form text fields (query, titles, channel/product names) use
 * `pdppSafeText`; structural strings (ids, ISO timestamps, urls) use
 * regex / url validation.
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const RECORD_ID_RE = /^[0-9a-f]{24}$/; // hashId(): 24-hex sha256 slice
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const recordIdSchema = z.string().regex(RECORD_ID_RE, "id must be a 24-hex sha256 slice");
// Watch/search history timestamps are the platform's own ISO `time` value,
// passed through verbatim; accept any leading-ISO datetime string.
const isoTimestampSchema = z.string().regex(ISO_DT_RE, "must be an ISO-8601 datetime");
// Latitude/longitude after E7 scaling. Bounded to valid geographic ranges.
const latitudeSchema = z.number().min(-90).max(90).nullable();
const longitudeSchema = z.number().min(-180).max(180).nullable();
// accuracy/velocity/altitude are raw Google numerics — float-capable.
const sensorNumberSchema = z.number().nullable();

/**
 * location_history: one point per Google Maps Timeline record.
 * Cursor: timestamp (ISO).
 */
export const locationHistorySchema = z.object({
  id: recordIdSchema,
  timestamp: isoTimestampSchema,
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  accuracy_meters: sensorNumberSchema,
  activity_type: pdppSafeText.max(80).nullable(),
  velocity_mps: sensorNumberSchema,
  altitude_m: sensorNumberSchema,
});

/**
 * youtube_watch_history: one entry per watched video.
 * Cursor: watched_at (ISO).
 */
export const youtubeWatchHistorySchema = z.object({
  id: recordIdSchema,
  watched_at: isoTimestampSchema,
  video_url: z.url().max(4096).nullable(),
  video_title: pdppSafeText.max(2000).nullable(),
  channel_name: pdppSafeText.max(500).nullable(),
  channel_url: z.url().max(4096).nullable(),
});

/**
 * search_history: one entry per My Activity search row. `query` is the
 * title with the "Searched for " prefix stripped, so it may be empty
 * string (the parser does not null it) — allow min(0).
 * Cursor: timestamp (ISO).
 */
export const searchHistorySchema = z.object({
  id: recordIdSchema,
  timestamp: isoTimestampSchema,
  query: pdppSafeText.max(4000),
  product: pdppSafeText.max(200).nullable(),
});

/**
 * photos: one entry per distinct photo/video content-hash in the Google
 * Takeout Photos archive (Takeout duplicates a photo's bytes into every
 * album folder it belongs to; `id` is derived from content sha256, not
 * filename/path, so duplicate album copies collapse to one record).
 * Metadata parsed from sidecar .json files where present. Cursor: event_time
 * (ISO). blob_ref/content_sha256/size_bytes are null when hydration did not
 * happen (upload boundary unavailable, oversized file, or read failure);
 * hydration_status/hydration_error explain why without leaking a local path.
 */
const blobRefSchema = z.object({
  blob_id: z.string(),
  mime_type: z.string(),
  sha256: z.string(),
  size_bytes: z.number(),
});
const HYDRATION_STATUS_RE = /^(failed|hydrated|skipped_too_large|unavailable)$/;
const coverageStatusSchema = z.enum(["collected", "inventory_only", "excluded", "deferred", "missing", "unsupported"]);

export const photosSchema = z.object({
  id: recordIdSchema,
  filename: z.string().max(4096),
  event_time: isoTimestampSchema,
  title: pdppSafeText.max(2000).nullable(),
  description: pdppSafeText.max(4000).nullable(),
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  altitude: sensorNumberSchema,
  blob_ref: blobRefSchema.nullable(),
  content_sha256: z.string().nullable(),
  size_bytes: z.number().nullable(),
  hydration_status: z.string().regex(HYDRATION_STATUS_RE),
  hydration_error: pdppSafeText.max(240).nullable(),
});

export const coverageDiagnosticsSchema = z.object({
  id: pdppSafeText,
  store: pdppSafeText,
  stream: pdppSafeText.nullable(),
  status: coverageStatusSchema,
  reason: pdppSafeText.max(512),
});

/**
 * Stream → schema registry. Single source of truth for the streams this
 * connector emits.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  location_history: locationHistorySchema,
  youtube_watch_history: youtubeWatchHistorySchema,
  search_history: searchHistorySchema,
  photos: photosSchema,
  coverage_diagnostics: coverageDiagnosticsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
