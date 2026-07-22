// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Calendar-aware instant-bucketing cluster extracted from records.ts.
// Owns the pure time-math stack for group_by_time aggregation.
// See openspec/changes/add-aggregate-time-buckets-and-distinct.
import { invalidQueryError } from "./record-expand-helpers.js";

// Calendar `date_trunc` granularity set for `group_by_time` (weeks start
// Monday). See openspec/changes/add-aggregate-time-buckets-and-distinct.
export type AggregateGranularity = "minute" | "hour" | "day" | "week" | "month" | "quarter" | "year";
export const SUPPORTED_AGGREGATE_GRANULARITIES = new Set<string>([
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "quarter",
  "year",
]);

export function resolveAggregateTimeZone(rawZone: string | null | undefined): string {
  if (!rawZone) {
    return "UTC";
  }
  try {
    // Throws RangeError for an unknown IANA zone.
    new Intl.DateTimeFormat("en-US", { timeZone: rawZone });
    return rawZone;
  } catch {
    throw invalidQueryError(`Unknown time_zone: '${rawZone}'`);
  }
}

interface ZonedParts {
  day: number;
  hour: number;
  minute: number;
  month: number;
  second: number;
  year: number;
}

// Decompose an absolute instant into wall-clock parts for the given IANA zone.
function zonedParts(epochMs: number, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(epochMs))) {
    if (p.type !== "literal") {
      parts[p.type] = p.value;
    }
  }
  // `Intl` emits hour "24" at midnight in some engines; normalize to 0.
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  return {
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    month: Number(parts.month),
    second: Number(parts.second),
    year: Number(parts.year),
  };
}

// ISO day-of-week (1 = Monday .. 7 = Sunday) for a Y/M/D in proleptic
// Gregorian terms. Used to snap weeks to a Monday start.
function isoDayOfWeek(year: number, month: number, day: number): number {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun
  return dow === 0 ? 7 : dow;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Calendar-truncate the instant `epochMs` to the start of its `granularity`
 * bucket in `timeZone`, returning a stable ISO key string. Returns `null`
 * when epochMs is null so the caller can route it to the single null bucket.
 * The caller is responsible for parsing the raw value into epochMs via
 * parseDateValue (which stays in records.ts).
 */
export function bucketStartForGranularity(
  epochMs: number | null,
  granularity: AggregateGranularity,
  timeZone: string
): string | null {
  if (epochMs == null) {
    return null;
  }
  const { year, month, day, hour, minute } = zonedParts(epochMs, timeZone);

  switch (granularity) {
    case "minute":
      return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}`;
    case "hour":
      return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:00`;
    case "day":
      return `${year}-${pad2(month)}-${pad2(day)}`;
    case "week": {
      // Snap back to Monday in the zone's wall-clock calendar.
      const offset = isoDayOfWeek(year, month, day) - 1;
      const monday = new Date(Date.UTC(year, month - 1, day - offset));
      return `${monday.getUTCFullYear()}-${pad2(monday.getUTCMonth() + 1)}-${pad2(monday.getUTCDate())}`;
    }
    case "month":
      return `${year}-${pad2(month)}-01`;
    case "quarter": {
      const quarterStartMonth = month - ((month - 1) % 3);
      return `${year}-${pad2(quarterStartMonth)}-01`;
    }
    case "year":
      return `${year}-01-01`;
    default:
      return null;
  }
}
