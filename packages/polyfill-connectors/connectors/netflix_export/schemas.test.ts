// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests for the Netflix export connector. Proves the emit-time schemas
 * accept records built by the real parsers from representative Netflix export
 * payloads (both real CSV schemas: direct_history and full_export), and
 * reject representative drift.
 * SLVP "validate representative emitted records".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildViewingActivityRecord } from "./parsers.ts";
import { validateRecord, viewingActivitySchema } from "./schemas.ts";
import type { ViewingActivityCSVRow } from "./types.ts";

test("viewing_activity schema accepts a parser-built direct_history record (basic)", () => {
  const row: ViewingActivityCSVRow = { title: "The Crown", date: "2024-01-15" };
  const rec = buildViewingActivityRecord(row, "direct_history");
  assert.ok(rec);
  assert.equal(rec.watched_at_precision, "day");
  assert.equal(rec.duration_seconds, null);
  const result = viewingActivitySchema.safeParse(rec);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("viewing_activity schema accepts a parser-built full_export record (basic)", () => {
  const row: ViewingActivityCSVRow = {
    "profile name": "Main Profile",
    "start time (utc)": "2024-01-15 20:14:03",
    "duration (h:mm:ss)": "0:42:10",
    title: "The Crown",
    "device type": "TV",
    country: "US",
  };
  const rec = buildViewingActivityRecord(row, "full_export");
  assert.ok(rec);
  assert.equal(rec.watched_at_precision, "instant");
  assert.equal(rec.duration_seconds, 2530);
  const result = viewingActivitySchema.safeParse(rec);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("viewing_activity schema accepts a direct_history record with null optional fields", () => {
  const row: ViewingActivityCSVRow = { title: undefined, date: "2024-01-15" };
  const rec = buildViewingActivityRecord(row, "direct_history");
  assert.ok(rec);
  const result = viewingActivitySchema.safeParse(rec);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("viewing_activity schema accepts a full_export record with multi-line quoted title", () => {
  const row: ViewingActivityCSVRow = {
    "profile name": "User Profile",
    "start time (utc)": "2024-01-15 12:00:00",
    "duration (h:mm:ss)": "0:25:00",
    title: 'Movie with "Quotes" Inside',
    "device type": "Laptop",
  };
  const rec = buildViewingActivityRecord(row, "full_export");
  assert.ok(rec);
  const result = viewingActivitySchema.safeParse(rec);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("viewing_activity schema accepts a record with special characters", () => {
  const row: ViewingActivityCSVRow = { title: "Café Delights: Episode 1", date: "2024-01-14" };
  const rec = buildViewingActivityRecord(row, "direct_history");
  assert.ok(rec);
  const result = viewingActivitySchema.safeParse(rec);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("viewing_activity schema rejects a record with negative duration_seconds", () => {
  const rec = {
    id: "a".repeat(24),
    title: "Test",
    watched_at: "2024-01-15T10:00:00.000Z",
    watched_at_precision: "instant",
    device_type: "TV",
    duration_seconds: -5,
    profile_name: "Profile",
    country: null,
    source_schema: "full_export",
  };
  const result = viewingActivitySchema.safeParse(rec);
  assert.equal(result.success, false);
});

test("viewing_activity schema rejects a record with a non-integer duration_seconds", () => {
  const rec = {
    id: "a".repeat(24),
    title: "Test",
    watched_at: "2024-01-15T10:00:00.000Z",
    watched_at_precision: "instant",
    device_type: "TV",
    duration_seconds: 42.5,
    profile_name: "Profile",
    country: null,
    source_schema: "full_export",
  };
  const result = viewingActivitySchema.safeParse(rec);
  assert.equal(result.success, false);
});

test("viewing_activity schema rejects invalid record ID format", () => {
  const rec = {
    id: "not-a-valid-hex-id",
    title: "Test",
    watched_at: "2024-01-15T10:00:00.000Z",
    watched_at_precision: "day",
    device_type: null,
    duration_seconds: null,
    profile_name: null,
    country: null,
    source_schema: "direct_history",
  };
  const result = viewingActivitySchema.safeParse(rec);
  assert.equal(result.success, false);
});

test("viewing_activity schema rejects invalid timestamp format", () => {
  const rec = {
    id: "a".repeat(24),
    title: "Test",
    watched_at: "not-a-valid-iso-date",
    watched_at_precision: "day",
    device_type: null,
    duration_seconds: null,
    profile_name: null,
    country: null,
    source_schema: "direct_history",
  };
  const result = viewingActivitySchema.safeParse(rec);
  assert.equal(result.success, false);
});

test("viewing_activity schema rejects an unrecognized watched_at_precision or source_schema", () => {
  const base = {
    id: "a".repeat(24),
    title: "Test",
    watched_at: "2024-01-15T10:00:00.000Z",
    device_type: null,
    duration_seconds: null,
    profile_name: null,
    country: null,
  };
  assert.equal(
    viewingActivitySchema.safeParse({ ...base, watched_at_precision: "week", source_schema: "direct_history" }).success,
    false
  );
  assert.equal(
    viewingActivitySchema.safeParse({ ...base, watched_at_precision: "day", source_schema: "legacy_shape" }).success,
    false
  );
});

test("validateRecord routes viewing_activity and passes unknown streams through", () => {
  const row: ViewingActivityCSVRow = { title: "Test", date: "2024-01-15" };
  const rec = buildViewingActivityRecord(row, "direct_history");
  assert.ok(rec);
  assert.equal(validateRecord("viewing_activity", rec).ok, true);
  assert.equal(validateRecord("unknown_stream", { x: 1 }).ok, true);
});

test("buildViewingActivityRecord creates deterministic IDs from the same input", () => {
  const row: ViewingActivityCSVRow = { title: "Show A", date: "2024-01-15" };
  const rec1 = buildViewingActivityRecord(row, "direct_history");
  const rec2 = buildViewingActivityRecord(row, "direct_history");
  assert.ok(rec1);
  assert.ok(rec2);
  assert.equal(rec1.id, rec2.id);
});

test("buildViewingActivityRecord creates different IDs for different titles", () => {
  const row1: ViewingActivityCSVRow = { title: "Show A", date: "2024-01-15" };
  const row2: ViewingActivityCSVRow = { title: "Show B", date: "2024-01-15" };
  const rec1 = buildViewingActivityRecord(row1, "direct_history");
  const rec2 = buildViewingActivityRecord(row2, "direct_history");
  assert.ok(rec1);
  assert.ok(rec2);
  assert.notEqual(rec1.id, rec2.id);
});

test("buildViewingActivityRecord returns null for a direct_history row without a valid date", () => {
  const row: ViewingActivityCSVRow = { title: "Show", date: undefined };
  const rec = buildViewingActivityRecord(row, "direct_history");
  assert.equal(rec, null);
});

test("buildViewingActivityRecord returns null for a direct_history row with a malformed date", () => {
  const row: ViewingActivityCSVRow = { title: "Show", date: "not-a-date" };
  const rec = buildViewingActivityRecord(row, "direct_history");
  assert.equal(rec, null);
});

test("buildViewingActivityRecord returns null for a full_export row without a valid start time", () => {
  const row: ViewingActivityCSVRow = { title: "Show", "start time (utc)": undefined };
  const rec = buildViewingActivityRecord(row, "full_export");
  assert.equal(rec, null);
});
