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
 * HOW THE STARVATION PRECONDITION IS ESTABLISHED (rewritten 2026-08-21).
 * Earlier revisions of this file tried to make page 1 saturate the round by
 * seeding a very large real backlog and racing it against a small real
 * `ROUND_MS`. That approach is structurally incapable of working, and its
 * repeated recalibration (100k -> 400k) was chasing a number that cannot be
 * made to hold:
 *
 *   The fold is capped by EVENT COUNT, not by backlog size.
 *   `drainTerminalFactEvents` returns as soon as `eventsProcessed >=
 *   maxEvents` (`BOUNDED_FOLD_MAX_EVENTS`, 500 by default), regardless of
 *   how many events remain unfolded. A 100k backlog and a 400k backlog
 *   therefore perform the SAME 500-event fold per round — measured: ~20ms
 *   at 100k and ~50-90ms at 400k, where the entire difference is index-seek
 *   depth, not folding work. Raising the backlog does not raise the round's
 *   cost to any bound; it only nudges a wall-clock measurement around the
 *   `ROUND_MS` threshold until the machine's speed decides the verdict.
 *   That is precisely a timing race, and it is what made this test ambient-
 *   red: it began passing/failing on fold cost the code never promised.
 *
 * The property under test was never "a big backlog is slow." It is: WHEN the
 * walk consumes the round, acceleration gets no turn. "The walk consumes the
 * round" is the PRECONDITION, not the thing being measured — so it is
 * established deterministically, via the same injected sweep clock the
 * sibling deadline tests already use (`connector-summary-sweep-no-late-
 * start.test.ts`, `connector-summary-dirty-priority-attempted-fairness.
 * test.ts`): the walk's own page-discovery seam advances the clock past the
 * round's deadline, modelling a genuinely fold-heavy page exactly.
 *
 * This is not a weaker test — it is a strictly stronger one. Cooperative
 * overshoot is real, and modelling it with a controlled clock asserts the
 * ORDERING invariant on every host instead of only on hosts slow enough for
 * a 500-event fold to cross 50ms. A modest real backlog is still seeded, so
 * page 1 genuinely reports `incomplete` from real unfolded history rather
 * than from the clock alone.
 *
 * This file proves:
 *   1. FAIL-BEFORE: with `firstTranche` fixed at `"walk"` every round (the
 *      pre-fix call shape), a fresh dirty row on a later page starves across
 *      several rounds while page 1's fold keeps the walk saturated.
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
  __testOnlySetSweepClock,
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
 * The round's pass-admission budget. Its absolute value no longer decides
 * anything: the fold-heavy page's cost is modelled by advancing the injected
 * sweep clock (see `createClock`/`saturateWalkPage`), so this is simply the
 * budget the clock is advanced past — not a wall-clock threshold real work
 * has to beat. Kept at a production-plausible order of magnitude for
 * readability.
 */
const ROUND_MS = 50;
/** A human-scale-interval bound: several rounds, never "eventually, unbounded". */
const MAX_ROUNDS = 12;
/**
 * A real, but deliberately MODEST, unfolded backlog for page 1.
 *
 * Its job is only to make page 1 genuinely report `incomplete` from real
 * unfolded terminal history — the fold's own event cap (500/round) means
 * `MAX_ROUNDS` rounds fold at most ~6,000 events, so 20,000 keeps page 1
 * honestly unconverged for the whole scenario with a 3x margin.
 *
 * It is deliberately NOT sized to make the fold slow. See this file's header:
 * the fold is event-capped, so backlog size cannot control per-round cost,
 * and the previous 100_000 -> 400_000 escalation was calibrating a quantity
 * that does not have the effect it was assumed to have. Shrinking this back
 * to 20k removes ~15s of pure seed time per seeding test with no loss of
 * coverage, because saturation is now established by the clock, not by bulk.
 */
const STUCK_BACKLOG_EVENT_COUNT = 20_000;

/**
 * A controllable clock, matching `connector-summary-sweep-no-late-start.
 * test.ts`'s own harness. Tests advance it explicitly; nothing here sleeps,
 * so deadline behavior is deterministic under any machine load.
 *
 * IMPORTANT — it starts from the REAL `Date.now()` and only ever runs
 * FORWARD from there. The injected clock (`sweepNow`) governs only the
 * sweep's own tranche/page admission seams; the inner
 * `observeConnectorSummaryEvidence` fold and repair phases deliberately read
 * the real `Date.now()` against the same deadline value. Seeding this clock
 * at an arbitrary small number (as the pure "did work start at all" tests
 * can afford to) would put the round's deadline trillions of milliseconds in
 * the real clock's past, so EVERY inner phase would refuse to start and the
 * scenario would degenerate into "nothing ever runs" — which passes a
 * starvation assertion for entirely the wrong reason. Anchoring to real time
 * keeps both clocks in the same frame, so advancing this one models elapsed
 * work rather than teleporting out of the deadline's domain.
 */
function createClock() {
  let now = Date.now();
  return {
    advance(ms: number) {
      now += ms;
    },
    read: () => now,
  };
}

