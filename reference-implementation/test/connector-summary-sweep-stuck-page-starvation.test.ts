// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Live UAT defect (2026-08-12): GitHub run run_1786513779797 completed with
 * 7/7 streams covered and checkpoints committed, `connector_summary_evidence`
 * for the connection had a fresh `stream_latest_facts_json` from that run and
 * `terminal_facts_state = current`, yet `dirty = 1`, `state = stale`, and
 * `/sources` kept reporting the connection unknown. The periodic reconcile
 * logged `scope_size=20 incomplete=true 0 repaired resume_state=none` every
 * 60s tick, with no progress round over round.
 *
 * Root cause: `runBoundedSummaryEvidenceSweep`'s cursor walk ran FIRST every
 * round under the round's FULL `maxDurationMs`, and on an incomplete page it
 * retried that EXACT page next round (`runCursorWalk`'s `cursor =
 * cursorBeforeCurrentPage` branch — see `connector-summary-dirty-priority-
 * starvation.test.ts` for the walk-vs-acceleration ordering this builds on).
 * A page whose own fold is genuinely fold-heavy (one connection with a very
 * large unfolded terminal-event backlog) can legitimately consume the
 * round's entire remaining budget every round and still report incomplete.
 * Because the walk always ran first with no ceiling of its own, "whatever
 * time remains" for the dirty-priority acceleration tranche
 * (`runDirtyPriorityAcceleration`) could be — and in the live incident, was —
 * legitimately, repeatedly ZERO for as long as that page's fold stayed
 * heavy enough to reach the deadline. A freshly-dirtied connection elsewhere
 * in the fleet then starved for the stuck page's entire multi-round
 * convergence window, which is unbounded in the general case.
 *
 * REJECTED FIX (2026-08-12, superseded below): capping the walk's OWN
 * sub-deadline at `maxDurationMs - minAccelerationReserveMs` looked like a
 * fix but is NOT structurally sound. Cooperative units (fold batches, repair
 * candidates) only check their deadline BETWEEN internal steps, never
 * mid-step — a single slow unit inside the walk can already overshoot past
 * a shortened sub-deadline before the next check fires, consuming into (or
 * past) the time meant to be reserved for acceleration. A "reserve" of N
 * milliseconds is therefore a probabilistic time-slice, not a guarantee, and
 * this codebase does not encode unproven timing margins as correctness
 * properties anywhere else — this fix must not be the first exception.
 *
 * ACTUAL FIX: `runBoundedSummaryEvidenceSweep({ firstTranche })` lets the
 * CALLER alternate which tranche receives the round's genuine first
 * opportunity — the full, undivided `maxDurationMs` budget, before the other
 * tranche is even attempted. `connector-maintenance-sweep.ts` alternates
 * this value every tick. This bounds worst-case starvation structurally: if
 * round N's first tranche overshoots and consumes the entire round, round
 * N+1 gives the OTHER tranche first opportunity instead — a tranche can be
 * denied first opportunity for at most ONE consecutive round, regardless of
 * how badly any single unit inside the other tranche overshoots. See
 * `runBoundedSummaryEvidenceSweep`'s own ordering comment for the full
 * argument.
 *
 * This file proves, with a REAL fold-heavy backlog (not a simulated clock
 * jump — the whole point is that cooperative overshoot is real, not a
 * modeling artifact):
 *   1. FAIL-BEFORE: with `firstTranche` fixed at `"walk"` every round (the
 *      pre-fix call shape), a fresh dirty row on a later page starves across
 *      several rounds while page 1's backlog keeps the walk saturated.
 *   2. FIX / discriminator (1): alternating `firstTranche` converges the
 *      SAME fresh dirty row within a small, bounded number of rounds, even
 *      though page 1 remains genuinely stuck throughout.
 *   3. FIX / discriminator (2): under SUSTAINED fresh dirty arrivals (a new
 *      row dirtied every round), the cursor walk still advances and
 *      eventually converges the whole clean fleet — alternation does not
 *      let acceleration starve the walk in the other direction.
 *   4. FIX / discriminator (3): deadline/result accounting stays honest
 *      under alternation — `incomplete`, `resumeAfterId`, and
 *      `prunedComplete` reflect reality in both tranche orders, including
 *      the case where the tranche that ran second never got to run at all.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeTransaction } from "../lib/db.ts";
import {
  __testOnlySetSweepDiscoveryHook,
  getConnectorSummaryEvidence,
  markConnectorSummaryEvidenceDirty,
  rebuildConnectorSummaryEvidence,
  runBoundedSummaryEvidenceSweep,
} from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const NOW = "2026-08-12T00:00:00.000Z";
const PAGE_SIZE = 25;
/**
 * Deliberately tight per-round budget: page 1's own real minimum cost — one
 * batch read against a genuinely large backlog plus classifying 25 rows —
 * must exceed the ENTIRE round on its own for this reproduction to be
 * honest. A budget with real slack left over (verified empirically: 400ms
 * left enough time for BOTH tranches to run every round regardless of
 * ordering, which would silently defeat the fail-before case) does not
 * exercise the actual defect. This is a ratio to real per-page cost, not a
 * literal match to production's 2000ms (proven correct separately by the
 * default wiring in `connector-maintenance-sweep.ts`/`server/index.ts`).
 */
const ROUND_MS = 50;
/** A human-scale-interval bound: several rounds, never "eventually, unbounded". */
const MAX_ROUNDS = 12;
/**
 * Large enough that page 1's fold cannot converge within MAX_ROUNDS at its
 * default per-round event cap (~500 events/round; 12 rounds is ~6,000
 * events, two orders of magnitude below this backlog). Seeded inside one
 * `writeTransaction` (below) — one row per autocommit at this volume is
 * itself the bottleneck, not the sweep under test.
 *
 * RECALIBRATED from 100_000 (2026-08-20). `aa8019f1d` added a general
 * `(connector_instance_id, event_seq)` index on `spine_events`, which is what
 * the fold's own batch read plans against. That made the read fast enough
 * that a 100k backlog no longer saturates a `ROUND_MS` round, so the
 * FAIL-BEFORE case below stopped reproducing — it failed at round 1 because
 * the walk finished early and left the acceleration tranche real time, not
 * because starvation had been fixed. That commit disclosed this and left the
 * calibration to be redone here rather than guessed at.
 *
 * The starvation precondition is a RATIO between per-page fold cost and
 * `ROUND_MS`, so restoring it means restoring the cost side. Measured on the
 * recalibration host: 200k still does not starve, 300k does — 400k sits ~33%
 * above that threshold. Note the margin is one-sided in the safe direction:
 * a SLOWER host (CI) makes the fold more expensive per round and starvation
 * easier to reproduce, so this bound does not get tighter on slower hardware.
 * `ROUND_MS` was deliberately NOT lowered instead: shrinking the round below
 * ~10ms makes it comparable to scheduler jitter, which would turn a real
 * structural property into a timing race.
 */
const STUCK_BACKLOG_EVENT_COUNT = 400_000;

function withTempDb(fn: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-stuck-page-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function seedConnection(connectorInstanceId: string, connectorId = "c1"): void {
  const existing = getDb().prepare("SELECT 1 FROM connectors WHERE connector_id = ?").get(connectorId);
  if (!existing) {
    getDb()
      .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, '{}', ?)")
      .run(connectorId, NOW);
  }
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, 'owner_local', ?, 'x', 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(connectorInstanceId, connectorId, connectorInstanceId, NOW, NOW);
}

let sqliteEventSeq = 0;

/**
 * A large terminal-event backlog for one connection — the "fold-heavy page"
 * shape from the live incident. Wrapped in one `writeTransaction`: at this
 * row count, one autocommit per insert is itself the bottleneck (~40+
 * seconds for 100k rows, and this suite now seeds several times that),
 * independent of anything this suite tests.
 */
function seedTerminalEventBacklog(connectorInstanceId: string, count: number): void {
  writeTransaction(() => {
    const stmt = getDb().prepare(
      `INSERT INTO spine_events(
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
       ) VALUES (?, ?, 'run.completed', ?, ?, 'test', ?, 'runtime', 'test', 'run', ?, 'succeeded', ?, ?, ?, '1')`
    );
    for (let i = 0; i < count; i += 1) {
      sqliteEventSeq += 1;
      const data = JSON.stringify({
        collection_facts: {
          reference_only: true,
          schema_version: 1,
          streams: [{ record_count: sqliteEventSeq, resolved: true, stream: "messages" }],
        },
        connection_id: connectorInstanceId,
        connector_instance_id: connectorInstanceId,
      });
      stmt.run(
        `evt_backlog_${sqliteEventSeq}`,
        sqliteEventSeq,
        NOW,
        NOW,
        `trace_backlog_${sqliteEventSeq}`,
        `run_backlog_${sqliteEventSeq}`,
        `run_backlog_${sqliteEventSeq}`,
        connectorInstanceId,
        data
      );
    }
  });
}

/**
 * Records one genuinely successful run, shaped like the live discriminator:
 * a resolved stream with a real record count — proving THIS run's facts are
 * readable, not merely that some dirty flag cleared. Allocates its own
 * event_seq from the shared counter so it never collides with the backlog.
 */
function seedSuccessfulRun(connectorInstanceId: string): string {
  sqliteEventSeq += 1;
  const eventSeq = sqliteEventSeq;
  const runId = `run_${connectorInstanceId}_${eventSeq}`;
  getDb()
    .prepare(
      `INSERT INTO spine_events(
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
       ) VALUES(?, ?, 'run.completed', ?, ?, 'test', ?, 'runtime', 'test', 'run', ?, 'succeeded', ?, ?, ?, '1')`
    )
    .run(
      `evt_${connectorInstanceId}_${eventSeq}`,
      eventSeq,
      NOW,
      NOW,
      `trace_${connectorInstanceId}_${eventSeq}`,
      runId,
      runId,
      connectorInstanceId,
      JSON.stringify({
        collection_facts: {
          reference_only: true,
          schema_version: 1,
          streams: [{ record_count: 1, resolved: true, stream: "widgets" }],
        },
        connection_id: connectorInstanceId,
        connector_instance_id: connectorInstanceId,
      })
    );
  return runId;
}

function readEvidence(connectorInstanceId: string): {
  dirty: number;
  streamLatestFactsJson: string | null;
} | null {
  const row = getDb()
    .prepare("SELECT dirty, stream_latest_facts_json FROM connector_summary_evidence WHERE connector_instance_id = ?")
    .get<{ dirty: number; stream_latest_facts_json: string | null }>(connectorInstanceId);
  if (!row) {
    return null;
  }
  return { dirty: Number(row.dirty ?? 0), streamLatestFactsJson: row.stream_latest_facts_json };
}

function isCurrentWithRun(connectorInstanceId: string, runId: string): boolean {
  const evidence = readEvidence(connectorInstanceId);
  if (!evidence || evidence.dirty !== 0 || !evidence.streamLatestFactsJson) {
    return false;
  }
  const facts = JSON.parse(evidence.streamLatestFactsJson) as Record<
    string,
    { fact?: { record_count?: number }; run_id?: string } | undefined
  >;
  return Number(facts.widgets?.fact?.record_count ?? -1) === 1 && facts.widgets?.run_id === runId;
}

/**
 * Seeds the exact reproduction shape: page 1 (ids `cin_stuck_0000`..`0024`)
 * contains one connection (`cin_stuck_0000`) with a backlog too large for
 * one round's default fold budget to clear, so page 1 stays incomplete every
 * round the walk revisits it. `cin_stuck_0030` sits on a LATER page (the
 * walk only reaches it once page 1 converges) — the discriminator only the
 * acceleration tranche can reach while page 1 is stuck.
 */
async function seedStuckFleet(): Promise<{ discriminatorId: string }> {
  const fleetSize = 60;
  for (let i = 0; i < fleetSize; i += 1) {
    seedConnection(`cin_stuck_${String(i).padStart(4, "0")}`);
  }
  // Baseline evidence rows for the whole fleet, so the scenario isolates the
  // starvation defect itself rather than cold-start discovery — matching
  // `connector-summary-dirty-priority-starvation.test.ts`'s own baseline step.
  await rebuildConnectorSummaryEvidence();
  seedTerminalEventBacklog("cin_stuck_0000", STUCK_BACKLOG_EVENT_COUNT);
  return { discriminatorId: "cin_stuck_0030" };
}

async function dirtyDiscriminator(discriminatorId: string): Promise<string> {
  const runId = seedSuccessfulRun(discriminatorId);
  await markConnectorSummaryEvidenceDirty({ connectorInstanceId: discriminatorId, reason: "run.completed" });
  return runId;
}

function stuckPageStillIncomplete(): boolean {
  const stuckRow = getDb()
    .prepare("SELECT stream_facts_event_seq FROM connector_summary_evidence WHERE connector_instance_id = ?")
    .get<{ stream_facts_event_seq: number }>("cin_stuck_0000");
  return Boolean(stuckRow) && Number(stuckRow?.stream_facts_event_seq) < STUCK_BACKLOG_EVENT_COUNT;
}

test(
  "FAIL-BEFORE: with firstTranche fixed at 'walk' every round, a genuinely fold-heavy page 1 starves a fresh dirty row on a later page across the entire bounded round budget",
  withTempDb(async () => {
    const { discriminatorId } = await seedStuckFleet();
    const runId = await dirtyDiscriminator(discriminatorId);

    let cursor: string | null = null;
    for (let round = 1; round <= MAX_ROUNDS; round += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each round must observe the prior round's durable cursor and evidence state.
      const result = await runBoundedSummaryEvidenceSweep({
        afterId: cursor,
        firstTranche: "walk",
        maxDurationMs: ROUND_MS,
        pageSize: PAGE_SIZE,
      });
      cursor = result.resumeAfterId;
      assert.equal(
        isCurrentWithRun(discriminatorId, runId),
        false,
        `round ${round}: with the walk always first, page 1's own fold consumes the entire round's budget, ` +
          "so the freshly-dirtied discriminator on a later page must still be starved"
      );
    }

    const evidence = await getConnectorSummaryEvidence(discriminatorId);
    assert.ok(evidence, "the discriminator has a durable evidence row");
    assert.equal(
      Number(evidence.dirty ?? 0),
      1,
      `the dirty flag is still set after ${MAX_ROUNDS} rounds — nothing ever consumed it, ` +
        "reproducing the live incident's scope_size/incomplete/0-repaired log shape"
    );
    assert.ok(stuckPageStillIncomplete(), "page 1's backlog is genuinely still incomplete — the starvation is real");
  })
);

test(
  "FIX discriminator (1): alternating firstTranche converges a fresh dirty row within a bounded number of rounds",
  withTempDb(async () => {
    const { discriminatorId } = await seedStuckFleet();
    const runId = await dirtyDiscriminator(discriminatorId);

    let cursor: string | null = null;
    let firstTranche: "walk" | "acceleration" = "walk";
    let convergedAtRound = -1;
    const firstDiscoveryByRound: string[] = [];
    try {
      for (let round = 1; round <= MAX_ROUNDS; round += 1) {
        const discoveryOrder: string[] = [];
        __testOnlySetSweepDiscoveryHook((point) => discoveryOrder.push(point));
        // biome-ignore lint/performance/noAwaitInLoops: each round must observe the prior round's durable cursor and evidence state.
        const result = await runBoundedSummaryEvidenceSweep({
          afterId: cursor,
          firstTranche,
          maxDurationMs: ROUND_MS,
          pageSize: PAGE_SIZE,
        });
        firstDiscoveryByRound.push(discoveryOrder[0] ?? "none");
        cursor = result.resumeAfterId;
        firstTranche = firstTranche === "walk" ? "acceleration" : "walk";
        if (isCurrentWithRun(discriminatorId, runId)) {
          convergedAtRound = round;
          break;
        }
      }
    } finally {
      __testOnlySetSweepDiscoveryHook(null);
    }

    assert.ok(
      convergedAtRound > 0 && convergedAtRound <= MAX_ROUNDS,
      `the freshly-dirtied discriminator must converge within ${MAX_ROUNDS} bounded rounds once firstTranche ` +
        "alternates — it did not converge, meaning alternation failed to give acceleration first opportunity"
    );
    // Alternation structurally bounds when a tranche STARTS, not how quickly
    // its cooperative work completes on a contended host. Assert the actual
    // invariant directly instead of turning runner throughput into a false
    // correctness condition.
    //
    // Round 2 only exists if round 1 did not already converge. Since
    // `aa8019f1d` indexed `spine_events` by instance for every event type,
    // the acceleration tranche's discovery is fast enough that round 1
    // frequently converges outright and the loop breaks — leaving no round 2
    // to observe. Converging in a SINGLE round is a strictly stronger result
    // than converging in two, so requiring a second round here would fail the
    // test for being too fast. Assert alternation only when round 2 actually
    // ran; `convergedAtRound` above is the invariant that always holds.
    if (firstDiscoveryByRound.length > 1) {
      assert.equal(
        firstDiscoveryByRound[1],
        "acceleration_dirty_ids",
        `round 2 must give acceleration first opportunity; observed ${firstDiscoveryByRound.join(", ")}`
      );
    }
  })
);

test(
  "FIX discriminator (2): under SUSTAINED fresh dirty arrivals, the cursor walk still advances and eventually covers the whole clean fleet",
  withTempDb(async () => {
    const fleetSize = 80;
    const ids: string[] = [];
    for (let i = 0; i < fleetSize; i += 1) {
      const id = `cin_sustained_${String(i).padStart(4, "0")}`;
      seedConnection(id);
      ids.push(id);
    }
    await rebuildConnectorSummaryEvidence();
    const laggard = ids.at(-1);
    const noisy = ids[0];
    assert.ok(laggard && noisy, "fleet seeded");

    let cursor: string | null = null;
    let firstTranche: "walk" | "acceleration" = "walk";
    // A fresh arrival every round, at the FRONT of the id order — the mirror
    // image of the stuck-page test: if alternation let acceleration starve
    // the walk, the cursor would never reach the laggard at the back.
    for (let round = 0; round < 12; round += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each round must observe the prior round's durable cursor.
      await markConnectorSummaryEvidenceDirty({ connectorInstanceId: noisy, reason: "sustained dirty work" });
      // biome-ignore lint/performance/noAwaitInLoops: sequential by construction — each round resumes from the prior round's cursor.
      const result = await runBoundedSummaryEvidenceSweep({
        afterId: cursor,
        firstTranche,
        maxDurationMs: 60_000,
        maxPages: 1,
        pageSize: PAGE_SIZE,
      });
      cursor = result.resumeAfterId;
      firstTranche = firstTranche === "walk" ? "acceleration" : "walk";
      if (cursor === null) {
        break;
      }
    }

    assert.equal(cursor, null, "the cursor walk reached the end of the fleet despite sustained competing dirty work");
    const laggardRow = readEvidence(laggard);
    assert.ok(laggardRow, "the laggard at the back of the id order has durable evidence");
    assert.equal(laggardRow.dirty, 0, "the laggard converged via the walk — sustained dirty work never starved it");
  })
);

test(
  "FIX discriminator (3): deadline/result accounting stays honest under alternation, including when the second tranche never runs",
  withTempDb(async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const id = `cin_honest_${String(i).padStart(4, "0")}`;
      seedConnection(id);
      ids.push(id);
    }
    const target = ids.at(-1);
    assert.ok(target, "fleet seeded");
    await markConnectorSummaryEvidenceDirty({ connectorInstanceId: target, reason: "run.completed" });

    // A small, fast fleet: whichever tranche runs first converges quickly,
    // leaving genuine time for the second — the ordinary, non-overloaded
    // case accounting must still get right in both tranche orders.
    const walkFirst = await runBoundedSummaryEvidenceSweep({
      afterId: null,
      firstTranche: "walk",
      maxDurationMs: 60_000,
      pageSize: PAGE_SIZE,
    });
    assert.equal(walkFirst.incomplete, false, "walk-first: the tiny fleet converges completely in one round");
    assert.equal(walkFirst.prunedComplete, true);

    await markConnectorSummaryEvidenceDirty({ connectorInstanceId: target, reason: "run.completed" });
    const accelerationFirst = await runBoundedSummaryEvidenceSweep({
      afterId: null,
      firstTranche: "acceleration",
      maxDurationMs: 60_000,
      pageSize: PAGE_SIZE,
    });
    assert.equal(
      accelerationFirst.incomplete,
      false,
      "acceleration-first: the tiny fleet still converges completely once the walk gets its turn afterward"
    );
    assert.equal(
      accelerationFirst.prunedComplete,
      true,
      "acceleration-first: complete-set pruning still runs once the walk genuinely covers the whole set"
    );

    // Zero-budget edge: a round with no time at all must not fabricate
    // progress regardless of which tranche was nominally "first."
    const zeroBudgetAccelerationFirst = await runBoundedSummaryEvidenceSweep({
      afterId: null,
      firstTranche: "acceleration",
      maxDurationMs: 0,
      pageSize: PAGE_SIZE,
    });
    assert.equal(zeroBudgetAccelerationFirst.discovered, 0, "a zero budget starts no work in either tranche order");
    assert.equal(zeroBudgetAccelerationFirst.repaired, 0);
    assert.equal(zeroBudgetAccelerationFirst.incomplete, true, "a round that covered nothing is honestly incomplete");
    assert.equal(
      zeroBudgetAccelerationFirst.prunedComplete,
      false,
      "a round that walked no pages never complete-prunes"
    );
  })
);
