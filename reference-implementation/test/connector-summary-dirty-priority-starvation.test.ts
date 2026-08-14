// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Dirty-priority starvation: a connection whose run just completed must
 * converge on the NEXT maintenance round, not "whenever the blind keyset
 * walk happens to reach its id".
 *
 * The live UAT defect this closes (2026-08-10): Apple Contacts run
 * run_1786372581260 succeeded, `connector_instances` went `active`, and the
 * write path correctly set `connector_summary_evidence.dirty = 1`. The row
 * nevertheless stayed stale/dirty with `stream_latest_facts_json` NULL
 * across repeated authenticated owner reads. 17/20 evidence-bearing
 * connectors showed the same class.
 *
 * Root cause proven here: write invalidation was never the failure. Nothing
 * CONSUMED the `dirty` flag. The 2026-07-29 terminal-gate revision removed
 * the read-time repair barrier from ordinary GET (correctly — an ordinary
 * GET must not write) and left `runBoundedSummaryEvidenceSweep` as the sole
 * repair path. That sweep walks `connector_instances` blind, ordered by
 * `connector_instance_id ASC`, 25 ids per tick on a 60s timer, and
 * `dirty` is only ever read to CLASSIFY an id the walk already selected
 * (`classifyCandidate`), never to SELECT which ids to visit. A freshly
 * dirtied connection therefore waits for the cursor to wrap the whole fleet
 * — `ceil(N/25) * 60s`, unbounded in N and entirely independent of when the
 * run completed. A connection late in the id order stays visibly stale for
 * many minutes after a successful run.
 *
 * The fix gives each maintenance round a bounded dirty-priority tranche, so
 * freshly-invalidated work is serviced without waiting for the cursor to reach
 * it. The `dirty` flag stays a latency hint, never the correctness backstop —
 * the cursor sweep remains the backstop unchanged.
 *
 * ORDERING (corrected after review): the cursor walk runs FIRST under the
 * round's one absolute deadline, and the dirty tranche runs after it from
 * whatever budget remains. Running the tranche first could consume the round
 * and deny the walk its turn; the only remedies for that were breaking the
 * caller's `maxDurationMs` bound or preempting a running unit, so the ordering
 * was inverted instead. Under overload, acceleration is sacrificed — dirty
 * rows still converge through the walk, they only lose the latency win.
 *
 * Fail-before/pass-after: with the dirty tranche disabled, the first test below
 * goes red — the last-id connection's facts stay NULL after a maintenance round.
 *
 * The budget-contract tests pin the other half: `maxDurationMs` is
 * authoritative, so neither tranche may BEGIN work after the deadline, and a
 * zero/near-zero round may legitimately do nothing and return its cursor
 * unmoved. The guarantee is first opportunity every tick, durable resume, and
 * eventual convergence under repeated normally-budgeted ticks — NOT a page per
 * round.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  markConnectorSummaryEvidenceDirty,
  runBoundedSummaryEvidenceSweep,
} from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const NOW = "2026-08-10T00:00:00.000Z";

/** Matches the production maintenance tick (`server/index.ts`). */
const PRODUCTION_PAGE_SIZE = 25;

function withTempDb(fn: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-dirty-priority-"));
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
    // Zero-padded so lexical order matches numeric order — the sweep's
    // keyset cursor depends on this, exactly as the bounded-sweep suite does.
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
 * Records one genuinely successful run for this connection, shaped exactly
 * like the live Apple Contacts discriminator: a resolved `address_books`
 * stream with 1 record and two resolved zero-count streams.
 */
function seedSuccessfulRun(connectorInstanceId: string, eventSeq: number): void {
  const runId = `run_${connectorInstanceId}`;
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
      `trace_${connectorInstanceId}`,
      runId,
      runId,
      connectorInstanceId,
      JSON.stringify({
        collection_facts: {
          reference_only: true,
          schema_version: 1,
          streams: [
            { record_count: 1, resolved: true, stream: "address_books" },
            { record_count: 0, resolved: true, stream: "contacts" },
            { record_count: 0, resolved: true, stream: "contact_groups" },
          ],
        },
        connection_id: connectorInstanceId,
        connector_instance_id: connectorInstanceId,
      })
    );
}

