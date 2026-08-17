// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

const attendeeSchema = z.object({
  email: z.string().max(320).nullable(),
  display_name: pdppSafeText.max(500).nullable(),
  organizer: z.boolean(),
  optional: z.boolean(),
  response_status: z.string().max(64).nullable(),
  self: z.boolean(),
});

export const calendarsSchema = z.object({
  id: z.string().min(1),
  summary: pdppSafeText.max(2000).nullable(),
  time_zone: z.string().max(128).nullable(),
  access_role: z.string().max(64).nullable(),
  primary: z.boolean(),
  source: z.literal("google_calendar_api"),
});

export const eventsSchema = z.object({
  id: z.string().min(1),
  calendar_id: z.string().min(1),
  summary: pdppSafeText.max(4000).nullable(),
  description: pdppSafeText.max(1_000_000).nullable(),
  location: pdppSafeText.max(2000).nullable(),
  status: z.string().max(64),
  deleted: z.boolean(),
  start: z.string().datetime({ offset: true }).nullable(),
  start_date: z.string().max(10).nullable(),
  end: z.string().datetime({ offset: true }).nullable(),
  end_date: z.string().max(10).nullable(),
  all_day: z.boolean(),
  organizer_email: z.string().max(320).nullable(),
  organizer_display_name: pdppSafeText.max(500).nullable(),
  attendees: z.array(attendeeSchema),
  recurrence: z.array(z.string().max(2000)).nullable(),
  recurring_event_id: z.string().nullable(),
  html_link: z.string().max(2048).nullable(),
  updated: z.string().datetime({ offset: true }).nullable(),
  source: z.literal("google_calendar_api"),
});

const SCHEMAS = {
  calendars: calendarsSchema,
  events: eventsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
