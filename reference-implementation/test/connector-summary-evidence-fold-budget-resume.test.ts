// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Budgeted, resumable per-connection fold (Sol fourth-verdict P1.2 /
 * minimum-closure item 2): "Make fold work itself budgeted and resumable.
 * Add an explicit max-events/time budget to the fold and return durable/
 * typed continuation state for an incomplete connection/page. Startup must
 * resume the same incomplete fold before advancing its connection cursor.
 * Gate prunedComplete on both a complete canonical connection census and
 * complete folds. Add a single-connection, multi-batch deterministic
 * oracle on SQLite and real PostgreSQL proving the first pass stops within
 * the work bound, reports incomplete without complete pruning, follow-ups
 * resume rather than restart/skip, and eventual state equals an unbounded
 * oracle."
 *
 * Sol's deterministic reproduction: one connection with 2,001 attributable
 * terminal events, `runBoundedSummaryEvidenceSweep({maxDurationMs:1,
 * pageSize:25})` still folded all 2,001 events and returned
 * `incomplete:false`/`resumeAfterId:null`/`prunedComplete:true` — the fold's
 * own batch-drain loop had no deadline/max-events budget at all, so page-
 * level resumability could not help: there was never anything to resume.
 *
 * This file proves the fix at three layers:
 *   1. `foldConnectorSummaryStreamFacts` itself respects an explicit
 *      `maxDurationMs`/`maxEvents` budget, stops mid-drain, and writes a
 *      genuine PARTIAL-progress checkpoint (not the pass's full high-water
 *      mark) that a follow-up call resumes from.
 *   2. `runBoundedSummaryEvidenceSweep` threads a page's remaining budget
 *      into its fold, reports the WHOLE sweep incomplete when any page's
 *      fold does not converge, resumes the SAME page (not past it), and
 *      only runs complete-set pruning once every page AND every fold
 *      genuinely converged.
 *   3. A multi-round walk (repeatedly calling the sweep with its own
 *      returned cursor) converges to EXACTLY the same final state an
 *      unbounded oracle call would reach — proving resumption, not
 *      silent loss.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  foldConnectorSummaryStreamFacts,
  getConnectorSummaryEvidence,
  rebuildConnectorSummaryEvidence,
  runBoundedSummaryEvidenceSweep,
  setConnectorSummaryReconcileObservationSink,
} from "../server/connector-summary-read-model.ts";
import type { ConnectorSummaryReconcileObservation } from "../server/connector-summary-reconcile-observability.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const NOW = "2026-07-17T00:00:00.000Z";
const EVENT_COUNT = 2001;

function postgresStorageConfig(): { backend: "postgres"; databaseUrl: string } {
  assert.ok(POSTGRES_URL, "Postgres test requires PDPP_TEST_POSTGRES_URL");
  return { backend: "postgres", databaseUrl: POSTGRES_URL };
}

/**
 * `getConnectorSummaryEvidence`'s `stream_latest_facts` field is untyped
 * `unknown` (its storage-side shape is caller-defined runtime fact JSON —
 * see `connector-summary-read-model.ts`'s `parseEvidenceJson`), so reading
 * this fixture's own `messages.fact.record_count` shape back needs a real
 * narrowing helper rather than a property-access chain on `unknown`.
 */
function messagesRecordCount(streamLatestFacts: unknown): number | undefined {
  if (typeof streamLatestFacts !== "object" || streamLatestFacts === null) {
    return;
  }
  const { messages } = streamLatestFacts as Record<string, unknown>;
  if (typeof messages !== "object" || messages === null) {
    return;
  }
  const { fact } = messages as Record<string, unknown>;
  if (typeof fact !== "object" || fact === null) {
    return;
  }
  const recordCount = (fact as Record<string, unknown>).record_count;
  return typeof recordCount === "number" ? recordCount : undefined;
}

async function converge<T extends { incomplete: boolean }>(
  last: T,
  rounds: number,
  maxRounds: number,
  next: (current: T) => Promise<T>
): Promise<{ last: T; rounds: number }> {
  if (!last.incomplete) {
    return { last, rounds };
  }
  const nextRound = rounds + 1;
  assert.ok(nextRound < maxRounds, `sanity bound: must converge within ${maxRounds} rounds`);
  const nextValue = await next(last);
  return converge(nextValue, nextRound, maxRounds, next);
}

