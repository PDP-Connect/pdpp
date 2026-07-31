// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// LIVE CANARY REVISE (2026-07-30): candidate 1a4d32971 was rolled back
// after `CREATE UNIQUE INDEX uniq_pg_run_history_run_id ON
// run_history(run_id)` failed with Postgres error 42P10 on a live
// instance, then every `ON CONFLICT(run_id)` writer/backfill insert
// failed the same way. Read-only live proof: exactly 2 duplicate run_ids,
// each representing TWO DISTINCT connection histories, not duplicate
// rows — run_1782401113918 = a failed run on connection cin_11deac... and
// a succeeded run on a different connection cin_b110...; run_1782865411684
// = a failed run on cin_11deac... and a succeeded run on cin_c858....
//
// Root cause: run_id is minted independently by several call sites
// (runtime/scheduler/run-executor.ts, runtime/controller.ts,
// runtime/index.ts) using Date.now()-based generators with no
// connection-scoped entropy, so two different connections can
// legitimately produce the identical run_id string. run_id alone was
// never a safe uniqueness/conflict/identity key.
//
// Fix: the real identity is the pair (run_id, connector_instance_id).
// - Unique index (SQLite `uniq_run_history_run_id_instance`, Postgres
//   `uniq_pg_run_history_run_id_instance`) is now on the composite pair,
//   not run_id alone — both duplicate-run_id rows the live proof
//   describes have DISTINCT connector_instance_id, so this index builds
//   successfully against exactly that data shape without collapsing or
//   deleting either row.
// - Every ON CONFLICT(run_id) writer (start, finalize-fallback,
//   scheduler upsert, backfill insert) now targets
//   ON CONFLICT(run_id, connector_instance_id).
// - Every UPDATE ... WHERE run_id = ? (finalize, progress-merge) now
//   also fences on `AND connector_instance_id = ?` — without this, a
//   terminal or progress write for one connection's run could otherwise
//   match and corrupt a DIFFERENT connection's still-running row sharing
//   the same run_id.
// - The backfill stage's candidate discovery, event-window fold, and
//   idempotency-skip all key on (run_id, connector_instance_id), not
//   bare run_id — a run_id-only window fetch is filtered down to one
//   candidate's own connection before folding with the UNCHANGED
//   summarizeEvents/summarizeRows fold, so two connections sharing a
//   run_id backfill into two separate rows, not one blended/wrong one.
//
// No compatibility read path, no swallowed index-creation error: the
// migration sites that used to fail-open (try/catch, log, continue) on
// duplicate run_id data now create the composite index unconditionally —
// it succeeds because the composite key does not collide on this data
// shape, and if it ever did, that would be a genuine data anomaly this
// migration should surface loudly, not hide.
//
// See openspec/changes/run-history-backfill-list-cutover.

import assert from "node:assert/strict";
import test from "node:test";
import { emitSpineEvent } from "../lib/spine.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { runRunHistoryBackfillRound } from "../server/stores/run-history-backfill-stage.ts";
import { createPostgresSchedulerStore, createSqliteSchedulerStore } from "../server/stores/scheduler-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const COMPOSITE_INDEX_KEY_PATTERN = /run_id,\s*connector_instance_id/;

const CONNECTOR_ID = "test_dup_run_id_connector";
// The exact colliding run_id shape from the live canary report.
const SHARED_RUN_ID = "run_1782401113918";

function startedEvent(runId: string, connectorInstanceId: string, triggerKind = "scheduled") {
  return {
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      boot_epoch: "boot-dup-run-id-identity",
      connection_id: connectorInstanceId,
      connector_instance_id: connectorInstanceId,
      seq: 1,
      source: { id: CONNECTOR_ID, kind: "connector" },
      trigger_kind: triggerKind,
    },
    event_id: `evt_${runId}_${connectorInstanceId}_started`,
    event_type: "run.started",
    object_id: runId,
    object_type: "run",
    run_id: runId,
    status: "started",
  };
}

