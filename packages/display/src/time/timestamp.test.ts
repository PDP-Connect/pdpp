// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  formatCalendarDate,
  formatInstantAbsolute,
  formatRelative,
  formatTimestampTitle,
  parseTimestampValue,
} from "./timestamp.ts";

const JANUARY_SECOND_2024_RE = /Jan 2, 2024/;

test("parses valid instants and rejects unparseable input", () => {
  assert.equal(parseTimestampValue(""), null);
  assert.equal(parseTimestampValue("not-a-date"), null);

  const parsed = parseTimestampValue("2024-01-02T03:04:05Z");
  assert.ok(parsed);
  assert.equal(parsed.kind, "instant");
  assert.equal(parsed.date.toISOString(), "2024-01-02T03:04:05.000Z");
});

test("keeps calendar dates timezone-stable and validates their calendar values", () => {
  const calendarDate = parseTimestampValue("2024-03-15");
  assert.ok(calendarDate);
  assert.equal(calendarDate.kind, "calendar-date");
  assert.equal(calendarDate.dateTime, "2024-03-15");
  assert.equal(formatCalendarDate(calendarDate.date), "Mar 15, 2024");
  assert.equal(parseTimestampValue("2024-02-30"), null);
});

test("accepts a calendar-date prefix only when explicitly requested", () => {
  const parsed = parseTimestampValue("2024-03-15T12:00:00Z", "calendar-date");
  assert.ok(parsed);
  assert.equal(parsed.kind, "calendar-date");
  assert.equal(parsed.dateTime, "2024-03-15");
});

test("normalizes offset-less SQL and ISO date-times as UTC instants", () => {
  const sql = parseTimestampValue("2024-01-02 03:04:05");
  const iso = parseTimestampValue("2024-01-02T03:04:05");
  assert.ok(sql);
  assert.ok(iso);
  assert.equal(sql.date.toISOString(), "2024-01-02T03:04:05.000Z");
  assert.equal(iso.date.toISOString(), "2024-01-02T03:04:05.000Z");
});

test("uses UTC output before mount for SSR-stable absolute labels and titles", () => {
  const date = new Date("2024-01-02T03:04:05Z");
  assert.equal(formatInstantAbsolute(date, "date", false), "Jan 2, 2024");
  assert.match(formatInstantAbsolute(date, "datetime", false), JANUARY_SECOND_2024_RE);
  assert.match(formatInstantAbsolute(date, "time", false), JANUARY_SECOND_2024_RE);
  assert.equal(formatTimestampTitle(date, false), "2024-01-02T03:04:05.000Z");
});

test("formats relative labels at the established cutoffs", () => {
  const now = Date.UTC(2024, 0, 1, 0, 0, 0);
  assert.equal(formatRelative(new Date(now - 44_999), now), "just now");
  assert.equal(formatRelative(new Date(now - 45_000), now), "1 minute ago");
  assert.equal(formatRelative(new Date(now + 2 * 60 * 60_000), now), "in 2 hours");
});
