// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Live symptom (2026-07-31, live f5dd75e0d): startup summary reconciliation
 * rounds 1 through at least 18 each inspect scope_size=16 and emit the SAME
 * resumeAfterId, resume_state='none' — candidate counts repeat while a
 * dirty, later-in-keyset connection stays dirty=1/state=stale/record+
 * manifest+retained failed and its list projection stays stale for minutes.
 *
 * `runBoundedSummaryEvidenceSweep` (server/connector-summary-read-model.ts)
 * walks the canonical `connector_instances` set page by page
 * (`readInstanceIdPage`, keyset pagination). Before this fix, when a page's
 * own discovery+fold+repair barrier (`observeConnectorSummaryEvidence`)
 * reported `incomplete: true` — its fold or repair phase did not converge
 * within the sweep's shared deadline — the OUTER page loop reset the cursor
 * to the position BEFORE that page and `break`, never even attempting to
 * read the next page. A page that keeps reporting `incomplete` on every
 * call (one connection in it has a repair/fold unit slow or blocked on
 * every attempt, not merely once) pinned the durable cursor there forever —
 * the entire rest of the fleet, however large, became permanently
 * unreachable by every future bounded round (periodic tick or startup
 * multi-round walk), not just that one stuck page.
 *
 * The terminal contract this fix implements (round-robin fairness ACROSS
 * separate invocations, using only the EXISTING dirty/checkpoint authority
 * as the durable memory of outstanding work — no second durable queue):
 *
 *   - Every page this call processes ADVANCES the cursor, converged or not
 *     — a non-converging page never pins the cursor before itself.
 *   - `incomplete: false` (the "fully converged, stop scheduling rounds"
 *     signal) is reported ONLY after a clean pass that started at the very
 *     beginning of keyset order AND reached the true end of the set AND had
 *     zero pages fail to converge along the way.
 *   - A pass that reaches the true end of the set WITHOUT satisfying all
 *     three of the above (started mid-fleet resuming a prior round, or some
 *     page skipped candidates) reports `incomplete: true` with
 *     `resumeAfterId: null` — a forced validation pass from position zero,
 *     not "done." A still-dirty/checkpoint-lagging row a prior page could
 *     not finish stays classified as a candidate regardless of cursor
 *     position, so this next full pass genuinely repairs it.
 *
 * This file proves, directly against the real production primitive:
 *
 *   1. A dirty connection living on page 2 (beyond `pageSize`) still
 *      converges within a bounded number of sweep calls even while page 1
 *      never converges on any single call's own budget.
 *   2. The resume cursor never repeats the exact identical value forever —
 *      it visits a genuine cycle of positions (round-robin), unlike the
 *      live symptom's single fixed value across 18+ rounds.
 *   3. Once every connection is genuinely clean, the walk terminates
 *      (`incomplete: false`) — the fix does not trade starvation for
 *      "reports incomplete forever even once nothing is actually dirty."
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runBoundedSummaryEvidenceSweep } from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const NOW = "2026-07-17T00:00:00.000Z";

