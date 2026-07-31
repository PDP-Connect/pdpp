// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// SECOND LIVE CANARY REVISE (2026-07-30): candidate f2b1ebe20 failed
// startup because migratePostgresRunHistoryRename found BOTH
// scheduler_run_history and a non-empty run_history and refused to guess
// which was authoritative (the original guard's throw). Root cause: a
// real interrupted migration — the first rejected canary (candidate
// 1a4d32971) had already renamed scheduler_run_history -> run_history and
// backfilled/live-wrote into it before it was rolled back to old revision
// 1392a386f, which has no run_history/rename machinery at all and
// resumes writing to a scheduler_run_history it recreates fresh via its
// own CREATE TABLE IF NOT EXISTS. Live read-only measurement (2026-07-30
// 19:23 CDT): scheduler_run_history=22 rows (actively growing since
// rollback), run_history=11,415 rows (frozen since the interrupted
// candidate stopped), composite-identity overlap=0 (a pure disjoint
// union on the actual live data) — but numeric `id` values DO overlap
// between the two tables, so legacy ids must never be reused/preserved
// blindly.
//
// Fix: migratePostgresRunHistoryRename / migrateRunHistoryRename no
// longer throw on this state. They reconcile scheduler_run_history's rows
// INTO run_history transactionally, using the SAME (run_id,
// connector_instance_id) upsert contract insert-run-history.sql already
// defines for "a scheduler row meets an existing run_history row"
// (scheduler-owned fields win via excluded.field), verify a genuine
// count-based invariant (every legacy row traceable in run_history)
// BEFORE dropping scheduler_run_history, then commit the merge + verify +
// drop as ONE all-or-nothing transaction — so a crash mid-reconciliation
// leaves scheduler_run_history completely untouched for the next boot to
// retry fresh, no persisted provenance marker needed.
//
// Proves: fresh install (never had scheduler_run_history) is unaffected;
// legacy-only migration (scheduler_run_history exists, no run_history —
// or an empty stale one) still does a pure rename, unchanged; the
// interrupted-migration state (both tables non-empty) reconciles
// losslessly — composite-identity overlap rows merge via the established
// upsert contract, disjoint rows from both tables are preserved, run_id
// IS NULL rows are preserved without collision, two different
// connections sharing a run_id across the two tables never collapse; a
// simulated crash mid-reconciliation (transaction never commits) leaves
// scheduler_run_history fully intact for a clean retry; every legacy
// numeric id is discarded, never reused, on the merge (a fresh
// run_history id is always assigned). Covered on both SQLite and real
// PostgreSQL.
//
// See openspec/changes/run-history-backfill-list-cutover.

import assert from "node:assert/strict";
import test from "node:test";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const SIMULATED_CRASH_ERROR_PATTERN = /simulated crash mid-reconciliation/;

// ─── SQLite fixture builders ────────────────────────────────────────────

// Builds the legacy scheduler_run_history table in the ALREADY-OPEN db
// (initDb must have been called by the test first). Does NOT close the
// db — migrateRunHistoryRename runs on every initDb, so closing/reopening
// here would reconcile-and-drop the just-created empty legacy table
// before the test gets a chance to insert its fixture rows. The test
// itself closes and re-opens once, after all fixture rows are inserted,
// to trigger the real migration/reconciliation path exactly once.
function buildSqliteLegacySchedulerRunHistoryTable(): void {
  const db = getDb();
  db.exec(`
    DROP TABLE IF EXISTS scheduler_run_history;
    CREATE TABLE scheduler_run_history (
      id                         INTEGER PRIMARY KEY AUTOINCREMENT,
      connector_instance_id      TEXT NOT NULL,
      connector_id               TEXT NOT NULL,
      source_json                TEXT NOT NULL,
      status                     TEXT NOT NULL,
      records_emitted            INTEGER NOT NULL DEFAULT 0,
      reported_records_emitted   INTEGER,
      checkpoint_summary_json    TEXT,
      known_gaps_json            TEXT NOT NULL DEFAULT '[]',
      connector_error_json       TEXT,
      run_id                     TEXT,
      trace_id                   TEXT,
      failure_reason             TEXT,
      terminal_reason            TEXT,
      started_at                 TEXT NOT NULL,
      completed_at               TEXT NOT NULL,
      error                      TEXT,
      attempt                    INTEGER NOT NULL
    );
  `);
}

