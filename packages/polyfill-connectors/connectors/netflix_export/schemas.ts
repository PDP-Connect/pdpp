// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Netflix export stream records. Shape-check-before-emit
 * per docs/reference/connector-authoring-guide.md §3: a record that doesn't match
 * becomes a SKIP_RESULT instead of a RECORD, so the RS never receives
 * archive data that looks right but isn't.
 *
 * Ground truth: the record builders in parsers.ts (`buildViewingActivityRecord`)
 * and the ViewingActivityRecord interface in types.ts. Schemas here mirror
 * the *emitted* shapes:
 *
 *   - `id` is a 24-hex-char sha256 slice (hashId in parsers.ts).
 *   - `watched_at` is an ISO-8601 string parsed from Netflix's timestamp field.
 *   - `watch_duration_percent` is a number 0-100 or null.
 *   - Text fields use `pdppSafeText` (no PII exposure in diagnostics).
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const RECORD_ID_RE = /^[0-9a-f]{24}$/; // hashId(): 24-hex sha256 slice
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const recordIdSchema = z.string().regex(RECORD_ID_RE, "id must be a 24-hex sha256 slice");
const isoTimestampSchema = z.string().regex(ISO_DT_RE, "must be an ISO-8601 datetime");
const watchDurationPercentSchema = z.number().min(0).max(100).nullable();

/**
 * viewing_activity: one entry per Netflix viewing session.
 * Cursor: watched_at (ISO).
 */
export const viewingActivitySchema = z.object({
  id: recordIdSchema,
  title: pdppSafeText.max(500).nullable(),
  watched_at: isoTimestampSchema,
  device_type: pdppSafeText.max(100).nullable(),
  watch_duration_percent: watchDurationPercentSchema,
  profile_name: pdppSafeText.max(200).nullable(),
});

/**
 * Stream → schema registry. Single source of truth for the streams this
 * connector emits.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  viewing_activity: viewingActivitySchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
