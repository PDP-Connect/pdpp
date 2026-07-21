/**
 * Schema tests for the Oura connector. Parsing is inline in index.ts (no
 * parsers.ts), so these assert the schema against literal records shaped
 * exactly as the `sleepRecord` / `readinessRecord` / `activityRecord` builders
 * emit them — the authoritative emitted shape.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { activitySchema, readinessSchema, sleepSchema, validateRecord } from "./schemas.ts";

// A sleep record exactly as sleepRecord emits it. Float HRV/efficiency are the
// real Oura shape — the schema must NOT require integers here.
const SLEEP_RECORD = {
  id: "8f9d6e1a-3b2c-4d5e-9f8a-1b2c3d4e5f60",
  day: "2024-05-20",
  bedtime_start: "2024-05-20T23:14:05-07:00",
  bedtime_end: "2024-05-21T07:02:11-07:00",
  total_sleep_duration: 26_400,
  rem_sleep_duration: 5400,
  deep_sleep_duration: 4800,
  light_sleep_duration: 16_200,
  efficiency: 91.5,
  latency: 720,
  average_heart_rate: 54.3,
  lowest_heart_rate: 48,
  average_hrv: 62.7,
  temperature_delta: -0.12,
  sleep_score: 78,
};

const READINESS_RECORD = {
  id: "11112222-3333-4444-5555-666677778888",
  day: "2024-05-20",
  score: 82,
  temperature_deviation: 0.05,
  temperature_trend_deviation: -0.1,
  contributors: { activity_balance: 90, hrv_balance: 75, resting_heart_rate: null },
};

const ACTIVITY_RECORD = {
  id: "aaaabbbb-cccc-dddd-eeee-ffff00001111",
  day: "2024-05-20",
  score: 88,
  active_calories: 540,
  total_calories: 2710,
  steps: 11_204,
  target_calories: 500,
  equivalent_walking_distance: 8123.4,
};

test("sleep schema accepts a representative emitted record (float HRV/efficiency)", () => {
  const result = sleepSchema.safeParse(SLEEP_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("sleep schema accepts a record with all optional metrics null", () => {
  const result = sleepSchema.safeParse({
    ...SLEEP_RECORD,
    bedtime_start: null,
    bedtime_end: null,
    total_sleep_duration: null,
    rem_sleep_duration: null,
    deep_sleep_duration: null,
    light_sleep_duration: null,
    efficiency: null,
    latency: null,
    average_heart_rate: null,
    lowest_heart_rate: null,
    average_hrv: null,
    temperature_delta: null,
    sleep_score: null,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("readiness schema accepts a representative emitted record", () => {
  const result = readinessSchema.safeParse(READINESS_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("readiness schema accepts an empty contributors map", () => {
  const result = readinessSchema.safeParse({ ...READINESS_RECORD, contributors: {} });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("activity schema accepts a representative emitted record", () => {
  const result = activitySchema.safeParse(ACTIVITY_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("sleep schema rejects a non-UUID id (wrong document captured)", () => {
  assert.equal(sleepSchema.safeParse({ ...SLEEP_RECORD, id: "sleep-1" }).success, false);
});

test("activity schema rejects a malformed day (datetime where a date is expected)", () => {
  assert.equal(activitySchema.safeParse({ ...ACTIVITY_RECORD, day: "2024-05-20T00:00:00Z" }).success, false);
});

test("readiness schema rejects a non-numeric contributor value (API map drift)", () => {
  assert.equal(
    readinessSchema.safeParse({ ...READINESS_RECORD, contributors: { activity_balance: "high" } }).success,
    false
  );
});

test("validateRecord routes by stream and passes unknown streams through", () => {
  assert.equal(validateRecord("sleep", SLEEP_RECORD).ok, true);
  assert.equal(validateRecord("readiness", READINESS_RECORD).ok, true);
  assert.equal(validateRecord("activity", ACTIVITY_RECORD).ok, true);
  assert.equal(validateRecord("heart_rate", { id: "x" }).ok, true);
});
