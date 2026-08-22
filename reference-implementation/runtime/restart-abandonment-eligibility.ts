// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Which staged checkpoints survive a CONTROLLER restart.
 *
 * ## Why this exists
 *
 * `commitState` runs only from `handleDoneClose`. A run whose controller is
 * replaced mid-walk never reaches DONE, so it commits no cursor however long
 * it ran. A walk longer than the interval between deploys therefore never
 * converges — that is a COMPLETENESS failure, not a slowness one. Measured on
 * this instance: 45 runs ended this way between 2026-08-15 and 2026-08-22,
 * concentrated in the longest walks (9 Slack, 4 Gmail, 3 YNAB, plus Amazon and
 * Google Maps).
 *
 * ## Why it is safe, and narrow
 *
 * The rule it carves out of exists to protect ONE invariant: a cursor must
 * never advance past records whose detail coverage was not proven. This
 * exception preserves that invariant structurally rather than trusting it:
 *
 *  - A stream that is a declared detail-coverage PARENT can face a DONE-time
 *    shortfall verdict, so it is excluded outright. Eligibility is read from
 *    the MANIFEST — a connector cannot declare itself eligible. (Ruling D10:
 *    qualification is proven, never self-declared. Voluntary honesty is a
 *    failure mode this program has already been burned by.)
 *  - A stream carrying a pending detail gap, or unproven coverage for the
 *    completed prefix, is excluded — the uncertain case fails CLOSED.
 *  - Only a CONTROLLER-lifecycle death qualifies. A connector that reported
 *    its own failure is not covered: its state map is unproven by definition.
 *
 * The run stays failed/abandoned and every withheld stream stays eligible for
 * retry. Nothing here makes a run look more complete than it was.
 *
 * Spec: `spec-collection-profile.md` — "Restart abandonment".
 */

/** Terminal reasons that mean THE CONTROLLER died, not that the connector failed.
 *
 *  Keyed on terminal REASON, never on status: restart-killed runs are stored
 *  under two different statuses (`abandoned` and `failed`), so a status-based
 *  check silently misses a large share of them — 17 of 45 on this instance. */
export const CONTROLLER_LIFECYCLE_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  "controller_terminated_before_run_finished",
  "controller_restarted",
]);

export interface RestartAbandonmentInput {
  /** Streams that are declared detail-coverage parents in the manifest. */
  readonly declaredDetailParentStreams: ReadonlySet<string>;
  /** State streams holding a pending detail gap this run. */
  readonly streamsWithPendingDetailGaps: ReadonlySet<string>;
  /** State streams whose completed prefix has unproven coverage. */
  readonly streamsWithUnprovenCoverage: ReadonlySet<string>;
  /** The run's terminal reason, if any. */
  readonly terminalReason: string | null | undefined;
}

/** True when the controller died rather than the connector reporting failure. */
export function isControllerLifecycleAbandonment(terminalReason: string | null | undefined): boolean {
  return typeof terminalReason === "string" && CONTROLLER_LIFECYCLE_TERMINAL_REASONS.has(terminalReason);
}

/**
 * The staged checkpoint streams that may commit despite no valid DONE.
 *
 * Returns an EMPTY set for anything that is not a controller-lifecycle
 * abandonment — a connector-reported failure, a protocol violation, and
 * cancellation all keep the default fail-closed rule.
 */
export function eligibleRestartAbandonmentStreams(
  stagedStateStreams: readonly string[],
  input: RestartAbandonmentInput
): ReadonlySet<string> {
  if (!isControllerLifecycleAbandonment(input.terminalReason)) {
    return new Set();
  }
  return new Set(
    stagedStateStreams.filter(
      (stream) =>
        !(
          input.declaredDetailParentStreams.has(stream) ||
          input.streamsWithPendingDetailGaps.has(stream) ||
          input.streamsWithUnprovenCoverage.has(stream)
        )
    )
  );
}
