// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure date-filter logic for the Explore canvas — the ONE honest statement of the
 * active time window (THE-LENS Gate 1, date-controls cell).
 *
 * There is exactly ONE date filter in Explore, derived from the URL `(since, until)`
 * pair, rendered as ONE chip, edited by ONE popover. This module owns:
 *   - `dateChipLabel(since, until, now)` — derive the single honest phrase
 *     (sliding `Last 7 days` / growing `Since Jun 12` / fixed `May 1 – May 14` /
 *     empty `Any time`) from the canonical `(since, until)`.
 *   - the local-day ↔ server-ISO edge conversion for a CUSTOM fixed window, so the
 *     boundary never lies about which records it includes.
 *   - reflecting the canonical `(since, until)` back into the From/To inputs.
 *
 * ── THE DAY TIMEZONE (honesty invariant) ──────────────────────────────────────
 * THE-LENS: "all boundaries are the OWNER'S LOCAL timezone… A record's day-grouping
 * in the feed must use the SAME local tz so the filter and the feed agree." The
 * Explore feed groups days in `explore-feed-grouping.ts` with a PINNED, SSR-
 * deterministic day zone (`UTC` today). The filter MUST bucket in the SAME zone or
 * the boundary lies vs. the feed. So `DAY_TZ` here is that one canonical day zone —
 * not the browser's wandering local zone (which SSR cannot see, breaking hydration
 * parity). Every function takes a `timeZone` arg defaulting to `DAY_TZ`, so the one
 * place to flip the canonical day zone (when the feed grouping does) is this const,
 * and tests can pin a zone to assert boundary math deterministically.
 *
 * ── INCLUSIVITY (honesty invariant) ───────────────────────────────────────────
 * The server window is HALF-OPEN: `[sinceMs, untilMs)` (assembler `isWithinWindow`:
 * `ms >= sinceMs` included, `ms >= untilMs` EXCLUDED). So:
 *   - `From = May 1` (inclusive from 00:00:00 local) → `since` = ISO of the START of
 *     May 1 in `DAY_TZ`. `ms >= sinceMs` includes all of May 1 onward. ✓
 *   - `To = May 14` (inclusive THROUGH 23:59:59.999 local) → `until` = ISO of the
 *     START of the NEXT day (May 15) in `DAY_TZ`. Because the upper bound is
 *     exclusive (`ms >= untilMs` excluded), everything strictly before May 15
 *     00:00:00 local — i.e. all of May 14 through 23:59:59.999 — is included. ✓
 * This is the off-by-one the previous `until` had: `Date.parse("2026-05-14")` is
 * UTC midnight at the START of May 14, which EXCLUDED the whole selected end day.
 *
 * Pure; no React, no Next, no client imports. Co-located test: `explore-date.test.ts`.
 */

import { sinceForRange } from "./explore-control-state.ts";

/** The canonical day zone — MUST match the feed grouping zone (see module doc). */
export const DAY_TZ = "UTC";

/** The resting Date-chip label (no window). Single source of truth for "no filter". */
export const ANY_TIME_LABEL = "Any time";

const DAY_MS = 86_400_000;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A local calendar day as `{ year, month (1-12), day }`. */
interface CalendarDay {
  day: number;
  month: number;
  year: number;
}