function terminalEvent(
  runId: string,
  connectorInstanceId: string,
  eventType: "run.completed" | "run.failed",
  status: string
) {
  return {
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      connection_id: connectorInstanceId,
      connector_instance_id: connectorInstanceId,
      records_emitted: 1,
      source: { id: CONNECTOR_ID, kind: "connector" },
    },
    event_id: `evt_${runId}_${connectorInstanceId}_terminal`,
    event_type: eventType,
    object_id: runId,
    object_type: "run",
    run_id: runId,
    status,
  };
}

function progressEvent(runId: string, connectorInstanceId: string, recordsPerSec: number) {
  return {
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      collection_rate: { records_per_sec: recordsPerSec },
      connection_id: connectorInstanceId,
      connector_instance_id: connectorInstanceId,
      source: { id: CONNECTOR_ID, kind: "connector" },
    },
    event_id: `evt_${runId}_${connectorInstanceId}_progress`,
    event_type: "run.progress_reported",
    object_id: runId,
    object_type: "run",
    run_id: runId,
    status: "running",
  };
}

interface RunHistoryTestRow {
  readonly completed_at: string | null;
  readonly connector_instance_id: string;
  readonly facts_json: string | null;
  readonly run_id: string;
  readonly status: string;
}

function sqliteRowsForRunId(runId: string): RunHistoryTestRow[] {
  return getDb()
    .prepare("SELECT * FROM run_history WHERE run_id = ? ORDER BY connector_instance_id ASC")
    .all(runId) as RunHistoryTestRow[];
}

test("SQLite: two different connections sharing a run_id each get their own run_history row, not a collapsed/overwritten one", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-dup-run-id-sqlite-");
  initDb(dbPath);
  try {
    const connectionA = "cin_11deac_failed";
    const connectionB = "cin_b110_succeeded";

    // Startup: fresh install must create the composite unique index, not
    // the old bare-run_id one — this is the schema half of the fix.
    const indexRow = getDb()
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'run_history' AND name = ?")
      .get("uniq_run_history_run_id_instance") as { sql: string } | undefined;
    assert.ok(indexRow, "fresh install creates the composite (run_id, connector_instance_id) unique index");
    assert.match(indexRow.sql, COMPOSITE_INDEX_KEY_PATTERN, "index is built on the composite key");

    // Scheduled writes: both connections' run.started events land as two
    // DISTINCT rows sharing the same run_id — this is the exact live
    // collision shape, and it must not throw a unique-constraint error.
    await emitSpineEvent(startedEvent(SHARED_RUN_ID, connectionA));
    await emitSpineEvent(startedEvent(SHARED_RUN_ID, connectionB));

    const afterStart = sqliteRowsForRunId(SHARED_RUN_ID);
    assert.equal(afterStart.length, 2, "both connections' started rows exist independently");
    assert.equal(afterStart[0]?.status, "running");
    assert.equal(afterStart[1]?.status, "running");

    // Progress updates: a progress event for connection A must merge only
    // into A's row, never B's — proves the connector_instance_id fence on
    // the progress-merge UPDATE.
    await emitSpineEvent(progressEvent(SHARED_RUN_ID, connectionA, 5));
    const afterProgress = sqliteRowsForRunId(SHARED_RUN_ID);
    const rowA1 = afterProgress.find((r) => r.connector_instance_id === connectionA);
    const rowB1 = afterProgress.find((r) => r.connector_instance_id === connectionB);
    assert.equal(rowA1?.facts_json, '{"collection_rate":{"records_per_sec":5}}', "A's row received the merge");
    assert.equal(rowB1?.facts_json, null, "B's row is untouched by A's progress event");

    // Terminalization: finalizing A must not affect B, and vice versa —
    // proves the connector_instance_id fence on the finalize UPDATE.
    await emitSpineEvent(terminalEvent(SHARED_RUN_ID, connectionA, "run.failed", "failed"));
    const afterAFinal = sqliteRowsForRunId(SHARED_RUN_ID);
    assert.equal(
      afterAFinal.find((r) => r.connector_instance_id === connectionA)?.status,
      "failed",
      "A finalized to failed"
    );
    assert.equal(
      afterAFinal.find((r) => r.connector_instance_id === connectionB)?.status,
      "running",
      "B is still running — A's finalize did not touch B's row"
    );

    await emitSpineEvent(terminalEvent(SHARED_RUN_ID, connectionB, "run.completed", "succeeded"));
    const finalRows = sqliteRowsForRunId(SHARED_RUN_ID);
    assert.equal(finalRows.length, 2, "still exactly two rows — no collapse, no overwrite");
    assert.equal(finalRows.find((r) => r.connector_instance_id === connectionA)?.status, "failed");
    assert.equal(finalRows.find((r) => r.connector_instance_id === connectionB)?.status, "succeeded");

    // Scheduler-store write authority: appendRunHistory's upsert must
    // also target the composite key — enrich A's row only.
    const schedulerStore = createSqliteSchedulerStore();
    await schedulerStore.appendRunHistory({
      attempt: 2,
      checkpointSummary: { cursor: "abc" },
      completedAt: "2026-07-30T00:05:00.000Z",
      connectorError: null,
      connectorId: CONNECTOR_ID,
      connectorInstanceId: connectionA,
      knownGaps: [],
      recordsEmitted: 1,
      runId: SHARED_RUN_ID,
      source: {},
      startedAt: "2026-07-30T00:00:00.000Z",
      status: "failed",
    });
    const afterSchedulerUpsert = sqliteRowsForRunId(SHARED_RUN_ID);
    assert.equal(afterSchedulerUpsert.length, 2, "scheduler upsert enriches A's row, does not create a third row");
  } finally {
    closeDb();
  }
});

