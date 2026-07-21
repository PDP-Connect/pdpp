// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the iCal connector. Kept free of Node I/O and fetch so
// they can be unit-tested in isolation (see parsers.test.ts). The file
// walker and subscription fetcher live in index.ts.

import { createHash } from "node:crypto";
import type { IcsAttendee, IcsEvent, IcsEventOut, IcsLine } from "./types.ts";

// ─── Constants ──────────────────────────────────────────────────────────

// Record ID length (hex). 24 chars = 96 bits of entropy — safe for a user's
// personal calendar event set.
const RECORD_ID_HASH_LENGTH = 24;

// ─── Module-scoped regexes (Biome useTopLevelRegex) ─────────────────────

export const ICAL_LINE_FOLD_RE = /\r?\n[ \t]/g;
export const ICAL_DATETIME_UTC_RE = /^\d{8}T\d{6}Z$/;
export const ICAL_DATETIME_LOCAL_RE = /^\d{8}T\d{6}$/;
export const ICAL_MAILTO_RE = /mailto:([^>]+)/i;
export const ICAL_ESC_NEWLINE_RE = /\\n/g;
export const ICAL_ESC_COMMA_RE = /\\,/g;
export const ICS_EXT_RE = /\.ics$/i;
export const RETRYABLE_FETCH_RE = /ECONN|fetch failed/i;
export const ICAL_LINE_SPLIT_RE = /\r?\n/;

// ─── Low-level helpers ─────────────────────────────────────────────────

export function hashId(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, RECORD_ID_HASH_LENGTH);
}

/** RFC 5545 line folding: continuation lines start with space/tab. */
export function unfoldIcal(text: string): string {
  return text.replace(ICAL_LINE_FOLD_RE, "");
}

export function unescapeIcsText(value: string): string {
  return value.replace(ICAL_ESC_NEWLINE_RE, "\n").replace(ICAL_ESC_COMMA_RE, ",");
}

export function parseIcsDate(raw: string | undefined, isDateOnly: boolean): string | null {
  if (!raw) {
    return null;
  }
  if (isDateOnly) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00Z`;
  }
  if (ICAL_DATETIME_UTC_RE.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`;
  }
  if (ICAL_DATETIME_LOCAL_RE.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}`;
  }
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) {
    return d.toISOString();
  }
  return null;
}

/**
 * Parse one unfolded VEVENT property line into name, value, and params.
 * Returns null for lines without a `name:value` shape (blank / comment /
 * malformed). Parameters (e.g. `DTSTART;VALUE=DATE:20240605`) land in the
 * `params` bag with upper-cased keys.
 */
export function parseIcsLine(raw: string): IcsLine | null {
  const line = raw.trim();
  const sepIdx = line.indexOf(":");
  if (sepIdx < 0) {
    return null;
  }
  const key = line.slice(0, sepIdx);
  const value = line.slice(sepIdx + 1);
  const [name, ...paramPairs] = key.split(";");
  const params: Record<string, string | undefined> = {};
  for (const p of paramPairs) {
    const [k, v] = p.split("=");
    if (k) {
      params[k.toUpperCase()] = v;
    }
  }
  return {
    name: (name ?? "").toUpperCase(),
    value,
    params,
    isDateOnly: params.VALUE === "DATE",
  };
}

// ─── Property → event mutations ────────────────────────────────────────

function applyOrganizer(event: IcsEvent, value: string): void {
  const m = value.match(ICAL_MAILTO_RE);
  if (m?.[1]) {
    event.organizer_email = m[1];
  }
}

function applyAttendee(event: IcsEvent, value: string, params: IcsLine["params"]): void {
  const m = value.match(ICAL_MAILTO_RE);
  if (!m?.[1]) {
    return;
  }
  const attendee: IcsAttendee = {
    email: m[1],
    name: params.CN || null,
    role: params.ROLE || null,
  };
  event.attendees.push(attendee);
}

/**
 * Apply a single property line to the in-flight event. Keeping this as a
 * plain switch (one branch per property) keeps each branch cheap and
 * keeps the dispatch table readable vs. a Record<string, fn>.
 */
export function applyIcsProperty(event: IcsEvent, line: IcsLine): void {
  switch (line.name) {
    case "UID":
      event.uid = line.value;
      return;
    case "SUMMARY":
      event.summary = unescapeIcsText(line.value);
      return;
    case "DESCRIPTION":
      event.description = unescapeIcsText(line.value);
      return;
    case "LOCATION":
      event.location = line.value;
      return;
    case "DTSTART":
      event.start = parseIcsDate(line.value, line.isDateOnly);
      event.all_day = line.isDateOnly;
      return;
    case "DTEND":
      event.end = parseIcsDate(line.value, line.isDateOnly);
      return;
    case "ORGANIZER":
      applyOrganizer(event, line.value);
      return;
    case "ATTENDEE":
      applyAttendee(event, line.value, line.params);
      return;
    case "STATUS":
      event.status = line.value;
      return;
    case "RRULE":
      event.rrule = line.value;
      return;
    default:
      return;
  }
}

// ─── Top-level parser ──────────────────────────────────────────────────

/**
 * Parse a full `.ics` source string into zero-or-more IcsEvent records.
 * Line folding per RFC 5545 is unwrapped first, then VEVENT blocks are
 * framed by BEGIN/END markers and each property line delegates to
 * `applyIcsProperty`.
 */
export function parseIcs(source: string, calendarName: string): IcsEvent[] {
  const unfolded = unfoldIcal(source);
  const lines = unfolded.split(ICAL_LINE_SPLIT_RE);
  const events: IcsEvent[] = [];
  let cur: IcsEvent | null = null;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === "BEGIN:VEVENT") {
      cur = { calendar_name: calendarName, attendees: [] };
      continue;
    }
    if (trimmed === "END:VEVENT") {
      if (cur) {
        events.push(cur);
      }
      cur = null;
      continue;
    }
    if (!cur) {
      continue;
    }
    const parsed = parseIcsLine(trimmed);
    if (parsed) {
      applyIcsProperty(cur, parsed);
    }
  }
  return events;
}

// ─── Event record builder + cursor helpers ─────────────────────────────

/**
 * Build an emittable `events`-stream record from a parsed IcsEvent.
 * Returns null when UID or start is missing — index.ts skips those
 * silently since iCal sources sometimes emit half-formed stubs.
 */
export function buildEventRecord(event: IcsEvent, calendarName: string): IcsEventOut | null {
  if (!(event.uid && event.start)) {
    return null;
  }
  return {
    id: hashId(`${calendarName}|${event.uid}|${event.start}`),
    calendar_name: calendarName,
    summary: event.summary ?? null,
    description: event.description ?? null,
    location: event.location ?? null,
    start: event.start,
    end: event.end ?? null,
    all_day: !!event.all_day,
    organizer_email: event.organizer_email ?? null,
    attendees: event.attendees ?? [],
    status: event.status ?? null,
    rrule: event.rrule ?? null,
    uid: event.uid,
  };
}

export function isBeforeCursor(start: string, since: string | undefined): boolean {
  return Boolean(since && start <= since);
}

export function advanceCursor(prev: string | undefined, next: string): string {
  if (!prev || next > prev) {
    return next;
  }
  return prev;
}
