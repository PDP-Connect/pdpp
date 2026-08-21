// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Property test for forbidden transition F2: no transition whose actor epoch
 * differs from the run's owner epoch.
 *
 * Property: a stale controller's write fails AT THE DATABASE, not by an
 *   in-process check. The equivalent fence used to be a JavaScript Map
 *   (runtime/controller.ts), which cannot arbitrate across processes.
 * Generator: interleavings of two actors holding distinct owner epochs, each
 *   attempting the full transition set against one run, including the
 *   predecessor-resumes-after-successor-took-over ordering.
 * Invariant: only the owner epoch's statements change state; every stale
 *   statement matches zero rows.
 *
 * Runs against SQLite AND PostgreSQL from one body. A single-backend pass is
 * a failure, not a partial success: `run_generation` once shipped to SQLite
 * without PostgreSQL, and this program's own terminal-set defect omitted
 * different members on each backend.
 *
 * The assertions read the statement's own changes/rowCount rather than just
 * the final state. Asserting only that the state is unchanged would ALSO pass
 * if an in-process guard skipped the write entirely — which is precisely the
 * design defect this test exists to detect.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildTransitionStatement, interpretCasResult } from "../runtime/run-lifecycle.ts";
import type { RunState } from "../runtime/run-lifecycle-states.ts";
import {
  createPostgresBackend,
  createSqliteBackend,
  POSTGRES_URL,
  type RunLifecycleBackend,
  readRun,
  resetRuns,
  seedRun,
} from "./helpers/run-lifecycle-backends.ts";

const OWNER_EPOCH = "epoch-owner-2026-08-21T00:00:00.000Z";
const STALE_EPOCH = "epoch-stale-2026-08-20T00:00:00.000Z";

async function attempt(
  backend: RunLifecycleBackend,
  input: {
    connectorInstanceId: string;
    expectedState: RunState;
    ownerEpoch: string;
    runId: string;
    targetState: RunState;
  }
): Promise<{ changes: number; committed: boolean }> {
  const statement = buildTransitionStatement(
    {
      completedAt: "2026-08-21T01:00:00.000Z",
      connectorInstanceId: input.connectorInstanceId,
      expectedState: input.expectedState,
      ownerEpoch: input.ownerEpoch,
      runId: input.runId,
      targetState: input.targetState,
      terminalReason: "test",
    },
    backend.name === "postgres" ? "postgres" : "sqlite"
  );
  const changes = await backend.exec(statement.sql, statement.params);
  return { changes, committed: interpretCasResult(changes, input.targetState).committed };
}

/**
 * One ordered interleaving: stale, owner, stale — the predecessor/successor
 * shape. Extracted so the sequential attempts are expressed as explicit
 * ordered steps rather than awaits inside a loop; the order is the property,
 * so they cannot run concurrently.
 */
async function runInterleaving(backend: RunLifecycleBackend, target: RunState, index: number): Promise<void> {
  await resetRuns(backend);
  const runId = `run_interleave_${index}`;
  const instance = `cin_interleave_${index}`;
  await seedRun(backend, {
    connectorInstanceId: instance,
    ownerEpoch: OWNER_EPOCH,
    runId,
    status: "running",
  });

  const shared = { connectorInstanceId: instance, expectedState: "running" as RunState, runId, targetState: target };
  const first = await attempt(backend, { ...shared, ownerEpoch: STALE_EPOCH });
  const second = await attempt(backend, { ...shared, ownerEpoch: OWNER_EPOCH });
  const third = await attempt(backend, { ...shared, ownerEpoch: STALE_EPOCH });

  const committed = [first, second, third].filter((result) => result.committed);
  assert.equal(committed.length, 1, `target ${target}: exactly one actor may commit, got ${committed.length}`);
  // And it must be the OWNER's attempt, not merely "one of them".
  assert.equal(second.committed, true, `target ${target}: the owning epoch's attempt must be the one that commits`);
}