test("SQLite: backfill discovers two connections sharing a run_id as two separate candidates, folds each with only its own connection's events", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-dup-run-id-backfill-sqlite-");
  initDb(dbPath);
  try {
    const connectionA = "cin_backfill_11deac";
    const connectionB = "cin_backfill_c858";
    const runId = "run_1782865411684";

    // Write both connections' full lifecycles via the live writer, then
    // delete their run_history rows — simulating spine-only historical
    // runs the backfill stage must discover and re-fold from spine_events
    // alone, exactly as R9.1-R9.3 specify.
    await emitSpineEvent(startedEvent(runId, connectionA));
    await emitSpineEvent(terminalEvent(runId, connectionA, "run.failed", "failed"));
    await emitSpineEvent(startedEvent(runId, connectionB));
    await emitSpineEvent(terminalEvent(runId, connectionB, "run.completed", "succeeded"));
    getDb().prepare("DELETE FROM run_history WHERE run_id = ?").run(runId);
    assert.equal(sqliteRowsForRunId(runId).length, 0, "precondition: no run_history rows, spine-only");

    const result = await runRunHistoryBackfillRound({ afterSeq: 0, batchSize: 50, maxDurationMs: 5000 });
    assert.equal(result.attempted, 2, "two distinct (run_id, connector_instance_id) candidates were discovered");
    assert.equal(result.backfilled, 2, "both candidates backfilled into two separate rows");

    const rows = sqliteRowsForRunId(runId);
    assert.equal(rows.length, 2, "backfill produced two rows, not one blended row");
    const rowA = rows.find((r) => r.connector_instance_id === connectionA);
    const rowB = rows.find((r) => r.connector_instance_id === connectionB);
    assert.equal(rowA?.status, "failed", "A's backfilled row reflects only A's own event window");
    assert.equal(
      rowB?.status,
      "succeeded",
      "B's backfilled row reflects only B's own event window — not blended with A's failure"
    );

    // Idempotency: a second round finds nothing left to backfill.
    const secondRound = await runRunHistoryBackfillRound({ afterSeq: 0, batchSize: 50, maxDurationMs: 5000 });
    assert.equal(secondRound.attempted, 0, "both candidates already have rows — excluded from rediscovery");
    assert.equal(sqliteRowsForRunId(runId).length, 2, "still exactly two rows after the idempotent second round");
  } finally {
    closeDb();
  }
});

