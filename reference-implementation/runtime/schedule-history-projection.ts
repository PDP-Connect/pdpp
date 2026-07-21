// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure projection functions for schedule history facts.
//
// No controller, browser-surface, lease, or store imports. External-dep types
// (SchedulerRunHistoryRecord, SchedulerLastRunTimeRecord, PendingPressureGap)
// are imported for their shapes only — ownership stays in their source modules.

import type { SchedulerLastRunTimeRecord, SchedulerRunHistoryRecord } from "../server/stores/scheduler-store.ts";
import type { PendingPressureGap } from "./scheduler-source-pressure-cooldown.ts";

export interface ScheduleHistoryFacts {
  /** Latest durable last-run timestamp, from history or `scheduler_last_run_times`. */
  readonly lastRunTimeMs: number | null;
  /** Error/skip code for the most recent terminal row, when that row was not successful. */
  readonly latestErrorCode: string | null;
  readonly latestFinishedAt: string | null;
  /** Most recent run that actually started (status in {succeeded, failed}). */
  readonly latestStartedAt: string | null;
  readonly latestStatus: "cancelled" | "failed" | "skipped" | "succeeded" | null;
  /** Most recent `succeeded` record's `completedAt`. */
  readonly latestSuccessfulAt: string | null;
  /**
   * Pending durable source-pressure detail gaps for this connection (reason in
   * `SOURCE_PRESSURE_GAP_REASONS`). Drives the cross-run cooldown projection so
   * the dashboard shows `cooling_off` while pressure persists instead of bare
   * green. Empty when there is no source pressure (the common case).
   */
  readonly pendingPressureGaps: readonly PendingPressureGap[];
  /** Recent durable scheduler history for this connector instance, oldest to newest. */
  readonly recentRuns: readonly SchedulerRunHistoryRecord[];
}

export type ScheduleHistoryIndex = ReadonlyMap<string, ScheduleHistoryFacts>;

export interface MutableScheduleHistoryFacts {
  lastRunTimeMs: number | null;
  latestErrorCode: string | null;
  latestFinishedAt: string | null;
  latestStartedAt: string | null;
  latestStatus: "cancelled" | "failed" | "skipped" | "succeeded" | null;
  latestSuccessfulAt: string | null;
  pendingPressureGaps: PendingPressureGap[];
  recentRuns: SchedulerRunHistoryRecord[];
}

export const EMPTY_SCHEDULE_HISTORY_FACTS: ScheduleHistoryFacts = {
  latestStartedAt: null,
  latestFinishedAt: null,
  latestStatus: null,
  latestSuccessfulAt: null,
  latestErrorCode: null,
  lastRunTimeMs: null,
  recentRuns: [],
  pendingPressureGaps: [],
};

const SAFE_SCHEDULER_ERROR_PREFIXES = new Set([
  "automation_policy_blocked",
  "not_ready",
  "schedule.back_off.cleared",
  "schedule.back_off.started",
  "schedule.gave_up",
  "scheduler_backoff_applied",
]);

function schedulerErrorCodeFromRecord(row: SchedulerRunHistoryRecord): string | null {
  if (row.terminalReason) {
    return row.terminalReason;
  }
  if (row.failureReason) {
    return row.failureReason;
  }
  if (!row.error) {
    return null;
  }
  const prefix = row.error.includes(":") ? row.error.slice(0, row.error.indexOf(":")) : row.error;
  if (SAFE_SCHEDULER_ERROR_PREFIXES.has(prefix)) {
    return prefix;
  }
  return "scheduler_error";
}

export type EnsureScheduleFacts = (connectorKey: string) => MutableScheduleHistoryFacts;

function ensureScheduleHistoryFacts(
  facts: Map<string, MutableScheduleHistoryFacts>,
  connectorKey: string
): MutableScheduleHistoryFacts {
  let entry = facts.get(connectorKey);
  if (!entry) {
    entry = {
      latestStartedAt: null,
      latestFinishedAt: null,
      latestStatus: null,
      latestSuccessfulAt: null,
      latestErrorCode: null,
      lastRunTimeMs: null,
      recentRuns: [],
      pendingPressureGaps: [],
    };
    facts.set(connectorKey, entry);
  }
  return entry;
}

// Hydrate `latestFinishedAt` from the `scheduler_last_run_times` table first
// so a connector that has rolled out of the bounded history window still has
// a non-null `last_finished_at`. History rows will overwrite with a more
// precise per-status anchor when they exist.
function hydrateScheduleHistoryFromLastRunTimes(
  lastRunTimes: readonly SchedulerLastRunTimeRecord[],
  ensure: EnsureScheduleFacts
): void {
  for (const row of lastRunTimes) {
    if (!Number.isFinite(row.last_run_time_ms)) {
      continue;
    }
    const entry = ensure(row.connector_instance_id || row.connector_id);
    if (!entry.latestFinishedAt) {
      entry.latestFinishedAt = new Date(row.last_run_time_ms).toISOString();
    }
    entry.lastRunTimeMs =
      entry.lastRunTimeMs === null ? row.last_run_time_ms : Math.max(entry.lastRunTimeMs, row.last_run_time_ms);
  }
}

function bucketRecentRunsByConnector(history: readonly SchedulerRunHistoryRecord[], ensure: EnsureScheduleFacts): void {
  for (const row of history) {
    if (!row || typeof row.connectorId !== "string") {
      continue;
    }
    ensure(row.connectorInstanceId || row.connectorId).recentRuns.push(row);
  }
}

// Walk newest to oldest. The store's chronological order means the last
// array element is the newest record overall; iterating in reverse keeps
// "first sighting wins" semantics for both `latest{Started,Successful}At`
// so we never overwrite a newer fact with an older one.
function deriveLatestScheduleFacts(history: readonly SchedulerRunHistoryRecord[], ensure: EnsureScheduleFacts): void {
  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i];
    if (!row || typeof row.connectorId !== "string") {
      continue;
    }
    applyHistoryRowToScheduleFacts(ensure(row.connectorInstanceId || row.connectorId), row);
  }
}

function applyHistoryRowToScheduleFacts(entry: MutableScheduleHistoryFacts, row: SchedulerRunHistoryRecord): void {
  if (entry.latestStatus === null) {
    entry.latestStatus = row.status;
    if (row.status === "failed" || row.status === "skipped") {
      entry.latestErrorCode = schedulerErrorCodeFromRecord(row);
    }
  }
  if (!entry.latestFinishedAt || row.completedAt > entry.latestFinishedAt) {
    entry.latestFinishedAt = row.completedAt;
  }
  // Only `succeeded`/`failed` records correspond to a run that actually
  // started. `skipped` records carry a `startedAt` for bookkeeping but the
  // connector child never spawned, so we hold `last_started_at` back. This
  // is what lets the dashboard and the doctor probe distinguish "ran but is
  // currently idle" from "currently being skipped (not_ready / needs_human /
  // disabled grant)".
  if (
    entry.latestStartedAt === null &&
    (row.status === "succeeded" || row.status === "failed") &&
    typeof row.startedAt === "string"
  ) {
    entry.latestStartedAt = row.startedAt;
  }
  if (entry.latestSuccessfulAt === null && row.status === "succeeded") {
    entry.latestSuccessfulAt = row.completedAt;
  }
}

export {
  applyHistoryRowToScheduleFacts,
  bucketRecentRunsByConnector,
  deriveLatestScheduleFacts,
  ensureScheduleHistoryFacts,
  hydrateScheduleHistoryFromLastRunTimes,
};
