// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests for the iCal connector. Parsing lives in parsers.ts; these
 * assert the schema against records shaped exactly as `buildEventRecord`
 * produces them — the authoritative emitted shape. The accepted cases cover
 * the three `parseIcsDate` output forms (UTC `...Z`, local without offset, and
 * the `toISOString` `.000Z` fallback) plus the attendee array; the reject cases
 * cover the structural invariants the gate exists to protect.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { eventsSchema, validateRecord } from "./schemas.ts";

// Shaped exactly as buildEventRecord(...) returns: id is a 24-char hex hash,
// start/end are parseIcsDate output, attendees are {email,name,role}.
const EVENT_RECORD = {
  id: "a1b2c3d4e5f6a7b8c9d0e1f2",
  calendar_name: "Personal",
  summary: "Dentist appointment",
  description: "Cleaning + checkup\nBring insurance card",
  location: "123 Main St, Suite 200",
  start: "2024-06-05T13:00:00Z",
  end: "2024-06-05T14:00:00Z",
  all_day: false,
  organizer_email: "front-desk@dental.example",
  attendees: [
    { email: "owner@example.com", name: "the owner", role: "REQ-PARTICIPANT" },
    { email: "assistant@dental.example", name: null, role: null },
  ],
  status: "CONFIRMED",
  rrule: "FREQ=YEARLY;COUNT=2",
  uid: "evt-0001@dental.example",
};

test("events schema accepts a representative emitted record", () => {
  const result = eventsSchema.safeParse(EVENT_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("events schema accepts the local-time (no trailing Z) start form parseIcsDate emits", () => {
  const result = eventsSchema.safeParse({ ...EVENT_RECORD, start: "2024-06-05T13:00:00", end: null });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("events schema accepts the toISOString (.000Z) fallback date form", () => {
  const result = eventsSchema.safeParse({ ...EVENT_RECORD, start: "2024-06-05T13:00:00.000Z" });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("events schema accepts an all-day event with no attendees, nullable text", () => {
  const result = eventsSchema.safeParse({
    ...EVENT_RECORD,
    summary: null,
    description: null,
    location: null,
    organizer_email: null,
    attendees: [],
    status: null,
    rrule: null,
    all_day: true,
    start: "2024-07-04T00:00:00Z",
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("events schema rejects a non-hex id (id builder regression)", () => {
  assert.equal(eventsSchema.safeParse({ ...EVENT_RECORD, id: "not-a-hash" }).success, false);
});

test("events schema rejects a missing start (cursor field must be present)", () => {
  const { start: _omit, ...withoutStart } = EVENT_RECORD;
  assert.equal(eventsSchema.safeParse(withoutStart).success, false);
});

test("events schema rejects a non-datetime start (raw VEVENT value leaked through)", () => {
  assert.equal(eventsSchema.safeParse({ ...EVENT_RECORD, start: "20240605T130000Z" }).success, false);
});

test("events schema rejects an attendee object missing its email", () => {
  assert.equal(
    eventsSchema.safeParse({ ...EVENT_RECORD, attendees: [{ name: "the owner", role: null }] }).success,
    false
  );
});

test("validateRecord routes events and passes unknown streams through", () => {
  assert.equal(validateRecord("events", EVENT_RECORD).ok, true);
  // Unknown stream (none other declared) passes through unchanged.
  assert.equal(validateRecord("calendars", { id: "x" }).ok, true);
});

test("validateRecord reports issues for a drifted events record", () => {
  const result = validateRecord("events", { ...EVENT_RECORD, id: "bad" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path === "id"));
  }
});