/**
 * Models the live incident's fold-heavy page 1 deterministically: after the
 * walk's page has genuinely been admitted and observed, the round's clock is
 * advanced past its deadline, so the walk has consumed the round by the time
 * it returns — exactly what a page whose own fold reaches the deadline does,
 * without depending on real fold work being slower than a wall-clock
 * threshold.
 *
 * The advance fires on the NEXT seam rather than on `walk_page_ids` itself,
 * because `walk_page_ids` fires BEFORE the walk re-checks admission for its
 * own page. Advancing there would prevent page 1's fold from ever beginning,
 * making page 1 "never ran" rather than "ran and was heavy" — a different
 * (and vacuous) scenario. Here page 1 does real folding work every round,
 * and is then charged for having taken the round.
 *
 * Only the WALK is charged, so the acceleration tranche never pays for the
 * walk's overshoot. That asymmetry is the point: the scenario is "the walk
 * saturates the round," and charging acceleration too would model both
 * tranches being slow, under which no ordering could help and the test would
 * prove nothing.
 *
 * Returns a per-round harness. `observedPoints` records tranche order (the
 * first entry is which tranche got first opportunity); `chargeWalkPage` is
 * passed as `onPageConverged`, which the walk calls right after its page's
 * observe — the exact "page finished, and it took the whole round" seam.
 */
function saturateWalkPage(clock: ReturnType<typeof createClock>) {
  const observedPoints: string[] = [];
  __testOnlySetSweepDiscoveryHook((point) => {
    observedPoints.push(point);
  });
  return {
    chargeWalkPage(): Promise<void> {
      // `onPageConverged` is shared by both tranches, so charge only when
      // this call came from the walk's page.
      if (observedPoints.includes("walk_page_ids")) {
        clock.advance(ROUND_MS * 2);
      }
      return Promise.resolve();
    },
    observedPoints,
  };
}

function withTempDb(fn: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-stuck-page-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn();
    } finally {
      __testOnlySetSweepDiscoveryHook(null);
      __testOnlySetSweepClock(null);
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

    const clock = createClock();
    __testOnlySetSweepClock(clock.read);

    let cursor: string | null = null;
    for (let round = 1; round <= MAX_ROUNDS; round += 1) {
      const { chargeWalkPage } = saturateWalkPage(clock);
      // biome-ignore lint/performance/noAwaitInLoops: each round must observe the prior round's durable cursor and evidence state.
      const result = await runBoundedSummaryEvidenceSweep({
        afterId: cursor,
        firstTranche: "walk",
        maxDurationMs: ROUND_MS,
        onPageConverged: chargeWalkPage,
        pageSize: PAGE_SIZE,
      });
      cursor = result.resumeAfterId;
      // A fresh round gets a fresh budget: advance past the round the walk
      // just consumed, exactly as the real scheduler's next tick would.
      clock.advance(ROUND_MS);
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

    // The SAME saturated page 1 as the fail-before case — only `firstTranche`
    // differs between the two tests. That is what makes this a discriminator
    // rather than a second, easier scenario.
    const clock = createClock();
    __testOnlySetSweepClock(clock.read);

    let cursor: string | null = null;
    let firstTranche: "walk" | "acceleration" = "walk";
    let convergedAtRound = -1;
    const firstDiscoveryByRound: string[] = [];
    try {
      for (let round = 1; round <= MAX_ROUNDS; round += 1) {
        const { chargeWalkPage, observedPoints } = saturateWalkPage(clock);
        // biome-ignore lint/performance/noAwaitInLoops: each round must observe the prior round's durable cursor and evidence state.
        const result = await runBoundedSummaryEvidenceSweep({
          afterId: cursor,
          firstTranche,
          maxDurationMs: ROUND_MS,
          onPageConverged: chargeWalkPage,
          pageSize: PAGE_SIZE,
        });
        firstDiscoveryByRound.push(observedPoints[0] ?? "none");
        cursor = result.resumeAfterId;
        clock.advance(ROUND_MS);
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
    // With page 1's saturation now deterministic, round 1 (walk-first)
    // CANNOT converge the discriminator — the walk consumes the round exactly
    // as in the fail-before case. So convergence must happen on round 2, the
    // first round alternation hands acceleration the opening, and the 2-round
    // starvation bound is asserted as the exact number it claims to be
    // rather than as "somewhere within twelve."
    //
    // An earlier revision could only assert this conditionally, because a
    // fast host sometimes converged in round 1 — which was itself a symptom
    // of the wall-clock precondition failing to hold, not a stronger result.
    assert.equal(
      convergedAtRound,
      2,
      `alternation's bound is ONE round of denied first opportunity, so the discriminator must converge on round 2 ` +
        `exactly; converged at ${convergedAtRound}`
    );
    assert.equal(
      firstDiscoveryByRound[0],
      "walk_page_ids",
      `round 1 must give the walk first opportunity; observed ${firstDiscoveryByRound.join(", ")}`
    );
    assert.equal(
      firstDiscoveryByRound[1],
      "acceleration_dirty_ids",
      `round 2 must give acceleration first opportunity; observed ${firstDiscoveryByRound.join(", ")}`
    );
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
