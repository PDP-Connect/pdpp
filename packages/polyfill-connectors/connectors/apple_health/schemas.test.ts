/**
 * Schema tests for the Apple Health connector. Parsing lives in parsers.ts;
 * these assert the schema against records shaped exactly as
 * `buildHealthRecord` / `buildWorkoutRecord` produce them — the authoritative
 * emitted shape. Both streams are exercised, including the float-capable
 * numeric values, the `value_raw` fallback for non-numeric category values, and
 * the structural reject cases the gate exists to protect.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { recordsSchema, validateRecord, workoutsSchema } from "./schemas.ts";

// Shaped exactly as buildHealthRecord(...) returns. A numeric quantity record
// (heart rate): value is a finite float, value_raw is null.
const RECORD_NUMERIC = {
  id: "a1b2c3d4e5f6a7b8c9d0e1f2",
  type: "HeartRate",
  source_name: "Apple Watch",
  source_version: "10.1",
  unit: "count/min",
  value: 72.5,
  value_raw: null,
  start_date: "2024-06-05T13:00:00.000Z",
  end_date: "2024-06-05T13:00:01.000Z",
};

// A category record (sleep analysis): value is null, value_raw carries the
// non-numeric HK category token.
const RECORD_CATEGORY = {
  id: "b1b2c3d4e5f6a7b8c9d0e1f2",
  type: "SleepAnalysis",
  source_name: "iPhone",
  source_version: null,
  unit: null,
  value: null,
  value_raw: "HKCategoryValueSleepAnalysisAsleepCore",
  start_date: "2024-06-05T03:00:00.000Z",
  end_date: null,
};

// Shaped exactly as buildWorkoutRecord(...) returns.
const WORKOUT_RECORD = {
  id: "c1b2c3d4e5f6a7b8c9d0e1f2",
  workout_activity_type: "Running",
  duration_minutes: 32.5,
  total_energy_burned_kcal: 410.2,
  total_distance_km: 5.04,
  source_name: "Apple Watch",
  start_date: "2024-06-05T06:00:00.000Z",
  end_date: "2024-06-05T06:32:30.000Z",
};

test("records schema accepts a numeric quantity record (float value)", () => {
  const result = recordsSchema.safeParse(RECORD_NUMERIC);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("records schema accepts a category record (null value, value_raw token)", () => {
  const result = recordsSchema.safeParse(RECORD_CATEGORY);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("records schema rejects a non-hex id (id builder regression)", () => {
  assert.equal(recordsSchema.safeParse({ ...RECORD_NUMERIC, id: "nope" }).success, false);
});

test("records schema rejects a missing type (manifest-required field)", () => {
  const { type: _omit, ...withoutType } = RECORD_NUMERIC;
  assert.equal(recordsSchema.safeParse(withoutType).success, false);
});

test("records schema rejects a non-finite value (Number parse leak)", () => {
  assert.equal(recordsSchema.safeParse({ ...RECORD_NUMERIC, value: Number.POSITIVE_INFINITY }).success, false);
});

test("records schema rejects a non-ISO start_date", () => {
  assert.equal(recordsSchema.safeParse({ ...RECORD_NUMERIC, start_date: "2024-06-05 13:00:00 -0700" }).success, false);
});

test("workouts schema accepts a representative emitted record", () => {
  const result = workoutsSchema.safeParse(WORKOUT_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("workouts schema accepts an all-null-metrics workout (only id + start)", () => {
  const result = workoutsSchema.safeParse({
    ...WORKOUT_RECORD,
    workout_activity_type: null,
    duration_minutes: null,
    total_energy_burned_kcal: null,
    total_distance_km: null,
    source_name: null,
    end_date: null,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("workouts schema rejects a negative distance (sign/selector drift)", () => {
  assert.equal(workoutsSchema.safeParse({ ...WORKOUT_RECORD, total_distance_km: -1 }).success, false);
});

test("validateRecord routes both streams and passes unknown streams through", () => {
  assert.equal(validateRecord("records", RECORD_NUMERIC).ok, true);
  assert.equal(validateRecord("workouts", WORKOUT_RECORD).ok, true);
  assert.equal(validateRecord("activity_summaries", { id: "x" }).ok, true);
});

test("validateRecord reports issues for a drifted workouts record", () => {
  const result = validateRecord("workouts", { ...WORKOUT_RECORD, total_distance_km: -1 });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path === "total_distance_km"));
  }
});
