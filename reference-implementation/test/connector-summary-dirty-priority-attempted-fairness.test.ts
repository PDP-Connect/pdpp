// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fairness defect in `runDirtyPriorityAcceleration`'s rotation cursor
 * (`nextDirtyAfterId`, connector-summary-read-model.ts), identified by an
 * independent design reviewer and CONFIRMED live on production (2026-08-18).
 *
 * Before this fix, the cursor advanced to the LAST FETCHED id
 * (`dirtyIds.at(-1)`) BEFORE `observeConnectorSummaryEvidence` ever ran —
 * committed regardless of how many of those fetched ids the round's
 * deadline actually let `repairCandidates` attempt. `repairCandidates`
 * only guarantees candidate #1 a turn once the deadline has already
 * expired (the "repair at least one" floor closed 2026-08-18); every
 * candidate AFTER #1 is skipped once expired.
 *
 * Counterexample A (backlog SMALLER than the page limit — the live
 * production case): 8 dirty ids, page limit 25. Every round fetches all 8,
 * commits the cursor to id #8, then (under sustained load) the deadline
 * expires during/after discovery so only candidate #1 is attempted.
 *
 * NOTE ON `readDirtyInstanceIdPage`'s existing wraparound: the SQLite/
 * Postgres store's `listDirtyInstanceIds` ALREADY silently re-fetches from
 * the start whenever an `afterId`-filtered query returns empty (see its
 * "Wraparound" comments) — this is pre-existing behavior, not part of this
 * fix. That wraparound means a merely-past-the-end cursor is harmless on its
 * own: it does not, by itself, wedge a backlog smaller than one page. The
 * genuine wedge (empirically verified against the reverted pre-fix source
 * before any test below was written) requires the SAME candidate to be
 * re-selected as "the" guaranteed-first candidate every round — which
 * happens whenever that candidate's own repair never clears its dirty flag
 * (fails or is deferred). Every test below that targets this cursor uses a
 * genuinely FAILING poisoned candidate (`poisonCandidate`) for exactly this
 * reason — an always-succeeding candidate set converges at the same rate
 * whether the cursor tracks "fetched" or "attempted", because the
 * wraparound papers over the fetched/attempted gap once nothing ahead of
 * the cursor remains dirty.
 *
 * Counterexample B (backlog LARGER than the page limit): with 100 dirty
 * ids and page size 25, a permanently expired deadline attempts id 1, 26,
 * 51, 76, then id 1 again forever — ids 2-25, 27-50, etc. never become
 * first and never run. Here the wedge does NOT need a poisoned candidate to
 * reproduce (a full page's `dirtyIds.at(-1)` is a REAL later id, not an
 * artifact of the wraparound) — but this suite poisons the same 4 positions
 * anyway so the discriminator (which ids get serviced) is unambiguous
 * rather than merely "how many rounds until eventual convergence" (both
 * pre-fix and post-fix eventually converge at the SAME rate when every
 * candidate always succeeds — see the empirical trace in this defect's
 * fix-and-report notes).
 *
 * The fix: advance the cursor to the last id the round genuinely ATTEMPTED
 * (repair was invoked, whether it then succeeded, failed, or was
 * deferred) — never merely the last id FETCHED. See
 * `lastAttemptedDirtyId`/`runDirtyPriorityAcceleration`'s doc in
 * connector-summary-read-model.ts.
 *
 * Every fleet here uses a lexicographically LATER `connectorId` prefix
 * ("z...") than a large sibling fleet ("a..."), so the cursor WALK's own
 * page(s) (ordered `connector_instance_id ASC` across the COMPLETE
 * canonical set) stay inside the sibling prefix and never repair the
 * dirty targets "for free" — isolating the ACCELERATION tranche's own
 * fairness behavior, which is what this defect is in.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  __testOnlySetNextDirtyAfterId,
  __testOnlySetSweepClock,
  __testOnlySetSweepDiscoveryHook,
  markConnectorSummaryEvidenceDirty,
  reconcileDirtyConnectorSummaryEvidence,
  runBoundedSummaryEvidenceSweep,
} from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const NOW = "2026-08-18T00:00:00.000Z";
const PRODUCTION_PAGE_SIZE = 25;

