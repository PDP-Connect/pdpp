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
