// Pure terminal/active decision logic for the run detail surface.
//
// Extracted from `page.tsx` so the envelope-driven decision can be unit-tested
// without a JSX render harness. The authoritative liveness signal is the
// window-independent `terminal_status` from the run-timeline envelope (resolved
// server-side from the run's most-recent terminal spine event) — NOT a scan of
// a single page of timeline events. The terminal event is emitted last, so for
// a run longer than the page the page-only scan never sees it.
//
// See: openspec/changes/add-run-timeline-terminal-status

import type { RunHandleStatus, TimelineEnvelope } from "../../lib/ref-client.ts";

export type TerminalRunStatus = "succeeded" | "succeeded_with_gaps" | "failed" | "cancelled" | null;

export type EnvelopeTerminalStatus = NonNullable<TimelineEnvelope["terminal_status"]>;

/**
 * The authoritative active/terminal decision: a run is active exactly when the
 * envelope reports no terminal status. Window-independent — the same answer for
 * any page or `limit` of the same run.
 */
export function isRunActive(envelopeTerminal: EnvelopeTerminalStatus | null): boolean {
  return envelopeTerminal == null;
}

/**
 * Whole-handle liveness from `GET /_ref/runs/:runId`.
 *
 * The timeline envelope only knows Collection Profile terminal events
 * (`run.completed` / `run.failed` / ...). Browser-surface setup runs can end
 * before `run.started`, so their truthful liveness comes from the run-status
 * handle surface instead.
 */
export function isRunHandleActive(status: RunHandleStatus | null): boolean {
  return (
    status === "active" ||
    status === "leased" ||
    status === "starting_surface" ||
    status === "waiting_for_browser_surface"
  );
}

/**
 * Map the run-timeline envelope's raw terminal class to the page's
 * `TerminalRunStatus` display type. Mirrors `getTerminalRunStatus`'s mapping
 * (`run.completed`→`succeeded`); `abandoned` has no dedicated display value, so
 * it renders as `failed` (matching how a non-cancelled `run.failed` is treated).
 */
export function mapEnvelopeTerminalToDisplay(envelopeTerminal: EnvelopeTerminalStatus): TerminalRunStatus {
  switch (envelopeTerminal) {
    case "completed":
      return "succeeded";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "abandoned":
      return "failed";
    default:
      return null;
  }
}

export function mapRunHandleStatusToDisplay(status: RunHandleStatus | null): TerminalRunStatus {
  switch (status) {
    case "completed":
      return "succeeded";
    case "cancelled":
      return "cancelled";
    case "abandoned":
    case "deferred":
    case "expired":
    case "failed":
    case "released":
    case "surface_failed":
      return "failed";
    default:
      return null;
  }
}

/**
 * Resolve the displayed terminal class. The envelope is authoritative for
 * WHETHER the run is terminal; when the terminal event is on the current page
 * the in-page scan is preferred for its finer detail (failed-vs-cancelled,
 * succeeded-with-gaps). When the envelope says terminal but the event is past
 * the page, the envelope's mapped class is used so the badge still renders.
 */
export function resolveDisplayTerminalStatus({
  coverageGapCount,
  envelopeTerminal,
  inPageTerminalStatus,
}: {
  coverageGapCount: number;
  envelopeTerminal: EnvelopeTerminalStatus | null;
  inPageTerminalStatus: TerminalRunStatus;
}): TerminalRunStatus {
  if (envelopeTerminal == null) {
    // Run is active per the envelope — no terminal class to display, even if
    // the page happened to scan a stray terminal-shaped event.
    return null;
  }
  const base = inPageTerminalStatus ?? mapEnvelopeTerminalToDisplay(envelopeTerminal);
  if (base === "succeeded" && coverageGapCount > 0) {
    return "succeeded_with_gaps";
  }
  return base;
}
