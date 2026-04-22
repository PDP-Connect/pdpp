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
import { createInterface } from "node:readline";
import type {
  EmittedMessage,
  RecordData,
  StreamScope,
} from "../../src/connector-runtime.ts";
import { stringifyForJsonl } from "../../src/safe-emit.ts";
import { resourceSet } from "../../src/scope-filters.ts";

interface StartMessage {
  scope?: { streams?: readonly StreamScope[] };
  state?: { events?: { latest_start?: string } };
  type: string;
}

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

const rl = createInterface({ input: process.stdin, terminal: false });
const emit = (m: EmittedMessage): boolean =>
  process.stdout.write(stringifyForJsonl(m));
const flushAndExit = (code: number): void => {
  if (process.stdout.writableLength > 0) {
    process.stdout.once("drain", () => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  } else {
    process.exit(code);
  }
};
const fail = (m: string, r = false): void => {
  emit({
    type: "DONE",
    status: "failed",
    records_emitted: 0,
    error: { message: m, retryable: r },
  });
  flushAndExit(1);
};
const nowIso = (): string => new Date().toISOString();
const hashId = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, 24);

function unfoldIcal(text: string): string {
  // RFC 5545 line folding: continuation lines start with space/tab.
  return text.replace(/\r?\n[ \t]/g, "");
}

function parseIcsDate(
  raw: string | undefined,
  isDateOnly: boolean
): string | null {
  if (!raw) {
    return null;
  }
  if (isDateOnly) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00Z`;
  }
  if (/^\d{8}T\d{6}Z$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`;
  }
  if (/^\d{8}T\d{6}$/.test(raw)) {
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
  const lines = unfolded.split(/\r?\n/);
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
        cur.summary = value.replace(/\\n/g, "\n").replace(/\\,/g, ",");
        break;
      case "DESCRIPTION":
        cur.description = value.replace(/\\n/g, "\n").replace(/\\,/g, ",");
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
        const m = value.match(/mailto:([^>]+)/i);
        if (m?.[1]) {
          cur.organizer_email = m[1];
        }
        break;
      }
      case "ATTENDEE": {
        const m = value.match(/mailto:([^>]+)/i);
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

async function main(): Promise<void> {
  const startMsg = await new Promise<StartMessage>((r, j) =>
    rl.once("line", (l) => {
      try {
        r(JSON.parse(l) as StartMessage);
      } catch (e) {
        j(e);
      }
    })
  );
  if (startMsg.type !== "START") {
    return fail("Expected START");
  }

  const requested = new Map<string, StreamScope>(
    (startMsg.scope?.streams || []).map((s) => [s.name, s])
  );
  if (!requested.size) {
    return fail("START.scope.streams is required");
  }

  const dir =
    process.env.ICAL_IMPORT_DIR || join(homedir(), ".pdpp/imports/ical");
  const subscriptionUrls = (process.env.ICAL_SUBSCRIPTION_URL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const sources: IcsSource[] = [];
  try {
    if (existsSync(dir)) {
      const files = (await readdir(dir)).filter((f) =>
        f.toLowerCase().endsWith(".ics")
      );
      for (const f of files) {
        sources.push({
          name: f.replace(/\.ics$/i, ""),
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
      emit({
        type: "SKIP_RESULT",
        stream: "events",
        reason: "ics_fetch_failed",
        message: msg,
      });
    }
  }

  if (!sources.length) {
    emit({
      type: "SKIP_RESULT",
      stream: "events",
      reason: "no_calendar_sources",
      message: `no .ics files in ${dir} and no ICAL_SUBSCRIPTION_URL set`,
    });
    emit({ type: "DONE", status: "succeeded", records_emitted: 0 });
    process.exit(0);
  }

  const state = startMsg.state || {};
  const emittedAt = nowIso();
  let total = 0;
  const _resFilters = new Map<string, ReadonlySet<string> | null>(
    (startMsg.scope?.streams || []).map((sr) => [sr.name, resourceSet(sr)])
  );
  const emitRecord = (s: string, d: RecordData): void => {
    if (d.id == null) {
      return;
    }
    const _rs = _resFilters.get(s);
    if (_rs && !_rs.has(String(d.id))) {
      return;
    }
    emit({
      type: "RECORD",
      stream: s,
      key: d.id,
      data: d,
      emitted_at: emittedAt,
    });
    total++;
  };

  const sinceStart = state.events?.latest_start;
  let latest: string | undefined = sinceStart;

  for (const src of sources) {
    emit({
      type: "PROGRESS",
      stream: "events",
      message: `Parsing ${src.name}`,
    });
    const events = parseIcs(src.text, src.name);
    for (const e of events) {
      if (!(e.uid && e.start)) {
        continue;
      }
      if (sinceStart && e.start <= sinceStart) {
        continue;
      }
      const id = hashId(`${src.name}|${e.uid}|${e.start}`);
      emitRecord("events", {
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

  emit({
    type: "STATE",
    stream: "events",
    cursor: { latest_start: latest },
  });
  emit({ type: "DONE", status: "succeeded", records_emitted: total });
  flushAndExit(0);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  emit({
    type: "DONE",
    status: "failed",
    records_emitted: 0,
    error: {
      message: msg,
      retryable: /ECONN|fetch failed/i.test(msg),
    },
  });
  flushAndExit(1);
});