test(
  "an incomplete terminal fold stays accelerated across bounded rounds instead of waiting for the fleet cursor to wrap",
  withTempDb(async () => {
    const ids = seedConnections(120);
    await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: PRODUCTION_PAGE_SIZE });

    const target = ids.at(-1);
    assert.ok(target, "fleet seeded");
    seedSuccessfulRun(target, 1);
    seedSuccessfulRun(target, 2);
    seedSuccessfulRun(target, 3);
    await markConnectorSummaryEvidenceDirty({ connectorInstanceId: target, reason: "run.completed" });

    const first = await runBoundedSummaryEvidenceSweep({
      afterId: null,
      firstTranche: "acceleration",
      maxDurationMs: 60_000,
      maxEventsPerFold: 2,
      maxPages: 1,
      pageSize: PRODUCTION_PAGE_SIZE,
    });
    const afterFirst = getDb()
      .prepare(
        `SELECT dirty, stream_facts_event_seq, terminal_facts_reason_code, terminal_facts_state
           FROM connector_summary_evidence WHERE connector_instance_id = ?`
      )
      .get<{
        dirty: number;
        stream_facts_event_seq: number;
        terminal_facts_reason_code: string | null;
        terminal_facts_state: string;
      }>(target);
    assert.ok(afterFirst, "target evidence exists after the first round");
    assert.equal(afterFirst.dirty, 0, "canonical repair completed; replay continuation is independently selected");
    assert.equal(afterFirst.stream_facts_event_seq, 2, "the first round consumed exactly its event budget");
    assert.equal(afterFirst.terminal_facts_state, "stale");
    assert.equal(afterFirst.terminal_facts_reason_code, "terminal_fold_incomplete");

    const second = await runBoundedSummaryEvidenceSweep({
      afterId: first.resumeAfterId,
      firstTranche: "acceleration",
      maxDurationMs: 60_000,
      maxEventsPerFold: 2,
      maxPages: 1,
      pageSize: PRODUCTION_PAGE_SIZE,
    });
    assert.ok(
      connectionIsCurrentAfterRound(target),
      "the next acceleration round resumes the incomplete target even though dirty was already cleared"
    );
    assert.ok(
      second.discovered > PRODUCTION_PAGE_SIZE,
      "the target was serviced by acceleration while the cursor walk remained far earlier in the fleet"
    );
  })
);

function readEvidence(connectorInstanceId: string): {
  dirty: number;
  streamLatestFactsJson: string | null;
  listSummaryProjectionState: string | null;
  state: string | null;
} | null {
  const row = getDb()
    .prepare(
      `SELECT dirty, stream_latest_facts_json, list_summary_projection_state, state
         FROM connector_summary_evidence WHERE connector_instance_id = ?`
    )
    .get<{
      dirty: number;
      stream_latest_facts_json: string | null;
      list_summary_projection_state: string | null;
      state: string | null;
    }>(connectorInstanceId);
  if (!row) {
    return null;
  }
  return {
    dirty: Number(row.dirty ?? 0),
    listSummaryProjectionState: row.list_summary_projection_state,
    state: row.state,
    streamLatestFactsJson: row.stream_latest_facts_json,
  };
}

/**
 * The live assertion, stated in owner-visible terms: after a completed run
 * plus activation, does ONE bounded maintenance round make this connection's
 * CURRENT run facts readable and its status current?
 */
function connectionIsCurrentAfterRound(connectorInstanceId: string): boolean {
  const evidence = readEvidence(connectorInstanceId);
  if (!evidence) {
    return false;
  }
  if (evidence.dirty !== 0) {
    return false;
  }
  if (!evidence.streamLatestFactsJson) {
    return false;
  }
  // Stored shape is per-stream envelopes: `{ <stream>: { event_seq, run_id,
  // evidence_as_of, fact: { record_count, resolved, stream } } }` — the
  // CURRENT run's facts, which is exactly what the owner read must surface.
  const facts = JSON.parse(evidence.streamLatestFactsJson) as Record<
    string,
    { fact?: { record_count?: number; resolved?: boolean }; run_id?: string } | undefined
  >;
  const { address_books: addressBooks, contact_groups: contactGroups, contacts } = facts;
  // The live discriminator: address_books 1/1, contacts and contact_groups
  // resolved at 0 — proving these are THIS run's facts, not a stale draft.
  return (
    Number(addressBooks?.fact?.record_count ?? -1) === 1 &&
    addressBooks?.fact?.resolved === true &&
    Number(contacts?.fact?.record_count ?? -1) === 0 &&
    Number(contactGroups?.fact?.record_count ?? -1) === 0 &&
    addressBooks?.run_id === `run_${connectorInstanceId}`
  );
}

