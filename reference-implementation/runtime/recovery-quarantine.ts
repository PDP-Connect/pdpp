// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-item recovery quarantine (OpenSpec
 * `add-connector-neutral-recovery-governor`, design.md D9/D10, tasks 1.6 / 2.5 /
 * runtime-3.4).
 *
 * The section 10-A terminal-gap classifier (`server/stores/terminal-gap-classifier.ts`)
 * already terminalizes a gap that keeps failing against a **non-transient** HTTP
 * error (404/410/permanent-403/401). That covers "the resource is provably
 * gone". It does NOT cover the two poison-item cases design.md calls out:
 *
 *   - D10 (poison item): an item that keeps failing **deterministically while
 *     siblings progress**, with a transient-*looking* signal (parse-missing,
 *     no-progress DOM navigation, an unclassified re-defer). Its `last_error`
 *     carries no non-transient HTTP status, so `maybeTerminateGap` never fires
 *     and the item retries forever, consuming the backlog's recovery budget.
 *   - D9 (crash loop): an attempt that is interrupted between emit and gap-state
 *     update. `markGapStatus('in_progress')` already counts the attempt before
 *     the connector acts, and the crash-reclaim path resets `in_progress` ->
 *     `pending` **without** decrementing `attempt_count`, so repeated
 *     interruption climbs `attempt_count` exactly like a repeated deterministic
 *     failure - and must escalate the same way rather than looping forever.
 *
 * Both converge on one connector-neutral rule: **count attempts, and when an
 * item crosses a per-item no-progress threshold without ever recovering,
 * quarantine it** - move it to the durable `terminal` status with a distinct
 * `quarantined` class and captured evidence. `terminal` is already excluded from
 * the fillable-pending set and counted separately, so quarantine reuses the
 * durable substrate with no schema change; the `quarantined` class is what the
 * recovery-decision classifier routes to `connector_defect` / `system_issue`
 * (no owner retry) and what owner-only accounting surfaces as a distinct count.
 *
 * This module is **pure**: it takes a gap-row projection + a policy and returns
 * a decision as data. The effectful "read row, decide, write terminal" wrapper
 * lives beside the terminal-gap classifier in the store layer
 * (`maybeQuarantineGap`), mirroring `maybeTerminateGap` so the two escalation
 * paths compose without a rewrite of either.
 */

/** The durable class stamped on a quarantined item's `reason` / `last_error.class`. */
export const QUARANTINE_CLASS = "quarantined";

/**
 * Per-item quarantine policy. `maxNoProgressAttempts` is the number of counted
 * attempts an item may make **without recovering** before it is quarantined.
 * This is deliberately distinct from the terminal-gap classifier's
 * `maxRecoveryAttempts` (which gates only non-transient HTTP errors): a poison
 * item's error is transient-looking, so it needs its own no-progress budget.
 *
 * The default is conservative: an item gets a generous number of confirming
 * no-progress attempts before it is declared poison, because a quarantine
 * removes it from owner-drainable retry. A connector MAY tighten this, but it
 * can never opt out - every item is subject to a finite no-progress budget so a
 * poison item can never consume the backlog indefinitely (design.md D10).
 */
export interface QuarantinePolicy {
  readonly maxNoProgressAttempts: number;
}

/**
 * Conservative default no-progress budget. A touch more generous than the
 * section 10-A non-transient budget (5) because a transient-looking failure deserves
 * more confirming retries than a provably-gone 404 before it is declared poison.
 */
export const DEFAULT_QUARANTINE_POLICY: QuarantinePolicy = Object.freeze({
  maxNoProgressAttempts: 8,
});

/**
 * The minimal projection `evaluateQuarantine` needs from a `connector_detail_gaps`
 * row. Matches the snake_case shape `rowToGap` returns; only the fields that
 * drive the decision are read, so this pure decision can never touch a payload,
 * locator, or secret.
 */
export interface QuarantineGapRow {
  readonly attempt_count?: number | null;
  readonly status?: string | null;
}

/** Why an item was (or was not) quarantined - a machine-readable data decision. */
export type QuarantineDecision =
  | { readonly quarantine: false; readonly reason: "already_terminal" | "recovered" | "under_budget" }
  | { readonly quarantine: true; readonly attemptCount: number; readonly threshold: number };

/**
 * Decide, from a gap row and a policy, whether the item has crossed its
 * per-item no-progress budget and must be quarantined. Pure - no I/O, no clock.
 *
 * A `recovered` or `terminal` item is never quarantined (recovery already
 * concluded, and `terminal` - including a prior quarantine - is sticky). An item
 * still under budget stays queued for another attempt. Only a still-open item
 * that has reached `maxNoProgressAttempts` counted attempts without recovering
 * is quarantined.
 */
export function evaluateQuarantine(row: QuarantineGapRow, policy: QuarantinePolicy): QuarantineDecision {
  const threshold = policy?.maxNoProgressAttempts;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0) {
    throw new Error(
      "evaluateQuarantine requires policy.maxNoProgressAttempts as a positive integer; " +
        "a poison item must always have a finite no-progress budget (design.md D10)"
    );
  }

  const status = typeof row?.status === "string" ? row.status : null;
  if (status === "terminal") {
    return { quarantine: false, reason: "already_terminal" };
  }
  if (status === "recovered") {
    return { quarantine: false, reason: "recovered" };
  }

  const attemptCount = normalizeNonNegativeInteger(row?.attempt_count);
  if (attemptCount < threshold) {
    return { quarantine: false, reason: "under_budget" };
  }
  return { quarantine: true, attemptCount, threshold };
}

function normalizeNonNegativeInteger(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}
