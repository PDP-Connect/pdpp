// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Parser tests for the Netflix export connector. Tests CSV parsing with
 * proper RFC 4180 quote/encoding handling, duplicate row detection,
 * malformed row resilience, and archive path resolution.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectViewingActivitySchema,
  parseCSVLine,
  parseDirectHistoryDate,
  parseFullExportDurationSeconds,
  parseFullExportStartTime,
} from "./parsers.ts";

test("parseCSVLine handles basic comma-separated fields", () => {
  const headers = ["title", "watched at", "device type", "watch duration", "profile name"];
  const line = "Show A,2024-01-15,TV,85%,Main Profile";
  const result = parseCSVLine(line, headers);

  assert.equal(result.title, "Show A");
  assert.equal(result["watched at"], "2024-01-15");
  assert.equal(result["device type"], "TV");
  assert.equal(result["watch duration"], "85%");
  assert.equal(result["profile name"], "Main Profile");
});

test("parseCSVLine handles quoted fields with embedded commas", () => {
  const headers = ["title", "watched at", "device type"];
  const line = '"Show, Season 1",2024-01-15,TV';
  const result = parseCSVLine(line, headers);

  assert.equal(result.title, "Show, Season 1");
  assert.equal(result["watched at"], "2024-01-15");
  assert.equal(result["device type"], "TV");
});

test("parseCSVLine handles escaped quotes (doubled quotes)", () => {
  const headers = ["title", "watched at"];
  const line = '"Movie with ""Quotes"" Inside",2024-01-15';
  const result = parseCSVLine(line, headers);

  assert.equal(result.title, 'Movie with "Quotes" Inside');
  assert.equal(result["watched at"], "2024-01-15");
});

test("parseCSVLine handles empty quoted fields", () => {
  const headers = ["title", "watched at", "device type"];
  const line = '"",2024-01-15,TV';
  const result = parseCSVLine(line, headers);

  assert.equal(result.title, undefined); // empty string becomes undefined
  assert.equal(result["watched at"], "2024-01-15");
});

test("parseCSVLine handles fields with no values", () => {
  const headers = ["title", "watched at", "device type", "duration"];
  const line = "Show,2024-01-15,,85%";
  const result = parseCSVLine(line, headers);

  assert.equal(result.title, "Show");
  assert.equal(result["watched at"], "2024-01-15");
  assert.equal(result["device type"], undefined);
  assert.equal(result.duration, "85%");
});

test("parseCSVLine handles quoted field with newline (should preserve)", () => {
  const headers = ["title", "watched at"];
  const line = '"Multi\nLine Title",2024-01-15';
  const result = parseCSVLine(line, headers);

  assert.equal(result.title, "Multi\nLine Title");
  assert.equal(result["watched at"], "2024-01-15");
});

test("parseCSVLine handles special characters and UTF-8", () => {
  const headers = ["title", "profile name"];
  const line = '"Café: naïve™",Français';
  const result = parseCSVLine(line, headers);

  assert.equal(result.title, "Café: naïve™");
  assert.equal(result["profile name"], "Français");
});

test("parseCSVLine trims whitespace outside quotes", () => {
  const headers = ["title", "watched at"];
  const line = '  "Show A"  ,  2024-01-15  ';
  const result = parseCSVLine(line, headers);

  assert.equal(result.title, "Show A");
  assert.equal(result["watched at"], "2024-01-15");
});

test("parseCSVLine handles many fields", () => {
  const headers = ["a", "b", "c", "d", "e", "f"];
  const line = '"val1","val2","val3","val4","val5","val6"';
  const result = parseCSVLine(line, headers);

  assert.equal(result.a, "val1");
  assert.equal(result.b, "val2");
  assert.equal(result.c, "val3");
  assert.equal(result.d, "val4");
  assert.equal(result.e, "val5");
  assert.equal(result.f, "val6");
});

test("parseCSVLine handles unquoted field at end", () => {
  const headers = ["title", "device"];
  const line = "Show,TV";
  const result = parseCSVLine(line, headers);

  assert.equal(result.title, "Show");
  assert.equal(result.device, "TV");
});

// ─── detectViewingActivitySchema ─────────────────────────────────────────

