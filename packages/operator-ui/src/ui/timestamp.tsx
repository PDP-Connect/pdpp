"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  formatCalendarDate,
  formatInstantAbsolute,
  formatRelative,
  formatTimestampTitle,
  MINUTE,
  parseTimestampValue,
  RELATIVE_CUTOFF,
  type TimestampValueKind,
} from "@pdpp/display";
import { useEffect, useState } from "react";

import { cn } from "./utils.ts";

export type TimestampMode = "auto" | "relative" | "absolute";
export type TimestampPrecision = "datetime" | "date" | "time";
export type { TimestampValueKind } from "@pdpp/display";
// biome-ignore lint/performance/noBarrelFile: preserve the existing timestamp module API while mechanics live in @pdpp/display.
export { parseTimestampValue } from "@pdpp/display";

export interface TimestampProps {
  className?: string;
  mode?: TimestampMode;
  precision?: TimestampPrecision;
  value: string | number | Date | null | undefined;
  valueKind?: TimestampValueKind;
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
    <time className={cn("tabular-nums", className)} dateTime={iso} title={formatTimestampTitle(parsed.date, mounted)}>
      {label}
    </time>
  );
}