test("PostgreSQL: migration builds the composite unique index over live duplicate-run_id data (the exact 42P10 failure this fix closes), preserving both connections' rows", {
  skip: !POSTGRES_URL,
}, async () => {
  assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: `pdpp_test_rh_dup_run_id_${process.pid}`,
    },
    async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });

      // Reproduce the exact pre-fix migration shape: run_history already
      // renamed from scheduler_run_history (no legacy table), but its
      // unique index is still the OLD bare-run_id one — and it already
      // has two rows sharing a run_id across different connections
      // (the live canary's own data shape). The old index could never
      // have been built on this data (42P10); this fixture starts from a
      // state where it was never successfully created at all, matching
      // "migration could not create uniq_pg_run_history_run_id" from the
      // live report.
      await postgresQuery("DROP INDEX IF EXISTS uniq_pg_run_history_run_id_instance");
      await postgresQuery(
        `INSERT INTO run_history(
           run_id, connector_instance_id, connector_id, source_json, status,
           known_gaps_json, started_at, completed_at, records_emitted, attempt
         ) VALUES
           ($1, $2, $3, '{}'::jsonb, 'failed', '[]'::jsonb, $4, $5, 1, 1),
           ($1, $6, $3, '{}'::jsonb, 'succeeded', '[]'::jsonb, $4, $5, 1, 1)`,
        [
          SHARED_RUN_ID,
          "cin_11deac_failed",
          CONNECTOR_ID,
          "2026-07-30T00:00:00.000Z",
          "2026-07-30T00:05:00.000Z",
          "cin_b110_succeeded",
        ]
      );

      // Re-running startup (initPostgresStorage's migration path) must
      // succeed and build the composite index over this exact duplicate-
      // run_id data — the old bare-run_id index could never have built
      // here; the composite one succeeds because the two rows have
      // distinct connector_instance_id values.
      await closePostgresStorage();
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });

      const indexCheck = await postgresQuery<{ indexdef: string; indexname: string }>(
        "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'run_history' AND indexname = $1",
        ["uniq_pg_run_history_run_id_instance"]
      );
      assert.equal(indexCheck.rows.length, 1, "the composite unique index now exists over duplicate-run_id data");
      assert.match(
        indexCheck.rows[0]?.indexdef ?? "",
        COMPOSITE_INDEX_KEY_PATTERN,
        "the index is built on the composite key"
      );

      const rows = await postgresQuery<{ connector_instance_id: string; status: string }>(
        "SELECT connector_instance_id, status FROM run_history WHERE run_id = $1 ORDER BY connector_instance_id ASC",
        [SHARED_RUN_ID]
      );
      assert.equal(rows.rows.length, 2, "both connections' rows survive the migration — neither collapsed nor deleted");
      assert.equal(rows.rows.find((r) => r.connector_instance_id === "cin_11deac_failed")?.status, "failed");
      assert.equal(rows.rows.find((r) => r.connector_instance_id === "cin_b110_succeeded")?.status, "succeeded");

      // Every subsequent ON CONFLICT(run_id, connector_instance_id)
      // writer/backfill insert must now succeed against this data — the
      // exact failure mode the live report described ("every ON
      // CONFLICT(run_id) writer/backfill failed with 42P10").
      const upsertResult = await postgresQuery(
        `INSERT INTO run_history(
           run_id, connector_instance_id, connector_id, source_json, status,
           known_gaps_json, started_at, attempt
         ) VALUES ($1, $2, $3, '{}'::jsonb, 'running', '[]'::jsonb, $4, 1)
         ON CONFLICT(run_id, connector_instance_id) WHERE run_id IS NOT NULL DO NOTHING`,
        [SHARED_RUN_ID, "cin_new_third_connection", CONNECTOR_ID, "2026-07-30T01:00:00.000Z"]
      );
      assert.equal(upsertResult.rowCount, 1, "a THIRD connection sharing this run_id inserts as its own new row");

      const allThree = await postgresQuery<{ connector_instance_id: string }>(
        "SELECT connector_instance_id FROM run_history WHERE run_id = $1",
        [SHARED_RUN_ID]
      );
      assert.equal(allThree.rows.length, 3, "three distinct connections can now share one run_id without collision");
    }
  );
});

