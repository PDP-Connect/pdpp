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
/**
 * Timestamp — Ink Carbon temporal primitive.
 *
 * IcTimestamp renders a `<time>` element in the mono protocol voice:
 * `--muted-foreground`, tabular-nums so digit columns stay aligned. It is a
 * pure formatter — NO base-ui, NO icons. The clock-derived "relative" label
 * ("5 minutes ago") only appears after mount so the server-rendered HTML and
 * the first client render agree (avoids hydration drift).
 *
 * Behaviour-preserving port of the operator-ui `Timestamp`: the parse/format
 * logic is reused verbatim so swapping the import is mechanical. Only the
 * presentation (Tailwind utility classes → `.pdpp-timestamp` token class)
 * changes.
 *
 * Prefixed `Ic` to avoid collision with operator-ui imports during migration.
 */
import { useEffect, useState } from "react";
import "./components.css";

export type TimestampMode = "auto" | "relative" | "absolute";
export type TimestampPrecision = "datetime" | "date";
export type { TimestampValueKind } from "@pdpp/display";
// biome-ignore lint/performance/noBarrelFile: preserve the existing brand timestamp API while mechanics live in @pdpp/display.
export { parseTimestampValue } from "@pdpp/display";

export interface IcTimestampProps {
  className?: string;
  mode?: TimestampMode;
  precision?: TimestampPrecision;
  value: string | number | Date | null | undefined;
  valueKind?: TimestampValueKind;
}

/** Single shared ticker for all <IcTimestamp /> instances on a page. */
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

function joinClass(...parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * IcTimestamp (Ink Carbon Timestamp) — token-driven `<time>` formatter.
 */
export function IcTimestamp({
  value,
  mode = "auto",
  precision = "datetime",
  valueKind = "auto",
  className,
}: IcTimestampProps) {
  const parsed = parseTimestampValue(value, valueKind);
  const mounted = useHasMounted();
  const now = useNowTick(mounted && mode !== "absolute");

  if (!parsed) {
    const raw = typeof value === "string" ? value : "";
    return (
      <span className={joinClass("pdpp-timestamp", "pdpp-timestamp--empty", className)} title={raw || undefined}>
        —
      </span>
    );
  }

  if (parsed.kind === "calendar-date") {
    return (
      <time className={joinClass("pdpp-timestamp", className)} dateTime={parsed.dateTime} title={parsed.raw}>
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
      className={joinClass("pdpp-timestamp", className)}
      dateTime={iso}
      title={formatTimestampTitle(parsed.date, mounted)}
    >
      {label}
    </time>
  );
}
