// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Fleet-migration gap fix (REVISE, terminal-read-architecture-fable-0730.md
// §9 gate second pass, 2026-07-30): e44bf3391's completed_at nullable
// repair lived INSIDE migrateRunHistoryRename's/migratePostgresRunHistoryRename's
// `legacyExists`-gated branch, which returns immediately once
// `scheduler_run_history` no longer exists. A database whose
// scheduler_run_history -> run_history rename already executed under an
// EARLIER deployment of this migration (before e44bf3391 shipped) never
// reaches the repair — the guard that would let it run is false by the
// time the fix ships, and every run.started write throws forever on that
// database.
//
// Proves: `migrateRunHistoryCompletedAtNullable` /
// `migratePostgresRunHistoryCompletedAtNullable` repair a database in
// exactly this pre-renamed-stuck state (run_history already exists,
// completed_at still NOT NULL, no scheduler_run_history table at all) on
// both backends; the repair is idempotent under a second run; row data,
// `id` values, and both indexes (the connector/completed_at index and the
// unique partial run_id index) survive the SQLite rebuild intact; and a
// fresh install (no legacy artifacts at all) is unaffected — the repair
// no-ops immediately.

import assert from "node:assert/strict";
import test from "node:test";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

// Test isolation (2026-07-30, gate second-pass correction): every
// Postgres proof in this file runs against its own disposable, uniquely
// named database (withTemporaryPostgresDatabase), never the shared
// pdpp_test base database — the fixtures below are destructive (DROP
// TABLE / raw CREATE TABLE against run_history) and must never touch
// shared state another test run depends on. Guaranteed create+drop
// cleanup even on assertion failure.
let tempDbCounter = 0;
function tempDbName(label: string): string {
  tempDbCounter += 1;
  return `pdpp_test_rh_fleet_mig_${label}_${process.pid}_${tempDbCounter}`;
}

// Reproduces the exact intermediate deployment shape: scheduler_run_history
// has already been renamed to run_history by an EARLIER deployment of
// migrateRunHistoryRename (which already ran its own ADD COLUMN steps for
// trigger_kind/facts_json/scheduler_managed — those are unconditional
// `addColumnIfMissing` calls, unrelated to the completed_at bug), but that
// earlier deployment predates e44bf3391, so completed_at is still the
// legacy NOT NULL. No scheduler_run_history table remains — the rename
// already happened — which is exactly what makes migrateRunHistoryRename's
// own legacyExists guard false on this boot, and exactly the gap
// migrateRunHistoryCompletedAtNullable exists to close.
function buildSqlitePreRenamedStuckFixture(dbPath: string): void {
  initDb(dbPath);
  const db = getDb();
  db.exec(`
    DROP TABLE run_history;
    CREATE TABLE run_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      connector_instance_id TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      trigger_kind TEXT,
      source_json TEXT NOT NULL,
      status TEXT NOT NULL,
      records_emitted INTEGER NOT NULL DEFAULT 0,
      reported_records_emitted INTEGER,
      checkpoint_summary_json TEXT,
      known_gaps_json TEXT NOT NULL DEFAULT '[]',
      connector_error_json TEXT,
      trace_id TEXT,
      failure_reason TEXT,
      terminal_reason TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      error TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      facts_json TEXT,
      scheduler_managed INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX idx_run_history_connector_completed
      ON run_history(connector_id, completed_at, id);
    CREATE UNIQUE INDEX uniq_run_history_run_id_instance
      ON run_history(run_id, connector_instance_id) WHERE run_id IS NOT NULL;
  `);
  db.prepare(
    "INSERT INTO run_history(connector_instance_id, connector_id, source_json, status, records_emitted, known_gaps_json, run_id, started_at, completed_at, attempt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    "cin_pre_renamed_stuck",
    "https://test.pdpp.org/connectors/pre-renamed-stuck",
    "{}",
    "succeeded",
    1,
    "[]",
    "run_pre_renamed_stuck",
    "2026-04-29T03:00:00.000Z",
    "2026-04-29T03:00:01.000Z",
    1
  );
  closeDb();
}

function sqliteCompletedAtNotNull(): number {
  const row = getDb()
    .prepare("SELECT \"notnull\" FROM pragma_table_info('run_history') WHERE name = 'completed_at'")
    .get() as { notnull: number };
  return row.notnull;
}

