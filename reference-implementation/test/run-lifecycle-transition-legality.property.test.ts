// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SKELETON — intentionally not implemented.
 *
 * Authored by openspec/changes/own-run-lifecycle-state-machine as a
 * tests-first artifact. Every case is `todo` because the run-lifecycle owner
 * module does not exist yet. These MUST NOT be made to pass by weakening the
 * assertion or by asserting against today's distributed writers: a test that
 * goes green without the implementation is the hollow-test defect this
 * program exists to kill.
 *
 * Covers forbidden transitions F7 (no transition out of a terminal state) and
 * F5 (no second terminal transition), from design.md (b).
 *
 * Property: after any generated sequence of transition attempts, the run's
 *   observed state is reachable from its initial state by LEGAL transitions
 *   alone, and a terminal state is never left.
 * Generator: random sequences drawn from the full
 *   (state x transition) cross-product, including transitions that are
 *   illegal from the current state. Length 1-20. Seeded and reported on
 *   failure so a counterexample is reproducible.
 * Invariant: the reachable-state check above, plus: the count of terminal
 *   transitions that reported success is at most 1 per run.
 */

import test from "node:test";

test("run lifecycle: transition legality", async (t) => {
  await t.test(
    "a generated attempt sequence leaves the run in a legally reachable state",
    { todo: "requires the run-lifecycle owner module (openspec: own-run-lifecycle-state-machine)" },
    () => {
      // Build the legal-transition table T1-T11 from the owner module's own
      // declaration -- never from a literal copied into this file, or the
      // test stops being able to catch a table change.
    }
  );

  await t.test(
    "no transition succeeds out of a terminal state (F7)",
    { todo: "requires the run-lifecycle owner module" },
    () => {
      // For each terminal state, attempt every transition. Expect every
      // attempt refused and the state unchanged.
    }
  );

  await t.test(
    "at most one terminal transition succeeds per run (F5)",
    { todo: "requires the run-lifecycle owner module" },
    () => {
      // Interleave several terminal attempts of differing kinds; exactly one
      // reports success and it is the one whose state the run ends in.
    }
  );

  await t.test(
    "the state set is closed: no attempt produces a state outside the declared set",
    { todo: "requires the run-lifecycle owner module" },
    () => {
      // Guards against a writer inventing a status string. Note there is no
      // CHECK constraint on run_history.status today, so nothing at the
      // database layer prevents this.
    }
  );
});
