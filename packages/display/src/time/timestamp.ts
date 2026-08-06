// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Framework-free parsing and formatting for human-readable timestamps. */
export type TimestampValue = string | number | Date | null | undefined;
export type TimestampPrecision = "datetime" | "date" | "time";
export type TimestampValueKind = "auto" | "calendar-date" | "instant";

export type ParsedTimestamp =
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

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const RELATIVE_CUTOFF = 7 * DAY;

const localDateFmt = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const localDateTimeFmt = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  year: "numeric",
});

const localTimeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const tooltipFmt = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  second: "2-digit",
  timeZoneName: "short",
  weekday: "short",
  year: "numeric",
});

const relFmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const utcDateFmt = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

const utcDateTimeFmt = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T/;
const SQL_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
const OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

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

/**
 * Parses calendar dates independently of the viewer's time zone and treats
 * offset-less date-times as UTC, matching the historical timestamp adapters.
 */
export function parseTimestampValue(
  value: TimestampValue,
  valueKind: TimestampValueKind = "auto"
): ParsedTimestamp | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (valueKind === "calendar-date") {
      return parseCalendarDate(trimmed, "date-prefix");
    }
    if (valueKind !== "instant") {
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

export function formatCalendarDate(date: Date): string {
  return utcDateFmt.format(date);
}

/**
 * `mounted` keeps the server and initial client render UTC-stable; local-zone
 * output is intentionally deferred until after mount by the React adapters.
 */
export function formatInstantAbsolute(date: Date, precision: TimestampPrecision, mounted: boolean): string {
  if (precision === "date") {
    return mounted ? localDateFmt.format(date) : utcDateFmt.format(date);
  }
  if (precision === "time") {
    return mounted ? localTimeFmt.format(date) : utcDateTimeFmt.format(date);
  }
  return mounted ? localDateTimeFmt.format(date) : utcDateTimeFmt.format(date);
}

export function formatRelative(date: Date, now: number): string {
  const diffMs = date.getTime() - now;
  const absoluteDifference = Math.abs(diffMs);
  if (absoluteDifference < 45_000) {
    return "just now";
  }
  if (absoluteDifference < HOUR) {
    return relFmt.format(Math.round(diffMs / MINUTE), "minute");
  }
  if (absoluteDifference < DAY) {
    return relFmt.format(Math.round(diffMs / HOUR), "hour");
  }
  return relFmt.format(Math.round(diffMs / DAY), "day");
}

export function formatTimestampTitle(date: Date, mounted: boolean): string {
  return mounted ? tooltipFmt.format(date) : date.toISOString();
}