function insertSqliteSchedulerRunHistoryRow(input: {
  readonly attempt?: number;
  readonly completedAt: string;
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly runId: string | null;
  readonly startedAt: string;
  readonly status: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO scheduler_run_history(
         connector_instance_id, connector_id, source_json, status, records_emitted,
         known_gaps_json, run_id, started_at, completed_at, attempt
       ) VALUES (?, ?, '{}', ?, 1, '[]', ?, ?, ?, ?)`
    )
    .run(
      input.connectorInstanceId,
      input.connectorId,
      input.status,
      input.runId,
      input.startedAt,
      input.completedAt,
      input.attempt ?? 1
    );
}

function insertSqliteRunHistoryRow(input: {
  readonly attempt?: number;
  readonly completedAt: string | null;
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly runId: string | null;
  readonly schedulerManaged?: boolean;
  readonly startedAt: string;
  readonly status: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO run_history(
         connector_instance_id, connector_id, source_json, status, records_emitted,
         known_gaps_json, run_id, started_at, completed_at, attempt, scheduler_managed
       ) VALUES (?, ?, '{}', ?, 1, '[]', ?, ?, ?, ?, ?)`
    )
    .run(
      input.connectorInstanceId,
      input.connectorId,
      input.status,
      input.runId,
      input.startedAt,
      input.completedAt,
      input.attempt ?? 1,
      input.schedulerManaged === false ? 0 : 1
    );
}

interface RunHistoryTestRow {
  readonly attempt: number;
  readonly completed_at: string | null;
  readonly connector_instance_id: string;
  readonly id: number;
  readonly run_id: string | null;
  readonly status: string;
}

function sqliteAllRunHistoryRows(): RunHistoryTestRow[] {
  return getDb().prepare("SELECT * FROM run_history ORDER BY id ASC").all() as RunHistoryTestRow[];
}

function sqliteTableExists(name: string): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

// ─── SQLite: fresh install is unaffected ────────────────────────────────

test("SQLite: a fresh install (never had scheduler_run_history) is unaffected by the reconciliation logic", () => {
  const dbPath = makeTemporaryDbPath("pdpp-rh-interrupted-mig-fresh-");
  initDb(dbPath);
  try {
    assert.equal(sqliteTableExists("scheduler_run_history"), false, "no legacy table on a fresh install");
    assert.equal(sqliteTableExists("run_history"), true, "run_history exists directly from CREATE TABLE IF NOT EXISTS");
    assert.equal(sqliteAllRunHistoryRows().length, 0, "fresh run_history is empty");
  } finally {
    closeDb();
  }
});

// ─── SQLite: legacy-only migration (no interruption) still works ───────

test("SQLite: legacy-only migration (scheduler_run_history exists, run_history does not) still does a pure rename, unchanged", () => {
  const dbPath = makeTemporaryDbPath("pdpp-rh-interrupted-mig-legacy-only-");
  initDb(dbPath);
  const db = getDb();
  db.exec("DROP TABLE run_history;");
  buildSqliteLegacySchedulerRunHistoryTable();
  insertSqliteSchedulerRunHistoryRow({
    completedAt: "2026-07-29T10:00:00Z",
    connectorId: "https://test/legacy",
    connectorInstanceId: "cin_legacy_only",
    runId: "run_legacy_only",
    startedAt: "2026-07-29T09:59:00Z",
    status: "succeeded",
  });
  closeDb();

  initDb(dbPath);
  try {
    assert.equal(sqliteTableExists("scheduler_run_history"), false, "legacy table renamed away");
    const rows = sqliteAllRunHistoryRows();
    assert.equal(rows.length, 1, "the single legacy row landed via the pure rename path");
    assert.equal(rows[0]?.run_id, "run_legacy_only");
    assert.equal(rows[0]?.status, "succeeded");
  } finally {
    closeDb();
  }
});

// ─── SQLite: interrupted-migration reconciliation (the core fix) ───────

