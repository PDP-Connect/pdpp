// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Centralized state-aware count/label primitives for a reference-server
 * `total_records`/`totalRecords` value (Sol fourth-verdict P1.3, "Health
 * boundary" — reconcile-active-summary-evidence design.md). Every renderer
 * of a `total_records` value MUST check `isTotalRecordsAuthoritative`
 * (directly or via `formatTotalRecordsLabel`) before treating the number as
 * a proven exact count. `undefined` (a reference predating this field) is
 * treated as authoritative, preserving the exact prior always-numeric
 * rendering for every existing caller.
 *
 * Lives outside sources-view-model.ts (which re-exports both for existing
 * import sites) because that module and lib/connection-evidence.ts import
 * from each other; these two pure helpers have no dependency on either
 * module's own state and were the only shared surface causing the cycle.
 */
import type { RefCountState } from "./ref-client.ts";

export function isTotalRecordsAuthoritative(totalRecordsState?: RefCountState): boolean {
  return totalRecordsState === undefined || totalRecordsState === "known" || totalRecordsState === "known_zero";
}

/**
 * Non-authoritative states never render the number as a confident count:
 *   - `"stale"`: the evidence exists but is not current — the carried-over
 *     number (including a carried-over ZERO) renders as an explicitly
 *     unverified hint, never bare.
 *   - `"unobserved"`/`"unknown"`: no trustworthy value exists at all — the
 *     unit noun itself (not a number) is rendered as unavailable.
 *   - `"known"`/`"known_zero"`/omitted: the exact prior always-numeric
 *     rendering.
 */
export function formatTotalRecordsLabel(
  totalRecords: number,
  totalRecordsState: RefCountState | undefined,
  unit: string
): string {
  if (totalRecordsState === "stale") {
    return `${totalRecords.toLocaleString()} ${unit} (unverified)`;
  }
  if (totalRecordsState === "unobserved" || totalRecordsState === "unknown") {
    return `${unit} unavailable`;
  }
  return `${totalRecords.toLocaleString()} ${unit}`;
}
