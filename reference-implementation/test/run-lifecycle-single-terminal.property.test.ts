// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SKELETON — intentionally not implemented. See
 * openspec/changes/own-run-lifecycle-state-machine.
 *
 * Covers forbidden transitions F5 (no second terminal transition) and F4
 * (the adjudication path may not record an interrupted run as `failed`).
 *
 * Property: a run reaches exactly one terminal state, and an interrupted run
 *   reaches `abandoned` rather than `failed`.
 * Generator: concurrent terminal attempts of differing kinds against one run,
 *   including a boot adjudicator racing a live executor, and a scheduler
 *   retry arriving after the generic writer already finalized.
 * Invariant: exactly one terminal transition reports success; the run's
 *   terminal state equals that transition's target; `records_emitted` is
 *   never revised downward.
 *
 * The scheduler-retry case is not hypothetical. `insert-run-history.sql:40`
 * and `stores/scheduler-store.ts:1018` upsert `status = excluded.status` with
 * NO `status = 'running'` fence -- the only status writers lacking one -- so a
 * scheduler retry can today overwrite an already-terminal status. This test
 * must fail against that writer before it is fixed.
 */

import test from "node:test";

test("run lifecycle: exactly one terminal state", async (t) => {
  await t.test(
    "concurrent terminal attempts resolve to exactly one winner",
    { todo: "requires the run-lifecycle owner module" },
    () => {
      // Count SUCCESSFUL terminal transitions, not final state. A design that
      // lets two writers both "succeed" and land on the same value would pass
      // a final-state-only assertion while still being two writers.
    }
  );

  await t.test(
    "an unfenced upsert cannot overwrite a terminal status",
    { todo: "requires the owner module; currently fails against insert-run-history.sql:40" },
    () => {
      // Terminalize a run, then replay the scheduler's appendRunHistory path
      // for the same (run_id, connector_instance_id). The terminal status must
      // survive.
    }
  );

  await t.test(
    "an interrupted run terminalizes as abandoned, never failed (F4)",
    { todo: "requires the owner module" },
    () => {
      // Of 134 production runs recorded as run.failed/controller_restarted,
      // 55 had staged a cursor and 34 had durably ingested a batch. The two
      // states carry different remedies and must not collapse.
    }
  );

  await t.test(
    "records committed before the terminal transition are never revised",
    { todo: "requires the owner module" },
    () => {
      // records_emitted must not be rewritten to zero by an abandon.
    }
  );
});