test("SQLite: interrupted migration reconciles losslessly — overlap merges via the upsert contract, disjoint rows from both tables preserved", () => {
  const dbPath = makeTemporaryDbPath("pdpp-rh-interrupted-mig-reconcile-");
  initDb(dbPath);
  buildSqliteLegacySchedulerRunHistoryTable();

  // run_history: frozen state left by the interrupted candidate.
  insertSqliteRunHistoryRow({
    completedAt: "2026-07-29T10:05:00Z",
    connectorId: "https://test/a",
    connectorInstanceId: "cin_a",
    runId: "run_A_overlap",
    startedAt: "2026-07-29T10:00:00Z",
    status: "succeeded",
  });
  insertSqliteRunHistoryRow({
    completedAt: "2026-07-29T09:02:00Z",
    connectorId: "https://test/c",
    connectorInstanceId: "cin_c",
    runId: "run_C_rh_only",
    schedulerManaged: false,
    startedAt: "2026-07-29T09:00:00Z",
    status: "succeeded",
  });
  // Two different connections sharing a run_id, one row already in
  // run_history — proves the duplicate-run_id-across-connections case
  // survives the reconciliation without collapsing.
  insertSqliteRunHistoryRow({
    completedAt: "2026-07-29T07:01:00Z",
    connectorId: "https://test/e",
    connectorInstanceId: "cin_e1",
    runId: "run_E_dup",
    startedAt: "2026-07-29T07:00:00Z",
    status: "failed",
  });

  // scheduler_run_history: actively growing since rollback.
  insertSqliteSchedulerRunHistoryRow({
    completedAt: "2026-07-29T10:05:00Z",
    connectorId: "https://test/a",
    connectorInstanceId: "cin_a",
    runId: "run_A_overlap",
    startedAt: "2026-07-29T10:00:00Z",
    status: "succeeded",
  });
  insertSqliteSchedulerRunHistoryRow({
    completedAt: "2026-07-30T11:03:00Z",
    connectorId: "https://test/b",
    connectorInstanceId: "cin_b",
    runId: "run_B_sched_only",
    startedAt: "2026-07-30T11:00:00Z",
    status: "succeeded",
  });
  // Same composite identity as an existing run_history row, but a NEWER,
  // divergent write (retry after rollback) — proves the established
  // upsert contract's scheduler-wins semantics apply.
  insertSqliteSchedulerRunHistoryRow({
    attempt: 2,
    completedAt: "2026-07-30T12:00:00Z",
    connectorId: "https://test/d",
    connectorInstanceId: "cin_d",
    runId: "run_D_overlap_stale",
    startedAt: "2026-07-29T08:00:00Z",
    status: "succeeded",
  });
  insertSqliteRunHistoryRow({
    completedAt: "2026-07-29T08:01:00Z",
    connectorId: "https://test/d",
    connectorInstanceId: "cin_d",
    runId: "run_D_overlap_stale",
    startedAt: "2026-07-29T08:00:00Z",
    status: "failed",
  });
  insertSqliteSchedulerRunHistoryRow({
    completedAt: "2026-07-30T13:01:00Z",
    connectorId: "https://test/e",
    connectorInstanceId: "cin_e2",
    runId: "run_E_dup",
    startedAt: "2026-07-30T13:00:00Z",
    status: "succeeded",
  });
  // A run_id-IS-NULL legacy row (e.g. a skipped run never assigned a
  // run_id) — proves NULL rows are preserved without collision.
  insertSqliteSchedulerRunHistoryRow({
    completedAt: "2026-07-30T14:01:00Z",
    connectorId: "https://test/f",
    connectorInstanceId: "cin_f",
    runId: null,
    startedAt: "2026-07-30T14:00:00Z",
    status: "skipped",
  });

  closeDb();

  // Re-open: this is the exact interrupted-migration boot — legacyExists
  // is true AND run_history is non-empty, which used to throw.
  initDb(dbPath);
  try {
    assert.equal(sqliteTableExists("scheduler_run_history"), false, "legacy table reconciled away, not left behind");
    const rows = sqliteAllRunHistoryRows();
    assert.equal(
      rows.length,
      7,
      "4 pre-existing run_history rows (A, C, D, E1) + 3 new-from-scheduler (B, E2, F/null-run_id) = 7 — A and D merge in place (overlap), never duplicated"
    );

    const runA = rows.find((r) => r.run_id === "run_A_overlap");
    assert.ok(runA, "overlap row A survives");
    assert.equal(runA?.status, "succeeded");

    const runB = rows.find((r) => r.run_id === "run_B_sched_only");
    assert.ok(runB, "scheduler-only row B is preserved");
    assert.equal(runB?.status, "succeeded");

    const runC = rows.find((r) => r.run_id === "run_C_rh_only");
    assert.ok(runC, "run_history-only row C is preserved");

    const runD = rows.find((r) => r.run_id === "run_D_overlap_stale");
    assert.ok(runD, "overlap row D survives, merged not duplicated");
    assert.equal(runD?.status, "succeeded", "scheduler's newer write wins per the established upsert contract");
    assert.equal(runD?.attempt, 2, "scheduler's attempt count wins");
    assert.equal(runD?.completed_at, "2026-07-30T12:00:00Z", "scheduler's completed_at wins (its own upsert field)");

    const runERows = rows.filter((r) => r.run_id === "run_E_dup");
    assert.equal(runERows.length, 2, "duplicate run_id across two different connections never collapses");
    assert.ok(
      runERows.some((r) => r.connector_instance_id === "cin_e1"),
      "connection 1's row for the shared run_id survives"
    );
    assert.ok(
      runERows.some((r) => r.connector_instance_id === "cin_e2"),
      "connection 2's row for the shared run_id survives"
    );

    const nullRunIdRows = rows.filter((r) => r.run_id === null);
    assert.equal(nullRunIdRows.length, 1, "the run_id-IS-NULL legacy row is preserved exactly once");

    // No legacy numeric id was reused — every merged row got a fresh
    // run_history id from run_history's own sequence, never
    // scheduler_run_history's overlapping ids.
    const ids = rows.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, "every run_history row has a distinct id");

    const indexRow = getDb()
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'uniq_run_history_run_id_instance'")
      .get() as { sql: string } | undefined;
    assert.ok(indexRow, "the composite unique index exists after reconciliation");
  } finally {
    closeDb();
  }
});

