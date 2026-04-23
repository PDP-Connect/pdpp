#!/usr/bin/env node

/**
 * PDPP iCal Connector (v0.1.0)
 *
 * Auth: none. User exports a calendar (.ics file) from Apple Calendar,
 * Google Calendar, Outlook, etc., and drops the file(s) into
 * ICAL_IMPORT_DIR (defaults ~/.pdpp/imports/ical/). Supports subscription
 * URLs via ICAL_SUBSCRIPTION_URL env var (comma-separated).
 *
 * Parses RFC 5545 (simplified) — VEVENT blocks with DTSTART, DTEND, SUMMARY,
 * LOCATION, DESCRIPTION, UID, ORGANIZER, ATTENDEE, RRULE, STATUS.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runConnector } from "../../src/connector-runtime.ts";

interface IcsAttendee {
  email: string;
  name: string | null;
  role: string | null;
}

interface IcsEvent {
  all_day?: boolean;
  attendees: IcsAttendee[];
  calendar_name: string;
  description?: string;
  end?: string | null;
  location?: string;
  organizer_email?: string;
  rrule?: string;
  start?: string | null;
  status?: string;
  summary?: string;
  uid?: string;
}

interface IcsSource {
  name: string;
  text: string;
}

interface IcalState {
  events?: { latest_start?: string };
}

// Record ID length (hex). 24 chars = 96 bits of entropy — safe for a user's
// personal calendar event set.
const RECORD_ID_HASH_LENGTH = 24;

// Module-level regexes (Biome useTopLevelRegex).
const ICAL_LINE_FOLD_RE = /\r?\n[ \t]/g;
const ICAL_DATETIME_UTC_RE = /^\d{8}T\d{6}Z$/;
const ICAL_DATETIME_LOCAL_RE = /^\d{8}T\d{6}$/;
const ICAL_MAILTO_RE = /mailto:([^>]+)/i;
const ICAL_ESC_NEWLINE_RE = /\\n/g;
const ICAL_ESC_COMMA_RE = /\\,/g;
const ICS_EXT_RE = /\.ics$/i;
const RETRYABLE_FETCH_RE = /ECONN|fetch failed/i;
const ICAL_LINE_SPLIT_RE = /\r?\n/;

const hashId = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, RECORD_ID_HASH_LENGTH);

function unfoldIcal(text: string): string {
  // RFC 5545 line folding: continuation lines start with space/tab.
  return text.replace(ICAL_LINE_FOLD_RE, "");
}

function parseIcsDate(raw: string | undefined, isDateOnly: boolean): string | null {
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

function parseIcs(source: string, calendarName: string): IcsEvent[] {
  const unfolded = unfoldIcal(source);
  const lines = unfolded.split(ICAL_LINE_SPLIT_RE);
  const events: IcsEvent[] = [];
  let cur: IcsEvent | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "BEGIN:VEVENT") {
      cur = { calendar_name: calendarName, attendees: [] };
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur) {
        events.push(cur);
      }
      cur = null;
      continue;
    }
    if (!cur) {
      continue;
    }
    const sepIdx = line.indexOf(":");
    if (sepIdx < 0) {
      continue;
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
    const isDateOnly = params.VALUE === "DATE";
    switch ((name ?? "").toUpperCase()) {
      case "UID":
        cur.uid = value;
        break;
      case "SUMMARY":
        cur.summary = value.replace(ICAL_ESC_NEWLINE_RE, "\n").replace(ICAL_ESC_COMMA_RE, ",");
        break;
      case "DESCRIPTION":
        cur.description = value.replace(ICAL_ESC_NEWLINE_RE, "\n").replace(ICAL_ESC_COMMA_RE, ",");
        break;
      case "LOCATION":
        cur.location = value;
        break;
      case "DTSTART":
        cur.start = parseIcsDate(value, isDateOnly);
        cur.all_day = isDateOnly;
        break;
      case "DTEND":
        cur.end = parseIcsDate(value, isDateOnly);
        break;
      case "ORGANIZER": {
        const m = value.match(ICAL_MAILTO_RE);
        if (m?.[1]) {
          cur.organizer_email = m[1];
        }
        break;
      }
      case "ATTENDEE": {
        const m = value.match(ICAL_MAILTO_RE);
        if (m?.[1]) {
          cur.attendees.push({
            email: m[1],
            name: params.CN || null,
            role: params.ROLE || null,
          });
        }
        break;
      }
      case "STATUS":
        cur.status = value;
        break;
      case "RRULE":
        cur.rrule = value;
        break;
      default:
        break;
    }
  }
  return events;
}

async function fetchIcs(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ics_fetch_${res.status}: ${url}`);
  }
  return res.text();
}

runConnector({
  name: "ical",
  retryablePattern: RETRYABLE_FETCH_RE,
  async collect({ state, emit, emitRecord, progress }) {
    const dir = process.env.ICAL_IMPORT_DIR || join(homedir(), ".pdpp/imports/ical");
    const subscriptionUrls = (process.env.ICAL_SUBSCRIPTION_URL || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const sources: IcsSource[] = [];
    try {
      if (existsSync(dir)) {
        const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".ics"));
        for (const f of files) {
          sources.push({
            name: f.replace(ICS_EXT_RE, ""),
            text: await readFile(join(dir, f), "utf8"),
          });
        }
      }
    } catch {
      /* ignore */
    }
    for (const url of subscriptionUrls) {
      try {
        const text = await fetchIcs(url);
        sources.push({ name: new URL(url).hostname, text });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await emit({
          type: "SKIP_RESULT",
          stream: "events",
          reason: "ics_fetch_failed",
          message: msg,
        });
      }
    }

    if (!sources.length) {
      await emit({
        type: "SKIP_RESULT",
        stream: "events",
        reason: "no_calendar_sources",
        message: `no .ics files in ${dir} and no ICAL_SUBSCRIPTION_URL set`,
      });
      return;
    }

    const typedState = state as IcalState;
    const sinceStart = typedState.events?.latest_start;
    let latest: string | undefined = sinceStart;

    for (const src of sources) {
      await progress(`Parsing ${src.name}`, { stream: "events" });
      const events = parseIcs(src.text, src.name);
      for (const e of events) {
        if (!(e.uid && e.start)) {
          continue;
        }
        if (sinceStart && e.start <= sinceStart) {
          continue;
        }
        const id = hashId(`${src.name}|${e.uid}|${e.start}`);
        await emitRecord("events", {
          id,
          calendar_name: src.name,
          summary: e.summary ?? null,
          description: e.description ?? null,
          location: e.location ?? null,
          start: e.start,
          end: e.end ?? null,
          all_day: !!e.all_day,
          organizer_email: e.organizer_email ?? null,
          attendees: e.attendees ?? [],
          status: e.status ?? null,
          rrule: e.rrule ?? null,
          uid: e.uid,
        });
        if (!latest || e.start > latest) {
          latest = e.start;
        }
      }
    }

    await emit({
      type: "STATE",
      stream: "events",
      cursor: { latest_start: latest },
    });
  },
});