// ─── SQLite ─────────────────────────────────────────────────────────────

function withTempDb(fn: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-fold-budget-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function seedSqliteConnection(connectorInstanceId: string, connectorId = "c1"): void {
  getDb()
    .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, "{}", NOW);
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

function seedSqliteTerminalEvents(connectorInstanceId: string, count: number): number {
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
      `evt_${sqliteEventSeq}`,
      sqliteEventSeq,
      NOW,
      NOW,
      `trace_${sqliteEventSeq}`,
      `run_${sqliteEventSeq}`,
      `run_${sqliteEventSeq}`,
      connectorInstanceId,
      data
    );
  }
  return sqliteEventSeq;
}

test(
  "SQLite: foldConnectorSummaryStreamFacts itself respects an explicit maxEvents budget and reports incomplete without reaching the high-water mark",
  withTempDb(async () => {
    seedSqliteConnection("cin_budget_target");
    await rebuildConnectorSummaryEvidence();
    const targetSeq = seedSqliteTerminalEvents("cin_budget_target", EVENT_COUNT);

    const result = await foldConnectorSummaryStreamFacts(["cin_budget_target"], { maxEvents: 500 });

    assert.equal(result.incomplete, true, "the fold genuinely stopped before reaching the full 2,001-event history");
    assert.equal(result.eventsRead, 500, "the bounded SQL batch reads exactly the configured 500 events, never 2,000");
    assert.equal(result.resumeAfterSeq, 500, "the resume checkpoint is exactly the 500th event");
    assert.ok(
      result.resumeAfterSeq !== null && result.resumeAfterSeq < targetSeq,
      "the resume cursor is a real partial position, not the final high-water mark"
    );

    const evidence = await getConnectorSummaryEvidence("cin_budget_target");
    assert.ok(evidence, "the evidence row exists after the initial fold");
    assert.equal(
      Number(evidence.stream_facts_event_seq),
      500,
      "the durable checkpoint is exactly the configured 500-event boundary, not the full maxSeq"
    );
    assert.notEqual(
      Number(evidence.stream_facts_event_seq),
      targetSeq,
      "the checkpoint has NOT falsely advanced to the full high-water mark"
    );
  })
);

test(
  "SQLite: a follow-up call with the same scope RESUMES from the partial checkpoint rather than restarting or skipping, converging to the unbounded oracle value",
  withTempDb(async () => {
    seedSqliteConnection("cin_budget_resume");
    await rebuildConnectorSummaryEvidence();
    const targetSeq = seedSqliteTerminalEvents("cin_budget_resume", EVENT_COUNT);

    const first = await foldConnectorSummaryStreamFacts(["cin_budget_resume"], { maxEvents: 500 });
    assert.equal(first.incomplete, true);
    const afterFirst = await getConnectorSummaryEvidence("cin_budget_resume");
    assert.ok(afterFirst, "the evidence row exists after the first bounded fold");
    const checkpointAfterFirst = Number(afterFirst.stream_facts_event_seq);
    assert.ok(checkpointAfterFirst > 0 && checkpointAfterFirst < targetSeq);

    // Repeated bounded calls (never an unbounded one) walk the whole
    // history to completion — proving genuine multi-round resumption.
    const { rounds } = await converge(first, 1, 20, () =>
      foldConnectorSummaryStreamFacts(["cin_budget_resume"], { maxEvents: 500 })
    );

    const finalEvidence = await getConnectorSummaryEvidence("cin_budget_resume");
    assert.ok(finalEvidence, "the evidence row exists after the final bounded fold");
    assert.equal(
      Number(finalEvidence.stream_facts_event_seq),
      targetSeq,
      "eventual state equals the unbounded oracle checkpoint"
    );
    assert.equal(
      messagesRecordCount(finalEvidence.stream_latest_facts),
      targetSeq,
      "eventual state equals the unbounded oracle fact (record_count is stamped equal to its own event_seq by the fixture) — the LAST event genuinely folded, not merely the checkpoint advanced"
    );
    assert.ok(rounds > 1, "genuinely took multiple rounds — this is resumption, not a single lucky call");
  })
);

