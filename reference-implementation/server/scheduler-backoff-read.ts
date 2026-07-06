// Pure readers over the scheduler's persisted `schedule` / `scheduler_backoff`
// records, used by the connection-health projection in `ref-control.ts` to
// decide whether a later successful run supersedes a stale scheduler backoff.
// Each takes an opaque persisted value and returns a typed record / millis /
// verdict, so this is a leaf module with no store or projection dependency.
// The run-summary shape is imported type-only (erased at runtime, no cycle).

import type { ConnectorRunSummary } from "./ref-control.ts";

/** Narrow an opaque persisted schedule to a record, or `null`. */
export function asScheduleRecord(schedule: unknown): Record<string, unknown> | null {
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    return null;
  }
  return schedule as Record<string, unknown>;
}

/** Read the `scheduler_backoff` sub-record off a schedule record, or `null`. */
export function asBackoffRecord(schedule: Record<string, unknown> | null): Record<string, unknown> | null {
  const backoff = schedule?.scheduler_backoff;
  if (!backoff || typeof backoff !== "object" || Array.isArray(backoff)) {
    return null;
  }
  return backoff as Record<string, unknown>;
}

/** A finite number, or `null`. */
export function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Parse an ISO timestamp string to epoch millis, or `null`. */
export function readIsoMillis(value: unknown): number | null {
  if (typeof value !== "string" || !value) {
    return null;
  }
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

/**
 * The most recent millis anchor the scheduler recorded for a failure —
 * the later of `last_finished_at` / `last_started_at`, or `null` when neither
 * is a valid timestamp.
 */
export function schedulerFailureAnchorMillis(schedule: Record<string, unknown> | null): number | null {
  const candidates = [readIsoMillis(schedule?.last_finished_at), readIsoMillis(schedule?.last_started_at)].filter(
    (value): value is number => value !== null
  );
  if (candidates.length === 0) {
    return null;
  }
  return Math.max(...candidates);
}

/**
 * True when the latest run succeeded at or after the scheduler's failure
 * anchor — i.e. a fresh success has superseded a stale recorded backoff, so
 * the projection should not surface that backoff as live.
 */
export function succeededRunSupersedesSchedulerBackoff(
  lastRun: ConnectorRunSummary | null,
  schedule: Record<string, unknown> | null
): boolean {
  if (lastRun?.status !== "succeeded") {
    return false;
  }
  const runMillis = readIsoMillis(lastRun.last_at);
  const failureAnchor = schedulerFailureAnchorMillis(schedule);
  return runMillis !== null && (failureAnchor === null || runMillis >= failureAnchor);
}