test("SQLite: interrupted-migration reconciliation is a no-op fixed point on a second boot (idempotent)", () => {
  const dbPath = makeTemporaryDbPath("pdpp-rh-interrupted-mig-idempotent-");
  initDb(dbPath);
  buildSqliteLegacySchedulerRunHistoryTable();
  insertSqliteRunHistoryRow({
    completedAt: "2026-07-29T10:05:00Z",
    connectorId: "https://test/a",
    connectorInstanceId: "cin_a",
    runId: "run_A",
    startedAt: "2026-07-29T10:00:00Z",
    status: "succeeded",
  });
  insertSqliteSchedulerRunHistoryRow({
    completedAt: "2026-07-30T11:03:00Z",
    connectorId: "https://test/b",
    connectorInstanceId: "cin_b",
    runId: "run_B",
    startedAt: "2026-07-30T11:00:00Z",
    status: "succeeded",
  });
  closeDb();

  initDb(dbPath);
  const firstRowCount = sqliteAllRunHistoryRows().length;
  closeDb();

  // Second boot: scheduler_run_history no longer exists (already
  // reconciled away), so migrateRunHistoryRename's legacyExists guard is
  // false immediately — a genuine no-op, not a re-merge.
  initDb(dbPath);
  try {
    assert.equal(sqliteTableExists("scheduler_run_history"), false);
    const rows = sqliteAllRunHistoryRows();
    assert.equal(rows.length, firstRowCount, "row count unchanged across the idempotent second boot");
  } finally {
    closeDb();
  }
});

test("SQLite: a crash before the reconciliation transaction commits leaves scheduler_run_history fully intact for a clean retry", () => {
  const dbPath = makeTemporaryDbPath("pdpp-rh-interrupted-mig-crash-");
  initDb(dbPath);
  buildSqliteLegacySchedulerRunHistoryTable();
  insertSqliteRunHistoryRow({
    completedAt: "2026-07-29T10:05:00Z",
    connectorId: "https://test/a",
    connectorInstanceId: "cin_a",
    runId: "run_A",
    startedAt: "2026-07-29T10:00:00Z",
    status: "succeeded",
  });
  insertSqliteSchedulerRunHistoryRow({
    completedAt: "2026-07-30T11:03:00Z",
    connectorId: "https://test/b",
    connectorInstanceId: "cin_b",
    runId: "run_B",
    startedAt: "2026-07-30T11:00:00Z",
    status: "succeeded",
  });
  const db = getDb();

  // Simulate a crash mid-reconciliation: open the same transaction shape
  // the real migration uses, insert into run_history, then throw before
  // COMMIT (SQLite auto-rolls-back an uncommitted transaction when the
  // connection is torn down, and better-sqlite3's raw.transaction()
  // wraps this with an explicit ROLLBACK on a thrown error).
  assert.throws(() => {
    db.transaction(() => {
      db.exec(
        "INSERT INTO run_history(connector_instance_id, connector_id, source_json, status, records_emitted, known_gaps_json, run_id, started_at, completed_at, attempt, scheduler_managed) VALUES ('cin_b', 'https://test/b', '{}', 'succeeded', 1, '[]', 'run_B', '2026-07-30T11:00:00Z', '2026-07-30T11:03:00Z', 1, 1)"
      );
      throw new Error("simulated crash mid-reconciliation");
    })();
  }, SIMULATED_CRASH_ERROR_PATTERN);

  // The simulated partial insert must have been rolled back — proving
  // SQLite's transaction semantics genuinely protect against a partial
  // merge landing.
  const rowsAfterCrash = sqliteAllRunHistoryRows();
  assert.equal(rowsAfterCrash.length, 1, "the crashed transaction's insert did not persist");
  assert.equal(sqliteTableExists("scheduler_run_history"), true, "scheduler_run_history is untouched by the crash");
  closeDb();

  // A subsequent clean boot reconciles successfully from the untouched
  // pre-crash state.
  initDb(dbPath);
  try {
    assert.equal(sqliteTableExists("scheduler_run_history"), false, "the retry reconciles and drops the legacy table");
    const rows = sqliteAllRunHistoryRows();
    assert.equal(rows.length, 2, "both rows present after the clean retry");
  } finally {
    closeDb();
  }
});

