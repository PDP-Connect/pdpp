// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CATEGORY_RECORD,
  HEART_RATE_RECORD,
  NO_START_DATE_RECORD,
  NON_NUMERIC_VALUE_RECORD,
  STEP_COUNT_RECORD,
} from "./__fixtures__/record-step-count.ts";
import { BAD_DATE_WORKOUT, RUN_WORKOUT, WALK_WORKOUT_MIN } from "./__fixtures__/workout-run.ts";
import {
  advanceCursor,
  buildHealthRecord,
  buildWorkoutRecord,
  hashId,
  healthTypeShort,
  isBeforeCursor,
  isoDate,
  parseAttrs,
} from "./parsers.ts";

// ─── parseAttrs ─────────────────────────────────────────────────────────

test('parseAttrs: extracts key="value" pairs', () => {
  const attrs = parseAttrs('type="HKStep" value="42" sourceName="iPhone"');
  assert.deepEqual(attrs, {
    type: "HKStep",
    value: "42",
    sourceName: "iPhone",
  });
});

test("parseAttrs: empty string → empty object", () => {
  assert.deepEqual(parseAttrs(""), {});
});

test("parseAttrs: handles attributes with spaces in value", () => {
  const attrs = parseAttrs('sourceName="Apple Watch" unit="count/min"');
  assert.equal(attrs.sourceName, "Apple Watch");
  assert.equal(attrs.unit, "count/min");
});

// ─── healthTypeShort ────────────────────────────────────────────────────

test("healthTypeShort: strips HKQuantityTypeIdentifier prefix", () => {
  assert.equal(healthTypeShort("HKQuantityTypeIdentifierStepCount"), "StepCount");
});

test("healthTypeShort: strips HKCategoryTypeIdentifier prefix", () => {
  assert.equal(healthTypeShort("HKCategoryTypeIdentifierSleepAnalysis"), "SleepAnalysis");
});

test("healthTypeShort: strips HKDataType prefix", () => {
  assert.equal(healthTypeShort("HKDataTypeSleepDurationGoal"), "SleepDurationGoal");
});

test("healthTypeShort: undefined → null", () => {
  assert.equal(healthTypeShort(undefined), null);
});

test("healthTypeShort: unknown prefix passes through", () => {
  assert.equal(healthTypeShort("CustomType"), "CustomType");
});

// ─── isoDate ────────────────────────────────────────────────────────────

test("isoDate: parses Apple Health timestamp with offset", () => {
  // '2024-06-05 13:45:22 -0700' → 2024-06-05T20:45:22.000Z
  assert.equal(isoDate("2024-06-05 13:45:22 -0700"), "2024-06-05T20:45:22.000Z");
});

test("isoDate: undefined → null", () => {
  assert.equal(isoDate(undefined), null);
});

test("isoDate: garbage string → null", () => {
  assert.equal(isoDate("not-a-date"), null);
});

// ─── hashId ─────────────────────────────────────────────────────────────

test("hashId: deterministic 24-char hex output", () => {
  const id = hashId("a|b|c");
  assert.match(id, /^[0-9a-f]{24}$/);
  assert.equal(id, hashId("a|b|c"));
});

test("hashId: differs for different inputs", () => {
  assert.notEqual(hashId("a"), hashId("b"));
});

// ─── buildHealthRecord ──────────────────────────────────────────────────

test("buildHealthRecord: step count → fully populated record", () => {
  const rec = buildHealthRecord(STEP_COUNT_RECORD);
  assert.ok(rec, "expected a record");
  assert.equal(rec.type, "StepCount");
  assert.equal(rec.source_name, "iPhone");
  assert.equal(rec.source_version, "17.5");
  assert.equal(rec.unit, "count");
  assert.equal(rec.value, 42);
  assert.equal(rec.value_raw, null);
  assert.equal(rec.start_date, "2024-06-05T20:45:22.000Z");
  assert.equal(rec.end_date, "2024-06-05T20:50:10.000Z");
  assert.match(rec.id, /^[0-9a-f]{24}$/);
});