test(
  "a freshly-dirtied connection at the END of the id order converges on the FIRST bounded maintenance round, not after a full fleet cursor wrap",
  withTempDb(async () => {
    // A fleet large enough that the production 25-per-page walk needs many
    // ticks to wrap — the live UAT fleet is this shape (20+ evidence-bearing
    // connectors, most of them stale).
    const fleetSize = 120;
    const ids = seedConnections(fleetSize);

    // Establish baseline evidence rows for the whole fleet so this test
    // isolates the STARVATION defect (dirty row never selected), not
    // cold-start discovery. A complete unbounded sweep is the honest way to
    // reach that steady state.
    const baseline = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: PRODUCTION_PAGE_SIZE });
    assert.equal(baseline.incomplete, false, "baseline sweep covers the complete fleet before the scenario begins");

    // The discriminator connection is the LAST id in the walk order — the
    // worst case for a blind cursor, and exactly why the live Apple Contacts
    // row never converged.
    const target = ids.at(-1);
    assert.ok(target, "fleet seeded");

    // A run completes successfully and the connection activates. The write
    // path marks evidence dirty — this part already works in production and
    // is NOT what this test is proving.
    seedSuccessfulRun(target, 1);
    await markConnectorSummaryEvidenceDirty({
      connectorInstanceId: target,
      reason: "run.completed",
    });

    const dirtyBefore = readEvidence(target);
    assert.ok(dirtyBefore, "the target has a durable evidence row");
    assert.equal(dirtyBefore.dirty, 1, "write invalidation genuinely marked the row dirty — this is not the defect");

    // ONE bounded maintenance round, with exactly the production budget
    // shape: a single page-sized bite of the fleet, starting from the top of
    // the cursor (a fresh process, or any tick whose cursor has wrapped).
    // Before the fix this covers ids 0..24 and never touches the target.
    const round = await runBoundedSummaryEvidenceSweep({
      afterId: null,
      maxDurationMs: 60_000,
      maxPages: 1,
      pageSize: PRODUCTION_PAGE_SIZE,
    });

    assert.ok(
      connectionIsCurrentAfterRound(target),
      "a connection whose run just completed must have current stream facts after one maintenance round — " +
        "a blind id-ordered walk starves it for ceil(N/pageSize) ticks regardless of when the run finished"
    );

    // The bounded contract is preserved: this round did NOT degenerate into
    // an unbounded whole-fleet pass just to service the dirty row.
    assert.ok(
      round.discovered <= PRODUCTION_PAGE_SIZE * 2,
      `a dirty-first round stays bounded (dirty prefix + one cursor page), got ${round.discovered}`
    );
  })
);

test(
  "dirty-priority servicing does not starve CLEAN rows — the cursor walk still advances and eventually covers the whole fleet",
  withTempDb(async () => {
    const fleetSize = 60;
    const ids = seedConnections(fleetSize);
    await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: PRODUCTION_PAGE_SIZE });

    // A permanently-dirty connection: every round has dirty work available.
    // If dirty servicing consumed the whole budget, the cursor would never
    // advance and clean rows would starve — the mirror-image defect.
    const [noisy] = ids;
    assert.ok(noisy, "fleet seeded");

    let cursor: string | null = null;
    for (let round = 0; round < 3; round += 1) {
      seedSuccessfulRun(`${noisy}_r${round}`, round + 1);
      // biome-ignore lint/performance/noAwaitInLoops: Each round must observe the prior round's durable cursor — sequential by design.
      await markConnectorSummaryEvidenceDirty({ connectorInstanceId: noisy, reason: "run.completed" });
      const result = await runBoundedSummaryEvidenceSweep({
        afterId: cursor,
        maxDurationMs: 60_000,
        maxPages: 1,
        pageSize: PRODUCTION_PAGE_SIZE,
      });
      cursor = result.resumeAfterId;
      assert.ok(
        cursor !== null || !result.incomplete,
        "an incomplete round still returns a cursor so the walk resumes rather than restarting"
      );
    }

    // After three page-sized rounds the walk has genuinely progressed past
    // the first page — dirty work rode alongside it, not instead of it.
    assert.ok(
      cursor === null || cursor > (ids[PRODUCTION_PAGE_SIZE - 1] ?? ""),
      "the cursor walk advances past its first page even while dirty work is continuously available"
    );
  })
);