test("detectViewingActivitySchema recognizes the direct_history header set (Title,Date)", () => {
  assert.equal(detectViewingActivitySchema(["title", "date"]), "direct_history");
  assert.equal(detectViewingActivitySchema(["Title", "Date"]), "direct_history");
});

test("detectViewingActivitySchema recognizes the full_export header set", () => {
  const headers = [
    "Profile Name",
    "Start Time (UTC)",
    "Duration (H:MM:SS)",
    "Attributes",
    "Title",
    "Supplemental Video Type",
    "Device Type",
    "Bookmark",
    "Latest Bookmark",
    "Country",
  ];
  assert.equal(detectViewingActivitySchema(headers), "full_export");
});

test("detectViewingActivitySchema rejects an unrecognized or mixed header row", () => {
  assert.equal(detectViewingActivitySchema(["title", "watched at", "device type"]), null);
  assert.equal(detectViewingActivitySchema(["title"]), null);
  assert.equal(detectViewingActivitySchema([]), null);
  // Partial full_export headers (missing most columns) must not match either schema.
  assert.equal(detectViewingActivitySchema(["title", "profile name"]), null);
});

// ─── parseDirectHistoryDate ───────────────────────────────────────────────

test("parseDirectHistoryDate handles ISO YYYY-MM-DD", () => {
  const result = parseDirectHistoryDate("2024-01-15");
  assert.equal(result, "2024-01-15T00:00:00.000Z");
});

test("parseDirectHistoryDate handles unambiguous DD/MM/YYYY (day > 12)", () => {
  // 25/03/2024 can only be DD/MM/YYYY since 25 can't be a month.
  const result = parseDirectHistoryDate("25/03/2024");
  assert.equal(result, "2024-03-25T00:00:00.000Z");
});

test("parseDirectHistoryDate handles unambiguous MM/DD/YYYY (day > 12)", () => {
  // 03/25/2024: second field (25) can't be a month, so it's MM/DD/YYYY.
  const result = parseDirectHistoryDate("03/25/2024");
  assert.equal(result, "2024-03-25T00:00:00.000Z");
});

test("parseDirectHistoryDate refuses to guess an ambiguous DD/MM vs MM/DD date", () => {
  // 05/03/2024: both fields <= 12, genuinely ambiguous without locale context.
  assert.equal(parseDirectHistoryDate("05/03/2024"), null);
});

test("parseDirectHistoryDate rejects malformed or missing dates", () => {
  assert.equal(parseDirectHistoryDate("not-a-date"), null);
  assert.equal(parseDirectHistoryDate(""), null);
  assert.equal(parseDirectHistoryDate(undefined), null);
  assert.equal(parseDirectHistoryDate("2024-13-01"), null);
  assert.equal(parseDirectHistoryDate("2024-01-32"), null);
});

// ─── parseFullExportStartTime ─────────────────────────────────────────────

test("parseFullExportStartTime handles YYYY-MM-DD HH:MM:SS as real UTC instant", () => {
  const result = parseFullExportStartTime("2024-01-15 14:30:00");
  assert.equal(result, "2024-01-15T14:30:00.000Z");
});

test("parseFullExportStartTime handles a date-only value as UTC midnight", () => {
  const result = parseFullExportStartTime("2024-01-15");
  assert.equal(result, "2024-01-15T00:00:00.000Z");
});

test("parseFullExportStartTime rejects malformed or missing timestamps", () => {
  assert.equal(parseFullExportStartTime("not-a-date"), null);
  assert.equal(parseFullExportStartTime(""), null);
  assert.equal(parseFullExportStartTime(undefined), null);
});

// ─── parseFullExportDurationSeconds ───────────────────────────────────────

test("parseFullExportDurationSeconds parses H:MM:SS into whole seconds", () => {
  assert.equal(parseFullExportDurationSeconds("0:42:10"), 2530);
  assert.equal(parseFullExportDurationSeconds("1:00:00"), 3600);
  assert.equal(parseFullExportDurationSeconds("0:00:05"), 5);
});

test("parseFullExportDurationSeconds rejects malformed or missing durations", () => {
  assert.equal(parseFullExportDurationSeconds("85%"), null);
  assert.equal(parseFullExportDurationSeconds("not-a-duration"), null);
  assert.equal(parseFullExportDurationSeconds(""), null);
  assert.equal(parseFullExportDurationSeconds(undefined), null);
});
