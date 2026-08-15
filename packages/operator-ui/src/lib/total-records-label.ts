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
 * Lives in operator-ui rather than the console app because both the console's
 * view-models and this package's pure render-models (e.g. `source-storage.ts`)
 * must route through it; the dependency runs console → operator-ui, so the
 * shared authority has to sit on this side. `apps/console/.../lib/
 * total-records-label.ts` re-exports these for its existing import sites.
 */

/**
 * Orthogonal count-evidence state (`reconcile-active-summary-evidence`
 * design.md "Health boundary"). Mirrors `RefCountState` in both ref-client
 * modules; declared here so this module stays free of wire-type imports.
 */
export type RefCountState = "known" | "known_zero" | "unobserved" | "stale" | "unknown";

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
