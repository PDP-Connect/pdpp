// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { EphemeralBrowserRuntimeProjection } from "./ephemeral-health-projection.ts";

export interface ConnectorSummaryCacheValue {
  readonly connection_health: {
    readonly ephemeral_browser_runtime: EphemeralBrowserRuntimeProjection | null;
  };
}

/**
 * No `freshUntil`/`staleUntil`/`value` fields: the central observation
 * barrier (`reconcileDirtyConnectorSummaryEvidence`, called by every
 * `listConnectorSummaries`/`getConnectorSummaryForRoute` caller before this
 * decision runs) already guarantees each computation reflects canonical
 * state, so a time-relative cached verdict can never be more current than a
 * fresh compute — only equal to it or stale. Retaining a fresh/stale value
 * window on top of that barrier would let a pre-repair verdict bypass it,
 * which design.md's "Central consumer and cache boundary" explicitly
 * forbids. `promise` is the only state worth keeping: in-flight coalescing
 * so N concurrent callers share one compute rather than issuing N barrier
 * passes + N syntheses.
 * Spec: openspec/changes/reconcile-active-summary-evidence/design.md
 */
export interface ConnectorSummaryCacheEntry<T extends ConnectorSummaryCacheValue> {
  readonly generation: number;
  readonly promise?: Promise<T[]>;
}

export type ConnectorSummaryCacheDecision = "await_refresh" | "compute";

function dynamicObservationExpiry(value: ConnectorSummaryCacheValue): number | null {
  const runtime = value.connection_health.ephemeral_browser_runtime;
  if (runtime?.surface_mode !== "dynamic-managed") {
    return null;
  }
  const expiry = runtime.allocator_observation?.expires_at;
  const parsed = expiry ? Date.parse(expiry) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Earliest expiry across a summary batch's dynamic-allocator observations,
 * or `null` when none are dynamic-managed. This is capability-currentness
 * evidence (does the allocator still vouch for this surface), a distinct
 * concern from the removed time-relative value cache — kept as a pure
 * utility for any caller that still needs to reason about allocator
 * observation freshness directly.
 */
export function dynamicRuntimeObservationExpiry(value: readonly ConnectorSummaryCacheValue[]): number | null {
  let earliest: number | null = null;
  for (const summary of value) {
    earliest = earliestDynamicExpiry(earliest, dynamicObservationExpiry(summary));
  }
  return earliest;
}

function earliestDynamicExpiry(earliest: number | null, candidate: number | null): number | null {
  if (earliest === 0) {
    return 0;
  }
  if (candidate === 0) {
    return 0;
  }
  if (candidate === null) {
    return earliest;
  }
  if (earliest === null) {
    return candidate;
  }
  return Math.min(earliest, candidate);
}

/**
 * Pure in-flight-coalescing decision: `await_refresh` when a compute for
 * this key is already running, `compute` otherwise. Never returns a
 * time-relative "still fresh" verdict — every call recomputes (which itself
 * re-runs the barrier), so no pre-repair value can be served.
 */
export function decideConnectorSummariesCacheRead<T extends ConnectorSummaryCacheValue>(
  entry: ConnectorSummaryCacheEntry<T> | undefined
): ConnectorSummaryCacheDecision {
  return entry?.promise ? "await_refresh" : "compute";
}