test("buildHealthRecord: heart rate carries numeric value", () => {
  const rec = buildHealthRecord(HEART_RATE_RECORD);
  assert.ok(rec);
  assert.equal(rec.type, "HeartRate");
  assert.equal(rec.value, 72);
});

test("buildHealthRecord: category record stores string in value_raw, null in value", () => {
  const rec = buildHealthRecord(CATEGORY_RECORD);
  assert.ok(rec);
  assert.equal(rec.type, "SleepAnalysis");
  assert.equal(rec.value, null);
  assert.equal(rec.value_raw, "HKCategoryValueSleepAnalysisAsleepCore");
});

test("buildHealthRecord: non-numeric value record → value_raw route", () => {
  const rec = buildHealthRecord(NON_NUMERIC_VALUE_RECORD);
  assert.ok(rec);
  assert.equal(rec.value, null);
  assert.equal(rec.value_raw, "HKCategoryValueSleepAnalysisAsleepCore");
});

test("buildHealthRecord: missing startDate → null (skip)", () => {
  assert.equal(buildHealthRecord(NO_START_DATE_RECORD), null);
});

test("buildHealthRecord: same key fields → same id (dedup stability)", () => {
  const a = buildHealthRecord(STEP_COUNT_RECORD);
  const b = buildHealthRecord(STEP_COUNT_RECORD);
  assert.ok(a && b);
  assert.equal(a.id, b.id);
});

// ─── buildWorkoutRecord ─────────────────────────────────────────────────

test("buildWorkoutRecord: populated run workout", () => {
  const w = buildWorkoutRecord(RUN_WORKOUT);
  assert.ok(w);
  assert.equal(w.workout_activity_type, "Running");
  assert.equal(w.duration_minutes, 32.5);
  assert.equal(w.total_distance_km, 5.2);
  assert.equal(w.total_energy_burned_kcal, 345);
  assert.equal(w.source_name, "Apple Watch");
  assert.equal(w.start_date, "2024-06-05T13:30:00.000Z");
});

test("buildWorkoutRecord: minimal walk workout leaves numeric fields null", () => {
  const w = buildWorkoutRecord(WALK_WORKOUT_MIN);
  assert.ok(w);
  assert.equal(w.workout_activity_type, "Walking");
  assert.equal(w.duration_minutes, null);
  assert.equal(w.total_distance_km, null);
  assert.equal(w.total_energy_burned_kcal, null);
});

test("buildWorkoutRecord: unparseable start date → null (skip)", () => {
  assert.equal(buildWorkoutRecord(BAD_DATE_WORKOUT), null);
});

// ─── Cursor helpers ─────────────────────────────────────────────────────

test("isBeforeCursor: no cursor → false (keep)", () => {
  assert.equal(isBeforeCursor("2024-06-05T00:00:00.000Z", undefined), false);
});

test("isBeforeCursor: equal → true (skip already-emitted)", () => {
  assert.equal(isBeforeCursor("2024-06-05T00:00:00.000Z", "2024-06-05T00:00:00.000Z"), true);
});

test("isBeforeCursor: strictly after cursor → false (keep)", () => {
  assert.equal(isBeforeCursor("2024-06-06T00:00:00.000Z", "2024-06-05T00:00:00.000Z"), false);
});

test("advanceCursor: undefined prev → takes next", () => {
  assert.equal(advanceCursor(undefined, "2024-06-05T00:00:00.000Z"), "2024-06-05T00:00:00.000Z");
});

test("advanceCursor: next > prev → takes next", () => {
  assert.equal(advanceCursor("2024-06-05T00:00:00.000Z", "2024-06-06T00:00:00.000Z"), "2024-06-06T00:00:00.000Z");
});

test("advanceCursor: next < prev → keeps prev (monotonic)", () => {
  assert.equal(advanceCursor("2024-06-06T00:00:00.000Z", "2024-06-05T00:00:00.000Z"), "2024-06-06T00:00:00.000Z");
});