test(
  "the dirty tranche is bounded — a fleet where EVERY row is dirty still services one bounded bite, never an unbounded whole-fleet pass",
  withTempDb(async () => {
    const fleetSize = 200;
    const ids = seedConnections(fleetSize);
    await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: PRODUCTION_PAGE_SIZE });

    for (const id of ids) {
      // biome-ignore lint/performance/noAwaitInLoops: Deterministic seeding order; concurrency would obscure which rows were marked.
      await markConnectorSummaryEvidenceDirty({ connectorInstanceId: id, reason: "bulk" });
    }

    const round = await runBoundedSummaryEvidenceSweep({
      afterId: null,
      maxDurationMs: 60_000,
      maxPages: 1,
      pageSize: PRODUCTION_PAGE_SIZE,
    });

    assert.ok(
      round.discovered <= PRODUCTION_PAGE_SIZE * 2,
      `an all-dirty fleet must not turn one round into a whole-fleet pass, got ${round.discovered}`
    );
    assert.equal(round.incomplete, true, "an all-dirty 200-connection fleet cannot be covered in one bounded round");
  })
);

// ---------------------------------------------------------------------------
// Budget contract: `maxDurationMs` is authoritative. Neither tranche may BEGIN
// work after its own deadline, so an exhausted or impossibly tight round may
// legitimately do nothing and return its cursor unmoved. Progress is a
// property of repeated NORMAL-budget rounds, never of one impossible round.
// ---------------------------------------------------------------------------

test(
  "a zero budget starts no work at all and leaves the cursor exactly where it was",
  withTempDb(async () => {
    const ids = seedConnections(60);
    await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: PRODUCTION_PAGE_SIZE });

    // Dirty work is available AND far from the cursor, so a round that starts
    // any work at all would be visible in `discovered`.
    const target = ids.at(-1);
    assert.ok(target, "fleet seeded");
    seedSuccessfulRun(target, 1);
    await markConnectorSummaryEvidenceDirty({ connectorInstanceId: target, reason: "run.completed" });

    const round = await runBoundedSummaryEvidenceSweep({
      afterId: null,
      maxDurationMs: 0,
      pageSize: PRODUCTION_PAGE_SIZE,
    });

    assert.equal(round.discovered, 0, "a zero budget must start neither a dirty prefix nor a walk page");
    assert.equal(round.repaired, 0, "no repair may happen after the budget is gone");
    assert.equal(round.incomplete, true, "a round that covered nothing is honestly incomplete");
    assert.equal(round.resumeAfterId, null, "the cursor is unmoved, so the next round restarts from the same place");
    assert.equal(round.prunedComplete, false, "a round that walked no pages must never complete-prune");
  })
);

test(
  "an already-expired budget starts no expensive page even when abundant dirty work is waiting",
  withTempDb(async () => {
    const ids = seedConnections(60);
    await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: PRODUCTION_PAGE_SIZE });
    for (const id of ids) {
      // biome-ignore lint/performance/noAwaitInLoops: Deterministic seeding order.
      await markConnectorSummaryEvidenceDirty({ connectorInstanceId: id, reason: "bulk" });
    }

    // 1ms is not a must-progress budget — it is a must-not-overrun one. The
    // only guarantee is that nothing BEGINS late, so whatever ran is whole
    // pages and never more than the fleet.
    const round = await runBoundedSummaryEvidenceSweep({
      afterId: null,
      maxDurationMs: 1,
      pageSize: PRODUCTION_PAGE_SIZE,
    });

    assert.ok(
      round.discovered === 0 || round.discovered % PRODUCTION_PAGE_SIZE === 0,
      `a tight round does whole pages or nothing, never a partial page — got ${round.discovered}`
    );
    assert.ok(round.discovered < ids.length, "a 1ms round cannot cover a 60-connection fleet");
    assert.equal(round.prunedComplete, false, "an incomplete round must never complete-prune");
  })
);