function sqliteIndexNames(): string[] {
  return (
    getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'run_history'").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

test("SQLite: a pre-renamed-stuck database (run_history already exists, no scheduler_run_history, completed_at still NOT NULL) is repaired on the next boot", () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-fleet-migration-stuck-");
  buildSqlitePreRenamedStuckFixture(dbPath);

  // Re-open: this is the exact scenario the gate flagged — no
  // scheduler_run_history table exists (legacyExists is false), so
  // migrateRunHistoryRename's own gated branch never runs, but the
  // standalone migrateRunHistoryCompletedAtNullable repair must still
  // fire because it does not share that guard.
  initDb(dbPath);
  try {
    assert.equal(sqliteCompletedAtNotNull(), 0, "completed_at is nullable after the standalone repair runs");

    const row = getDb().prepare("SELECT * FROM run_history WHERE run_id = ?").get("run_pre_renamed_stuck") as {
      completed_at: string;
      id: number;
      status: string;
    };
    assert.ok(row, "the pre-existing row survives the rebuild");
    assert.equal(row.id, 1, "the row's id is preserved exactly (order tie-breaker contract)");
    assert.equal(row.completed_at, "2026-04-29T03:00:01.000Z", "the row's own data is preserved exactly");
    assert.equal(row.status, "succeeded");

    const indexNames = sqliteIndexNames();
    assert.ok(
      indexNames.includes("idx_run_history_connector_completed"),
      "the connector/completed_at index survives the rebuild"
    );
    assert.ok(
      indexNames.includes("uniq_run_history_run_id_instance"),
      "the unique partial (run_id, connector_instance_id) index survives the rebuild"
    );

    // Idempotency: closing and re-opening again must not throw, must not
    // re-rebuild (already nullable), and must not alter existing data.
    closeDb();
    initDb(dbPath);
    assert.equal(sqliteCompletedAtNotNull(), 0, "still nullable after a second boot (no-op repair)");
    const rowAgain = getDb().prepare("SELECT * FROM run_history WHERE run_id = ?").get("run_pre_renamed_stuck") as {
      completed_at: string;
      id: number;
    };
    assert.equal(rowAgain.id, 1, "id unchanged across the idempotent second run");
    assert.equal(
      rowAgain.completed_at,
      "2026-04-29T03:00:01.000Z",
      "row data unchanged across the idempotent second run"
    );
  } finally {
    closeDb();
  }
});

test("SQLite: a fresh install is unaffected by the fleet-migration repair", () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-fleet-migration-fresh-");
  initDb(dbPath);
  try {
    assert.equal(
      sqliteCompletedAtNotNull(),
      0,
      "fresh install's run_history.completed_at is nullable from CREATE TABLE"
    );
    const indexNames = sqliteIndexNames();
    assert.ok(indexNames.includes("idx_run_history_connector_completed"), "fresh-install index present");
    assert.ok(indexNames.includes("uniq_run_history_run_id_instance"), "fresh-install unique index present");
  } finally {
    closeDb();
  }
});

