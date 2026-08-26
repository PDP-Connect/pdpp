// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SKELETON — intentionally not implemented. See
 * openspec/changes/own-run-lifecycle-state-machine.
 *
 * Covers forbidden transition F6: a run may not remain non-terminal forever
 * with no live owner epoch. This is the YNAB stuck-run wedge as a property.
 *
 * Property: for any run abandoned mid-flight by an epoch that never returns,
 *   a terminal state is reachable, and afterwards the connector instance can
 *   admit a new run.
 * Generator: runs left non-terminal at every non-terminal state
 *   (`pending`, `running`, `awaiting_interaction`, `cancel_requested`) by an
 *   epoch that is then retired, followed by a successor boot.
 * Invariant: after the successor boots, the run is terminal AND a subsequent
 *   admission on that connector instance succeeds.
 *
 * The historical failure: a hung connector subprocess that never resolved or
 * rejected left an `activeRuns` entry forever, permanently 409-ing every
 * future manual run with `active_run_exists` until a process restart. The UAT
 * instance was later measured holding 7 of 8 `run_history` rows claiming
 * `running` as zombies up to two days old, each already carrying a
 * `run.abandoned` spine event -- the projection and the event log disagreeing
 * about the same run.
 *
 * The second assertion is the load-bearing one. Terminalizing the run while
 * leaving the instance unable to admit work would satisfy a naive
 * "is it terminal?" check and still reproduce the outage.
 */

import test from "node:test";

test("run lifecycle: no permanent wedge", async (t) => {
  await t.test(
    "a run whose owner epoch never returns becomes terminal",
    { todo: "requires the owner module and boot adjudication as a transition" },
    () => {
      // Cover every non-terminal state, not just `running`. A run wedged in
      // `awaiting_interaction` is the case that costs the owner a real OTP.
    }
  );

  await t.test(
    "the connector instance admits a new run after adjudication",
    { todo: "requires the owner module" },
    () => {
      // Assert admission SUCCEEDS -- the 409 `active_run_exists` path must be
      // gone. Terminality alone is not the property that matters here.
    }
  );

  await t.test(
    "the durable projection never claims running against a terminal event log",
    { todo: "requires the owner module" },
    () => {
      // The zombie-row condition measured on UAT. The event and its
      // projection must commit in one transaction.
    }
  );
});
