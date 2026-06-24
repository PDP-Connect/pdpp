/**
 * The single run-row grammar, shared by every surface that lists connector
 * runs:
 *   - the standalone /dashboard/runs and /sandbox/runs list
 *   - the overview "Recent runs" mini-list
 *   - the overview "Failed runs" panel
 *
 * One entity, one row shape everywhere. A run row leads with *what happened to
 * whom* (the connector label via `runRowLabel`) plus its lifecycle StatusBadge,
 * and demotes the raw `run_…` id to a monospace lookup key on the detail line —
 * alongside the event count, optional provider, any failure reason, and run
 * duration (first_at..last_at).
 *
 * The standalone list additionally surfaces operator-actionable chips
 * (needs-input, browser-surface backpressure); the overview mini-lists omit
 * those via `chips={false}` but keep the identical core grammar so the same run
 * never reads two different ways depending on where it is shown.
 *
 * Danger row tint: failed/rejected/cancelled rows get a 2px left border in
 * --status-danger-fg and a low-alpha --status-danger-bg fill so operators can
 * spot failures sub-second on long lists. Design direction decision 2.
 */

import Link from "next/link";
import type { RunSummary } from "../lib/ref-client.ts";
import { runRowLabel } from "../lib/summary-row-label.ts";
import { Timestamp } from "../ui/timestamp.tsx";
import { StatusBadge } from "./primitives.tsx";
import { browserSurfaceStatusCopy, isAwaitingInteraction } from "./run-row-helpers.ts";

const DANGER_STATUSES = new Set(["failed", "rejected", "cancelled"]);

/** Format elapsed seconds as a compact duration string, e.g. "1m 4s", "32s". */
function formatRunDuration(startIso: string, endIso: string): string | null {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    return null;
  }
  const totalSeconds = Math.round((endMs - startMs) / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function RunRow({
  run,
  href,
  peeked = false,
  chips = false,
}: {
  run: RunSummary;
  href: string;
  /** Whether this row is the one currently peeked (standalone list only). */
  peeked?: boolean;
  /** Render operator-actionable chips (needs-input / browser-surface). */
  chips?: boolean;
}) {
  const awaitingInput = chips && isAwaitingInteraction(run);
  const browserSurfaceCopy = chips ? browserSurfaceStatusCopy(run) : null;
  const isDanger = DANGER_STATUSES.has(run.status);
  const duration = formatRunDuration(run.first_at, run.last_at);

  // Danger tint: left border + low-alpha fill. When peeked, bg-muted wins to
  // keep the selected row clearly highlighted.
  const rowClass = isDanger
    ? `pdpp-data-list-row block border-l-2 pr-3 pl-[10px] transition-colors [border-left-color:var(--status-danger-fg)] [background-color:var(--status-danger-bg)] ${
        peeked ? "bg-muted" : ""
      }`
    : `pdpp-data-list-row block px-3 transition-colors ${peeked ? "bg-muted" : "hover:bg-muted/50"}`;

  return (
    <Link aria-current={peeked ? "true" : undefined} className={rowClass} href={href} scroll={false}>
      {/* Lead with the connector + outcome (what an operator scans for); the
          raw run id is demoted to a monospace lookup key on the detail line. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-medium text-foreground">{runRowLabel(run)}</span>
          <StatusBadge status={run.status} />
          {awaitingInput ? <AwaitingInputChip /> : null}
          {browserSurfaceCopy ? <BrowserSurfaceChip label={browserSurfaceCopy.label} /> : null}
        </div>
        <span className="pdpp-caption shrink-0 text-muted-foreground tabular-nums">
          <Timestamp value={run.last_at} />
        </span>
      </div>
      <div className="pdpp-caption mt-0.5 flex flex-wrap items-center gap-x-2 text-muted-foreground">
        <code className="break-all font-mono">{run.run_id}</code>
        <span className="text-muted-foreground/50">·</span>
        <span className="tabular-nums">
          {run.event_count} event{run.event_count === 1 ? "" : "s"}
        </span>
        {duration ? (
          <>
            <span className="text-muted-foreground/50">·</span>
            <span className="tabular-nums">{duration}</span>
          </>
        ) : null}
        {run.provider_id ? (
          <>
            <span className="text-muted-foreground/50">·</span>
            <span>provider {run.provider_id}</span>
          </>
        ) : null}
        {run.failure_reason ? (
          <>
            <span className="text-muted-foreground/50">·</span>
            <span className="text-destructive/90">{run.failure_reason}</span>
          </>
        ) : null}
      </div>
      {browserSurfaceCopy ? (
        <div className="pdpp-caption mt-1 text-muted-foreground">{browserSurfaceCopy.detail}</div>
      ) : null}
    </Link>
  );
}

function AwaitingInputChip() {
  return (
    <span
      className="pdpp-eyebrow rounded-[3px] bg-[color:var(--warning-wash)] px-1.5 py-0.5 font-medium text-[color:var(--warning)]"
      data-surface="human"
      title="This run is paused and requires operator input. Open it to respond."
    >
      needs input
    </span>
  );
}

function BrowserSurfaceChip({ label }: { label: string }) {
  return (
    <span
      className="pdpp-eyebrow rounded-[3px] bg-muted px-1.5 py-0.5 font-medium text-foreground"
      title="This is browser-surface resource backpressure, not connector auth or protocol failure."
    >
      {label}
    </span>
  );
}
