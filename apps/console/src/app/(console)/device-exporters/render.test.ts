// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { DeviceExporter, DeviceSourceInstance } from "../lib/ref-client.ts";
import {
  classifyHeartbeatFreshness,
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
  const device = {
    source_instances: [{ accepted_record_count: 3, rejected_record_count: 1 }, { accepted_record_count: 2 }],
  } as Pick<DeviceExporter, "source_instances">;

  assert.deepEqual(summarizeIngestCounts(device), { accepted: 5, rejected: 1 });
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
