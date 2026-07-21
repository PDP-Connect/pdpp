/**
 * Zod schemas for Strava stream records. Shape-check-before-emit per
 * docs/reference/connector-authoring-guide.md §3.
 *
 * Ground truth: the `toActivityRecord` builder in index.ts. Schema mirrors the
 * emitted shape:
 *
 *   - `id` is `String(a.id)` — Strava activity ids are numeric, so the id is a
 *     numeric string (NUMERIC_ID_RE).
 *   - `name` is the user-authored activity title → `pdppSafeText`.
 *   - `type` / `sport_type` are Strava's activity-type enums (e.g. "Run",
 *     "VirtualRide") and `timezone` is an Olson/offset label; all are short
 *     structural strings (bounded), not free-form human text.
 *   - Distances, times, speeds, elevation, heart rates are nullable numbers —
 *     left as `z.number()` (NOT `.int()`): Strava returns floats for distance,
 *     speed, and elevation; the builder passes them through.
 *   - Counts (kudos/comment/achievement) are nullable non-negative ints.
 *   - `start_latlng` / `end_latlng` are number arrays. Strava returns `[lat,
 *     lng]` for activities with GPS and `[]` (the builder's `|| []` fallback)
 *     otherwise — so the schema accepts a 0- or 2-element array of finite
 *     numbers.
 *   - `map_polyline` is Google's encoded-polyline string — an opaque encoded
 *     structural string, neither a URL nor human text; bounded plain string.
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const NUMERIC_ID_RE = /^\d{1,30}$/; // String(numeric Strava id)
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const metricSchema = z.number().nullable();
const countSchema = z.number().int().min(0).nullable();
// [lat, lng] when GPS present, [] otherwise (builder `|| []`). 0 or 2 elements.
const latlngSchema = z.array(z.number()).max(2);

/**
 * activities stream: one record per Strava athlete activity.
 * Cursor: last_start_epoch (derived from start_date).
 */
export const activitiesSchema = z.object({
  id: z.string().regex(NUMERIC_ID_RE, "id must be a numeric Strava activity id"),
  name: pdppSafeText.max(2000).nullable(),
  type: z.string().min(1).max(64).nullable(),
  sport_type: z.string().min(1).max(64).nullable(),
  start_date: z.string().regex(ISO_DT_RE, "start_date must be an ISO-8601 datetime"),
  start_date_local: z.string().regex(ISO_DT_RE, "start_date_local must be an ISO-8601 datetime").nullable(),
  timezone: z.string().min(1).max(128).nullable(),
  distance_m: metricSchema,
  moving_time_s: metricSchema,
  elapsed_time_s: metricSchema,
  total_elevation_gain_m: metricSchema,
  average_speed_mps: metricSchema,
  max_speed_mps: metricSchema,
  average_heartrate: metricSchema,
  max_heartrate: metricSchema,
  kudos_count: countSchema,
  comment_count: countSchema,
  achievement_count: countSchema,
  start_latlng: latlngSchema,
  end_latlng: latlngSchema,
  map_polyline: z.string().max(65_000).nullable(),
});

/**
 * Stream → schema registry. Single source of truth for emitted streams.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  activities: activitiesSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
