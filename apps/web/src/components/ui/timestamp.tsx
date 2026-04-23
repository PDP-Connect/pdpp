"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type TimestampMode = "auto" | "relative" | "absolute";
export type TimestampPrecision = "datetime" | "date";

export type TimestampProps = {
  value: string | number | Date | null | undefined;
  mode?: TimestampMode;
  precision?: TimestampPrecision;
  /** Disable the hover tooltip (e.g. inside another tooltip). */
  noTooltip?: boolean;
  className?: string;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RELATIVE_CUTOFF = 7 * DAY;

const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});

const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const utcFmt = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

const relFmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function parse(value: TimestampProps["value"]): Date | null {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatAbsolute(d: Date, precision: TimestampPrecision): string {
  return precision === "date" ? dateFmt.format(d) : dateTimeFmt.format(d);
}

function formatRelative(d: Date, now: number): string {
  const diffMs = d.getTime() - now;
  const abs = Math.abs(diffMs);
  if (abs < 45_000) return "just now";
  if (abs < HOUR) return relFmt.format(Math.round(diffMs / MINUTE), "minute");
  if (abs < DAY) return relFmt.format(Math.round(diffMs / HOUR), "hour");
  return relFmt.format(Math.round(diffMs / DAY), "day");
}

/** Single shared ticker for all <Timestamp /> instances on a page. */
const tickSubscribers = new Set<() => void>();
let tickInterval: ReturnType<typeof setInterval> | null = null;

function subscribeToTick(cb: () => void): () => void {
  tickSubscribers.add(cb);
  if (tickInterval === null) {
    tickInterval = setInterval(() => {
      tickSubscribers.forEach((fn) => fn());
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
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    return subscribeToTick(() => setNow(Date.now()));
  }, [enabled]);
  return now;
}

function useHasMounted(): boolean {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  return mounted;
}

export function Timestamp({
  value,
  mode = "auto",
  precision = "datetime",
  noTooltip = false,
  className,
}: TimestampProps) {
  const date = parse(value);
  const mounted = useHasMounted();
  const now = useNowTick(mounted && mode !== "absolute");

  if (!date) {
    const raw = typeof value === "string" ? value : "";
    return (
      <span
        className={cn("text-muted-foreground tabular-nums", className)}
        aria-label="invalid or missing timestamp"
        title={raw || undefined}
      >
        —
      </span>
    );
  }

  const iso = date.toISOString();
  const ageMs = Math.abs(Date.now() - date.getTime());
  const useRelative =
    mode === "relative" || (mode === "auto" && mounted && ageMs < RELATIVE_CUTOFF);

  const label = !mounted
    ? formatAbsolute(date, precision)
    : useRelative
      ? formatRelative(date, now)
      : formatAbsolute(date, precision);

  if (noTooltip) {
    return (
      <time dateTime={iso} className={cn("tabular-nums", className)}>
        {label}
      </time>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <time
            dateTime={iso}
            className={cn(
              "tabular-nums underline decoration-dotted decoration-muted-foreground/40 underline-offset-[3px] hover:decoration-foreground/70 focus-visible:decoration-foreground/70 cursor-help transition-[text-decoration-color] outline-none",
              className,
            )}
          />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipContent
        className="max-w-none min-w-[15rem] px-3 py-2 font-mono text-[11px] leading-relaxed text-background"
        side="top"
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <dt className="text-background/60 uppercase tracking-wide text-[9px]">Local</dt>
          <dd className="tabular-nums">{dateTimeFmt.format(date)}</dd>
          <dt className="text-background/60 uppercase tracking-wide text-[9px]">UTC</dt>
          <dd className="tabular-nums">{utcFmt.format(date)}Z</dd>
          <dt className="text-background/60 uppercase tracking-wide text-[9px]">ISO</dt>
          <dd className="break-all tabular-nums">{iso}</dd>
          <dt className="text-background/60 uppercase tracking-wide text-[9px]">Epoch</dt>
          <dd className="tabular-nums">{date.getTime()} ms</dd>
        </dl>
      </TooltipContent>
    </Tooltip>
  );
}