test("PostgreSQL: two different connections sharing a run_id each get their own run_history row via the live spine writer", {
  skip: !POSTGRES_URL,
}, async () => {
  assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: `pdpp_test_rh_dup_run_id_writer_${process.pid}`,
    },
    async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const connectionA = "cin_pg_11deac_failed";
      const connectionB = "cin_pg_c858_succeeded";

      await emitSpineEvent(startedEvent(SHARED_RUN_ID, connectionA));
      await emitSpineEvent(startedEvent(SHARED_RUN_ID, connectionB));

      const afterStart = await postgresQuery<{ connector_instance_id: string; status: string }>(
        "SELECT connector_instance_id, status FROM run_history WHERE run_id = $1 ORDER BY connector_instance_id ASC",
        [SHARED_RUN_ID]
      );
      assert.equal(afterStart.rows.length, 2, "both connections' started rows exist independently on Postgres");

      await emitSpineEvent(progressEvent(SHARED_RUN_ID, connectionA, 9));
      const afterProgress = await postgresQuery<{ connector_instance_id: string; facts_json: unknown }>(
        "SELECT connector_instance_id, facts_json FROM run_history WHERE run_id = $1",
        [SHARED_RUN_ID]
      );
      const rowA = afterProgress.rows.find((r) => r.connector_instance_id === connectionA);
      const rowB = afterProgress.rows.find((r) => r.connector_instance_id === connectionB);
      assert.deepEqual(rowA?.facts_json, { collection_rate: { records_per_sec: 9 } }, "A's row received the merge");
      assert.equal(rowB?.facts_json, null, "B's row is untouched by A's progress event");

      await emitSpineEvent(terminalEvent(SHARED_RUN_ID, connectionA, "run.failed", "failed"));
      await emitSpineEvent(terminalEvent(SHARED_RUN_ID, connectionB, "run.completed", "succeeded"));
      const finalRows = await postgresQuery<{ connector_instance_id: string; status: string }>(
        "SELECT connector_instance_id, status FROM run_history WHERE run_id = $1 ORDER BY connector_instance_id ASC",
        [SHARED_RUN_ID]
      );
      assert.equal(finalRows.rows.length, 2, "still exactly two rows on Postgres — no collapse, no overwrite");
      assert.equal(finalRows.rows.find((r) => r.connector_instance_id === connectionA)?.status, "failed");
      assert.equal(finalRows.rows.find((r) => r.connector_instance_id === connectionB)?.status, "succeeded");

      const schedulerStore = createPostgresSchedulerStore();
      await schedulerStore.appendRunHistory({
        attempt: 2,
        checkpointSummary: null,
        completedAt: "2026-07-30T00:05:00.000Z",
        connectorError: null,
        connectorId: CONNECTOR_ID,
        connectorInstanceId: connectionA,
        knownGaps: [],
        recordsEmitted: 1,
        runId: SHARED_RUN_ID,
        source: {},
        startedAt: "2026-07-30T00:00:00.000Z",
        status: "failed",
      });
      const afterSchedulerUpsert = await postgresQuery<{ connector_instance_id: string }>(
        "SELECT connector_instance_id FROM run_history WHERE run_id = $1",
        [SHARED_RUN_ID]
      );
      assert.equal(
        afterSchedulerUpsert.rows.length,
        2,
        "Postgres scheduler upsert enriches A's row, does not create a third row"
      );
    }
  );
});