/** Parse a `YYYY-MM-DD` string into a calendar day, or null if it is not one. */
function parseYmd(value: string): CalendarDay | null {
  const m = value.match(YMD_RE);
  if (!m) {
    return null;
  }
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/**
 * The day, in `timeZone`, that contains the instant `ms` — as a calendar day. Uses
 * `Intl.DateTimeFormat` so the zone is explicit and SSR-deterministic (no reliance
 * on the host's `TZ`). The `en-CA` locale yields a `YYYY-MM-DD`-shaped value.
 */
function calendarDayInZone(ms: number, timeZone: string): CalendarDay {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day") };
}

/**
 * The UTC-epoch ms of the START (00:00:00.000) of a calendar `day` AS OBSERVED in
 * `timeZone`. We find the zone's offset at the target day by probing a UTC guess and
 * reading back the wall-clock parts, then correcting — robust across DST because the
 * correction is computed from the actual rendered offset, not a fixed assumption.
 */
function startOfDayMs(day: CalendarDay, timeZone: string): number {
  // First guess: treat the wall-clock as if it were UTC.
  const utcGuess = Date.UTC(day.year, day.month - 1, day.day, 0, 0, 0, 0);
  // Read what wall-clock the zone shows for that instant, derive the offset, correct.
  const shown = wallClockMsInZone(utcGuess, timeZone);
  const offset = shown - utcGuess;
  return utcGuess - offset;
}

/** The wall-clock instant (as if-UTC ms) that `timeZone` displays for epoch `ms`. */
function wallClockMsInZone(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
}

/** Format a calendar day back to `YYYY-MM-DD`. */
function formatYmd(day: CalendarDay): string {
  const mm = String(day.month).padStart(2, "0");
  const dd = String(day.day).padStart(2, "0");
  return `${day.year}-${mm}-${dd}`;
}

/**
 * Resolve a CUSTOM fixed window from the `From`/`To` date inputs (each `YYYY-MM-DD`
 * in the owner's day zone) into the canonical server `(since, until)` ISO strings.
 *
 *   - `since` = ISO of the START of the `from` day (inclusive lower bound).
 *   - `until` = ISO of the START of the day AFTER `to` (exclusive upper bound = the
 *     whole `to` day is included; see the inclusivity invariant in the module doc).
 *
 * Either endpoint may be empty (open-ended). An empty pair yields empty strings
 * (clear). If both are present and `to < from`, the endpoints are swapped so the
 * window is always well-formed (the UI also guards this, belt-and-suspenders).
 */
export function resolveCustomRange(
  from: string,
  to: string,
  timeZone: string = DAY_TZ
): { since: string; until: string } {
  let fromDay = parseYmd(from);
  let toDay = parseYmd(to);
  if (fromDay && toDay && startOfDayMs(toDay, timeZone) < startOfDayMs(fromDay, timeZone)) {
    [fromDay, toDay] = [toDay, fromDay];
  }
  const since = fromDay ? new Date(startOfDayMs(fromDay, timeZone)).toISOString() : "";
  // Exclusive upper bound = START of the day AFTER `to`.
  const until = toDay ? new Date(startOfDayMs(toDay, timeZone) + DAY_MS).toISOString() : "";
  return { since, until };
}

/**
 * Reflect the canonical `(since, until)` back into the From/To date inputs (so a
 * preset, a typed `after:`/`before:`, or a reload always shows the resolved range
 * in Custom — Primer's "never hide the resolved range" lesson).
 *
 *   - `from` = the day `since` falls in.
 *   - `to`   = the INCLUSIVE end day, derived from the EXCLUSIVE `until` by stepping
 *     back 1ms (so an exclusive May 15 boundary reflects as the inclusive May 14).
 */
export function customRangeInputs(
  since: string,
  until: string,
  timeZone: string = DAY_TZ
): { from: string; to: string } {
  const from = since ? formatYmd(calendarDayInZone(Date.parse(since), timeZone)) : "";
  const to = until ? formatYmd(calendarDayInZone(Date.parse(until) - 1, timeZone)) : "";
  return { from, to };
}

/**
 * Resolve a lifted `after:`/`before:` pair into the canonical `(since, until)` nav
 * delta. Only an endpoint the user actually typed (non-null) overrides the canonical
 * window — the other side is carried forward by the caller (last-write-wins, never
 * stacks). Each typed endpoint goes through the SAME edge conversion the Custom picker
 * uses (`resolveCustomRange` → honest local-day ISO boundaries, inclusive end day), so
 * a typed `after:2026-01-01` and a Custom `From = 2026-01-01` produce the IDENTICAL
 * server `since`. Pure so the canonical-date normalization is one tested place — shared
 * by the in-app commit path AND the URL/SSR/reload normalizer (date-controls cell).
 *
 *   - both null            → `{}` (no date delta; nothing typed)
 *   - `after` typed only   → `{ since }`  (the other endpoint is carried forward)
 *   - `before` typed only  → `{ until }`
 *   - both typed           → `{ since, until }` (a fixed window)
 */
export function dateNavFromLift(
  after: string | null,
  before: string | null,
  timeZone: string = DAY_TZ
): { since?: string; until?: string } {
  if (after === null && before === null) {
    return {};
  }
  const resolved = resolveCustomRange(after ?? "", before ?? "", timeZone);
  const nav: { since?: string; until?: string } = {};
  if (after !== null) {
    nav.since = resolved.since;
  }
  if (before !== null) {
    nav.until = resolved.until;
  }
  return nav;
}

const MONTH_DAY_FMT_CACHE = new Map<string, Intl.DateTimeFormat>();

function monthDayFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = MONTH_DAY_FMT_CACHE.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone });
    MONTH_DAY_FMT_CACHE.set(timeZone, fmt);
  }
  return fmt;
}

/** "Jun 12" style label for an instant, in the day zone. */
function monthDayLabel(ms: number, timeZone: string): string {
  return monthDayFormatter(timeZone).format(new Date(ms));
}

/** Whether `since` is a relative-preset `since` whose end is "now" (a sliding window). */
function matchSlidingPreset(since: string, nowMs: number): string | null {
  if (since === sinceForRange("today", nowMs)) {
    return "Today";
  }
  if (since === sinceForRange("7d", nowMs)) {
    return "Last 7 days";
  }
  if (since === sinceForRange("30d", nowMs)) {
    return "Last 30 days";
  }
  return null;
}

/**
 * Derive the ONE honest chip phrase from the canonical `(since, until)`.
 *
 *   - empty `(since, until)`              → `Any time`
 *   - sliding preset (since matches a     → `Today` / `Last 7 days` / `Last 30 days`
 *     relative range, until empty)          (end behavior = NOW; reads as sliding)
 *   - growing (since set, until empty,    → `Since Jun 12`
 *     not a preset)                          (anchored start, still growing to now)
 *   - fixed window (both set)             → `May 1 – May 14` (inclusive end day)
 *
 * `now` (default `Date.now()`) lets the sliding-preset match + tests pin the clock.
 * `timeZone` (default `DAY_TZ`) keeps the rendered dates in the canonical day zone.
 */
export function dateChipLabel(
  since: string,
  until: string,
  now: number = Date.now(),
  timeZone: string = DAY_TZ
): string {
  if (!(since || until)) {
    return ANY_TIME_LABEL;
  }
  // Fixed window: both ends set. Render the INCLUSIVE end day (until is exclusive).
  if (since && until) {
    const sinceMs = Date.parse(since);
    const inclusiveEndMs = Date.parse(until) - 1;
    return `${monthDayLabel(sinceMs, timeZone)} – ${monthDayLabel(inclusiveEndMs, timeZone)}`;
  }
  // Until-only (no since): everything up to the inclusive end day.
  if (!since && until) {
    const inclusiveEndMs = Date.parse(until) - 1;
    return `Until ${monthDayLabel(inclusiveEndMs, timeZone)}`;
  }
  // Since-only: a sliding preset reads by its rolling name; otherwise it is growing.
  const preset = matchSlidingPreset(since, now);
  if (preset) {
    return preset;
  }
  return `Since ${monthDayLabel(Date.parse(since), timeZone)}`;
}