test(
  "under SUSTAINED dirty work, repeated normal-budget rounds still advance the cursor and converge every clean row",
  withTempDb(async () => {
    const fleetSize = 60;
    const ids = seedConnections(fleetSize);
    await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: PRODUCTION_PAGE_SIZE });

    // A permanently-dirty connection at the FRONT of the id order: every round
    // has prefix work available. If the prefix could starve the walk, the
    // cursor would never reach the back of the fleet.
    const [noisy] = ids;
    const laggard = ids.at(-1);
    assert.ok(noisy && laggard, "fleet seeded");

    // A realistic deterministic budget — generous enough that the split gives
    // BOTH tranches real time, so this proves policy rather than timing.
    let cursor: string | null = null;
    let rounds = 0;
    while (rounds < 10) {
      rounds += 1;
      // biome-ignore lint/performance/noAwaitInLoops: Each round must observe the prior round's durable cursor.
      await markConnectorSummaryEvidenceDirty({ connectorInstanceId: noisy, reason: "sustained dirty work" });
      const result = await runBoundedSummaryEvidenceSweep({
        afterId: cursor,
        maxDurationMs: 60_000,
        maxPages: 1,
        pageSize: PRODUCTION_PAGE_SIZE,
      });
      cursor = result.resumeAfterId;
      if (cursor === null) {
        break;
      }
    }

    // The walk reached the end of the id space despite unbroken dirty work.
    assert.equal(
      cursor,
      null,
      `the cursor walk completed the fleet within ${rounds} rounds under sustained dirty work`
    );
    const laggardRow = readEvidence(laggard);
    assert.ok(laggardRow, "the last connection in the id order has durable evidence");
    assert.equal(
      laggardRow.dirty,
      0,
      "a clean row at the BACK of the walk still converged — the prefix never starved it"
    );
  })
);

// ---------------------------------------------------------------------------
// The cursor walk is the backstop for STALE-BUT-NOT-DIRTY rows.
//
// Live discriminator (deployed 447568d04): 45 evidence rows, terminal_facts
// stale for 32 / current for 13, yet dirty=1 for only 2. The owner saw
// widespread "Coverage unknown" (`SourceCoverageComplete:coverage_unknown`,
// which `runtime/connection-health.ts` raises when the coverage axis is
// absent — i.e. no usable terminal/stream facts). The dirty-first prefix
// cannot help those 30 rows: they carry no dirty marker at all. Convergence
// for them is the cursor walk's job, and these tests pin exactly that.
// ---------------------------------------------------------------------------

test(
  "the cursor walk converges STALE-BUT-NOT-DIRTY rows — the live 32-stale/2-dirty shape, where the prefix cannot help",
  withTempDb(async () => {
    const fleetSize = 45;
    const ids = seedConnections(fleetSize);
    await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: PRODUCTION_PAGE_SIZE });

    // Every connection has a completed run whose facts are NOT yet folded,
    // then is forced stale with dirty explicitly CLEARED — reproducing rows
    // that need repair but carry no dirty marker to attract the prefix.
    for (const [index, id] of ids.entries()) {
      seedSuccessfulRun(id, index + 1);
    }
    getDb()
      .prepare(
        `UPDATE connector_summary_evidence
            SET dirty = 0,
                state = 'stale',
                terminal_facts_state = 'stale',
                stream_latest_facts_json = NULL,
                stream_facts_event_seq = 0`
      )
      .run();

    const stillDirty = getDb()
      .prepare("SELECT COUNT(*) AS n FROM connector_summary_evidence WHERE dirty <> 0")
      .get<{ n: number }>();
    assert.equal(Number(stillDirty?.n), 0, "precondition: NO row is dirty, so the prefix has nothing to select");

    // Repeated normal-budget rounds, resuming from the durable cursor — the
    // real maintenance-tick shape.
    let cursor: string | null = null;
    for (let round = 0; round < 10; round += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Rounds must observe the prior round's durable cursor.
      const result = await runBoundedSummaryEvidenceSweep({
        afterId: cursor,
        maxDurationMs: 60_000,
        maxPages: 1,
        pageSize: PRODUCTION_PAGE_SIZE,
      });
      cursor = result.resumeAfterId;
      if (cursor === null) {
        break;
      }
    }

    // Every connection now carries THIS run's facts — the coverage axis is
    // populated, so health no longer reports coverage_unknown.
    for (const id of ids) {
      assert.ok(
        connectionIsCurrentAfterRound(id),
        `stale-but-not-dirty connection ${id} must converge via the cursor walk alone`
      );
    }
    const stale = getDb()
      .prepare("SELECT COUNT(*) AS n FROM connector_summary_evidence WHERE terminal_facts_state <> 'current'")
      .get<{ n: number }>();
    assert.equal(Number(stale?.n), 0, "no terminal_facts row is left stale after the walk covers the fleet");
  })
);