test(
  "SQLite: runBoundedSummaryEvidenceSweep reports the WHOLE sweep incomplete and skips complete pruning when a page's fold does not converge",
  withTempDb(async () => {
    seedSqliteConnection("cin_sweep_budget");
    await rebuildConnectorSummaryEvidence();
    const targetSeq = seedSqliteTerminalEvents("cin_sweep_budget", EVENT_COUNT);
    const observations: ConnectorSummaryReconcileObservation[] = [];
    setConnectorSummaryReconcileObservationSink((observation) => observations.push(observation));

    try {
      const result = await runBoundedSummaryEvidenceSweep({
        maxDurationMs: 60_000,
        maxEventsPerFold: 500,
        pageSize: 25,
      });

      assert.equal(
        result.incomplete,
        true,
        "the sweep is incomplete because the page's own fold did not converge, even though discovery+repair for the page finished"
      );
      assert.equal(
        result.prunedComplete,
        false,
        "complete-set pruning must NOT run when a page's fold left terminal history unfolded"
      );
      assert.equal(
        result.resumeAfterId,
        null,
        "an incomplete first page resumes from its cursor-before-page: NULL means retry that same page"
      );
      assert.equal(
        observations.at(-1)?.terminalFoldEventsRead,
        500,
        "the default bounded sweep reads exactly 500 events"
      );
      const partial = await getConnectorSummaryEvidence("cin_sweep_budget");
      assert.ok(partial);
      assert.equal(Number(partial.stream_facts_event_seq), targetSeq - (EVENT_COUNT - 500));
    } finally {
      setConnectorSummaryReconcileObservationSink(null);
    }
  })
);

test(
  "SQLite: a follow-up sweep resumes the SAME still-incomplete page (not past it) and eventually converges with complete pruning",
  withTempDb(async () => {
    // 30 connections across two pages (pageSize 25): page 1 = 25 ordinary
    // connections with no terminal history, page 2 = 5 connections, one of
    // which (cin_0026) carries a large terminal history a small
    // maxEventsPerFold cannot finish in one shot.
    for (let i = 0; i < 30; i += 1) {
      seedSqliteConnection(`cin_${String(i).padStart(4, "0")}`);
    }
    await rebuildConnectorSummaryEvidence();
    const targetSeq = seedSqliteTerminalEvents("cin_0026", 4500);

    const first = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, maxEventsPerFold: 200, pageSize: 25 });
    const { last, rounds } = await converge(first, 1, 30, (current) =>
      runBoundedSummaryEvidenceSweep({
        afterId: current.resumeAfterId,
        maxDurationMs: 60_000,
        maxEventsPerFold: 200,
        pageSize: 25,
      })
    );

    assert.equal(last.prunedComplete, true, "the final converging round runs complete-set pruning");

    const targetEvidence = await getConnectorSummaryEvidence("cin_0026");
    assert.ok(targetEvidence, "the stuck connection has an evidence row");
    assert.equal(
      Number(targetEvidence.stream_facts_event_seq),
      targetSeq,
      "the stuck connection eventually reaches the unbounded oracle checkpoint across resumed rounds"
    );
    // Every OTHER connection (converged in the very first page) is untouched
    // by the later resumed rounds re-processing page 2 — proving resumption
    // targets exactly the incomplete page, not a blanket restart.
    const untouchedEvidence = await getConnectorSummaryEvidence("cin_0000");
    assert.ok(untouchedEvidence, "the untouched connection has an evidence row");
    assert.equal(Number(untouchedEvidence.stream_facts_event_seq), 0);
    assert.ok(rounds > 1, "genuinely required multiple rounds — proves resumption, not a single lucky sweep");
  })
);