test("PostgreSQL: a pre-renamed-stuck database is repaired on the next boot, idempotently, with row/id/index preservation", {
  skip: !POSTGRES_URL,
}, async () => {
  assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: tempDbName("stuck"),
    },
    async (url) => {
      // Bootstrap once to get a canonical run_history, then tear it
      // down and rebuild the exact stuck shape — run_history already
      // exists (as if renamed by an earlier deployment), completed_at
      // is still NOT NULL, no scheduler_run_history table exists at
      // all — entirely inside this disposable database.
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      await postgresQuery("DROP TABLE IF EXISTS run_history CASCADE");
      await postgresQuery(`
          CREATE TABLE run_history (
            id BIGSERIAL PRIMARY KEY,
            connector_instance_id TEXT NOT NULL,
            connector_id TEXT NOT NULL,
            source_json JSONB NOT NULL,
            status TEXT NOT NULL,
            records_emitted INTEGER NOT NULL DEFAULT 0,
            reported_records_emitted INTEGER,
            checkpoint_summary_json JSONB,
            known_gaps_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            connector_error_json JSONB,
            run_id TEXT,
            trace_id TEXT,
            failure_reason TEXT,
            terminal_reason TEXT,
            started_at TEXT NOT NULL,
            completed_at TEXT NOT NULL,
            error TEXT,
            attempt INTEGER NOT NULL
          )
        `);
      await postgresQuery(
        "CREATE INDEX idx_pg_run_history_connector_completed ON run_history(connector_id, completed_at, id)"
      );
      await postgresQuery(
        "CREATE UNIQUE INDEX uniq_pg_run_history_run_id_instance ON run_history(run_id, connector_instance_id) WHERE run_id IS NOT NULL"
      );
      const insertResult = await postgresQuery<{ id: string }>(
        `INSERT INTO run_history(
             connector_instance_id, connector_id, source_json, status, records_emitted,
             known_gaps_json, run_id, started_at, completed_at, attempt
           ) VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb, $7, $8, $9, $10)
           RETURNING id::text AS id`,
        [
          "cin_pg_pre_renamed_stuck",
          "https://test.pdpp.org/connectors/pg-pre-renamed-stuck",
          "{}",
          "succeeded",
          1,
          "[]",
          "run_pg_pre_renamed_stuck",
          "2026-04-29T03:00:00.000Z",
          "2026-04-29T03:00:01.000Z",
          1,
        ]
      );
      const originalId = insertResult.rows[0]?.id;
      assert.ok(originalId, "fixture row inserted");

      // Re-bootstrap: this is the scenario — legacyExists
      // (scheduler_run_history) is false, so
      // migratePostgresRunHistoryRename's own gated branch never runs,
      // but the standalone completedAt repair must still fire.
      await closePostgresStorage();
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });

      const nullableCheck = await postgresQuery<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'run_history' AND column_name = 'completed_at'`
      );
      assert.equal(
        nullableCheck.rows[0]?.is_nullable,
        "YES",
        "completed_at is nullable after the standalone repair runs"
      );

      const rowCheck = await postgresQuery<{ completed_at: string; id: string; status: string }>(
        "SELECT id::text AS id, completed_at, status FROM run_history WHERE run_id = $1",
        ["run_pg_pre_renamed_stuck"]
      );
      assert.equal(rowCheck.rows[0]?.id, originalId, "the row's id is preserved exactly across the repair");
      assert.equal(
        rowCheck.rows[0]?.completed_at,
        "2026-04-29T03:00:01.000Z",
        "the row's own data is preserved exactly"
      );
      assert.equal(rowCheck.rows[0]?.status, "succeeded");

      const indexCheck = await postgresQuery<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'run_history'"
      );
      const indexNames = indexCheck.rows.map((r) => r.indexname);
      assert.ok(
        indexNames.includes("idx_pg_run_history_connector_completed"),
        "the connector/completed_at index survives the repair (ALTER COLUMN does not touch indexes)"
      );
      assert.ok(
        indexNames.includes("uniq_pg_run_history_run_id_instance"),
        "the unique partial (run_id, connector_instance_id) index survives the repair"
      );

      // Idempotency: a second bootstrap must not throw and must leave
      // the already-nullable column and existing row alone.
      await closePostgresStorage();
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const nullableAgain = await postgresQuery<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'run_history' AND column_name = 'completed_at'`
      );
      assert.equal(nullableAgain.rows[0]?.is_nullable, "YES", "still nullable after a second boot (no-op repair)");
      const rowAgain = await postgresQuery<{ completed_at: string; id: string }>(
        "SELECT id::text AS id, completed_at FROM run_history WHERE run_id = $1",
        ["run_pg_pre_renamed_stuck"]
      );
      assert.equal(rowAgain.rows[0]?.id, originalId, "id unchanged across the idempotent second run");
      assert.equal(
        rowAgain.rows[0]?.completed_at,
        "2026-04-29T03:00:01.000Z",
        "row data unchanged across the idempotent second run"
      );

      // Real run.started write now succeeds against the repaired
      // table — the exact failure mode the original gate probe
      // reproduced.
      const startedResult = await postgresQuery(
        `INSERT INTO run_history(
             connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, attempt
           ) VALUES ($1, $2, '{}'::jsonb, 'running', '[]'::jsonb, $3, 1)`,
        [
          "cin_pg_post_repair_started",
          "https://test.pdpp.org/connectors/pg-pre-renamed-stuck",
          "2026-04-29T04:00:00.000Z",
        ]
      );
      assert.equal(
        startedResult.rowCount,
        1,
        "a run.started-shaped INSERT with completed_at unset succeeds post-repair"
      );
    }
  );
});

test("PostgreSQL: a fresh install is unaffected by the fleet-migration repair", { skip: !POSTGRES_URL }, async () => {
  assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: tempDbName("fresh"),
    },
    async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const nullableCheck = await postgresQuery<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'run_history' AND column_name = 'completed_at'`
      );
      assert.equal(nullableCheck.rows[0]?.is_nullable, "YES", "fresh install's run_history.completed_at is nullable");
    }
  );
});
