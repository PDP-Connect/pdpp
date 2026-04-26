"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils.ts";

export type TimestampMode = "auto" | "relative" | "absolute";
export type TimestampPrecision = "datetime" | "date";

export interface TimestampProps {
  className?: string;
  mode?: TimestampMode;
  precision?: TimestampPrecision;
  value: string | number | Date | null | undefined;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RELATIVE_CUTOFF = 7 * DAY;

const localDateTimeFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
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

function parse(value: TimestampProps["value"]): Date | null {
  if (value == null || value === "") {
    return null;
  }
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatAbsolute(d: Date, precision: TimestampPrecision, mounted: boolean): string {
  if (precision === "date") {
    // Treat date-only displays as calendar dates, not as local midnights.
    return utcDateFmt.format(d);
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

function useNowTick(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
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

export function Timestamp({ value, mode = "auto", precision = "datetime", className }: TimestampProps) {
  const date = parse(value);
  const mounted = useHasMounted();
  const now = useNowTick(mounted && mode !== "absolute");

  if (!date) {
    const raw = typeof value === "string" ? value : "";
    return (
      <span className={cn("text-muted-foreground tabular-nums", className)} title={raw || undefined}>
        —
      </span>
    );
  }

  const iso = date.toISOString();
  const ageMs = Math.abs(Date.now() - date.getTime());
  const useRelative = mode === "relative" || (mode === "auto" && mounted && ageMs < RELATIVE_CUTOFF);

  let label = formatAbsolute(date, precision, mounted);
  if (mounted && useRelative) {
    label = formatRelative(date, now);
  }

  return (
    <time className={cn("tabular-nums", className)} dateTime={iso} title={mounted ? tooltipFmt.format(date) : iso}>
      {label}
    </time>
  );
}