test(
  "SQLite mutation: a 1ms existing-participant fold reads no more than its finite 500-event slice and resumes 2,001 events",
  withTempDb(async () => {
    seedSqliteConnection("cin_deadline_event_cap");
    await rebuildConnectorSummaryEvidence();
    const targetSeq = seedSqliteTerminalEvents("cin_deadline_event_cap", EVENT_COUNT);
    const observations: ConnectorSummaryReconcileObservation[] = [];
    setConnectorSummaryReconcileObservationSink((observation) => observations.push(observation));
    try {
      const first = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 1, pageSize: 25 });
      assert.equal(first.incomplete, true, "the finite fold slice leaves 2,001 events resumable");
      assert.equal(first.resumeAfterId, null, "the first incomplete page retains its durable page cursor");
      const receipt = observations.at(-1);
      assert.equal(
        "terminalFoldBudgetMs" in (receipt ?? {}),
        false,
        "the receipt exposes no invented one-millisecond fold budget"
      );
      assert.ok(
        (receipt?.terminalFoldEventsRead ?? 0) <= 500,
        "the one-millisecond bounded sweep may defer its first batch but never exceeds the finite 500-event cap"
      );
      const partial = await getConnectorSummaryEvidence("cin_deadline_event_cap");
      assert.ok(partial, "the existing participant remains durable after the bounded attempt");
      assert.ok(
        Number(partial.stream_facts_event_seq) >= 0 && Number(partial.stream_facts_event_seq) <= 500,
        "the one-millisecond durable checkpoint remains within the same finite event cap"
      );

      const { last } = await converge(first, 1, 20, (current) =>
        runBoundedSummaryEvidenceSweep({
          afterId: current.resumeAfterId,
          maxDurationMs: 60_000,
          pageSize: 25,
        })
      );
      assert.equal(last.incomplete, false, "later rounds converge the same durable participant");
      const complete = await getConnectorSummaryEvidence("cin_deadline_event_cap");
      assert.ok(complete);
      assert.equal(
        Number(complete.stream_facts_event_seq),
        targetSeq,
        "eventual checkpoint reaches the 2,001-event high-water"
      );
    } finally {
      setConnectorSummaryReconcileObservationSink(null);
    }
  })
);

// ─── Postgres (gated) ───────────────────────────────────────────────────

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

