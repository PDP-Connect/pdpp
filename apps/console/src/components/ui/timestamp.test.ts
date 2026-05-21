import assert from "node:assert/strict";
import test from "node:test";

import { parseTimestampValue } from "./timestamp.tsx";

test("date-only strings are calendar dates, not localizable instants", () => {
  const parsed = parseTimestampValue("2005-07-10");

  assert.equal(parsed?.kind, "calendar-date");
  assert.equal(parsed.dateTime, "2005-07-10");
  assert.equal(parsed.date.toISOString(), "2005-07-10T00:00:00.000Z");
});

test("invalid date-only strings do not normalize into another calendar day", () => {
  assert.equal(parseTimestampValue("2026-02-31"), null);
});

test("date-time strings are instants", () => {
  const parsed = parseTimestampValue("2026-04-25T18:30:00-05:00");

  assert.equal(parsed?.kind, "instant");
  assert.equal(parsed.dateTime, "2026-04-25T23:30:00.000Z");
});

test("explicit calendar-date display uses the source date component", () => {
  const parsed = parseTimestampValue("2026-04-25T23:30:00Z", "calendar-date");

  assert.equal(parsed?.kind, "calendar-date");
  assert.equal(parsed.dateTime, "2026-04-25");
});

test("sql datetime strings are treated as UTC reference instants", () => {
  const parsed = parseTimestampValue("2026-04-25 18:30:00");

  assert.equal(parsed?.kind, "instant");
  assert.equal(parsed.dateTime, "2026-04-25T18:30:00.000Z");
});