// ─── FOURTH-PASS GATE FIX: duplicate composite key WITHIN scheduler_run_history ──

// FOURTH PASS (2026-07-30): the gate found that scheduler_run_history can
// itself contain multiple rows sharing the identical (run_id,
// connector_instance_id) pair — structurally reachable because the
// pre-generalization scheduler writer at the rolled-back revision
// (1392a386f) does a plain INSERT with no ON CONFLICT clause at all, so a
// retried/duplicate scheduled-run completion under that currently-live
// writer produces exactly this shape. On Postgres, the composite-identity
// merge's INSERT ... SELECT ... ON CONFLICT DO UPDATE threw "ON CONFLICT
// DO UPDATE command cannot affect row a second time" whenever two source
// rows targeted the same conflict key — a hard Postgres restriction,
// independent of ORDER BY, meaning the previous fix could never complete
// on a database with this shape (permanently blocked, not merely slow to
// retry). SQLite's own INSERT ... SELECT ... ON CONFLICT DO UPDATE does
// NOT throw on duplicate source rows (applies them in source order, last
// one wins) — but both backends now explicitly pre-deduplicate the
// source by (run_id, connector_instance_id), keeping only the highest
// `id` (the latest write), rather than relying on that backend asymmetry.
test("SQLite: two scheduler_run_history rows sharing the identical composite key deduplicate to the latest (highest id) before merge", () => {
  const dbPath = makeTemporaryDbPath("pdpp-rh-interrupted-mig-dup-composite-");
  initDb(dbPath);
  buildSqliteLegacySchedulerRunHistoryTable();
  insertSqliteRunHistoryRow({
    completedAt: "2026-07-29T10:05:00Z",
    connectorId: "https://test/dup",
    connectorInstanceId: "cin_dup",
    runId: "run_dup_composite",
    schedulerManaged: false,
    startedAt: "2026-07-29T10:00:00Z",
    status: "succeeded",
  });
  // Two legacy rows, SAME (run_id, connector_instance_id), different
  // attempt/status — the exact fixture shape the gate's probe used. The
  // second insert (higher id) is the later, "winning" write.
  insertSqliteSchedulerRunHistoryRow({
    attempt: 1,
    completedAt: "2026-07-30T11:01:00Z",
    connectorId: "https://test/dup",
    connectorInstanceId: "cin_dup",
    runId: "run_dup_composite",
    startedAt: "2026-07-30T11:00:00Z",
    status: "failed",
  });
  insertSqliteSchedulerRunHistoryRow({
    attempt: 2,
    completedAt: "2026-07-30T11:05:00Z",
    connectorId: "https://test/dup",
    connectorInstanceId: "cin_dup",
    runId: "run_dup_composite",
    startedAt: "2026-07-30T11:00:00Z",
    status: "succeeded",
  });
  closeDb();

  // Re-open: migration must not throw despite the intra-table duplicate
  // composite key.
  initDb(dbPath);
  try {
    assert.equal(
      sqliteTableExists("scheduler_run_history"),
      false,
      "migration completed, legacy table reconciled away"
    );
    const rows = sqliteAllRunHistoryRows().filter((r) => r.run_id === "run_dup_composite");
    assert.equal(rows.length, 1, "exactly one row survives for the duplicated composite key — no throw, no split");
    assert.equal(rows[0]?.status, "succeeded", "the highest-id (latest) source row's status wins");
    assert.equal(rows[0]?.attempt, 2, "the highest-id (latest) source row's attempt wins");
    assert.equal(
      rows[0]?.completed_at,
      "2026-07-30T11:05:00Z",
      "the highest-id (latest) source row's completed_at wins"
    );
  } finally {
    closeDb();
  }
});

