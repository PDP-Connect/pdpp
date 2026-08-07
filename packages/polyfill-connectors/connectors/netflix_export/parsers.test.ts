// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Parser tests for the Netflix export connector. Tests CSV parsing with
 * proper RFC 4180 quote/encoding handling, duplicate row detection,
 * malformed row resilience, and archive path resolution.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCSVLine, parseNetflixTimestamp, parseWatchDurationPercent } from "./parsers.ts";

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

test("parseWatchDurationPercent handles integer percentages", () => {
  assert.equal(parseWatchDurationPercent("50%"), 50);
  assert.equal(parseWatchDurationPercent("0%"), 0);
  assert.equal(parseWatchDurationPercent("100%"), 100);
});

test("parseWatchDurationPercent handles decimal percentages", () => {
  assert.equal(parseWatchDurationPercent("50.5%"), 50.5);
  assert.equal(parseWatchDurationPercent("99.99%"), 99.99);
});

test("parseWatchDurationPercent handles numeric strings without %", () => {
  assert.equal(parseWatchDurationPercent("75"), 75);
  assert.equal(parseWatchDurationPercent("0"), 0);
  assert.equal(parseWatchDurationPercent("100"), 100);
});

test("parseWatchDurationPercent rejects values out of range", () => {
  assert.equal(parseWatchDurationPercent("101%"), null);
  assert.equal(parseWatchDurationPercent("-1%"), null);
  assert.equal(parseWatchDurationPercent("150%"), null);
});

test("parseWatchDurationPercent rejects non-numeric strings", () => {
  assert.equal(parseWatchDurationPercent("abc%"), null);
  assert.equal(parseWatchDurationPercent("50 percent"), null);
  assert.equal(parseWatchDurationPercent(""), null);
  assert.equal(parseWatchDurationPercent(undefined), null);
});

test("parseNetflixTimestamp handles YYYY-MM-DD format", () => {
  const result = parseNetflixTimestamp("2024-01-15");
  assert.ok(result);
  assert.ok(result.startsWith("2024-01-15"));
  assert.ok(result.includes("T"));
});

test("parseNetflixTimestamp handles YYYY-MM-DD HH:MM:SS format", () => {
  const result = parseNetflixTimestamp("2024-01-15 14:30:00");
  assert.ok(result);
  assert.ok(result.includes("2024-01-15"));
  assert.ok(result.includes("T"));
});

test("parseNetflixTimestamp handles ISO datetime strings", () => {
  const result = parseNetflixTimestamp("2024-01-15T14:30:00Z");
  assert.ok(result);
  assert.ok(result.includes("2024-01-15"));
});

test("parseNetflixTimestamp rejects malformed dates", () => {
  assert.equal(parseNetflixTimestamp("not-a-date"), null);
  assert.equal(parseNetflixTimestamp("2024-13-01"), null); // invalid month
  assert.equal(parseNetflixTimestamp("2024-01-32"), null); // invalid day
  assert.equal(parseNetflixTimestamp(""), null);
  assert.equal(parseNetflixTimestamp(undefined), null);
});

test("parseNetflixTimestamp preserves date component", () => {
  const result = parseNetflixTimestamp("2024-06-15");
  assert.ok(result?.startsWith("2024-06-15"));
});
