// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * "No work unit BEGINS after expiry" — proven at the exact seam where it was
 * broken, with a controllable clock rather than sleeps or wall-clock races.
 *
 * Independent review found the deadline was checked only ONCE per tranche,
 * before the first awaited discovery read, and never again:
 *
 *   - `runCursorWalk` checked before `readInstanceIdPage`, then began
 *     `observeConnectorSummaryEvidence` — the expensive discovery+fold+repair
 *     unit — however long that read had taken. Worse, it then ADVANCED the
 *     cursor, so a page nothing had genuinely repaired was skipped forever.
 *   - `runDirtyPriorityAcceleration` (then named `runDirtyFirstPrefix`) checked
 *     before `readDirtyInstanceIdPage`, then ran its observe with no further
 *     gate.
 *
 * Both contradicted the documented contract ("no later repair or fold batch
 * starts after expiry"). A real slow discovery read is exactly what makes this
 * reachable in production; here the injected clock jumps past the deadline at
 * that same point, deterministically.
 *
 * The oracle is `setConnectorSummaryReconcileObservationSink`: an observation
 * is emitted once per `observeConnectorSummaryEvidence` call, so ZERO
 * observations proves no expensive unit began. That is a genuine
 * work-did-not-start signal, not a timing assertion.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  __testOnlySetSweepClock,
  __testOnlySetSweepDiscoveryHook,
  markConnectorSummaryEvidenceDirty,
  runBoundedSummaryEvidenceSweep,
  setConnectorSummaryReconcileObservationSink,
} from "../server/connector-summary-read-model.ts";
import type { ConnectorSummaryReconcileObservation } from "../server/connector-summary-reconcile-observability.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const NOW = "2026-08-10T00:00:00.000Z";
const PAGE_SIZE = 25;

/**
 * A controllable clock. Tests advance it explicitly; nothing here sleeps, so
 * the deadline behavior is deterministic under any machine load.
 */
function createClock(startMs: number) {
  let now = startMs;
  return {
    advance(ms: number) {
      now += ms;
    },
    read: () => now,
  };
}