// ─── PostgreSQL: identical proof set against the real backend ──────────

const PG_LEGACY_SCHEDULER_RUN_HISTORY_DDL = `
  CREATE TABLE scheduler_run_history (
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
    attempt INTEGER NOT NULL DEFAULT 1
  )
`;

test("PostgreSQL: interrupted migration reconciles losslessly against real Postgres — overlap merges, disjoint rows preserved, duplicate run_id across connections survives", {
  skip: !POSTGRES_URL,
}, async () => {
  assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: `pdpp_test_rh_interrupted_mig_${process.pid}`,
    },
    async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });

      // Reproduce the exact interrupted-migration topology: run_history
      // already exists (with real live data left by the interrupted
      // candidate) AND scheduler_run_history exists too (recreated fresh
      // by the rolled-back-to old revision, now actively growing).
      await postgresQuery(PG_LEGACY_SCHEDULER_RUN_HISTORY_DDL);

      await postgresQuery(
        `INSERT INTO run_history(run_id, connector_instance_id, connector_id, source_json, status, records_emitted, known_gaps_json, started_at, completed_at, attempt, scheduler_managed)
         VALUES
         ('run_A_overlap', 'cin_a', 'https://test/a', '{}', 'succeeded', 1, '[]', '2026-07-29T10:00:00Z', '2026-07-29T10:05:00Z', 1, true),
         ('run_C_rh_only', 'cin_c', 'https://test/c', '{}', 'succeeded', 1, '[]', '2026-07-29T09:00:00Z', '2026-07-29T09:02:00Z', 1, false),
         ('run_D_overlap_stale', 'cin_d', 'https://test/d', '{}', 'failed', 1, '[]', '2026-07-29T08:00:00Z', '2026-07-29T08:01:00Z', 1, true),
         ('run_E_dup', 'cin_e1', 'https://test/e', '{}', 'failed', 1, '[]', '2026-07-29T07:00:00Z', '2026-07-29T07:01:00Z', 1, true)`
      );
      await postgresQuery(
        `INSERT INTO scheduler_run_history(run_id, connector_instance_id, connector_id, source_json, status, records_emitted, known_gaps_json, started_at, completed_at, attempt)
         VALUES
         ('run_A_overlap', 'cin_a', 'https://test/a', '{}', 'succeeded', 1, '[]', '2026-07-29T10:00:00Z', '2026-07-29T10:05:00Z', 1),
         ('run_B_sched_only', 'cin_b', 'https://test/b', '{}', 'succeeded', 1, '[]', '2026-07-30T11:00:00Z', '2026-07-30T11:03:00Z', 1),
         ('run_D_overlap_stale', 'cin_d', 'https://test/d', '{}', 'succeeded', 1, '[]', '2026-07-29T08:00:00Z', '2026-07-30T12:00:00Z', 2),
         ('run_E_dup', 'cin_e2', 'https://test/e', '{}', 'succeeded', 1, '[]', '2026-07-30T13:00:00Z', '2026-07-30T13:01:00Z', 1),
         (NULL, 'cin_f', 'https://test/f', '{}', 'skipped', 0, '[]', '2026-07-30T14:00:00Z', '2026-07-30T14:01:00Z', 1)`
      );

      const beforeIds = await postgresQuery<{ id: string }>("SELECT id::text AS id FROM run_history");
      const preExistingIds = new Set(beforeIds.rows.map((r) => r.id));

      // Re-bootstrap: this is the exact interrupted-migration boot the
      // live incident hit — legacyExists is true AND run_history is
      // non-empty, which used to throw with "refusing to guess which is
      // authoritative".
      await closePostgresStorage();
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });

      const legacyStillExists = await postgresQuery<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'scheduler_run_history') AS exists"
      );
      assert.equal(legacyStillExists.rows[0]?.exists, false, "legacy table reconciled away, not left behind");

      const rows = await postgresQuery<{
        attempt: number;
        completed_at: string | null;
        connector_instance_id: string;
        id: string;
        run_id: string | null;
        status: string;
      }>(
        "SELECT id::text AS id, run_id, connector_instance_id, status, attempt, completed_at FROM run_history ORDER BY id ASC"
      );

      assert.equal(
        rows.rows.length,
        7,
        "4 pre-existing run_history rows (A, C, D, E1) + 3 new-from-scheduler (B, E2, F/null-run_id) = 7 — A and D merge in place (overlap), never duplicated"
      );

      const runA = rows.rows.find((r) => r.run_id === "run_A_overlap");
      assert.ok(runA, "overlap row A survives");
      assert.ok(preExistingIds.has(runA?.id ?? ""), "row A kept its ORIGINAL run_history id (it was already there)");

      const runB = rows.rows.find((r) => r.run_id === "run_B_sched_only");
      assert.ok(runB, "scheduler-only row B is preserved");
      assert.ok(
        !preExistingIds.has(runB?.id ?? ""),
        "row B got a FRESH run_history id, never a legacy scheduler_run_history id"
      );

      const runC = rows.rows.find((r) => r.run_id === "run_C_rh_only");
      assert.ok(runC, "run_history-only row C is preserved");

      const runD = rows.rows.find((r) => r.run_id === "run_D_overlap_stale");
      assert.ok(runD, "overlap row D survives, merged not duplicated");
      assert.equal(runD?.status, "succeeded", "scheduler's newer write wins per the established upsert contract");
      assert.equal(runD?.attempt, 2, "scheduler's attempt count wins");

      const runERows = rows.rows.filter((r) => r.run_id === "run_E_dup");
      assert.equal(runERows.length, 2, "duplicate run_id across two different connections never collapses");
      assert.ok(runERows.some((r) => r.connector_instance_id === "cin_e1"));
      assert.ok(runERows.some((r) => r.connector_instance_id === "cin_e2"));

      const nullRunIdRows = rows.rows.filter((r) => r.run_id === null);
      assert.equal(nullRunIdRows.length, 1, "the run_id-IS-NULL legacy row is preserved exactly once");

      const ids = rows.rows.map((r) => r.id);
      assert.equal(new Set(ids).size, ids.length, "every run_history row has a distinct id — no legacy id collision");

      const indexCheck = await postgresQuery<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'run_history' AND indexname = $1",
        ["uniq_pg_run_history_run_id_instance"]
      );
      assert.equal(indexCheck.rows.length, 1, "the composite unique index exists after reconciliation");

      // Idempotency: a second boot is a genuine no-op — scheduler_run_history
      // is already gone, so legacyExists is false immediately.
      await closePostgresStorage();
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const rowsAfterSecondBoot = await postgresQuery("SELECT COUNT(*)::int AS n FROM run_history");
      assert.equal(rowsAfterSecondBoot.rows[0]?.n, 7, "row count unchanged across the idempotent second boot");
    }
  );
});