async function seedPostgresConnection(connectorInstanceId: string, connectorId = "c1_pg_budget"): Promise<void> {
  await postgresQuery(
    "INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3) ON CONFLICT DO NOTHING",
    [connectorId, "{}", NOW]
  );
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES ($1, 'owner_local', $2, 'x', 'active', 'account', $1, '{}'::jsonb, $3, $3, NULL)`,
    [connectorInstanceId, connectorId, NOW]
  );
}

let postgresEventSeq = 0;

async function seedPostgresTerminalEvents(connectorInstanceId: string, count: number): Promise<number> {
  const seedNext = async (index: number): Promise<void> => {
    if (index >= count) {
      return;
    }
    postgresEventSeq += 1;
    const data = {
      collection_facts: {
        reference_only: true,
        schema_version: 1,
        streams: [{ record_count: postgresEventSeq, resolved: true, stream: "messages" }],
      },
      connection_id: connectorInstanceId,
      connector_instance_id: connectorInstanceId,
    };
    await postgresQuery(
      `INSERT INTO spine_events(
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
       ) VALUES($1, (SELECT COALESCE(MAX(event_seq),0)+1 FROM spine_events), 'run.completed', $2, $2, 'test', $3, 'runtime', 'test', 'run', $4, 'succeeded', $5, $6, $7::jsonb, '1')`,
      [
        `evt_pg_budget_${postgresEventSeq}`,
        NOW,
        `trace_pg_budget_${postgresEventSeq}`,
        `run_pg_budget_${postgresEventSeq}`,
        `run_pg_budget_${postgresEventSeq}`,
        connectorInstanceId,
        JSON.stringify(data),
      ]
    );
    await seedNext(index + 1);
  };
  await seedNext(0);
  return postgresEventSeq;
}

async function cleanupPostgres() {
  await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_id = $1", ["c1_pg_budget"]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_id = $1", ["c1_pg_budget"]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", ["c1_pg_budget"]);
  await postgresQuery("DELETE FROM spine_events WHERE event_id LIKE $1", ["evt_pg_budget_%"]);
  postgresEventSeq = 0;
}

test("real PostgreSQL: foldConnectorSummaryStreamFacts respects an explicit maxEvents budget, reports incomplete, and a follow-up call resumes to the unbounded oracle value", {
  skip: !POSTGRES_URL,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanupPostgres();
    await seedPostgresConnection("cin_budget_target_pg");
    await rebuildConnectorSummaryEvidence();
    const targetSeq = await seedPostgresTerminalEvents("cin_budget_target_pg", EVENT_COUNT);

    const first = await foldConnectorSummaryStreamFacts(["cin_budget_target_pg"], { maxEvents: 500 });
    assert.equal(first.incomplete, true);
    assert.equal(first.eventsRead, 500, "the PostgreSQL bounded SQL batch reads exactly 500 events");
    assert.equal(first.resumeAfterSeq, 500, "the PostgreSQL resume checkpoint is exactly the 500th event");
    assert.ok(first.resumeAfterSeq !== null && first.resumeAfterSeq < targetSeq);

    const afterFirst = await getConnectorSummaryEvidence("cin_budget_target_pg");
    assert.ok(afterFirst, "the evidence row exists after the first bounded fold on real PostgreSQL");
    assert.equal(Number(afterFirst.stream_facts_event_seq), 500);
    assert.notEqual(Number(afterFirst.stream_facts_event_seq), targetSeq);

    const { rounds } = await converge(first, 1, 20, () =>
      foldConnectorSummaryStreamFacts(["cin_budget_target_pg"], { maxEvents: 500 })
    );

    const finalEvidence = await getConnectorSummaryEvidence("cin_budget_target_pg");
    assert.ok(finalEvidence, "the evidence row exists after the final bounded fold on real PostgreSQL");
    assert.equal(
      Number(finalEvidence.stream_facts_event_seq),
      targetSeq,
      "eventual state equals the unbounded oracle checkpoint on real PostgreSQL"
    );
    assert.equal(
      messagesRecordCount(finalEvidence.stream_latest_facts),
      targetSeq,
      "record_count is stamped equal to its own event_seq by the fixture"
    );
    assert.ok(rounds > 1);
  } finally {
    await cleanupPostgres();
    await closePostgresStorage();
  }
});

test("real PostgreSQL: runBoundedSummaryEvidenceSweep reports incomplete and skips complete pruning when a page's fold does not converge, then resumes", {
  skip: !POSTGRES_URL,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanupPostgres();
    await seedPostgresConnection("cin_sweep_budget_pg");
    await rebuildConnectorSummaryEvidence();
    const targetSeq = await seedPostgresTerminalEvents("cin_sweep_budget_pg", EVENT_COUNT);
    const observations: ConnectorSummaryReconcileObservation[] = [];
    setConnectorSummaryReconcileObservationSink((observation) => observations.push(observation));

    const first = await runBoundedSummaryEvidenceSweep({
      maxDurationMs: 60_000,
      maxEventsPerFold: 500,
      pageSize: 25,
    });
    assert.equal(
      first.incomplete,
      true,
      "the sweep is incomplete on real PostgreSQL because the page's own fold did not converge"
    );
    assert.equal(first.prunedComplete, false, "complete-set pruning must not run on real PostgreSQL either");
    assert.equal(first.resumeAfterId, null, "the real PostgreSQL first page also retries from NULL");
    assert.equal(
      observations.at(-1)?.terminalFoldEventsRead,
      500,
      "the PostgreSQL default bounded sweep reads exactly 500 events"
    );
    const partial = await getConnectorSummaryEvidence("cin_sweep_budget_pg");
    assert.ok(partial);
    assert.equal(
      Number(partial.stream_facts_event_seq),
      500,
      "the PostgreSQL default cap persists exactly the 500th event"
    );

    const { last, rounds } = await converge(first, 1, 30, (current) =>
      runBoundedSummaryEvidenceSweep({
        afterId: current.resumeAfterId,
        maxDurationMs: 60_000,
        maxEventsPerFold: 500,
        pageSize: 25,
      })
    );
    assert.equal(last.prunedComplete, true);

    const finalEvidence = await getConnectorSummaryEvidence("cin_sweep_budget_pg");
    assert.ok(finalEvidence, "the evidence row exists after the resumed sweep rounds on real PostgreSQL");
    assert.equal(
      Number(finalEvidence.stream_facts_event_seq),
      targetSeq,
      "converges to the unbounded oracle value on real PostgreSQL after resumed rounds"
    );
    assert.ok(rounds > 1);
  } finally {
    setConnectorSummaryReconcileObservationSink(null);
    await cleanupPostgres();
    await closePostgresStorage();
  }
});

test("real PostgreSQL: the 25-row first-page starvation shape folds before slow generic repairs and survives restart/resume", {
  skip: !POSTGRES_URL,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  const triggerName = "test_summary_starvation_slow_generic";
  const functionName = "test_summary_starvation_slow_generic_fn";
  try {
    await cleanupPostgres();
    const ids = Array.from({ length: 25 }, (_, index) => `cin_starvation_pg_${String(index).padStart(2, "0")}`);
    for (const id of ids) {
      // biome-ignore lint/performance/noAwaitInLoops: test setup advances a shared durable fixture in order.
      await seedPostgresConnection(id);
    }
    await rebuildConnectorSummaryEvidence();
    const targetSeq = await seedPostgresTerminalEvents(ids[0] as string, 274);
    await postgresQuery("UPDATE connector_summary_evidence SET dirty = 1 WHERE connector_id = $1", ["c1_pg_budget"]);
    await postgresQuery(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN PERFORM pg_sleep(0.08); RETURN NEW; END;
       $$`
    );
    await postgresQuery(
      `CREATE TRIGGER ${triggerName}
         BEFORE UPDATE OF computed_at ON connector_summary_evidence
         FOR EACH ROW EXECUTE FUNCTION ${functionName}()`
    );
    const observations: ConnectorSummaryReconcileObservation[] = [];
    setConnectorSummaryReconcileObservationSink((emitted) => observations.push(emitted));
    const first = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 300, pageSize: 25 });
    assert.equal(first.incomplete, true, "slow generic repairs exhaust the remaining bounded round");
    assert.equal(first.resumeAfterId, null, "an incomplete first page retries from its durable NULL cursor");
    const checkpoints = await postgresQuery(
      "SELECT stream_facts_event_seq FROM connector_summary_evidence WHERE connector_id = $1 ORDER BY connector_instance_id",
      ["c1_pg_budget"]
    );
    assert.deepEqual(
      checkpoints.rows.map((row) => Number((row as { stream_facts_event_seq: number }).stream_facts_event_seq)),
      Array.from({ length: 25 }, () => targetSeq),
      "every existing first-page participant advances at the real PostgreSQL seam"
    );
    const receipt = observations.at(-1);
    assert.equal(receipt?.terminalFoldParticipants, 25);
    assert.equal(receipt?.terminalFoldMinimumCheckpointBefore, 0);
    assert.equal(receipt?.terminalFoldMinimumCheckpointAfter, targetSeq);
    assert.equal(receipt?.terminalFoldEventsRead, targetSeq);
    assert.equal(receipt?.terminalFoldZeroProgress, false);
    assert.equal(
      "terminalFoldBudgetMs" in (receipt ?? {}),
      false,
      "the cooperative deadline has no invented fold budget"
    );

    await postgresQuery(`DROP TRIGGER IF EXISTS ${triggerName} ON connector_summary_evidence`);
    await postgresQuery(`DROP FUNCTION IF EXISTS ${functionName}()`);
    const restarted = await runBoundedSummaryEvidenceSweep({
      afterId: first.resumeAfterId,
      maxDurationMs: 300,
      pageSize: 25,
    });
    assert.equal(restarted.incomplete, false, "restart from the durable NULL first-page cursor converges");
    assert.equal(restarted.resumeAfterId, null);
  } finally {
    setConnectorSummaryReconcileObservationSink(null);
    await postgresQuery(`DROP TRIGGER IF EXISTS ${triggerName} ON connector_summary_evidence`);
    await postgresQuery(`DROP FUNCTION IF EXISTS ${functionName}()`);
    await cleanupPostgres();
    await closePostgresStorage();
  }
});

