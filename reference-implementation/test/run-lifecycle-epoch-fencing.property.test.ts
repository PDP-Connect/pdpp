// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SKELETON — intentionally not implemented. See
 * openspec/changes/own-run-lifecycle-state-machine. Every case is `todo`
 * because the run-lifecycle owner module does not exist yet, and because
 * `run_history` has no `owner_epoch` column on either backend today
 * (server/db.ts:1358, server/postgres-storage.ts:2169).
 *
 * Covers forbidden transition F2: no transition whose actor epoch differs
 * from the run's owner epoch.
 *
 * Property: a stale controller's write fails AT THE DATABASE, not by an
 *   in-process check. Today the equivalent fence is a JavaScript Map
 *   (runtime/controller.ts:1046), which cannot arbitrate across processes.
 * Generator: interleavings of two actors holding distinct owner epochs,
 *   each attempting the full transition set against one run. Includes the
 *   predecessor-resumes-after-successor-took-over ordering.
 * Invariant: only the owner epoch's statements change state; every stale
 *   statement matches zero rows.
 *
 * MUST run against SQLite AND PostgreSQL from one body. A Postgres-only or
 * SQLite-only pass is a failure: this repo has already shipped a fence to
 * SQLite without PostgreSQL (`run_generation`), and 6,792 tests once stayed
 * green while the deployed backend could not paginate.
 */

import test from "node:test";

test("run lifecycle: owner-epoch fencing", async (t) => {
  await t.test(
    "a stale epoch's transition matches zero rows on both backends",
    { todo: "requires run_history.owner_epoch and the owner module" },
    () => {
      // Assert on the statement's own changes/rowCount -- proving the DATABASE
      // refused it. Asserting only that final state is unchanged would also
      // pass if an in-process guard skipped the write, which is the exact
      // design defect this test exists to detect.
    }
  );

  await t.test(
    "a null owner epoch is claimable, and the predicate does not spare it",
    { todo: "requires run_history.owner_epoch and the owner module" },
    () => {
      // Legacy rows written before the column existed. On PostgreSQL,
      // `owner_epoch IS DISTINCT FROM NULL` reduces to `IS NOT NULL` and
      // would spare exactly these rows -- the bug the sibling owner-epoch
      // change was bitten by. Assert the explicit-null-arm spelling instead.
    }
  );

  await t.test(
    "run_id alone does not fence: two connections sharing a run_id are isolated",
    { todo: "requires the owner module" },
    () => {
      // run_id is not unique across connections; identity is the
      // (run_id, connector_instance_id) pair. Note controller-boot.ts:829
      // (PostgreSQL drift repair) currently matches on run_id alone while its
      // SQLite twin at :788 fences on the pair.
    }
  );

  await t.test(
    "both backends produce identical fencing outcomes for the same interleaving",
    { todo: "requires run_history.owner_epoch on both backends" },
    () => {
      // Replay one generated interleaving against each backend and diff the
      // outcome sequences.
    }
  );
});