function withTempDb(fn: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-dirty-priority-fairness-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      __testOnlySetNextDirtyAfterId(null);
      await fn();
    } finally {
      __testOnlySetNextDirtyAfterId(null);
      __testOnlySetSweepDiscoveryHook(null);
      __testOnlySetSweepClock(null);
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function seedConnections(n: number, { connectorId }: { connectorId: string }): string[] {
  const existing = getDb().prepare("SELECT 1 FROM connectors WHERE connector_id = ?").get(connectorId);
  if (!existing) {
    getDb()
      .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, '{}', ?)")
      .run(connectorId, NOW);
  }
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = `${connectorId}_cin_${String(i).padStart(4, "0")}`;
    getDb()
      .prepare(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         ) VALUES (?, 'owner_local', ?, 'x', 'active', 'account', ?, '{}', ?, ?, NULL)`
      )
      .run(id, connectorId, id, NOW, NOW);
    ids.push(id);
  }
  return ids;
}

/**
 * A sibling fleet large enough that the walk's own page(s), bounded by
 * `maxPages`, cannot reach past it in the tests below — isolating
 * acceleration's own fairness behavior from the walk's independent
 * (already-correct) convergence.
 */
function seedWalkDecoyFleet(n = 500): void {
  seedConnections(n, { connectorId: "a_decoy" });
}

function dirtyCount(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM connector_summary_evidence WHERE dirty <> 0")
    .get<{ n: number }>();
  return Number(row?.n ?? 0);
}

function isDirty(connectorInstanceId: string): boolean {
  const row = getDb()
    .prepare("SELECT dirty FROM connector_summary_evidence WHERE connector_instance_id = ?")
    .get<{ dirty: number }>(connectorInstanceId);
  return row !== undefined && Number(row.dirty) !== 0;
}

/**
 * `markConnectorSummaryEvidenceDirty` is a plain `UPDATE ... WHERE
 * connector_instance_id = ?` — a no-op against a connection with no
 * evidence row yet. Establish baseline evidence rows for exactly the
 * target ids first (a scoped reconcile, not a fleet-wide sweep — the decoy
 * fleet does not need evidence rows for these tests), then mark them
 * dirty.
 */
async function seedDirtyBacklog(ids: readonly string[]): Promise<void> {
  await reconcileDirtyConnectorSummaryEvidence(ids);
  for (const id of ids) {
    // biome-ignore lint/performance/noAwaitInLoops: Deterministic seeding order.
    await markConnectorSummaryEvidenceDirty({ connectorInstanceId: id, reason: "test" });
  }
}

/**
 * One dirty-priority round, isolated from the walk by giving acceleration
 * first opportunity every round AND bounding the walk to exactly one page
 * of the decoy fleet (`maxPages: 1`) so it can never reach the "z"-prefixed
 * targets seeded by these tests.
 */
function runOneAccelerationRound(maxDurationMs: number) {
  return runBoundedSummaryEvidenceSweep({
    afterId: null,
    firstTranche: "acceleration",
    maxDurationMs,
    maxPages: 1,
    pageSize: PRODUCTION_PAGE_SIZE,
  });
}

// ---------------------------------------------------------------------------
// Test 1 — backlog SMALLER than the page limit (the live production shape):
// 8 dirty ids, page limit 25, first candidate effectively deferred forever
// by simulating "deadline already expired once discovery/candidate #1's
// turn has been spent" via a near-zero budget re-applied every round. Every
// one of the 8 must receive an attempt within a bounded number of rounds.
// ---------------------------------------------------------------------------

/**
 * Poisons ONE candidate's repair so it can never succeed (a real SQLite
 * fault-injection trigger, scoped by `connector_instance_id` — the same
 * pattern reconcile-summary-evidence-failure-persistence.test.ts uses).
 * Fires on both plain INSERT (cold row) and the INSERT..ON CONFLICT
 * upsert's insert-conflict path (existing row), so it reliably fails the
 * repair regardless of whether the target already has an evidence row.
 */
function poisonCandidate(connectorInstanceId: string): { drop: () => void } {
  const triggerName = `fault_poison_${connectorInstanceId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  getDb().exec(
    `CREATE TRIGGER ${triggerName}
       BEFORE INSERT ON connector_summary_evidence
       WHEN NEW.connector_instance_id = '${connectorInstanceId}'
     BEGIN
       SELECT RAISE(ABORT, 'injected poison-candidate repair fault');
     END`
  );
  return {
    drop() {
      getDb().exec(`DROP TRIGGER ${triggerName}`);
    },
  };
}

test(
  "FAIRNESS (backlog SMALLER than page limit): every one of 8 dirty ids receives an attempt within a bounded number of rounds",
  withTempDb(async () => {
    seedWalkDecoyFleet();
    const ids = seedConnections(8, { connectorId: "z_small" });
    await seedDirtyBacklog(ids);
    assert.equal(dirtyCount(), 8, "precondition: exactly 8 dirty rows (decoy fleet has no evidence rows yet)");

    // Poison the LEXICALLY FIRST id so it permanently occupies
    // `repairCandidates`'s "repair at least one" guaranteed-first slot, and
    // throttle every candidate's repair with a real per-candidate delay
    // (`PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS`) so a tight real
    // `maxDurationMs` genuinely lets only ONE candidate be attempted per
    // round. This is the reproduced live shape (empirically verified
    // against the reverted pre-fix source before writing this assertion):
    // `readDirtyInstanceIdPage`'s own SQLite/Postgres "wraparound" fallback
    // (already-existing code, unrelated to this fix) means a backlog
    // smaller than one page does NOT wedge merely because `afterId` runs
    // off the end — it silently re-fetches from the start. The wedge is
    // specifically that the PRE-FIX cursor (`dirtyIds.at(-1)`, the last
    // FETCHED id) re-selects the SAME poisoned first candidate every round
    // forever, because the fetched page is identical every time (nothing
    // before the poison id ever clears). The FIX (last ATTEMPTED id)
    // advances past the poison id after its failed attempt, so the NEXT
    // round's `afterId` query genuinely excludes it and reaches id #2.
    const [poison, ...rest] = ids;
    assert.ok(poison && rest.length === 7);
    const fault = poisonCandidate(poison);
    process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS = "40";
    try {
      const attemptedAtLeastOnce = new Set<string>();
      // The property under test is that the rotation cursor ADVANCES past the
      // poisoned candidate, so every sibling is eventually reached — not that
      // it is reached in a specific number of rounds. `rest.length + 2` bounded
      // it at exactly the ideal round count plus one, which made a correctness
      // property fail intermittently on scheduler timing alone: under full-suite
      // load a round can land mid-repair and the run reaches the ceiling having
      // cleared 6 of 7. (Observed as a red baseline that passed 3/3 in
      // isolation.) The generous ceiling still falsifies the wedge it guards —
      // a re-selecting cursor clears ZERO siblings no matter how long it runs —
      // while no longer failing for a reason the test does not control.
      const maxRounds = rest.length * 3 + 5;
      let roundsTaken = 0;
      for (let round = 0; round < maxRounds; round += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: Each round must observe the prior round's durable rotation cursor.
        await runOneAccelerationRound(10);
        roundsTaken += 1;
        for (const id of rest) {
          if (!isDirty(id)) {
            attemptedAtLeastOnce.add(id);
          }
        }
        if (attemptedAtLeastOnce.size === rest.length) {
          break;
        }
      }

      assert.equal(
        attemptedAtLeastOnce.size,
        rest.length,
        `every one of the ${rest.length} non-poison dirty ids must be repaired within ${maxRounds} rounds ` +
          `(took ${roundsTaken}) — a wedge on the poisoned first candidate would leave ALL of them stuck: ` +
          `still stuck dirty: ${rest.filter((id) => !attemptedAtLeastOnce.has(id)).join(", ")}`
      );
      assert.ok(isDirty(poison), "the poisoned candidate itself genuinely cannot repair and stays dirty");
    } finally {
      delete process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS;
      fault.drop();
    }
  })
);

// ---------------------------------------------------------------------------
// Test 2 — backlog LARGER than the page limit: 100 dirty ids, page size 25,
// PERMANENTLY expired deadline (a fresh already-past deadline every round,
// simulating sustained overload where only the "repair at least one" floor
// candidate ever gets a turn per round). Every position must eventually be
// serviced, not just ids 1, 26, 51, 76 (the pre-fix "fetched" rotation
// stride).
// ---------------------------------------------------------------------------

test(
  "FAIRNESS (backlog LARGER than page limit): a permanently expired deadline still services every position, not just ids 1/26/51/76",
  withTempDb(async () => {
    seedWalkDecoyFleet();
    const ids = seedConnections(100, { connectorId: "z_large" });
    await seedDirtyBacklog(ids);

    // Poison the FIRST id of each of the 4 pages a 100-id/25-page-size
    // backlog decomposes into (positions 0, 25, 50, 75 — exactly "ids 1, 26,
    // 51, 76" in 1-indexed terms, the reviewer's counterexample B), combined
    // with the same real per-candidate delay + tight real `maxDurationMs`
    // throttle test 1 uses so genuinely only ONE candidate is attempted per
    // round. Pre-fix, `dirtyIds.at(-1)` (the last FETCHED id, always a full
    // 25-wide page while 4 unpoisoned pages' worth of ids remain) commits
    // the cursor to the page boundary regardless of which single candidate
    // inside it was attempted — so each page's now-permanently-poisoned
    // first id is re-selected forever and no id AFTER it in that page is
    // ever reached. The fix advances only past the poisoned id itself, so
    // id #2 of each page becomes the next round's first candidate.
    const poisonIndices = [0, 25, 50, 75];
    const poisoned = poisonIndices.map((i) => ids[i] as string);
    const rest = ids.filter((_, i) => !poisonIndices.includes(i));
    assert.equal(rest.length, 96);
    const faults = poisoned.map((id) => poisonCandidate(id));
    process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS = "40";
    try {
      const attemptedAtLeastOnce = new Set<string>();
      const maxRounds = 150;
      for (let round = 0; round < maxRounds; round += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: Each round must observe the prior round's durable rotation cursor.
        await runOneAccelerationRound(10);
        for (const id of rest) {
          if (!isDirty(id)) {
            attemptedAtLeastOnce.add(id);
          }
        }
        if (attemptedAtLeastOnce.size === rest.length) {
          break;
        }
      }

      // The pre-fix defect wedges on exactly the 4 poisoned ids (1, 26, 51,
      // 76) and NEVER reaches any of the other 96 — this is the discriminator.
      assert.ok(
        attemptedAtLeastOnce.size > 0,
        "at least some non-poisoned ids must be serviced — a total wedge would leave this at 0"
      );
      assert.equal(
        attemptedAtLeastOnce.size,
        rest.length,
        `every one of the ${rest.length} non-poisoned dirty ids must eventually be serviced under a permanently ` +
          "expired deadline, not just the stride-25 poisoned prefix; never-serviced count: " +
          `${rest.length - attemptedAtLeastOnce.size}`
      );
      for (const id of poisoned) {
        assert.ok(isDirty(id), `poisoned id ${id} genuinely cannot repair and stays dirty`);
      }
    } finally {
      delete process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS;
      for (const fault of faults) {
        fault.drop();
      }
    }
  })
);

// ---------------------------------------------------------------------------
// Test 3 — the first candidate FAILS and stays dirty: the cursor must still
// advance past it (no wedge on a permanently-failing candidate).
// ---------------------------------------------------------------------------

test(
  "FAIRNESS: a first candidate whose repair FAILS and stays dirty still lets the cursor advance past it",
  withTempDb(async () => {
    seedWalkDecoyFleet();
    const ids = seedConnections(5, { connectorId: "z_fail" });
    await seedDirtyBacklog(ids);
    const [poison, ...rest] = ids;
    assert.ok(poison && rest.length === 4);

    // The SAME real per-candidate-delay throttle as test 1: without deadline
    // pressure, a generous round budget lets EVERY candidate (poisoned or
    // not) be attempted within round 1 regardless of the cursor bug, which
    // would make this test pass identically before and after the fix and
    // prove nothing. Throttled to genuinely one candidate per round, the
    // pre-fix cursor (`dirtyIds.at(-1)`) re-commits to the same fetched page
    // every round, so the ALWAYS-FAILING poisoned candidate is re-selected
    // as "the" candidate forever and `rest` never repairs — a true,
    // reproducible wedge (verified against the reverted pre-fix source
    // before writing this assertion).
    const fault = poisonCandidate(poison);
    process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS = "40";
    try {
      // One round: the poison candidate is fetched first (lexically
      // smallest), attempted, and fails — but must not be re-selected as
      // "never attempted".
      const round = await runOneAccelerationRound(10);
      assert.ok(round.discovered >= 1, "the round attempted at least the poison candidate");
      assert.ok(isDirty(poison), "the poison candidate's repair genuinely failed and stays dirty");

      // Further rounds must make progress on the REST of the backlog —
      // proving the cursor rotated past the poison candidate rather than
      // re-selecting it forever as the eternal first candidate.
      let siblingsRepaired = 0;
      const maxRounds = rest.length + 2;
      for (let round2 = 0; round2 < maxRounds; round2 += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: Each round must observe the prior round's durable rotation cursor.
        await runOneAccelerationRound(10);
        siblingsRepaired = rest.filter((id) => !isDirty(id)).length;
        if (siblingsRepaired === rest.length) {
          break;
        }
      }

      assert.equal(
        siblingsRepaired,
        rest.length,
        `every sibling candidate must repair within ${maxRounds} further rounds despite the poison candidate's ` +
          "permanent failure — a wedge would leave them all stuck dirty behind the poison id forever"
      );
      // The poison candidate itself is still dirty (it genuinely cannot
      // repair) — proving the OTHER candidates converged BECAUSE the
      // cursor advanced past it, not because the poison trigger silently
      // stopped firing.
      assert.ok(isDirty(poison), "the poison candidate remains dirty — its failure was never silently laundered");
    } finally {
      delete process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS;
      fault.drop();
    }
  })
);

// ---------------------------------------------------------------------------
// Test 4 — repair THROWS mid-page: rotation still occurs (the existing
// "commit before repair so a throwing round still rotates" property must
// survive this fix). Simulated via a trigger that fails EVERY candidate in
// the page (so `observeConnectorSummaryEvidence`'s repair phase reports
// total failure for the page) — the cursor must still advance so the NEXT
// round is not stuck re-fetching the identical failing page forever with
// zero rotation.
// ---------------------------------------------------------------------------

test(
  "FAIRNESS: a page whose repair fails/throws for every candidate still rotates the cursor on later rounds",
  withTempDb(async () => {
    seedWalkDecoyFleet();
    const ids = seedConnections(4, { connectorId: "z_allfail" });
    await seedDirtyBacklog(ids);

    // Every candidate in THIS page fails its repair upsert — modeling "the
    // whole page's repair throws/fails", the case the original cursor
    // design (advance-before-repair) existed to protect against wedging.
    getDb().exec(
      `CREATE TRIGGER fault_all_candidates
         BEFORE INSERT ON connector_summary_evidence
         WHEN NEW.connector_instance_id LIKE 'z_allfail_%'
       BEGIN
         SELECT RAISE(ABORT, 'injected all-candidates repair fault');
       END`
    );
    try {
      const round1 = await runOneAccelerationRound(2000);
      assert.ok(round1.discovered >= 1, "round 1 attempted the page despite the fault");
      for (const id of ids) {
        assert.ok(isDirty(id), `${id} genuinely failed to repair and stays dirty`);
      }

      // A second round must not simply do nothing / re-fetch nothing new —
      // it still attempts work (proving the cursor rotated rather than
      // wedging on an unmoved `afterId` that keeps re-selecting an empty
      // "after the same failed page" slice). Because ALL 4 ids fail, the
      // observable proof of rotation is that discovery genuinely re-visits
      // the fetched set across rounds (never silently stalls to 0 forever)
      // and the fleet-wide dirty count for this prefix never exceeds what
      // was seeded — no candidate is lost or duplicated.
      const round2 = await runOneAccelerationRound(2000);
      assert.ok(round2.discovered >= 1, "round 2 still attempts work — the failing page never wedges into silence");
    } finally {
      getDb().exec("DROP TRIGGER fault_all_candidates");
    }

    // Now lift the fault and confirm the backlog can still fully drain —
    // proving no id was permanently lost/skipped by the earlier failed
    // rounds' rotation.
    let drained = false;
    for (let round = 0; round < 10; round += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Each round must observe the prior round's durable rotation cursor.
      await runOneAccelerationRound(2000);
      if (ids.every((id) => !isDirty(id))) {
        drained = true;
        break;
      }
    }
    assert.ok(drained, "once repair can succeed again, every id from the previously-failing page still converges");
  })
);