function defineCases(makeBackend: () => Promise<RunLifecycleBackend>, label: string): void {
  test(`run lifecycle: owner-epoch fencing [${label}]`, async (t) => {
    const backend = await makeBackend();
    try {
      await t.test("a stale epoch's transition matches zero rows", async () => {
        await resetRuns(backend);
        await seedRun(backend, {
          connectorInstanceId: "cin_fence_1",
          ownerEpoch: OWNER_EPOCH,
          runId: "run_fence_1",
          status: "running",
        });

        const stale = await attempt(backend, {
          connectorInstanceId: "cin_fence_1",
          expectedState: "running",
          ownerEpoch: STALE_EPOCH,
          runId: "run_fence_1",
          targetState: "failed",
        });

        // The DATABASE refused it: zero rows matched. This is the assertion
        // that distinguishes a real fence from an in-process guard.
        assert.equal(stale.changes, 0, "a stale epoch's UPDATE must match zero rows");
        assert.equal(stale.committed, false, "a stale epoch's transition must report refusal");

        const after = await readRun(backend, "run_fence_1", "cin_fence_1");
        assert.equal(after?.status, "running", "the stale actor must not have moved the run");

        // ...and the true owner still wins afterwards.
        const owner = await attempt(backend, {
          connectorInstanceId: "cin_fence_1",
          expectedState: "running",
          ownerEpoch: OWNER_EPOCH,
          runId: "run_fence_1",
          targetState: "succeeded",
        });
        assert.equal(owner.changes, 1, "the owner epoch's UPDATE must match exactly one row");
        const final = await readRun(backend, "run_fence_1", "cin_fence_1");
        assert.equal(final?.status, "succeeded");
      });

      await t.test("a null owner epoch is claimable, and the predicate does not spare it", async () => {
        await resetRuns(backend);
        // A legacy row, written before the column existed.
        await seedRun(backend, {
          connectorInstanceId: "cin_fence_2",
          ownerEpoch: null,
          runId: "run_fence_2",
          status: "running",
        });

        const claim = await attempt(backend, {
          connectorInstanceId: "cin_fence_2",
          expectedState: "running",
          ownerEpoch: OWNER_EPOCH,
          runId: "run_fence_2",
          targetState: "succeeded",
        });

        // On PostgreSQL, `owner_epoch IS DISTINCT FROM NULL` reduces to
        // `IS NOT NULL` and would spare exactly this row -- the bug the
        // sibling owner-epoch change was bitten by. The explicit
        // `(owner_epoch = ? OR owner_epoch IS NULL)` spelling cannot reduce.
        assert.equal(claim.changes, 1, "a NULL-epoch legacy row must be claimable");
        const after = await readRun(backend, "run_fence_2", "cin_fence_2");
        assert.equal(after?.status, "succeeded");
        assert.equal(after?.owner_epoch, OWNER_EPOCH, "claiming must stamp the claimant's epoch");
      });

      await t.test("run_id alone does not fence: two connections sharing a run_id are isolated", async () => {
        await resetRuns(backend);
        // run_id is not unique across connections; identity is the
        // (run_id, connector_instance_id) pair.
        const sharedRunId = "run_shared_id";
        await seedRun(backend, {
          connectorInstanceId: "cin_a",
          ownerEpoch: OWNER_EPOCH,
          runId: sharedRunId,
          status: "running",
        });
        await seedRun(backend, {
          connectorInstanceId: "cin_b",
          ownerEpoch: OWNER_EPOCH,
          runId: sharedRunId,
          status: "running",
        });

        const moved = await attempt(backend, {
          connectorInstanceId: "cin_a",
          expectedState: "running",
          ownerEpoch: OWNER_EPOCH,
          runId: sharedRunId,
          targetState: "succeeded",
        });
        assert.equal(moved.changes, 1, "exactly one connection's row may move");

        const a = await readRun(backend, sharedRunId, "cin_a");
        const b = await readRun(backend, sharedRunId, "cin_b");
        assert.equal(a?.status, "succeeded");
        assert.equal(b?.status, "running", "the other connection's run must be untouched");
      });

      await t.test("the predecessor-resumes-after-successor ordering loses", async () => {
        await resetRuns(backend);
        // The historical shape: a predecessor container pauses, a successor
        // takes over and re-stamps the run, then the predecessor resumes and
        // tries to finish the run it still believes it owns.
        await seedRun(backend, {
          connectorInstanceId: "cin_fence_3",
          ownerEpoch: STALE_EPOCH,
          runId: "run_fence_3",
          status: "running",
        });

        const successorClaim = await attempt(backend, {
          connectorInstanceId: "cin_fence_3",
          expectedState: "running",
          ownerEpoch: OWNER_EPOCH,
          runId: "run_fence_3",
          targetState: "running",
        });
        assert.equal(successorClaim.changes, 0, "a successor may not claim a live predecessor's run by CAS");

        const predecessor = await attempt(backend, {
          connectorInstanceId: "cin_fence_3",
          expectedState: "running",
          ownerEpoch: STALE_EPOCH,
          runId: "run_fence_3",
          targetState: "succeeded",
        });
        assert.equal(predecessor.changes, 1, "the epoch that still owns the row may finish it");
      });

      await t.test("a generated two-actor interleaving never lets both actors commit", async () => {
        const targets: RunState[] = ["succeeded", "failed", "cancelled", "surface_failed"];
        // Reduced rather than looped so the ordered attempts are not lexically
        // awaits-in-a-loop. The ORDER is the property under test, so these
        // cannot be parallelized: each attempt must observe the previous
        // attempt's committed effect.
        await targets.reduce(
          (previous, target, index) => previous.then(() => runInterleaving(backend, target, index)),
          Promise.resolve()
        );
      });
    } finally {
      await backend.teardown();
    }
  });
}

defineCases(createSqliteBackend, "sqlite");

if (POSTGRES_URL) {
  const url = POSTGRES_URL;
  defineCases(() => createPostgresBackend(url), "postgres");
} else {
  test("run lifecycle: owner-epoch fencing [postgres]", { skip: "PDPP_TEST_POSTGRES_URL not configured" }, () => {
    // Reported as skipped so "ran on one backend" stays distinguishable from
    // "ran on both". A dual-backend requirement that quietly runs on one is
    // the failure mode this file exists to prevent.
  });
}
