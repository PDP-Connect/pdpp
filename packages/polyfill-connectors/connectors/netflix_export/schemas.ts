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
 * the *emitted* shapes, honestly reflecting Netflix's two distinct CSV
 * schemas (direct_history vs full_export — see types.ts) rather than
 * pretending one unified shape with fabricated precision:
 *
 *   - `id` is a 24-hex-char sha256 slice (hashId in parsers.ts).
 *   - `watched_at` is an ISO-8601 string; `watched_at_precision` says whether
 *     it's a real instant ("instant", from full_export's Start Time (UTC))
 *     or midnight UTC of a calendar day only ("day", from direct_history's
 *     Date column — Netflix doesn't give us a time-of-day for that source).
 *   - `duration_seconds` is whole seconds from full_export's Duration
 *     (H:MM:SS) column, or null (direct_history never has a duration).
 *   - `watched_at_raw` preserves the original, unparsed date/timestamp
 *     string verbatim, for auditability of the (locale-dependent, for
 *     direct_history) date-order inference in parsers.ts.
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
const durationSecondsSchema = z.number().int().min(0).nullable();

/**
 * viewing_activity: one entry per Netflix viewing session.
 * Cursor: watched_at (ISO).
 */
export const viewingActivitySchema = z.object({
  id: recordIdSchema,
  title: pdppSafeText.max(500).nullable(),
  watched_at: isoTimestampSchema,
  watched_at_precision: z.enum(["day", "instant"]),
  watched_at_raw: pdppSafeText.max(100),
  device_type: pdppSafeText.max(100).nullable(),
  duration_seconds: durationSecondsSchema,
  profile_name: pdppSafeText.max(200).nullable(),
  country: pdppSafeText.max(100).nullable(),
  source_schema: z.enum(["direct_history", "full_export"]),
});

/**
 * Stream → schema registry. Single source of truth for the streams this
 * connector emits.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  viewing_activity: viewingActivitySchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
