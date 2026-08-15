// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { activeScheduleRunId, scheduleEnabled, scheduleIntervalSeconds } from "./schedule-evidence.ts";

test("schedule interval evidence fails closed for missing or invalid values", () => {
  for (const value of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, 0, -1, "3600"]) {
    assert.equal(scheduleIntervalSeconds(value), null);
  }
  assert.equal(scheduleIntervalSeconds(3600), 3600);
});

test("schedule enabled evidence fails closed when the flag is missing", () => {
  assert.equal(scheduleEnabled(undefined), null);
  assert.equal(scheduleEnabled("true"), null);
  assert.equal(scheduleEnabled(true), true);
  assert.equal(scheduleEnabled(false), false);
});

test("active schedule run evidence only accepts a non-empty string id", () => {
  assert.equal(activeScheduleRunId(null), null);
  assert.equal(activeScheduleRunId({ active_run_id: undefined }), null);
  assert.equal(activeScheduleRunId({ active_run_id: 42 }), null);
  assert.equal(activeScheduleRunId({ active_run_id: "" }), null);
  assert.equal(activeScheduleRunId({ active_run_id: "run_1" }), "run_1");
});
