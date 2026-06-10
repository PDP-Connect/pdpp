/**
 * Schema tests for the Strava connector. Parsing is inline in index.ts (no
 * parsers.ts), so these assert the schema against a literal record shaped
 * exactly as `toActivityRecord` emits it — the authoritative emitted shape.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { activitiesSchema, validateRecord } from "./schemas.ts";

// An activity record exactly as toActivityRecord emits it. Float distance /
// speed / elevation are the real Strava shape — must NOT require integers.
const ACTIVITY_RECORD = {
  id: "11385479490",
  name: "Morning Run",
  type: "Run",
  sport_type: "Run",
  start_date: "2024-05-20T13:05:32Z",
  start_date_local: "2024-05-20T06:05:32Z",
  timezone: "(GMT-08:00) America/Los_Angeles",
  distance_m: 8123.4,
  moving_time_s: 2710,
  elapsed_time_s: 2890,
  total_elevation_gain_m: 64.2,
  average_speed_mps: 2.997,
  max_speed_mps: 4.51,
  average_heartrate: 152.3,
  max_heartrate: 178,
  kudos_count: 12,
  comment_count: 1,
  achievement_count: 3,
  start_latlng: [37.7749, -122.4194],
  end_latlng: [37.7808, -122.4203],
  map_polyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
};

test("activities schema accepts a representative GPS activity (float metrics)", () => {
  const result = activitiesSchema.safeParse(ACTIVITY_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("activities schema accepts an indoor activity (empty latlng arrays, null polyline)", () => {
  const result = activitiesSchema.safeParse({
    ...ACTIVITY_RECORD,
    sport_type: "VirtualRide",
    start_latlng: [],
    end_latlng: [],
    map_polyline: null,
    average_heartrate: null,
    max_heartrate: null,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("activities schema rejects a non-numeric id (String(a.id) regression)", () => {
  assert.equal(activitiesSchema.safeParse({ ...ACTIVITY_RECORD, id: "act_11385479490" }).success, false);
});

test("activities schema rejects a 3-element latlng (malformed coordinate array)", () => {
  assert.equal(activitiesSchema.safeParse({ ...ACTIVITY_RECORD, start_latlng: [1, 2, 3] }).success, false);
});

test("activities schema rejects a missing start_date (cursor input must be present)", () => {
  const { start_date: _omit, ...withoutStart } = ACTIVITY_RECORD;
  assert.equal(activitiesSchema.safeParse(withoutStart).success, false);
});

test("validateRecord routes by stream and passes unknown streams through", () => {
  assert.equal(validateRecord("activities", ACTIVITY_RECORD).ok, true);
  assert.equal(validateRecord("segments", { id: "1" }).ok, true);
});
