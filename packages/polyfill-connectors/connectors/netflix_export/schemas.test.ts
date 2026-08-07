// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests for the Netflix export connector. Proves the emit-time schemas
 * accept records built by the real parsers from representative Netflix export
 * payloads, and reject representative drift.
 * SLVP "validate representative emitted records".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildViewingActivityRecord, parseNetflixTimestamp, parseWatchDurationPercent } from "./parsers.ts";
import { validateRecord, viewingActivitySchema } from "./schemas.ts";
import type { ViewingActivityCSVRow } from "./types.ts";

test("viewing_activity schema accepts a parser-built record (basic)", () => {
  const row: ViewingActivityCSVRow = {
    title: "The Crown",
    "watched at": "2024-01-15",
    "device type": "TV",
    "watch duration": "85%",
    "profile name": "Main Profile",
  };
  const rec = buildViewingActivityRecord(row);
  assert.ok(rec);
  const result = viewingActivitySchema.safeParse(rec);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("viewing_activity schema accepts a record with null optional fields", () => {
  const row: ViewingActivityCSVRow = {
    title: undefined,
    "watched at": "2024-01-15",
    "device type": undefined,
    "watch duration": undefined,
    "profile name": undefined,
  };
  const rec = buildViewingActivityRecord(row);
  assert.ok(rec);
  const result = viewingActivitySchema.safeParse(rec);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("viewing_activity schema accepts a record with multi-line quoted title", () => {
  const row: ViewingActivityCSVRow = {
    title: 'Movie with "Quotes" Inside',
    "watched at": "2024-01-15",
    "device type": "Laptop",
    "watch duration": "50%",
    "profile name": "User Profile",
  };
  const rec = buildViewingActivityRecord(row);
  assert.ok(rec);
  const result = viewingActivitySchema.safeParse(rec);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("viewing_activity schema accepts a record with special characters", () => {
  const row: ViewingActivityCSVRow = {
    title: "Café Delights: Episode 1",
    "watched at": "2024-01-14",
    "device type": "TV",
    "watch duration": "88%",
    "profile name": "Français Profile",
  };
  const rec = buildViewingActivityRecord(row);
  assert.ok(rec);
  const result = viewingActivitySchema.safeParse(rec);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("viewing_activity schema rejects a record with duration out of range (>100)", () => {
  const rec = {
    id: "a".repeat(24),
    title: "Test",
    watched_at: "2024-01-15T10:00:00.000Z",
    device_type: "TV",
    watch_duration_percent: 150, // Invalid: > 100
    profile_name: "Profile",
  };
  const result = viewingActivitySchema.safeParse(rec);
  assert.equal(result.success, false);
});

test("viewing_activity schema rejects a record with negative duration", () => {
  const rec = {
    id: "a".repeat(24),
    title: "Test",
    watched_at: "2024-01-15T10:00:00.000Z",
    device_type: "TV",
    watch_duration_percent: -5, // Invalid: < 0
    profile_name: "Profile",
  };
  const result = viewingActivitySchema.safeParse(rec);
  assert.equal(result.success, false);
});

test("viewing_activity schema rejects invalid record ID format", () => {
  const rec = {
    id: "not-a-valid-hex-id",
    title: "Test",
    watched_at: "2024-01-15T10:00:00.000Z",
    device_type: "TV",
    watch_duration_percent: 50,
    profile_name: "Profile",
  };
  const result = viewingActivitySchema.safeParse(rec);
  assert.equal(result.success, false);
});

test("viewing_activity schema rejects invalid timestamp format", () => {
  const rec = {
    id: "a".repeat(24),
    title: "Test",
    watched_at: "not-a-valid-iso-date",
    device_type: "TV",
    watch_duration_percent: 50,
    profile_name: "Profile",
  };
  const result = viewingActivitySchema.safeParse(rec);
  assert.equal(result.success, false);
});

test("parseWatchDurationPercent handles percentage strings", () => {
  assert.equal(parseWatchDurationPercent("85%"), 85);
  assert.equal(parseWatchDurationPercent("100%"), 100);
  assert.equal(parseWatchDurationPercent("0%"), 0);
  assert.equal(parseWatchDurationPercent("50.5%"), 50.5);
});

test("parseWatchDurationPercent handles numeric strings without %", () => {
  assert.equal(parseWatchDurationPercent("75"), 75);
  assert.equal(parseWatchDurationPercent("0"), 0);
});

test("parseWatchDurationPercent rejects malformed strings", () => {
  assert.equal(parseWatchDurationPercent("abc%"), null);
  assert.equal(parseWatchDurationPercent(""), null);
  assert.equal(parseWatchDurationPercent(undefined), null);
  assert.equal(parseWatchDurationPercent("150%"), null);
  assert.equal(parseWatchDurationPercent("-5%"), null);
});

test("parseNetflixTimestamp handles ISO date strings", () => {
  const ts = parseNetflixTimestamp("2024-01-15");
  assert.ok(ts);
  assert.ok(ts.startsWith("2024-01-15T"));
});

test("parseNetflixTimestamp handles datetime strings", () => {
  const ts = parseNetflixTimestamp("2024-01-15 14:30:00");
  assert.ok(ts);
  assert.ok(ts.includes("2024-01-15"));
});

test("parseNetflixTimestamp rejects malformed strings", () => {
  assert.equal(parseNetflixTimestamp("not-a-date"), null);
  assert.equal(parseNetflixTimestamp(""), null);
  assert.equal(parseNetflixTimestamp(undefined), null);
});

test("validateRecord routes viewing_activity and passes unknown streams through", () => {
  const row: ViewingActivityCSVRow = {
    title: "Test",
    "watched at": "2024-01-15",
    "device type": "TV",
    "watch duration": "50%",
    "profile name": "Profile",
  };
  const rec = buildViewingActivityRecord(row);
  assert.ok(rec);
  assert.equal(validateRecord("viewing_activity", rec).ok, true);
  assert.equal(validateRecord("unknown_stream", { x: 1 }).ok, true);
});

test("buildViewingActivityRecord creates deterministic IDs from same input", () => {
  const row: ViewingActivityCSVRow = {
    title: "Show A",
    "watched at": "2024-01-15",
    "device type": "TV",
    "watch duration": "50%",
    "profile name": "Profile",
  };
  const rec1 = buildViewingActivityRecord(row);
  const rec2 = buildViewingActivityRecord(row);
  assert.ok(rec1);
  assert.ok(rec2);
  assert.equal(rec1.id, rec2.id);
});

test("buildViewingActivityRecord creates different IDs for different titles", () => {
  const row1: ViewingActivityCSVRow = {
    title: "Show A",
    "watched at": "2024-01-15",
    "device type": "TV",
    "watch duration": "50%",
    "profile name": "Profile",
  };
  const row2: ViewingActivityCSVRow = {
    title: "Show B",
    "watched at": "2024-01-15",
    "device type": "TV",
    "watch duration": "50%",
    "profile name": "Profile",
  };
  const rec1 = buildViewingActivityRecord(row1);
  const rec2 = buildViewingActivityRecord(row2);
  assert.ok(rec1);
  assert.ok(rec2);
  assert.notEqual(rec1.id, rec2.id);
});

test("buildViewingActivityRecord skips rows without valid timestamp", () => {
  const row: ViewingActivityCSVRow = {
    title: "Show",
    "watched at": undefined,
    "device type": "TV",
    "watch duration": "50%",
    "profile name": "Profile",
  };
  const rec = buildViewingActivityRecord(row);
  assert.equal(rec, null);
});

test("buildViewingActivityRecord returns null for malformed timestamp", () => {
  const row: ViewingActivityCSVRow = {
    title: "Show",
    "watched at": "not-a-date",
    "device type": "TV",
    "watch duration": "50%",
    "profile name": "Profile",
  };
  const rec = buildViewingActivityRecord(row);
  assert.equal(rec, null);
});
