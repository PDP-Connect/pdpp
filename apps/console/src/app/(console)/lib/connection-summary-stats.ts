// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure connection-health summary rollup for the records-list view.
 *
 * The records-list view is a JSX component that cannot be imported in Node's
 * test runner, so the summary counting logic lives here as a pure function and
 * is exercised behaviourally in `connection-summary-stats.test.ts`. The view
 * imports `summarizeConnectionHealth` and renders the result; it must not carry
 * its own copy of the counting predicates.
 *
 * Contract (openspec `align-dashboard-health-summary`):
 *
 *   - A degraded, cooling-off, or stalled-outbox connection MUST be visible in
 *     an attention-visible summary bucket. We expose a distinct `degraded`
 *     count rather than folding it into `needsAttention`, so the operator can
 *     tell "needs owner action now" (blocked / needs_attention) apart from
 *     "retryable or self-healing degraded work" (degraded / cooling_off /
 *     stalled outbox). The summary therefore can never read all-zero across the
 *     attention-relevant buckets while such cards are present.
 *   - Unknown freshness is NOT counted as stale. Staleness requires the health
 *     projection's freshness axis to say `stale` (a freshness policy verdict).
 *     We never re-derive staleness from raw `last ingest` age here.
 *   - The connection count names its population: `primaryList` is the
 *     operator-surfaced list (records, local-device progress, or actionable
 *     health/run state), `registeredTotal` includes no-data registrations, and
 *     `noData` is the difference.
 */

import { shouldShowInPrimaryConnections } from "./records-list-classification.ts";
import type { ConnectorOverview } from "./rs-client.ts";

export interface ConnectionHealthSummaryStats {
  /**
   * Degraded / cooling_off / stalled-outbox: retryable or self-healing work
   * the operator should see but does not have to act on immediately. Stalled
   * local-device outbox work surfaces here (via the `degraded` projection
   * state), never relabeled as a scheduler failure.
   */
  readonly degraded: number;
  /** Blocked / needs_attention: the owner must act before progress resumes. */
  readonly needsAttention: number;
  /** Registered connections with no durable progress yet. */
  readonly noData: number;
  /** Sources surfaced in the primary list. May include zero-record actionable rows. */
  readonly primaryList: number;
  /** All registered connections, including no-data registrations. */
  readonly registeredTotal: number;
  /** A run or durable work item is actively progressing. */
  readonly running: number;
  /** Freshness axis says `stale` (policy-aware); unknown freshness is excluded. */
  readonly stale: number;
}

/** Owner action required now. */
function isNeedsAttention(overview: ConnectorOverview): boolean {
  const state = overview.connectionHealth?.state;
  if (state === "blocked" || state === "needs_attention") {
    return true;
  }
  // Fallback only when no health projection is present: a failed last run is
  // the strongest available attention signal.
  if (!state && overview.lastRun?.status === "failed") {
    return true;
  }
  return false;
}

/**
 * Retryable / self-healing degraded work. `degraded` already subsumes a
 * stalled local-device outbox in the health projection (precedence step
 * "outbox stalled / coverage/run incomplete -> degraded"), so checking the
 * headline state keeps stalled outbox attention-visible without reclassifying
 * it as a scheduler failure. `cooling_off` (active backoff) is included because
 * it is retry-relevant work the operator should be able to see at a glance.
 */
function isDegraded(overview: ConnectorOverview): boolean {
  const state = overview.connectionHealth?.state;
  return state === "degraded" || state === "cooling_off";
}

function isRunning(overview: ConnectorOverview): boolean {
  // push-mode local collectors report via the syncing badge, not isRunning.
  return Boolean(overview.isRunning || overview.connectionHealth?.badges.syncing);
}

/**
 * Stale requires the projection's freshness axis to say `stale`. When no
 * projection is present we have no freshness policy, so we do NOT guess — an
 * unknown-freshness connection is never counted as stale.
 */
function isStale(overview: ConnectorOverview): boolean {
  return overview.connectionHealth?.axes?.freshness === "stale";
}

export function summarizeConnectionHealth(overviews: readonly ConnectorOverview[]): ConnectionHealthSummaryStats {
  const primaryList = overviews.filter(shouldShowInPrimaryConnections);
  let needsAttention = 0;
  let degraded = 0;
  let running = 0;
  let stale = 0;
  for (const overview of primaryList) {
    if (isNeedsAttention(overview)) {
      needsAttention += 1;
    }
    // degraded and needsAttention are mutually exclusive on the projection
    // state machine (a connection has exactly one headline state), so a
    // connection is never double-counted across the two attention buckets.
    if (isDegraded(overview)) {
      degraded += 1;
    }
    if (isRunning(overview)) {
      running += 1;
    }
    if (isStale(overview)) {
      stale += 1;
    }
  }
  return {
    degraded,
    needsAttention,
    noData: overviews.length - primaryList.length,
    primaryList: primaryList.length,
    registeredTotal: overviews.length,
    running,
    stale,
  };
}
