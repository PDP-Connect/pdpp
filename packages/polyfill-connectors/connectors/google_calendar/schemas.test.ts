// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { calendarsSchema, eventsSchema, validateRecord } from "./schemas.ts";

const CALENDAR_RECORD = {
  id: "primary",
  summary: "Work",
  time_zone: "America/Chicago",
  access_role: "owner",
  primary: true,
  source: "google_calendar_api",
};

const EVENT_RECORD = {
  id: "evt1",
  calendar_id: "primary",
  summary: "Standup",
  description: null,
  location: null,
  status: "confirmed",
  deleted: false,
  start: "2026-08-01T09:00:00-05:00",
  start_date: null,
  end: "2026-08-01T09:15:00-05:00",
  end_date: null,
  all_day: false,
  organizer_email: "owner@example.com",
  organizer_display_name: null,
  attendees: [
    {
      email: "a@example.com",
      display_name: null,
      organizer: true,
      optional: false,
      response_status: "accepted",
      self: true,
    },
  ],
  recurrence: ["RRULE:FREQ=DAILY"],
  recurring_event_id: null,
  html_link: "https://calendar.google.com/event?eid=abc",
  updated: "2026-08-01T00:00:00Z",
  source: "google_calendar_api",
};

test("calendars schema accepts a representative record", () => {
  assert.equal(calendarsSchema.safeParse(CALENDAR_RECORD).success, true);
});

test("calendars schema rejects a wrong source literal", () => {
  assert.equal(calendarsSchema.safeParse({ ...CALENDAR_RECORD, source: "ical" }).success, false);
});

test("events schema accepts a representative event with attendees and recurrence", () => {
  const result = eventsSchema.safeParse(EVENT_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("events schema accepts a cancelled tombstone with nulled fields", () => {
  const tombstone = {
    ...EVENT_RECORD,
    status: "cancelled",
    deleted: true,
    summary: null,
    attendees: [],
    recurrence: null,
  };
  assert.equal(eventsSchema.safeParse(tombstone).success, true);
});

test("events schema accepts an all-day event using start_date instead of start", () => {
  const allDay = {
    ...EVENT_RECORD,
    start: null,
    start_date: "2026-08-01",
    end: null,
    end_date: "2026-08-02",
    all_day: true,
  };
  assert.equal(eventsSchema.safeParse(allDay).success, true);
});

test("events schema rejects a missing status", () => {
  const { status: _omit, ...withoutStatus } = EVENT_RECORD;
  assert.equal(eventsSchema.safeParse(withoutStatus).success, false);
});

test("validateRecord routes by stream and passes unknown streams through", () => {
  assert.equal(validateRecord("calendars", CALENDAR_RECORD).ok, true);
  assert.equal(validateRecord("events", EVENT_RECORD).ok, true);
  assert.equal(validateRecord("attachments", { id: "1" }).ok, true);
});
