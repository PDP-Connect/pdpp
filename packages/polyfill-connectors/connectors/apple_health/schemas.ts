// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Apple Health stream records. Shape-check-before-emit per
 * docs/reference/connector-authoring-guide.md §3.
 *
 * Ground truth: `buildHealthRecord` (records) and `buildWorkoutRecord`
 * (workouts) in parsers.ts — the only things index.ts passes to
 * `emitRecord(...)`. Schemas mirror the *emitted* shape, not the manifest:
 *
 *   - `id` is `hashId(...)` → a 24-char lowercase hex digest (sha256 sliced).
 *   - `start_date` / `end_date` come from `isoDate`, which is
 *     `new Date(v).toISOString()` → always `...T..:..:...sssZ`. The schema
 *     accepts that via an ISO-prefix regex.
 *   - `type` (records) is `healthTypeShort(...)` — the HK identifier with its
 *     `HKQuantityTypeIdentifier` / `HKCategoryTypeIdentifier` / `HKDataType`
 *     prefix stripped (e.g. `StepCount`, `HeartRate`). Defaults to the raw type
 *     or `"Unknown"` when absent, so it is always a non-empty structural token,
 *     NOT free-form human text. Required by the manifest.
 *   - `workout_activity_type` (workouts) is the HKWorkoutActivityType with its
 *     prefix stripped (e.g. `Running`), or null. Structural token, nullable.
 *   - `value` is `Number(attrs.value)` only when finite; otherwise null. It is
 *     FLOAT-CAPABLE (heart rate, body mass, etc. are non-integers) and is
 *     `z.number().nullable()`, NOT `.int()`. `value_raw` carries the original
 *     non-numeric string (e.g. a category value like `HKCategoryValueSleep...`)
 *     when `value` could not be parsed — a structural HK token, bounded string.
 *   - `unit` / `source_name` / `source_version` are short device/app metadata
 *     strings (`mg/dL`, `Apple Watch`, `10.1`), nullable structural strings.
 *   - workout numerics (`duration_minutes`, `total_energy_burned_kcal`,
 *     `total_distance_km`) are `Number(...)` passthroughs → float-capable,
 *     non-negative, nullable.
 *
 * `source_name` is device/app provenance, not free human prose, so it is a
 * bounded `z.string()` rather than `pdppSafeText`. Apple Health records carry
 * no free-form user text fields — every string is a structural HK token or a
 * device/app identifier.
 */

import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const APPLE_HEALTH_ID_RE = /^[0-9a-f]{24}$/; // hashId: 24-char sha256 hex slice
// isoDate => new Date(v).toISOString() => always ...T..:..:...sssZ.
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const appleHealthIdSchema = z.string().regex(APPLE_HEALTH_ID_RE, "must be a 24-char hex Apple Health record id");
const isoDateTimeSchema = z.string().regex(ISO_DT_RE, "must be an ISO-8601 datetime");

/**
 * records stream: one record per HKRecord element with a parseable startDate.
 * Cursor: start_date (last_start_date).
 */
export const recordsSchema = z.object({
  id: appleHealthIdSchema,
  type: z.string().min(1).max(200),
  source_name: z.string().min(1).max(500).nullable(),
  source_version: z.string().min(1).max(200).nullable(),
  unit: z.string().min(1).max(100).nullable(),
  // float-capable (heart rate, body mass, etc.) — not .int(). zod's z.number()
  // already rejects NaN/Infinity, matching the builder's `Number.isFinite` gate.
  value: z.number().nullable(),
  value_raw: z.string().min(1).max(500).nullable(),
  start_date: isoDateTimeSchema,
  end_date: isoDateTimeSchema.nullable(),
});

/**
 * workouts stream: one record per HKWorkout element with a parseable startDate.
 * Cursor: start_date (last_start_date).
 */
export const workoutsSchema = z.object({
  id: appleHealthIdSchema,
  workout_activity_type: z.string().min(1).max(200).nullable(),
  duration_minutes: z.number().min(0).nullable(),
  total_energy_burned_kcal: z.number().min(0).nullable(),
  total_distance_km: z.number().min(0).nullable(),
  source_name: z.string().min(1).max(500).nullable(),
  start_date: isoDateTimeSchema,
  end_date: isoDateTimeSchema.nullable(),
});

/**
 * Stream → schema registry. Single source of truth for emitted streams.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  records: recordsSchema,
  workouts: workoutsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
