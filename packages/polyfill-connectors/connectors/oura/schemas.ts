/**
 * Zod schemas for Oura stream records. Shape-check-before-emit per
 * docs/reference/connector-authoring-guide.md §3.
 *
 * Ground truth: the `sleepRecord` / `readinessRecord` / `activityRecord`
 * builders in index.ts. Schemas mirror the *emitted* shape:
 *
 *   - `id` is the Oura document id — a UUID returned by the v2 API. Required
 *     (the builder reads `s.id` unconditionally).
 *   - `day` is the calendar date the document belongs to (`YYYY-MM-DD`); it is
 *     the cursor field, always present.
 *   - `bedtime_start` / `bedtime_end` are ISO-8601 datetimes (with offset) or
 *     null.
 *   - All physiological metrics are nullable numbers. They are NOT constrained
 *     to integers: Oura returns floats for HRV, efficiency, temperature deltas,
 *     and walking-equivalent distance, and the builder passes them through
 *     unchanged. Durations/steps/calories happen to arrive as integers but are
 *     left as `z.number()` to follow the passthrough rather than over-constrain.
 *   - `contributors` (readiness) is the raw Oura contributors object, an opaque
 *     provider map the builder forwards verbatim (`r.contributors ?? {}`). It
 *     is genuinely opaque key→score data, so it is typed as a record of
 *     numbers/nulls rather than enumerated — see note on the schema.
 *
 * No free-form human text fields exist on any Oura stream, so this module has
 * no `pdppSafeText` usage; every string is structurally constrained (UUID /
 * date / datetime).
 */

import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const ouraIdSchema = z.string().regex(UUID_RE, "id must be an Oura document UUID");
const daySchema = z.string().regex(DAY_RE, "day must be YYYY-MM-DD");
const isoDateTimeNullable = z.string().regex(ISO_DT_RE, "must be an ISO-8601 datetime").nullable();
// Physiological metrics: nullable floats. Oura returns floats for HRV /
// efficiency / temperature; do not force .int() (would reject real records).
const metricSchema = z.number().nullable();

/**
 * sleep stream: one record per nightly sleep session.
 * Cursor: day.
 */
export const sleepSchema = z.object({
  id: ouraIdSchema,
  day: daySchema,
  bedtime_start: isoDateTimeNullable,
  bedtime_end: isoDateTimeNullable,
  total_sleep_duration: metricSchema,
  rem_sleep_duration: metricSchema,
  deep_sleep_duration: metricSchema,
  light_sleep_duration: metricSchema,
  efficiency: metricSchema,
  latency: metricSchema,
  average_heart_rate: metricSchema,
  lowest_heart_rate: metricSchema,
  average_hrv: metricSchema,
  temperature_delta: metricSchema,
  sleep_score: metricSchema,
});

/**
 * readiness stream: one record per daily readiness document.
 * `contributors` is Oura's opaque contributors map (key → 0-100 sub-score).
 * The builder forwards it verbatim; we constrain values to nullable numbers
 * (their documented shape) without enumerating keys, since Oura adds/renames
 * contributors across firmware versions.
 */
export const readinessSchema = z.object({
  id: ouraIdSchema,
  day: daySchema,
  score: metricSchema,
  temperature_deviation: metricSchema,
  temperature_trend_deviation: metricSchema,
  contributors: z.record(z.string(), z.number().nullable()),
});

/**
 * activity stream: one record per daily activity document.
 * Cursor: day.
 */
export const activitySchema = z.object({
  id: ouraIdSchema,
  day: daySchema,
  score: metricSchema,
  active_calories: metricSchema,
  total_calories: metricSchema,
  steps: metricSchema,
  target_calories: metricSchema,
  equivalent_walking_distance: metricSchema,
});

/**
 * Stream → schema registry. Single source of truth for emitted streams.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  sleep: sleepSchema,
  readiness: readinessSchema,
  activity: activitySchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
