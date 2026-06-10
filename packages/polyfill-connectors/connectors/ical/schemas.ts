/**
 * Zod schemas for iCal stream records. Shape-check-before-emit per
 * docs/connector-authoring-guide.md §3.
 *
 * Ground truth: `buildEventRecord` in parsers.ts (the only thing index.ts
 * passes to `emitRecord("events", ...)`). Schemas mirror the *emitted* shape,
 * not the manifest's looser JSON Schema:
 *
 *   - `id` is `hashId(...)` → a 24-char lowercase hex digest (sha256 sliced).
 *   - `uid` is the raw VEVENT UID, copied verbatim from the .ics source. It is
 *     a structural identifier (often an email-like or @-suffixed token) but is
 *     attacker-influenced free text in practice, so it is a bounded
 *     `pdppSafeText` rather than a bare string — it can carry arbitrary user
 *     calendar content and is required.
 *   - `start` / `end` come from `parseIcsDate`, which emits THREE shapes: UTC
 *     (`...Z`), local-without-offset (`...T13:00:00`, no trailing Z), and the
 *     `Date.prototype.toISOString()` fallback (`...T13:00:00.000Z`). The schema
 *     accepts all three via a date-prefix regex that does NOT force a trailing
 *     `Z` — forcing `Z` would reject the legitimate local-time form.
 *   - `summary` / `description` / `location` / `calendar_name` are free-form
 *     human text → `pdppSafeText` (calendar_name is the .ics filename or the
 *     subscription hostname, still owner-controlled text).
 *   - `attendees` is an array of `{ email, name|null, role|null }` objects built
 *     by `applyAttendee`. `email` is the mailto-extracted address; `name` (CN
 *     param) and `role` (ROLE param) are free-form/short and nullable.
 *   - `organizer_email` is the mailto-extracted organizer address or null.
 *   - `all_day` is a boolean; `status` / `rrule` are short structural strings
 *     copied verbatim from the source, nullable.
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const ICAL_ID_RE = /^[0-9a-f]{24}$/; // hashId: 24-char sha256 hex slice
// parseIcsDate emits UTC (...Z), local (...T..:..:.. no offset), or
// toISOString (...T..:..:...000Z). Match the date+time prefix; do not force Z.
const ICAL_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/; // permissive; mailto: payloads are loose

const icalIdSchema = z.string().regex(ICAL_ID_RE, "must be a 24-char hex iCal record id");
const icalDateSchema = z.string().regex(ICAL_DATE_RE, "must be an ISO-8601 datetime prefix");
const emailSchema = z.string().regex(EMAIL_RE, "must look like an email address").max(320);

/**
 * One attendee, as built by `applyAttendee`. `email` is required (the builder
 * only pushes an attendee when a mailto: address was extracted); `name` (CN)
 * and `role` (ROLE) are free-form/short and nullable.
 */
const attendeeSchema = z.object({
  email: emailSchema,
  name: pdppSafeText.max(500).nullable(),
  role: z.string().min(1).max(64).nullable(),
});

/**
 * events stream: one record per parsed VEVENT with a UID and a start.
 * Cursor: start (latest_start).
 */
export const eventsSchema = z.object({
  id: icalIdSchema,
  calendar_name: pdppSafeText.max(500),
  summary: pdppSafeText.max(4000).nullable(),
  description: pdppSafeText.max(100_000).nullable(),
  location: pdppSafeText.max(4000).nullable(),
  start: icalDateSchema,
  end: icalDateSchema.nullable(),
  all_day: z.boolean(),
  organizer_email: emailSchema.nullable(),
  attendees: z.array(attendeeSchema),
  status: z.string().min(1).max(64).nullable(),
  rrule: z.string().min(1).max(2000).nullable(),
  uid: pdppSafeText.max(2000),
});

/**
 * Stream → schema registry. Single source of truth for emitted streams.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  events: eventsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