test(
  "a stale-but-not-dirty fleet converges even while sustained dirty work competes for the same rounds",
  withTempDb(async () => {
    const ids = seedConnections(45);
    await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: PRODUCTION_PAGE_SIZE });
    for (const [index, id] of ids.entries()) {
      seedSuccessfulRun(id, index + 1);
    }
    getDb()
      .prepare(
        `UPDATE connector_summary_evidence
            SET dirty = 0, state = 'stale', terminal_facts_state = 'stale',
                stream_latest_facts_json = NULL, stream_facts_event_seq = 0`
      )
      .run();

    // The prefix is continuously busy with one front-of-fleet row. If it
    // could crowd out the walk, the other 44 stale rows would never converge.
    const [noisy] = ids;
    assert.ok(noisy, "fleet seeded");

    let cursor: string | null = null;
    for (let round = 0; round < 12; round += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Rounds are sequential by construction.
      await markConnectorSummaryEvidenceDirty({ connectorInstanceId: noisy, reason: "sustained dirty work" });
      const result = await runBoundedSummaryEvidenceSweep({
        afterId: cursor,
        maxDurationMs: 60_000,
        maxPages: 1,
        pageSize: PRODUCTION_PAGE_SIZE,
      });
      cursor = result.resumeAfterId;
      if (cursor === null) {
        break;
      }
    }

    assert.equal(cursor, null, "the walk reached the end of the fleet despite unbroken prefix work");
    const stale = getDb()
      .prepare("SELECT COUNT(*) AS n FROM connector_summary_evidence WHERE terminal_facts_state <> 'current'")
      .get<{ n: number }>();
    assert.equal(Number(stale?.n), 0, "sustained prefix work never prevents the walk from converging stale rows");
    // Every row carries THIS run's facts, not merely a non-stale flag.
    for (const id of ids) {
      assert.ok(connectionIsCurrentAfterRound(id), `connection ${id} converged under competing prefix work`);
    }
  })
);

test(
  "ACCELERATION: in a normal-budget round the dirty tranche converges a late-ID row the walk would not reach for many rounds",
  withTempDb(async () => {
    // 120 connections at the production page size: the walk needs ~5 rounds to
    // reach the last id. The acceleration's whole value is collapsing that to
    // one, and this measures the difference rather than asserting it.
    const ids = seedConnections(120);
    await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: PRODUCTION_PAGE_SIZE });

    const target = ids.at(-1);
    assert.ok(target, "fleet seeded");
    seedSuccessfulRun(target, 1);
    await markConnectorSummaryEvidenceDirty({ connectorInstanceId: target, reason: "run.completed" });

    // ONE round, from the top of the cursor. The walk covers ids 0..24 and
    // never touches the target; only the dirty tranche can.
    const round = await runBoundedSummaryEvidenceSweep({
      afterId: null,
      maxDurationMs: 2000,
      maxPages: 1,
      pageSize: PRODUCTION_PAGE_SIZE,
    });

    assert.ok(
      connectionIsCurrentAfterRound(target),
      "the late-ID dirty row carries THIS run's facts after a single normal-budget round"
    );
    // And the walk genuinely had its turn in the same round — acceleration is
    // additive, not a substitute for the backstop.
    assert.ok(round.discovered > PRODUCTION_PAGE_SIZE, "both tranches ran: a full walk page plus the dirty row");
  })
);

test(
  "ACCELERATION is sacrificed before correctness: with no time left the dirty row still converges via the walk",
  withTempDb(async () => {
    const ids = seedConnections(60);
    await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: PRODUCTION_PAGE_SIZE });

    const target = ids.at(-1);
    assert.ok(target, "fleet seeded");
    seedSuccessfulRun(target, 1);
    await markConnectorSummaryEvidenceDirty({ connectorInstanceId: target, reason: "run.completed" });

    // Repeated rounds whose budget the WALK consumes entirely, so the dirty
    // tranche never gets a turn. The row must still converge — later than it
    // would with acceleration, but converge it must: that is the property the
    // walk-first ordering trades acceleration away to protect.
    let cursor: string | null = null;
    for (let round = 0; round < 10; round += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Each round must observe the prior round's durable cursor.
      const result = await runBoundedSummaryEvidenceSweep({
        afterId: cursor,
        maxDurationMs: 60_000,
        maxPages: 1,
        pageSize: PRODUCTION_PAGE_SIZE,
      });
      cursor = result.resumeAfterId;
      if (connectionIsCurrentAfterRound(target)) {
        break;
      }
    }

    assert.ok(
      connectionIsCurrentAfterRound(target),
      "a dirty row converges through the cursor walk alone when acceleration never runs"
    );
  })
);
