// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SKELETON — intentionally not implemented. See
 * openspec/changes/own-run-lifecycle-state-machine.
 *
 * Covers forbidden transition F3: no transition may commit on a premise that
 * changed under it. This is the collector-runner drain/clock boundary race
 * generalized.
 *
 * Property: for any transition, if the run's state changes between the
 *   caller's observation and its write, the write does not commit.
 * Generator: transition attempts with a competing actor injected into the
 *   window between read and write, mutating the run to every other reachable
 *   state. Also covers two observations of the same clock/state taken at
 *   different instants within one decision.
 * Invariant: the transition commits only if the observed state still holds
 *   at write time; otherwise it is refused and reports refusal.
 *
 * The original incident: `drainCollectorOutbox` abandoned a due outbox row
 * because two clock reads used opposite boundary semantics (`<=` on claim,
 * `>` on `nextRetryTime`), so a deadline landing between the two reads
 * produced a false "empty" exit. The generalized defect is decide-then-write
 * against a premise nobody re-checked.
 *
 * A compare-and-swap makes the class unrepresentable rather than fixing the
 * instance -- which is the point: the same shape recurred in the maintenance
 * sweep three times after being named twice.
 */

import test from "node:test";

test("run lifecycle: no transition commits on a stale premise", async (t) => {
  await t.test(
    "a competing mutation in the read-write window refuses the transition",
    { todo: "requires the owner module's compare-and-swap" },
    () => {
      // Inject the competing write between observation and attempt, across
      // every target state.
    }
  );

  await t.test(
    "a refused transition reports refusal rather than silently no-oping",
    { todo: "requires the owner module" },
    () => {
      // A refusal that looks like success is how a false "empty" exit
      // happened. The caller must be able to tell the two apart.
    }
  );

  await t.test(
    "no decision reads the same fact twice with different boundary semantics",
    { todo: "requires the owner module" },
    () => {
      // The literal drain/clock defect: one decision, one observation.
    }
  );
});
