// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { DeviceExporter, DeviceSourceInstance } from "../lib/ref-client.ts";
import {
  classifyHeartbeatFreshness,
  formatIngestCount,
  formatLastError,
  formatRelativeTime,
  sourceLabel,
  summarizeIngestCounts,
} from "./render.ts";

test("classifyHeartbeatFreshness preserves never, stale, and fresh states", () => {
  assert.equal(classifyHeartbeatFreshness(null, false), "never");
  assert.equal(classifyHeartbeatFreshness("2026-04-30T12:00:00.000Z", true), "stale");
  assert.equal(classifyHeartbeatFreshness("2026-04-30T12:00:00.000Z", false), "fresh");
});

test("summarizeIngestCounts totals source-instance accepted and rejected counts", () => {
  // CHANGED (2026-08-23): this test previously asserted `{accepted: 5,
  // rejected: 1}` for this exact fixture — pinning the `?? 0` coalescing that
  // turned the SECOND instance's ABSENT rejected count into a proven zero. It
  // was pinning the defect: the device row derives the rejected pill's tone
  // from that total, so a fabricated 0 rendered as a neutral "no rejects".
  // The fixture is unchanged so the change in intent is legible; only the
  // expectation moved. `rejected` now reports the sum of the counts that
  // genuinely exist (1) AND that it is incomplete, so the caller can decline
  // to state it.
  const device = {
    source_instances: [{ accepted_record_count: 3, rejected_record_count: 1 }, { accepted_record_count: 2 }],
  } as Pick<DeviceExporter, "source_instances">;

  assert.deepEqual(summarizeIngestCounts(device), {
    accepted: { complete: true, total: 5 },
    rejected: { complete: false, total: 1 },
  });
});

test("summarizeIngestCounts reports a genuine all-zero total as complete, not unknown", () => {
  // The guard must not refuse a real zero. A device whose instances all
  // reported 0 has a PROVEN zero, and suppressing it would be the mirror
  // defect — a refused zero is as bad as a fabricated one.
  const device = {
    source_instances: [{ accepted_record_count: 0, rejected_record_count: 0 }],
  } as Pick<DeviceExporter, "source_instances">;

  assert.deepEqual(summarizeIngestCounts(device), {
    accepted: { complete: true, total: 0 },
    rejected: { complete: true, total: 0 },
  });
});

test("formatIngestCount prints a proven total and refuses an unproven one", () => {
  assert.equal(formatIngestCount({ complete: true, total: 0 }), "0");
  assert.equal(formatIngestCount({ complete: true, total: 1234 }), "1,234");
  assert.equal(
    formatIngestCount({ complete: false, total: 1 }),
    "unknown",
    "a partial sum must never be printed as though it were the total"
  );
});

test("formatLastError prefers message, then code, then generic state", () => {
  assert.equal(formatLastError(null), "none");
  assert.equal(
    formatLastError({ code: "session_expired", message: "browser session expired" }),
    "browser session expired"
  );
  assert.equal(formatLastError({ code: "rate_limited" }), "rate_limited");
  assert.equal(formatLastError({ detail: "opaque" }), "error reported");
});

test("formatRelativeTime handles missing, invalid, and recent timestamps", () => {
  const now = new Date("2026-04-30T12:00:00.000Z");

  assert.equal(formatRelativeTime(null, now), "never");
  assert.equal(formatRelativeTime("not-a-date", now), "unknown");
  assert.equal(formatRelativeTime("2026-04-30T11:45:00.000Z", now), "15m ago");
  assert.equal(formatRelativeTime("2026-04-30T13:00:00.000Z", now), "1h from now");
});

test("sourceLabel uses display name before local binding and id", () => {
  const base = {
    connector_id: "spotify",
    created_at: "2026-04-30T12:00:00.000Z",
    device_id: "dev_1",
    local_binding_name: "laptop",
    object: "device_source_instance",
    source_instance_id: "src_1",
  } as DeviceSourceInstance;

  assert.equal(sourceLabel({ ...base, display_name: "Personal laptop" }), "Personal laptop");
  assert.equal(sourceLabel(base), "laptop");
  assert.equal(sourceLabel({ ...base, local_binding_name: "" }), "src_1");
});