test("PostgreSQL: a crash before the reconciliation transaction commits leaves scheduler_run_history fully intact for a clean retry", {
  skip: !POSTGRES_URL,
}, async () => {
  assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: `pdpp_test_rh_interrupted_mig_crash_${process.pid}`,
    },
    async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      await postgresQuery(PG_LEGACY_SCHEDULER_RUN_HISTORY_DDL);
      await postgresQuery(
        `INSERT INTO run_history(run_id, connector_instance_id, connector_id, source_json, status, records_emitted, known_gaps_json, started_at, completed_at, attempt, scheduler_managed)
         VALUES ('run_A', 'cin_a', 'https://test/a', '{}', 'succeeded', 1, '[]', '2026-07-29T10:00:00Z', '2026-07-29T10:05:00Z', 1, true)`
      );
      await postgresQuery(
        `INSERT INTO scheduler_run_history(run_id, connector_instance_id, connector_id, source_json, status, records_emitted, known_gaps_json, started_at, completed_at, attempt)
         VALUES ('run_B', 'cin_b', 'https://test/b', '{}', 'succeeded', 1, '[]', '2026-07-30T11:00:00Z', '2026-07-30T11:03:00Z', 1)`
      );

      // Simulate a crash mid-reconciliation: BEGIN, insert into
      // run_history exactly as the real reconciliation would, then
      // ROLLBACK instead of COMMIT (a crashed process never commits —
      // Postgres itself discards the uncommitted transaction on
      // connection loss, which ROLLBACK models exactly).
      await postgresQuery("BEGIN");
      await postgresQuery(
        `INSERT INTO run_history(run_id, connector_instance_id, connector_id, source_json, status, records_emitted, known_gaps_json, started_at, completed_at, attempt, scheduler_managed)
         VALUES ('run_B', 'cin_b', 'https://test/b', '{}', 'succeeded', 1, '[]', '2026-07-30T11:00:00Z', '2026-07-30T11:03:00Z', 1, true)`
      );
      await postgresQuery("ROLLBACK");

      const rowsAfterCrash = await postgresQuery("SELECT COUNT(*)::int AS n FROM run_history");
      assert.equal(rowsAfterCrash.rows[0]?.n, 1, "the crashed transaction's insert did not persist");
      const legacyStillExists = await postgresQuery<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'scheduler_run_history') AS exists"
      );
      assert.equal(legacyStillExists.rows[0]?.exists, true, "scheduler_run_history is untouched by the crash");

      // A subsequent clean boot reconciles successfully from the
      // untouched pre-crash state.
      await closePostgresStorage();
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const legacyAfterRetry = await postgresQuery<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'scheduler_run_history') AS exists"
      );
      assert.equal(legacyAfterRetry.rows[0]?.exists, false, "the retry reconciles and drops the legacy table");
      const rowsAfterRetry = await postgresQuery("SELECT COUNT(*)::int AS n FROM run_history");
      assert.equal(rowsAfterRetry.rows[0]?.n, 2, "both rows present after the clean retry");
    }
  );
});

