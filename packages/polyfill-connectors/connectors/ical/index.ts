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

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type EmittedMessage, runConnector } from "../../src/connector-runtime.ts";
import {
  advanceCursor,
  buildEventRecord,
  ICS_EXT_RE,
  isBeforeCursor,
  parseIcs,
  RETRYABLE_FETCH_RE,
} from "./parsers.ts";
import type { IcalState, IcsSource } from "./types.ts";

async function fetchIcs(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ics_fetch_${res.status}: ${url}`);
  }
  return res.text();
}

/**
 * Read every .ics file inside `dir` (if it exists) into an IcsSource.
 * Silently swallows read errors — matches the prior inline try/catch
 * behavior in collect() before decomposition.
 */
async function loadLocalSources(dir: string): Promise<IcsSource[]> {
  const sources: IcsSource[] = [];
  if (!existsSync(dir)) {
    return sources;
  }
  try {
    const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".ics"));
    for (const f of files) {
      sources.push({
        name: f.replace(ICS_EXT_RE, ""),
        text: await readFile(join(dir, f), "utf8"),
      });
    }
  } catch {
    /* ignore — fall through with whatever we collected */
  }
  return sources;
}

/**
 * Fetch every subscription URL. Failed URLs report a SKIP_RESULT via the
 * runtime's emit() and are left out of the returned array.
 */
async function loadSubscriptionSources(
  urls: readonly string[],
  emit: (msg: EmittedMessage) => Promise<void>
): Promise<IcsSource[]> {
  const sources: IcsSource[] = [];
  for (const url of urls) {
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
  return sources;
}

function readSubscriptionUrls(): string[] {
  return (process.env.ICAL_SUBSCRIPTION_URL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Cursor state mutated while iterating sources. */
interface EventCursor {
  latest: string | undefined;
  since: string | undefined;
}

async function emitEventsFromSource(
  src: IcsSource,
  cursor: EventCursor,
  emitRecord: (stream: string, rec: Record<string, unknown>) => Promise<void>,
  progress: (message: string, opts?: { stream?: string }) => Promise<void>
): Promise<void> {
  await progress(`Parsing ${src.name}`, { stream: "events" });
  const events = parseIcs(src.text, src.name);
  for (const e of events) {
    const rec = buildEventRecord(e, src.name);
    if (!rec) {
      continue;
    }
    if (isBeforeCursor(rec.start, cursor.since)) {
      continue;
    }
    cursor.latest = advanceCursor(cursor.latest, rec.start);
    await emitRecord("events", { ...rec });
  }
}

runConnector({
  name: "ical",
  retryablePattern: RETRYABLE_FETCH_RE,
  async collect({ state, emit, emitRecord, progress }) {
    const dir = process.env.ICAL_IMPORT_DIR || join(homedir(), ".pdpp/imports/ical");
    const subscriptionUrls = readSubscriptionUrls();

    const localSources = await loadLocalSources(dir);
    const remoteSources = await loadSubscriptionSources(subscriptionUrls, emit);
    const sources = [...localSources, ...remoteSources];

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
    const cursor: EventCursor = {
      since: typedState.events?.latest_start,
      latest: typedState.events?.latest_start,
    };

    for (const src of sources) {
      await emitEventsFromSource(src, cursor, emitRecord, progress);
    }

    await emit({
      type: "STATE",
      stream: "events",
      cursor: { latest_start: cursor.latest },
    });
  },
});
