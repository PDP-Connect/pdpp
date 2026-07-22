"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";

import { cn } from "./utils.ts";

export type TimestampMode = "auto" | "relative" | "absolute";
export type TimestampPrecision = "datetime" | "date" | "time";
export type TimestampValueKind = "auto" | "calendar-date" | "instant";

export interface TimestampProps {
  className?: string;
  mode?: TimestampMode;
  precision?: TimestampPrecision;
  value: string | number | Date | null | undefined;
  valueKind?: TimestampValueKind;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RELATIVE_CUTOFF = 7 * DAY;

const localDateFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});

const localDateTimeFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

// Time-of-day only (e.g. "10:42 AM"). Used by `precision="time"` for rows that
// already sit under a day-group header — the header carries the date, so the row
// shows only WHEN in the day (the Slack / iMessage / Outlook pattern). The full
// date+time stays in the hover title.
const localTimeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const tooltipFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});

const relFmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const utcDateFmt = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const utcDateTimeFmt = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});

const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T/;
const SQL_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
const OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

type ParsedTimestamp =
  | {
      date: Date;
      dateTime: string;
      kind: "calendar-date";
      raw: string;
    }
  | {
      date: Date;
      dateTime: string;
      kind: "instant";
      raw: string;
    };

function parseCalendarDate(value: string, mode: "exact" | "date-prefix" = "exact"): ParsedTimestamp | null {
  const dateText = mode === "date-prefix" ? value.slice(0, 10) : value;
  const match = CALENDAR_DATE_RE.exec(dateText);
  if (!match) {
    return null;
  }
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return { date, dateTime: dateText, kind: "calendar-date", raw: value };
}

function normalizeInstantString(value: string): string {
  const trimmed = value.trim();
  if (SQL_DATETIME_RE.test(trimmed)) {
    return `${trimmed.replace(" ", "T")}Z`;
  }
  if (ISO_DATETIME_PREFIX_RE.test(trimmed) && !OFFSET_RE.test(trimmed)) {
    return `${trimmed}Z`;
  }
  return trimmed;
}

export function parseTimestampValue(
  value: TimestampProps["value"],
  valueKind: TimestampValueKind = "auto"
): ParsedTimestamp | null {
  if (value == null || value === "") {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (valueKind === "calendar-date") {
      return parseCalendarDate(trimmed, "date-prefix");
    }
    if (valueKind !== "instant") {
      // Calendar dates are not instants. Keep `YYYY-MM-DD` stable across
      // viewer, server, and container time zones.
      const looksLikeCalendarDate = CALENDAR_DATE_RE.test(trimmed);
      const calendarDate = parseCalendarDate(trimmed);
      if (calendarDate || looksLikeCalendarDate) {
        return calendarDate;
      }
    }
    const date = new Date(normalizeInstantString(trimmed));
    return Number.isNaN(date.getTime()) ? null : { date, dateTime: date.toISOString(), kind: "instant", raw: trimmed };
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : { date, dateTime: date.toISOString(), kind: "instant", raw: date.toISOString() };
}

function formatCalendarDate(d: Date): string {
  return utcDateFmt.format(d);
}

function formatInstantAbsolute(d: Date, precision: TimestampPrecision, mounted: boolean): string {
  if (precision === "date") {
    return mounted ? localDateFmt.format(d) : utcDateFmt.format(d);
  }
  if (precision === "time") {
    // Time-of-day only, post-mount (needs the viewer's local zone). Before mount
    // we have no zone, so fall back to the UTC date+time for a stable SSR string;
    // it swaps to local time-of-day on hydration.
    return mounted ? localTimeFmt.format(d) : utcDateTimeFmt.format(d);
  }
  return mounted ? localDateTimeFmt.format(d) : utcDateTimeFmt.format(d);
}

function formatRelative(d: Date, now: number): string {
  const diffMs = d.getTime() - now;
  const abs = Math.abs(diffMs);
  if (abs < 45_000) {
    return "just now";
  }
  if (abs < HOUR) {
    return relFmt.format(Math.round(diffMs / MINUTE), "minute");
  }
  if (abs < DAY) {
    return relFmt.format(Math.round(diffMs / HOUR), "hour");
  }
  return relFmt.format(Math.round(diffMs / DAY), "day");
}

/** Single shared ticker for all <Timestamp /> instances on a page. */
const tickSubscribers = new Set<() => void>();
let tickInterval: ReturnType<typeof setInterval> | null = null;

function subscribeToTick(cb: () => void): () => void {
  tickSubscribers.add(cb);
  if (tickInterval === null) {
    tickInterval = setInterval(() => {
      for (const fn of tickSubscribers) {
        fn();
      }
    }, MINUTE);
  }
  return () => {
    tickSubscribers.delete(cb);
    if (tickSubscribers.size === 0 && tickInterval !== null) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
  };
}

function useNowTick(enabled: boolean): number | null {
  // SSR-safe initial null; we read the wall clock only after mount, so the
  // server-rendered HTML and the first client render agree (both render with
  // `now=null`). Consumers gate clock-derived output on a non-null value.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    setNow(Date.now());
    return subscribeToTick(() => setNow(Date.now()));
  }, [enabled]);
  return now;
}

function useHasMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

export function Timestamp({
  value,
  mode = "auto",
  precision = "datetime",
  valueKind = "auto",
  className,
}: TimestampProps) {
  const parsed = parseTimestampValue(value, valueKind);
  const mounted = useHasMounted();
  const now = useNowTick(mounted && mode !== "absolute");

  if (!parsed) {
    const raw = typeof value === "string" ? value : "";
    return (
      <span className={cn("text-muted-foreground tabular-nums", className)} title={raw || undefined}>
        —
      </span>
    );
  }

  if (parsed.kind === "calendar-date") {
    // A calendar date has NO time-of-day. Under a day-group header (precision
    // "time"), printing the date again would just duplicate the header, so show a
    // quiet em-dash — the record is honestly date-only — with the full date in the
    // hover title. Elsewhere (date/datetime precision) render the date as before.
    if (precision === "time") {
      return (
        <time
          className={cn("text-muted-foreground tabular-nums", className)}
          dateTime={parsed.dateTime}
          title={formatCalendarDate(parsed.date)}
        >
          —
        </time>
      );
    }
    return (
      <time className={cn("tabular-nums", className)} dateTime={parsed.dateTime} title={parsed.raw}>
        {formatCalendarDate(parsed.date)}
      </time>
    );
  }

  const iso = parsed.date.toISOString();
  const ageMs = Math.abs(Date.now() - parsed.date.getTime());
  const useRelative = mode === "relative" || (mode === "auto" && mounted && ageMs < RELATIVE_CUTOFF);

  let label = formatInstantAbsolute(parsed.date, precision, mounted);
  // `now` is only populated after mount via `useNowTick`. Both gates
  // (`mounted`, `now !== null`) are enforced together to keep SSR HTML and
  // first-client-render output identical (relative formatting is post-mount).
  if (mounted && useRelative && now !== null) {
    label = formatRelative(parsed.date, now);
  }

  return (
    <time
      className={cn("tabular-nums", className)}
      dateTime={iso}
      title={mounted ? tooltipFmt.format(parsed.date) : iso}
    >
      {label}
    </time>
  );
}