test("PostgreSQL: two scheduler_run_history rows sharing the identical composite key deduplicate to the latest (highest id) before merge — the exact fourth-pass gate reproduction", {
  skip: !POSTGRES_URL,
}, async () => {
  assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: `pdpp_test_rh_dup_composite_${process.pid}`,
    },
    async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      // The legacy table's own DDL has NO unique constraint on (run_id,
      // connector_instance_id) — that constraint never existed
      // pre-generalization — so this fixture shape is directly
      // constructible, exactly as the gate's probe built it.
      await postgresQuery(PG_LEGACY_SCHEDULER_RUN_HISTORY_DDL);

      await postgresQuery(
        `INSERT INTO run_history(run_id, connector_instance_id, connector_id, source_json, status, records_emitted, known_gaps_json, started_at, completed_at, attempt, scheduler_managed)
         VALUES ('run_dup_composite', 'cin_dup', 'https://test/dup', '{}', 'succeeded', 1, '[]', '2026-07-29T10:00:00Z', '2026-07-29T10:05:00Z', 1, false)`
      );
      // Two legacy rows, SAME (run_id, connector_instance_id), different
      // attempt/status — before this fix, Postgres's ON CONFLICT DO
      // UPDATE throws "cannot affect row a second time" on exactly this
      // shape.
      await postgresQuery(
        `INSERT INTO scheduler_run_history(run_id, connector_instance_id, connector_id, source_json, status, records_emitted, known_gaps_json, started_at, completed_at, attempt)
         VALUES
         ('run_dup_composite', 'cin_dup', 'https://test/dup', '{}', 'failed', 1, '[]', '2026-07-30T11:00:00Z', '2026-07-30T11:01:00Z', 1),
         ('run_dup_composite', 'cin_dup', 'https://test/dup', '{}', 'succeeded', 1, '[]', '2026-07-30T11:00:00Z', '2026-07-30T11:05:00Z', 2)`
      );

      // Re-bootstrap: this must NOT throw.
      await closePostgresStorage();
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });

      const legacyStillExists = await postgresQuery<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'scheduler_run_history') AS exists"
      );
      assert.equal(legacyStillExists.rows[0]?.exists, false, "migration completed, legacy table reconciled away");

      const rows = await postgresQuery<{ attempt: number; completed_at: string | null; status: string }>(
        "SELECT status, attempt, completed_at FROM run_history WHERE run_id = $1",
        ["run_dup_composite"]
      );
      assert.equal(
        rows.rows.length,
        1,
        "exactly one row survives for the duplicated composite key — no throw, no split"
      );
      assert.equal(rows.rows[0]?.status, "succeeded", "the highest-id (latest) source row's status wins");
      assert.equal(rows.rows[0]?.attempt, 2, "the highest-id (latest) source row's attempt wins");
      assert.equal(
        rows.rows[0]?.completed_at,
        "2026-07-30T11:05:00Z",
        "the highest-id (latest) source row's completed_at wins"
      );
    }
  );
});