function withHarness(fn: (ctx: { observations: ConnectorSummaryReconcileObservation[] }) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-no-late-start-"));
    const observations: ConnectorSummaryReconcileObservation[] = [];
    try {
      initDb(join(dir, "pdpp.sqlite"));
      setConnectorSummaryReconcileObservationSink((observation) => observations.push(observation));
      await fn({ observations });
    } finally {
      setConnectorSummaryReconcileObservationSink(null);
      __testOnlySetSweepDiscoveryHook(null);
      __testOnlySetSweepClock(null);
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function seedConnections(n: number): string[] {
  getDb().prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES ('c1', '{}', ?)").run(NOW);
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = `c1_cin_${String(i).padStart(4, "0")}`;
    getDb()
      .prepare(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         ) VALUES (?, 'owner_local', 'c1', 'x', 'active', 'account', ?, '{}', ?, ?, NULL)`
      )
      .run(id, id, NOW, NOW);
    ids.push(id);
  }
  return ids;
}

test(
  "WALK: a discovery read that consumes the budget must not let the page's observe begin, and must not advance the cursor",
  withHarness(async ({ observations }) => {
    seedConnections(60);

    const clock = createClock(1_000_000);
    __testOnlySetSweepClock(clock.read);
    // The walk's page-id discovery read "takes" the entire round. This is the
    // exact seam review identified: previously the next statement was the
    // expensive observe, with no gate between.
    __testOnlySetSweepDiscoveryHook((point) => {
      if (point === "walk_page_ids") {
        clock.advance(10_000);
      }
    });

    const result = await runBoundedSummaryEvidenceSweep({
      afterId: null,
      maxDurationMs: 1000,
      pageSize: PAGE_SIZE,
    });

    assert.equal(
      observations.length,
      0,
      "no observe/fold unit may BEGIN after expiry — one observation per call, so zero proves none started"
    );
    assert.equal(result.discovered, 0, "a page whose observe never ran must not be counted as discovered");
    assert.equal(result.repaired, 0, "nothing may be claimed repaired");
    assert.equal(
      result.resumeAfterId,
      null,
      "the cursor must NOT advance past a page nothing repaired — the next round revisits it"
    );
    assert.equal(result.incomplete, true, "a round that covered nothing is honestly incomplete");
    assert.equal(result.prunedComplete, false, "a round that walked no pages must never complete-prune");
  })
);

test(
  "ACCELERATION: its discovery read consuming the budget must not let its observe begin",
  withHarness(async ({ observations }) => {
    const ids = seedConnections(60);
    await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: PAGE_SIZE });
    // A dirty row late in the id order — the walk will not reach it this round,
    // so only the acceleration tranche could service it.
    const target = ids.at(-1);
    assert.ok(target, "fleet seeded");
    await markConnectorSummaryEvidenceDirty({ connectorInstanceId: target, reason: "run.completed" });

    observations.length = 0;
    const clock = createClock(2_000_000);
    __testOnlySetSweepClock(clock.read);
    // The walk runs first and completes normally; the budget is then consumed
    // by the acceleration tranche's own (single) discovery read.
    __testOnlySetSweepDiscoveryHook((point) => {
      if (point === "acceleration_dirty_ids") {
        clock.advance(10_000);
      }
    });

    const result = await runBoundedSummaryEvidenceSweep({
      afterId: null,
      maxDurationMs: 1000,
      pageSize: PAGE_SIZE,
    });

    assert.ok(result.discovered > 0, "the walk had its turn first and made genuine progress");
    assert.equal(
      observations.filter((observation) => observation.scopeSize === 1).length,
      0,
      "the acceleration tranche's single-id observe must not begin after the deadline passed mid-discovery"
    );
    assert.ok(
      observations.every((observation) => observation.scopeSize === PAGE_SIZE),
      "every observation that ran is a full walk page"
    );
  })
);

test(
  "a budget consumed mid-walk stops the NEXT page from starting while keeping the pages that genuinely ran",
  withHarness(async ({ observations }) => {
    seedConnections(120);
    // Warm the fleet first: a COLD page's own fold reports incomplete and
    // legitimately resumes from before itself, which would mask the cursor
    // assertion below. After this, pages converge and advance the cursor.
    await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: PAGE_SIZE });

    observations.length = 0;
    const clock = createClock(4_000_000);
    __testOnlySetSweepClock(clock.read);
    // Let page one's discovery through, then burn the budget so page two
    // cannot start. Proves the gate keeps applying as pages accumulate,
    // without discarding work that legitimately completed.
    let pageReads = 0;
    __testOnlySetSweepDiscoveryHook((point) => {
      if (point === "walk_page_ids") {
        pageReads += 1;
        if (pageReads === 2) {
          clock.advance(10_000);
        }
      }
    });

    const result = await runBoundedSummaryEvidenceSweep({
      afterId: null,
      maxDurationMs: 1000,
      pageSize: PAGE_SIZE,
    });

    // Whatever the walk's own fold decided, the gate invariant holds: an
    // observe never runs for a page whose discovery landed past the deadline,
    // and `discovered` counts exactly the pages that genuinely ran.
    assert.ok(observations.length <= pageReads, "no observe ran for a page whose discovery was gated out");
    assert.equal(
      result.discovered,
      observations.length * PAGE_SIZE,
      "discovered counts exactly the pages whose observe genuinely ran"
    );
    assert.equal(result.incomplete, true, "the fleet was not covered");
    assert.equal(result.prunedComplete, false, "an incomplete round never complete-prunes");
  })
);

test(
  "a gated page leaves the cursor exactly at its incoming position, so the next round re-reads the SAME page",
  withHarness(async ({ observations }) => {
    seedConnections(120);
    await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: PAGE_SIZE });

    // Resume mid-fleet, so a non-null incoming cursor is at stake: if a gated
    // page advanced it, the connections in that page would be skipped for good.
    const incomingCursor = `c1_cin_${String(PAGE_SIZE - 1).padStart(4, "0")}`;
    observations.length = 0;
    const clock = createClock(5_000_000);
    __testOnlySetSweepClock(clock.read);
    __testOnlySetSweepDiscoveryHook((point) => {
      if (point === "walk_page_ids") {
        clock.advance(10_000);
      }
    });

    const gated = await runBoundedSummaryEvidenceSweep({
      afterId: incomingCursor,
      maxDurationMs: 1000,
      pageSize: PAGE_SIZE,
    });

    assert.equal(observations.length, 0, "the page's observe never began");
    assert.equal(gated.discovered, 0, "no page was processed");
    assert.equal(
      gated.resumeAfterId,
      incomingCursor,
      "the cursor is returned UNCHANGED — the next round re-reads exactly the page that was gated out"
    );

    // Releasing the clock, the very next round processes that same page for
    // real: nothing was permanently skipped.
    __testOnlySetSweepDiscoveryHook(null);
    const resumed = await runBoundedSummaryEvidenceSweep({
      afterId: gated.resumeAfterId,
      maxDurationMs: 1000,
      maxPages: 1,
      pageSize: PAGE_SIZE,
    });
    assert.ok(resumed.discovered > 0, "the previously gated page is genuinely processed on the next round");
    assert.ok(observations.length > 0, "an observe ran once the budget allowed it");
  })
);

// ---------------------------------------------------------------------------
// LIVENESS — first opportunity, not an arithmetic round bound.
//
// A deadline bounds when a tranche may START work, not how long a started unit
// runs. While the dirty tranche ran FIRST, a unit whose fold reliably outlived
// the round handed the walk an already-expired deadline: the walk did ZERO
// pages every round and the cursor never moved, reproduced at 6/6 rounds.
// Unbounded starvation of the correctness backstop.
//
// The fix is ordering, not extra time: the walk runs FIRST under the one
// absolute deadline, so it is offered the round's budget before acceleration
// can touch it. The defensible guarantee is therefore:
//
//   - first opportunity every tick (structural — this is what is tested here),
//   - durable resume when a round makes no progress, and
//   - eventual convergence under repeated normally-budgeted ticks with finite,
//     progressing folds.
//
// NOT "one page per round": a zero/tiny budget, a discovery read that consumes
// the deadline, or an incomplete fold each legitimately yield no advance. The
// test below therefore asserts the walk gets its turn under sustained
// acceleration pressure with an adequate budget — not a page-count identity.
// ---------------------------------------------------------------------------

test(
  "LIVENESS: an acceleration tranche that overruns EVERY round cannot deny the cursor walk its first opportunity",
  withHarness(async () => {
    const ids = seedConnections(120);
    await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: PAGE_SIZE });

    const clock = createClock(9_000_000);
    __testOnlySetSweepClock(clock.read);
    // The acceleration tranche blows the round's remaining budget every
    // single round — the pathological sustained case.
    __testOnlySetSweepDiscoveryHook((point) => {
      if (point === "acceleration_dirty_ids") {
        clock.advance(5000);
      }
    });

    const target = ids.at(-1);
    assert.ok(target, "fleet seeded");

    let cursor: string | null = null;
    let roundsWithProgress = 0;
    for (let round = 0; round < 6; round += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Rounds are sequential by construction.
      await markConnectorSummaryEvidenceDirty({ connectorInstanceId: target, reason: "sustained dirty work" });
      const result = await runBoundedSummaryEvidenceSweep({
        afterId: cursor,
        maxDurationMs: 1000,
        maxPages: 1,
        pageSize: PAGE_SIZE,
      });
      if (result.discovered > 0) {
        roundsWithProgress += 1;
      }
      cursor = result.resumeAfterId;
      clock.advance(1000);
    }

    assert.equal(
      roundsWithProgress,
      6,
      "the walk gets its first opportunity in EVERY round — a permanently overrunning acceleration tranche cannot deny it"
    );
  })
);