function withTempDb(fn: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-sweep-page-starvation-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function seedConnections(n: number, { connectorId = "c1" }: { connectorId?: string } = {}): string[] {
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

function evidenceRow(connectorInstanceId: string): Record<string, unknown> | undefined {
  return getDb()
    .prepare("SELECT * FROM connector_summary_evidence WHERE connector_instance_id = ?")
    .get(connectorInstanceId) as Record<string, unknown> | undefined;
}

function evidenceRowCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM connector_summary_evidence").get<{ n: number }>();
  assert.ok(row, "evidence count query returns a row");
  return row.n;
}

/**
 * Sustains a permanently-slow repair for the ENTIRE test (unlike
 * `connector-summary-evidence-bounded-sweep.test.ts`'s existing scenarios,
 * which delete the env var before their second round) — modeling a fleet
 * where some connection's repair genuinely never completes quickly on any
 * attempt, matching the live symptom's 18+ identical rounds never
 * resolving on their own.
 */
async function withSustainedSlowRepair<T>(delayMs: number, fn: () => Promise<T>): Promise<T> {
  process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS = String(delayMs);
  try {
    return await fn();
  } finally {
    delete process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS;
  }
}

test(
  "a connection on page 2 converges, and the cursor makes genuine round-robin progress, while every repair is permanently slow",
  withTempDb(() =>
    withSustainedSlowRepair(250, async () => {
      const pageSize = 16;
      // Two full pages plus a bit: the connection under test (index 20)
      // sits on page 2, past page 1's boundary — the exact shape the live
      // symptom describes (a later-in-keyset connection starved behind an
      // earlier page that never converges within one call's budget).
      const ids = seedConnections(40, { connectorId: "c1" });
      const targetId = ids[20] as string;

      // A tight per-call deadline relative to the 250ms per-repair delay:
      // no single call's page can finish all 16 of its own candidates
      // (16 * 250ms = 4000ms vs. a 100ms budget), so every page this walk
      // ever reaches reports its own `incomplete: true` on every visit —
      // exactly the "permanently slow page" shape, sustained for the whole
      // test, not just the first round.
      const maxDurationMs = 100;
      const maxRounds = 15;

      let cursor: string | null = null;
      const resumeCursorsSeen: (string | null)[] = [];
      let convergedAt = -1;
      for (let round = 0; round < maxRounds; round += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: Each round must observe the previous round's durable cursor before deciding the next.
        const result = await runBoundedSummaryEvidenceSweep({ afterId: cursor, maxDurationMs, pageSize });
        resumeCursorsSeen.push(result.resumeAfterId);
        cursor = result.resumeAfterId;
        if (evidenceRow(targetId) && convergedAt === -1) {
          convergedAt = round;
        }
        if (!result.incomplete) {
          break;
        }
      }

      // 1. Reachability: the page-2 connection must converge well before
      // the round budget runs out — never left permanently unreachable
      // behind the permanently-slow earlier pages.
      assert.ok(
        convergedAt >= 0 && convergedAt < maxRounds,
        `the page-2 connection must receive a durable evidence row within ${maxRounds} rounds even though every page is permanently slow (never converged)`
      );
      const targetRow = evidenceRow(targetId);
      assert.notEqual(
        targetRow?.state,
        "failed",
        "the page-2 connection's evidence must not be starved into a failed state by unrelated permanently-slow pages"
      );

      // 2. Genuine round-robin progress, not the live symptom's single
      // fixed cursor value repeated forever: across the rounds it took to
      // reach convergence, the cursor must have visited more than one
      // distinct position.
      const cursorsBeforeConvergence = resumeCursorsSeen.slice(0, convergedAt + 1);
      const distinctCursorValues = new Set(cursorsBeforeConvergence);
      assert.ok(
        distinctCursorValues.size > 1,
        `the resume cursor must cycle through multiple positions instead of repeating one fixed value forever (saw: ${JSON.stringify(
          cursorsBeforeConvergence
        )})`
      );
    })
  )
);

test(
  "a permanently-slow fleet-wide repair still terminates (incomplete: false) once every connection is genuinely clean",
  withTempDb(() =>
    withSustainedSlowRepair(60, async () => {
      const pageSize = 16;
      const n = 40;
      seedConnections(n, { connectorId: "c1" });

      let cursor: string | null = null;
      let finalResult: Awaited<ReturnType<typeof runBoundedSummaryEvidenceSweep>> | null = null;
      const maxRounds = 40;
      for (let round = 0; round < maxRounds; round += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: Each round must observe the previous round's durable cursor before deciding the next.
        const result = await runBoundedSummaryEvidenceSweep({ afterId: cursor, maxDurationMs: 200, pageSize });
        finalResult = result;
        cursor = result.resumeAfterId;
        if (!result.incomplete) {
          break;
        }
      }

      assert.ok(finalResult, "at least one round ran");
      assert.equal(
        finalResult?.incomplete,
        false,
        `the walk must genuinely terminate once every connection converges, not report incomplete forever (within ${maxRounds} rounds)`
      );
      assert.equal(finalResult?.resumeAfterId, null, "a genuinely converged walk clears its resume cursor");
      assert.equal(
        evidenceRowCount(),
        n,
        "every connection has a durable evidence row once the walk reports genuine convergence"
      );
    })
  )
);

/**
 * Sets the test-only per-page-fetch delay seam
 * (`testOnlySweepPageFetchDelay` in connector-summary-read-model.ts) for the
 * duration of `fn`. `pageIndex: undefined` delays every page's fetch;
 * a specific index delays only that 0-based page.
 */
async function withSweepPageFetchDelay<T>(delayMs: number, pageIndex: number | undefined, fn: () => Promise<T>) {
  process.env.PDPP_TEST_SWEEP_PAGE_FETCH_DELAY_MS = String(delayMs);
  if (pageIndex !== undefined) {
    process.env.PDPP_TEST_SWEEP_PAGE_FETCH_DELAY_PAGE_INDEX = String(pageIndex);
  }
  try {
    return await fn();
  } finally {
    delete process.env.PDPP_TEST_SWEEP_PAGE_FETCH_DELAY_MS;
    delete process.env.PDPP_TEST_SWEEP_PAGE_FETCH_DELAY_PAGE_INDEX;
  }
}

/**
 * 2026-08-01 LIVE symptom (distinct from the scenarios above): those tests
 * model a page whose repair genuinely RUNS but is slow. This models the gap
 * that survived that fix — a page that IS fetched (unlike a page the outer
 * loop's own deadline check declines to fetch at all, which the pre-existing
 * cursor behavior already resumes correctly from), but whose own
 * repair/fold phases find the shared deadline already spent by the time
 * their turn comes up, because an EARLIER page in the SAME call legitimately
 * consumed most of the budget. Live evidence: two connector instances on the
 * fleet's second (16-row) page stayed `dirty=1`/`state=stale` for over an
 * hour despite a periodic sweep ticking every 60s and completing a full
 * round-robin pass each tick — `candidate_reason_counts: {}` was logged for
 * that page on nearly every tick (proving `observeConnectorSummaryEvidence`
 * WAS invoked for it — a log line only emits after that call returns), yet
 * `discoverCandidates` inside it never actually ran.
 *
 * This exact race (deadline crosses in the narrow window between the OUTER
 * loop's per-page check and that page's OWN first internal check) is
 * reliably sub-millisecond against local SQLite — not reproducible via real
 * wall-clock timing alone (confirmed empirically: 40+ trials at varying
 * budgets never landed in the window). `testOnlySweepPageFetchDelay` makes
 * it deterministic, the same "synchronous test-only block on a specific
 * seam" technique `testOnlyRepairCandidateSqliteDelay` already uses for the
 * analogous per-candidate race in connector-summary-evidence-engine.ts.
 *
 * Before this fix: `runBoundedSummaryEvidenceSweep`'s per-page loop treated
 * a starved page exactly like a slow-but-ran page — it advanced the cursor
 * PAST it. Because the SAME earlier page exhausts the shared budget on
 * every subsequent call too (its own dirty/candidate set is unaffected by
 * cursor position), the starved page was starved again next call, and again
 * after that — the round-robin wraparound that is supposed to guarantee
 * eventual revisit never fired, because every call restarts from page 1 and
 * re-exhausts the same budget there first.
 *
 * After this fix: a page whose repair/fold phases never got to run even one
 * discovery query this call (`BoundedObservationPhases.starved`) rewinds the
 * resume cursor to exactly BEFORE that page, instead of advancing past it —
 * so the VERY NEXT call gives it first claim on a fresh deadline. This test
 * proves the starved page's connection converges on the immediate next
 * round, not "eventually, maybe never."
 */
test(
  "a page that IS fetched but finds the shared deadline already spent (starved) still repairs on the very next bounded tick",
  withTempDb(async () => {
    const pageSize = 5;
    // 10 brand-new connections, one keyset-ordered id space — every one is a
    // genuine "missing" repair candidate (first-ever observation, no
    // evidence row yet), so page 1 does REAL discovery+repair work (not
    // injected) and converges within its own share of the budget. Page 1 =
    // the first 5 ids; page 2 = the remaining 5 (exactly one more full page,
    // so the walk stops there rather than continuing to a third page).
    const allIds = seedConnections(10, { connectorId: "c1" });
    const page1Ids = allIds.slice(0, pageSize);
    const page2Ids = allIds.slice(pageSize);
    const targetId = page2Ids.at(-1) as string;

    // Page 1 (index 0) fetches and runs normally, fast. Page 2 (index 1)'s
    // OWN fetch is held just long enough that the shared 60ms deadline is
    // already spent by the time page 2's phases check it — reproducing the
    // exact live race deterministically.
    const result = await withSweepPageFetchDelay(80, 1, () =>
      runBoundedSummaryEvidenceSweep({ maxDurationMs: 60, pageSize })
    );

    // Sanity: page 1 genuinely ran and converged (real repair work
    // happened) — this is NOT the "deadline already spent before ANY page
    // starts" shape (that case, `starved` on page 1 itself, already
    // resumes correctly from position zero via the ordinary path).
    assert.equal(
      page1Ids.every((id) => evidenceRow(id) !== undefined),
      true,
      "page 1 must have genuinely run and repaired every one of its own candidates"
    );

    // The decisive assertion this fix adds: page 2 was starved this call
    // (fetched, but its repair phase never ran even one discovery query) —
    // proven via the new `starved` flag, not inferred indirectly from
    // timing or from an absent evidence row alone.
    assert.equal(
      result.starved,
      true,
      "page 2 must be reported starved: it was fetched but its repair phase never ran even one discovery query this call"
    );
    assert.equal(result.discovered, pageSize + page2Ids.length, "both pages were genuinely fetched this call");
    assert.equal(evidenceRow(targetId), undefined, "the starved page's connection has no evidence row yet this call");

    // The mutation-sensitive proof: the resume cursor must rewind to BEFORE
    // page 2 (page 1's own last id), not advance past page 2 and not wrap
    // to null, so the very next call gives page 2 first claim on a fresh
    // deadline.
    assert.equal(
      result.resumeAfterId,
      page1Ids.at(-1),
      "a starved page's resume cursor must rewind to exactly before it (the last id of the page before it), not advance past it or wrap to null"
    );
    assert.equal(result.incomplete, true, "a call with a starved page is never a clean full pass");

    // The terminal proof: the VERY NEXT bounded call, resuming from that
    // cursor, must genuinely repair the previously-starved connection — not
    // "eventually, maybe never." No fetch delay this round: page 2 now
    // goes FIRST, with the complete fresh budget to itself.
    const secondResult = await runBoundedSummaryEvidenceSweep({
      afterId: result.resumeAfterId,
      maxDurationMs: 60_000,
      pageSize,
    });
    assert.notEqual(
      evidenceRow(targetId),
      undefined,
      "the previously-starved connection must have a durable evidence row after exactly one more bounded tick"
    );
    assert.equal(
      secondResult.starved,
      false,
      "the previously-starved page must not be starved again on the immediate next call — it now goes first"
    );
    assert.equal(
      secondResult.discovered,
      page2Ids.length,
      "the second call covers exactly the previously-starved page"
    );
  })
);

test(
  "a mid-fleet-started call that reaches the end of keyset order without a clean start still reports incomplete and forces a wraparound validation pass",
  withTempDb(async () => {
    const pageSize = 16;
    const ids = seedConnections(20, { connectorId: "c1" });

    // Start from the middle of the set (as a resumed round would) rather
    // than from the true beginning.
    const result = await runBoundedSummaryEvidenceSweep({
      afterId: ids[9] as string,
      maxDurationMs: 60_000,
      pageSize,
    });

    // This call's own walk (ids 10..19) converged cleanly and reached the
    // true end of keyset order — but it never re-examined ids 0..9, so it
    // must not claim the COMPLETE set is converged.
    assert.equal(
      result.incomplete,
      true,
      "a call that started mid-fleet must not claim complete convergence merely because ITS OWN walk reached the end"
    );
    assert.equal(
      result.resumeAfterId,
      null,
      "the forced next pass resumes from position zero (a validation pass), not from nowhere and not pinned mid-fleet"
    );

    // The forced follow-up pass, starting genuinely from position zero,
    // must now see the complete set and converge cleanly.
    const followUp = await runBoundedSummaryEvidenceSweep({ afterId: null, maxDurationMs: 60_000, pageSize });
    assert.equal(followUp.incomplete, false, "the validation pass from position zero genuinely converges");
    assert.equal(evidenceRowCount(), 20, "every connection has a durable evidence row after the validation pass");
  })
);