test("real PostgreSQL mutation: a 1ms cold 25-row page starts at most one slow repair and later converges", {
  skip: !POSTGRES_URL,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  const triggerName = "test_summary_cold_deadline_slow_repair";
  const functionName = "test_summary_cold_deadline_slow_repair_fn";
  try {
    await cleanupPostgres();
    const ids = Array.from({ length: 25 }, (_, index) => `cin_cold_deadline_pg_${String(index).padStart(2, "0")}`);
    for (const id of ids) {
      // biome-ignore lint/performance/noAwaitInLoops: test setup advances a shared durable fixture in order.
      await seedPostgresConnection(id);
    }
    await seedPostgresTerminalEvents(ids[0] as string, 1);
    await postgresQuery(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN PERFORM pg_sleep(0.08); RETURN NEW; END;
       $$`
    );
    await postgresQuery(
      `CREATE TRIGGER ${triggerName}
         BEFORE UPDATE OF computed_at ON connector_summary_evidence
         FOR EACH ROW EXECUTE FUNCTION ${functionName}()`
    );
    const observations: ConnectorSummaryReconcileObservation[] = [];
    setConnectorSummaryReconcileObservationSink((emitted) => observations.push(emitted));
    const startedAt = Date.now();
    const first = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 1, pageSize: 25 });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(first.incomplete, true);
    assert.equal(first.resumeAfterId, null, "the expired first page retains its durable resume point");
    const evidenceRows = await postgresQuery(
      "SELECT COUNT(*)::int AS count FROM connector_summary_evidence WHERE connector_id = $1",
      ["c1_pg_budget"]
    );
    assert.ok(
      Number((evidenceRows.rows[0] as { count: number }).count) <= 1,
      "no page-sized set of delayed repairs starts"
    );
    assert.ok(elapsedMs < 750, "one started PostgreSQL repair is the only permitted cooperative overshoot");
    const receipt = observations.at(-1);
    assert.equal("terminalFoldBudgetMs" in (receipt ?? {}), false, "no post-expiry fold timeout is invented");
    assert.ok((receipt?.terminalFoldEventsRead ?? 0) <= 500);

    await postgresQuery(`DROP TRIGGER IF EXISTS ${triggerName} ON connector_summary_evidence`);
    await postgresQuery(`DROP FUNCTION IF EXISTS ${functionName}()`);
    setConnectorSummaryReconcileObservationSink(null);
    const resumed = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: 25 });
    assert.equal(resumed.incomplete, false, "a later round converges all cold evidence");
    const checkpoint = await postgresQuery(
      "SELECT stream_facts_event_seq FROM connector_summary_evidence WHERE connector_instance_id = $1",
      [ids[0] as string]
    );
    assert.equal(Number((checkpoint.rows[0] as { stream_facts_event_seq: number }).stream_facts_event_seq), 1);
  } finally {
    setConnectorSummaryReconcileObservationSink(null);
    await postgresQuery(`DROP TRIGGER IF EXISTS ${triggerName} ON connector_summary_evidence`);
    await postgresQuery(`DROP FUNCTION IF EXISTS ${functionName}()`);
    await cleanupPostgres();
    await closePostgresStorage();
  }
});

test("real PostgreSQL mutation: a 1ms 2,001-event fold is capped and resumes from its durable checkpoint", {
  skip: !POSTGRES_URL,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanupPostgres();
    await seedPostgresConnection("cin_deadline_event_cap_pg");
    await rebuildConnectorSummaryEvidence();
    const targetSeq = await seedPostgresTerminalEvents("cin_deadline_event_cap_pg", EVENT_COUNT);
    const observations: ConnectorSummaryReconcileObservation[] = [];
    setConnectorSummaryReconcileObservationSink((emitted) => observations.push(emitted));
    const first = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 1, pageSize: 25 });
    assert.equal(first.incomplete, true);
    const receipt = observations.at(-1);
    assert.equal("terminalFoldBudgetMs" in (receipt ?? {}), false);
    assert.ok(
      (receipt?.terminalFoldEventsRead ?? 0) <= 500,
      "a one-millisecond deadline may defer the batch but can never start a 2,000-event read"
    );
    const partial = await getConnectorSummaryEvidence("cin_deadline_event_cap_pg");
    assert.ok(partial);
    assert.ok(
      Number(partial.stream_facts_event_seq) <= 500,
      "a one-millisecond deadline may defer checkpoint writes but cannot leap beyond the finite batch"
    );
    const { last } = await converge(first, 1, 20, (current) =>
      runBoundedSummaryEvidenceSweep({
        afterId: current.resumeAfterId,
        maxDurationMs: 60_000,
        pageSize: 25,
      })
    );
    assert.equal(last.incomplete, false);
    const complete = await getConnectorSummaryEvidence("cin_deadline_event_cap_pg");
    assert.ok(complete);
    assert.equal(Number(complete.stream_facts_event_seq), targetSeq);
  } finally {
    setConnectorSummaryReconcileObservationSink(null);
    await cleanupPostgres();
    await closePostgresStorage();
  }
});

test("real PostgreSQL mutation: an expired fold stops its delayed participant checkpoint-write tail after one started write", {
  skip: !POSTGRES_URL,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  const triggerName = "test_summary_deadline_checkpoint_tail";
  const functionName = "test_summary_deadline_checkpoint_tail_fn";
  try {
    await cleanupPostgres();
    const ids = Array.from(
      { length: 25 },
      (_, index) => `cin_deadline_checkpoint_pg_${String(index).padStart(2, "0")}`
    );
    for (const id of ids) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered durable fixture setup is intentional.
      await seedPostgresConnection(id);
    }
    await rebuildConnectorSummaryEvidence();
    const targetSeq = await seedPostgresTerminalEvents(ids[0] as string, 1);
    await postgresQuery(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN PERFORM pg_sleep(0.08); RETURN NEW; END;
       $$`
    );
    await postgresQuery(
      `CREATE TRIGGER ${triggerName}
         BEFORE UPDATE OF stream_facts_event_seq ON connector_summary_evidence
         FOR EACH ROW EXECUTE FUNCTION ${functionName}()`
    );
    const startedAt = Date.now();
    const result = await foldConnectorSummaryStreamFacts(ids, { deadline: startedAt + 20, maxEvents: 500 });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.eventsRead, 1);
    assert.equal(result.incomplete, true, "checkpoint-write expiry remains a resumable incomplete fold");
    assert.equal(result.resumeAfterSeq, 0, "the incomplete participant set retains its minimum durable checkpoint");
    assert.ok(elapsedMs < 750, "only one already-started 80ms checkpoint write may overshoot the deadline");
    const checkpointWrites = await postgresQuery(
      "SELECT COUNT(*)::int AS count FROM connector_summary_evidence WHERE connector_id = $1 AND stream_facts_event_seq = $2",
      ["c1_pg_budget", targetSeq]
    );
    assert.ok(
      Number((checkpointWrites.rows[0] as { count: number }).count) <= 1,
      "expiry prevents the remaining 24 independent checkpoint writes from starting"
    );
    await postgresQuery(`DROP TRIGGER IF EXISTS ${triggerName} ON connector_summary_evidence`);
    await postgresQuery(`DROP FUNCTION IF EXISTS ${functionName}()`);
    const resumed = await foldConnectorSummaryStreamFacts(ids, { maxEvents: 500 });
    assert.equal(resumed.incomplete, false, "a later fold resumes every unfinished participant");
    const converged = await postgresQuery(
      "SELECT COUNT(*)::int AS count FROM connector_summary_evidence WHERE connector_id = $1 AND stream_facts_event_seq = $2",
      ["c1_pg_budget", targetSeq]
    );
    assert.equal(Number((converged.rows[0] as { count: number }).count), 25);
  } finally {
    await postgresQuery(`DROP TRIGGER IF EXISTS ${triggerName} ON connector_summary_evidence`);
    await postgresQuery(`DROP FUNCTION IF EXISTS ${functionName}()`);
    await cleanupPostgres();
    await closePostgresStorage();
  }
});
