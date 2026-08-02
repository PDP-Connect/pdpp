// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Authority Slice A — kind-neutral run_history writer.
//
// Proves: a run_history row is created at run.started and finalized at
// the terminal event for every run kind (scheduled/manual/browser/
// cancelled); the write is idempotent under retried/duplicate started
// and terminal emissions; a terminal event arriving with no prior
// started row still lands (fallback insert); and scheduler-only readers
// (listRunHistory) stay scoped to scheduler_managed rows so a non-
// scheduler run does not silently start influencing scheduler cadence.
//
// See openspec/changes/generalize-run-history-write-authority and
// terminal-read-architecture-fable-0730.md §7.

import assert from "node:assert/strict";
import test from "node:test";
import { emitSpineEvent } from "../lib/spine.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createSqliteSchedulerStore } from "../server/stores/scheduler-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

interface RunHistoryTestRow {
  readonly attempt: number;
  readonly checkpoint_summary_json: string | null;
  readonly completed_at: string | null;
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly facts_json: string | null;
  readonly known_gaps_json: string;
  readonly records_emitted: number;
  readonly run_id: string;
  readonly scheduler_managed: 0 | 1;
  readonly started_at: string;
  readonly status: string;
  readonly trigger_kind: string | null;
}

function readRunHistoryRow(runId: string): RunHistoryTestRow | undefined {
  return getDb().prepare("SELECT * FROM run_history WHERE run_id = ?").get(runId) as RunHistoryTestRow | undefined;
}

function countRunHistoryRows(runId: string): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM run_history WHERE run_id = ?").get(runId) as {
    n: number;
  };
  return row.n;
}

const CONNECTOR_ID = "test_connector";

function startedEvent(runId: string, connectorInstanceId: string, triggerKind?: string) {
  return {
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      boot_epoch: "boot-authority-slice-a",
      connection_id: connectorInstanceId,
      connector_instance_id: connectorInstanceId,
      seq: 1,
      source: { id: CONNECTOR_ID, kind: "connector" },
      ...(triggerKind ? { trigger_kind: triggerKind } : {}),
    },
    event_id: `evt_${runId}_started`,
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
  eventType: "run.abandoned" | "run.browser_surface_failed" | "run.cancelled" | "run.completed" | "run.failed",
  status: string
) {
  return {
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      connection_id: connectorInstanceId,
      connector_instance_id: connectorInstanceId,
      records_emitted: 3,
      source: { id: CONNECTOR_ID, kind: "connector" },
    },
    event_id: `evt_${runId}_terminal`,
    event_type: eventType,
    object_id: runId,
    object_type: "run",
    run_id: runId,
    status,
  };
}

test("run.started creates a running row; every canonical terminal event finalizes it", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-writer-kinds-");
  initDb(dbPath);
  try {
    const cases = [
      {
        eventType: "run.completed" as const,
        runId: "run_scheduled_case",
        status: "succeeded",
        triggerKind: "scheduled",
      },
      { eventType: "run.completed" as const, runId: "run_manual_case", status: "succeeded", triggerKind: "manual" },
      { eventType: "run.completed" as const, runId: "run_browser_case", status: "succeeded", triggerKind: "webhook" },
      { eventType: "run.cancelled" as const, runId: "run_cancelled_case", status: "cancelled", triggerKind: "manual" },
      { eventType: "run.abandoned" as const, runId: "run_abandoned_case", status: "abandoned", triggerKind: "manual" },
    ];

    for (const testCase of cases) {
      const connectorInstanceId = `cin_${testCase.runId}`;
      // biome-ignore lint/performance/noAwaitInLoops: each case independently proves the started->finalized transition.
      await emitSpineEvent(startedEvent(testCase.runId, connectorInstanceId, testCase.triggerKind));
      const startedRow = readRunHistoryRow(testCase.runId);
      assert.ok(startedRow, `${testCase.runId}: run.started must create a run_history row`);
      assert.equal(startedRow?.status, "running", `${testCase.runId}: started row is status=running`);
      assert.equal(startedRow?.completed_at, null, `${testCase.runId}: started row has no completed_at yet`);
      assert.equal(startedRow?.trigger_kind, testCase.triggerKind, `${testCase.runId}: trigger_kind carried through`);
      assert.equal(startedRow?.scheduler_managed, 0, `${testCase.runId}: spine-hook row is not scheduler_managed`);

      await emitSpineEvent(terminalEvent(testCase.runId, connectorInstanceId, testCase.eventType, testCase.status));
      const finalRow = readRunHistoryRow(testCase.runId);
      assert.equal(finalRow?.status, testCase.status, `${testCase.runId}: finalized to the terminal status`);
      assert.ok(finalRow?.completed_at, `${testCase.runId}: finalized row has completed_at`);
      assert.equal(countRunHistoryRows(testCase.runId), 1, `${testCase.runId}: exactly one row for the run_id`);
    }
  } finally {
    closeDb();
  }
});

test("a terminal-only browser-surface failure is durable with its bounded nested facts", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-writer-browser-surface-terminal-");
  initDb(dbPath);
  try {
    const runId = "run_browser_surface_terminal_only";
    const connectorInstanceId = "cin_browser_surface_terminal_only";
    // Browser acquisition fails before connector execution, so this is the
    // canonical terminal event and intentionally has no run.started row.
    await emitSpineEvent({
      ...terminalEvent(runId, connectorInstanceId, "run.browser_surface_failed", "surface_failed"),
      data: {
        browser_surface: {
          browser_surface_lease_id: "lease_terminal_only",
          browser_surface_profile_key: `${CONNECTOR_ID}:${connectorInstanceId}`,
          browser_surface_status: "surface_failed",
          browser_surface_wait_reason: "surface_unhealthy",
        },
        connection_id: connectorInstanceId,
        connector_instance_id: connectorInstanceId,
        source: { id: CONNECTOR_ID, kind: "connector" },
      },
    });

    const row = readRunHistoryRow(runId);
    assert.equal(row?.status, "surface_failed", "the pre-launch terminal event must not be dropped or normalized away");
    assert.deepEqual(JSON.parse(row?.facts_json ?? "{}"), {
      browser_surface_lease_id: "lease_terminal_only",
      browser_surface_profile_key: `${CONNECTOR_ID}:${connectorInstanceId}`,
      browser_surface_status: "surface_failed",
      browser_surface_wait_reason: "surface_unhealthy",
    });
    assert.equal(countRunHistoryRows(runId), 1, "terminal fallback creates exactly one fenced row");
  } finally {
    closeDb();
  }
});

test("retried run.started is idempotent (no duplicate row, no error)", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-writer-retry-started-");
  initDb(dbPath);
  try {
    const runId = "run_retry_started";
    const connectorInstanceId = "cin_retry_started";
    await emitSpineEvent(startedEvent(runId, connectorInstanceId));
    const firstRow = readRunHistoryRow(runId);
    assert.ok(firstRow, "first run.started creates the row");

    // A retried emission of the identical run.started (same run_id) must
    // not throw and must not create a second row.
    await emitSpineEvent({ ...startedEvent(runId, connectorInstanceId), event_id: "evt_retry_started_dup" });
    assert.equal(countRunHistoryRows(runId), 1, "retried run.started stays a no-op");
    const secondRow = readRunHistoryRow(runId);
    assert.equal(secondRow?.started_at, firstRow?.started_at, "the original started_at is preserved");
  } finally {
    closeDb();
  }
});

test("retried terminal event is idempotent (finalize no-ops once already terminal)", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-writer-retry-terminal-");
  initDb(dbPath);
  try {
    const runId = "run_retry_terminal";
    const connectorInstanceId = "cin_retry_terminal";
    await emitSpineEvent(startedEvent(runId, connectorInstanceId));
    await emitSpineEvent(terminalEvent(runId, connectorInstanceId, "run.completed", "succeeded"));
    const firstFinal = readRunHistoryRow(runId);
    assert.equal(firstFinal?.status, "succeeded");

    // A duplicate terminal emission (retry/at-least-once delivery) must not
    // resurrect the row to 'running' or create a second row — the UPDATE
    // targets `status = 'running'` only, so this is a no-op once terminal.
    await emitSpineEvent({
      ...terminalEvent(runId, connectorInstanceId, "run.failed", "failed"),
      event_id: "evt_retry_terminal_dup",
    });
    const afterRetry = readRunHistoryRow(runId);
    assert.equal(afterRetry?.status, "succeeded", "first terminal status wins; retry does not flip it");
    assert.equal(countRunHistoryRows(runId), 1, "still exactly one row");
  } finally {
    closeDb();
  }
});

// Regression coverage for the live-canary finding (2026-07-31, gmail
// run_1785535147325_1): the spine-hook writer (this file) is the writer of
// record for any run whose scheduler-side `appendRunHistory` write loses
// the race against — or never overwrites — the finalize UPDATE that fires
// synchronously off the terminal spine event inside runtime/index.ts. That
// writer previously omitted `checkpoint_summary_json` from both its UPDATE
// and INSERT-fallback entirely, and hardcoded `known_gaps_json = '[]'`
// regardless of what the runtime actually reported. The net effect: a run
// that stopped inside a designed per-run budget (`run_cap_deferred`) with
// its staged messages/attachments cursor never durably committed looked,
// from the row alone, identical to a run with a fully healthy, silently-
// discarded checkpoint — indistinguishable from data loss, and with no
// `known_gaps` evidence a reader could use to tell the two apart.
test("a terminal event carrying checkpoint-commit accounting durably persists checkpoint_summary_json and the real known_gaps_json, not a fabricated empty array", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-writer-checkpoint-summary-");
  initDb(dbPath);
  try {
    const runId = "run_checkpoint_not_committed";
    const connectorInstanceId = "cin_checkpoint_not_committed";
    const notCommittedGap = {
      kind: "checkpoint_commit",
      message: "Staged stream state was not committed",
      reason: "not_committed",
      recovery_hint: { action: "retry_by_runtime", retryable: true },
      severity: "actionable",
      stream: null,
    };
    await emitSpineEvent(startedEvent(runId, connectorInstanceId, "scheduled"));
    await emitSpineEvent({
      ...terminalEvent(runId, connectorInstanceId, "run.failed", "failed"),
      data: {
        buffered_records_dropped: 0,
        checkpoint_commit_status: "not_committed",
        connection_id: connectorInstanceId,
        connector_instance_id: connectorInstanceId,
        known_gaps: [notCommittedGap],
        reason: "runtime_error",
        records_emitted: 206,
        records_flushed: 206,
        source: { id: CONNECTOR_ID, kind: "connector" },
        state_streams_committed: 0,
        state_streams_staged: 3,
      },
    });

    const row = readRunHistoryRow(runId);
    assert.ok(row, "the terminal event lands a row");
    assert.equal(row?.status, "failed");
    assert.equal(row?.records_emitted, 206, "the real emitted count is preserved (already worked before this fix)");

    assert.ok(
      row?.checkpoint_summary_json,
      "checkpoint_summary_json must not be null when the runtime reported checkpoint accounting"
    );
    const checkpointSummary = JSON.parse(row?.checkpoint_summary_json ?? "null");
    assert.equal(
      checkpointSummary.commit_status,
      "not_committed",
      "commit_status is carried through, not silently dropped"
    );
    assert.equal(checkpointSummary.state_streams_committed, 0);
    assert.equal(checkpointSummary.state_streams_staged, 3);

    const knownGaps = JSON.parse(row.known_gaps_json) as Record<string, unknown>[];
    assert.equal(knownGaps.length, 1, "the real known_gaps array is persisted, not hardcoded to []");
    const gap = knownGaps[0] as { kind: string; reason: string; recovery_hint?: { retryable?: boolean } };
    assert.equal(gap.kind, "checkpoint_commit");
    assert.equal(gap.reason, "not_committed");
    assert.equal(
      gap.recovery_hint?.retryable,
      true,
      "the gap's own retryable signal survives — a reader does not need to re-derive retry eligibility from terminal_reason alone"
    );
  } finally {
    closeDb();
  }
});

// The inverse case: a terminal event with NO checkpoint accounting at all
// (e.g. a pre-launch admission failure that never reached the runtime's
// checkpoint bookkeeping) must leave checkpoint_summary_json as a genuine
// SQL NULL, not a fabricated zeroed object — a reader must be able to tell
// "no checkpoint data was ever computed" apart from "checkpoint data was
// computed and nothing had committed yet".
test("a terminal event with no checkpoint accounting at all leaves checkpoint_summary_json null (not a fabricated zero object)", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-writer-no-checkpoint-data-");
  initDb(dbPath);
  try {
    const runId = "run_no_checkpoint_data";
    const connectorInstanceId = "cin_no_checkpoint_data";
    await emitSpineEvent(terminalEvent(runId, connectorInstanceId, "run.browser_surface_failed", "surface_failed"));
    const row = readRunHistoryRow(runId);
    assert.ok(row, "the terminal event lands a row");
    assert.equal(row.checkpoint_summary_json, null);
    assert.deepEqual(JSON.parse(row.known_gaps_json), []);
  } finally {
    closeDb();
  }
});

// Idempotency for the new columns specifically: a retried/duplicate
// terminal emission for an already-terminal run must not touch
// checkpoint_summary_json a second time (the finalize UPDATE is fenced on
// `status = 'running'`, same as every other terminal column).
test("retried terminal event does not overwrite an already-committed checkpoint_summary_json", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-writer-checkpoint-retry-");
  initDb(dbPath);
  try {
    const runId = "run_checkpoint_retry";
    const connectorInstanceId = "cin_checkpoint_retry";
    await emitSpineEvent(startedEvent(runId, connectorInstanceId, "scheduled"));
    await emitSpineEvent({
      ...terminalEvent(runId, connectorInstanceId, "run.completed", "succeeded"),
      data: {
        checkpoint_commit_status: "committed",
        connection_id: connectorInstanceId,
        connector_instance_id: connectorInstanceId,
        known_gaps: [],
        records_emitted: 10,
        source: { id: CONNECTOR_ID, kind: "connector" },
        state_streams_committed: 2,
        state_streams_staged: 2,
      },
    });
    const firstFinal = readRunHistoryRow(runId);
    const firstCheckpoint = firstFinal?.checkpoint_summary_json;
    assert.ok(firstCheckpoint);

    await emitSpineEvent({
      ...terminalEvent(runId, connectorInstanceId, "run.failed", "failed"),
      data: {
        checkpoint_commit_status: "not_committed",
        connection_id: connectorInstanceId,
        connector_instance_id: connectorInstanceId,
        known_gaps: [{ kind: "checkpoint_commit", reason: "not_committed" }],
        records_emitted: 999,
        source: { id: CONNECTOR_ID, kind: "connector" },
        state_streams_committed: 0,
        state_streams_staged: 2,
      },
      event_id: "evt_checkpoint_retry_dup",
    });
    const afterRetry = readRunHistoryRow(runId);
    assert.equal(afterRetry?.status, "succeeded", "first terminal status wins");
    assert.equal(
      afterRetry?.checkpoint_summary_json,
      firstCheckpoint,
      "the retried terminal event's checkpoint data does not clobber the already-committed row"
    );
  } finally {
    closeDb();
  }
});

test("a terminal event with no prior started row still lands (fallback insert covers a lost/raced run.started)", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-writer-terminal-only-");
  initDb(dbPath);
  try {
    const runId = "run_terminal_only";
    const connectorInstanceId = "cin_terminal_only";
    // No run.started emitted at all — simulates a lost/raced started write.
    await emitSpineEvent(terminalEvent(runId, connectorInstanceId, "run.completed", "succeeded"));
    const row = readRunHistoryRow(runId);
    assert.ok(row, "the terminal-only fallback insert still creates a row");
    assert.equal(row?.status, "succeeded");
    assert.equal(countRunHistoryRows(runId), 1);
  } finally {
    closeDb();
  }
});

test("scheduler.appendRunHistory upserts scheduler-only enrichment onto the spine-hook row instead of creating a duplicate", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-writer-scheduler-merge-");
  initDb(dbPath);
  try {
    const runId = "run_scheduler_merge";
    const connectorInstanceId = "cin_scheduler_merge";
    await emitSpineEvent(startedEvent(runId, connectorInstanceId, "scheduled"));
    await emitSpineEvent(terminalEvent(runId, connectorInstanceId, "run.completed", "succeeded"));
    assert.equal(countRunHistoryRows(runId), 1, "spine hook alone produced exactly one row");
    const beforeMerge = readRunHistoryRow(runId);
    assert.equal(beforeMerge?.scheduler_managed, 0, "not yet scheduler_managed before the scheduler's own append");

    const store = createSqliteSchedulerStore();
    await store.appendRunHistory({
      attempt: 2,
      checkpointSummary: { streams: 3 },
      completedAt: "2026-04-29T04:00:00.000Z",
      connectorError: null,
      connectorId: CONNECTOR_ID,
      connectorInstanceId,
      knownGaps: [],
      recordsEmitted: 3,
      runId,
      source: { id: CONNECTOR_ID, kind: "connector" },
      startedAt: "2026-04-29T03:59:00.000Z",
      status: "succeeded",
    });

    assert.equal(countRunHistoryRows(runId), 1, "scheduler append merges into the existing row, no duplicate");
    const merged = readRunHistoryRow(runId);
    assert.equal(merged?.scheduler_managed, 1, "scheduler's own write marks the row scheduler_managed");
    assert.equal(merged?.attempt, 2, "scheduler enrichment (attempt) is applied");
  } finally {
    closeDb();
  }
});

test("listRunHistory (scheduler cadence hydration) stays scoped to scheduler_managed rows", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-writer-scoped-list-");
  initDb(dbPath);
  try {
    const store = createSqliteSchedulerStore();

    // A manual run driven only by the spine hook (e.g. controller.runNow)
    // — never touches scheduler.appendRunHistory.
    await emitSpineEvent(startedEvent("run_direct_manual", "cin_direct_manual", "manual"));
    await emitSpineEvent(terminalEvent("run_direct_manual", "cin_direct_manual", "run.completed", "succeeded"));

    // A scheduled run that also goes through the scheduler's own append.
    await emitSpineEvent(startedEvent("run_via_scheduler", "cin_via_scheduler", "scheduled"));
    await emitSpineEvent(terminalEvent("run_via_scheduler", "cin_via_scheduler", "run.completed", "succeeded"));
    await store.appendRunHistory({
      attempt: 1,
      checkpointSummary: null,
      completedAt: "2026-04-29T04:00:00.000Z",
      connectorError: null,
      connectorId: CONNECTOR_ID,
      connectorInstanceId: "cin_via_scheduler",
      knownGaps: [],
      recordsEmitted: 3,
      runId: "run_via_scheduler",
      source: { id: CONNECTOR_ID, kind: "connector" },
      startedAt: "2026-04-29T03:59:00.000Z",
      status: "succeeded",
    });

    const history = await store.listRunHistory(500);
    const runIds = history.map((row) => row.runId);
    assert.ok(runIds.includes("run_via_scheduler"), "the scheduler-managed run is visible to listRunHistory");
    assert.ok(
      !runIds.includes("run_direct_manual"),
      "the direct/manual run (never scheduler-managed) stays invisible to listRunHistory"
    );
  } finally {
    closeDb();
  }
});

// Regression coverage for the REVISE gate finding (2026-07-30): a database
// migrated from the legacy scheduler_run_history schema carries over
// completed_at TEXT NOT NULL. The generalized writer's run.started INSERT
// deliberately leaves completed_at unset (the row sits in status='running'
// until the terminal event finalizes it), so on a migrated-but-not-rebuilt
// table that INSERT violates the surviving NOT NULL constraint and every
// run of every kind throws at the moment it starts. This is the majority
// deploy path — every already-running instance has scheduler_run_history,
// not a fresh install. migrateRunHistoryRename / migratePostgresRunHistoryRename
// must rebuild/relax the constraint, not just rename + add columns.

test("SQLite: a run.started write succeeds against a database migrated from legacy scheduler_run_history", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-writer-legacy-completed-at-");
  initDb(dbPath);
  try {
    const db = getDb();
    // Reproduce the real pre-migration production shape exactly:
    // completed_at TEXT NOT NULL, no trigger_kind/facts_json/scheduler_managed.
    db.exec(`
      DROP TABLE run_history;
      CREATE TABLE scheduler_run_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connector_instance_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        source_json TEXT NOT NULL,
        status TEXT NOT NULL,
        records_emitted INTEGER NOT NULL DEFAULT 0,
        reported_records_emitted INTEGER,
        checkpoint_summary_json TEXT,
        known_gaps_json TEXT NOT NULL DEFAULT '[]',
        connector_error_json TEXT,
        run_id TEXT,
        trace_id TEXT,
        failure_reason TEXT,
        terminal_reason TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        error TEXT,
        attempt INTEGER NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO scheduler_run_history(connector_instance_id, connector_id, source_json, status, records_emitted, known_gaps_json, run_id, started_at, completed_at, attempt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "cin_legacy_history",
      CONNECTOR_ID,
      "{}",
      "succeeded",
      1,
      "[]",
      "run_legacy_history",
      "2026-04-29T03:00:00.000Z",
      "2026-04-29T03:00:01.000Z",
      1
    );
    closeDb();

    // Re-open: this drives migrateRunHistoryRename against the legacy table.
    initDb(dbPath);

    const notNullBefore = getDb()
      .prepare("SELECT \"notnull\" FROM pragma_table_info('run_history') WHERE name = 'completed_at'")
      .get() as { notnull: number };
    assert.equal(notNullBefore.notnull, 0, "completed_at is nullable on the migrated table");

    // The exact failure mode the gate reproduced: a run.started INSERT
    // (completed_at unset) against the migrated table.
    const runId = "run_after_legacy_migration";
    const connectorInstanceId = "cin_after_legacy_migration";
    const event = await emitSpineEvent(startedEvent(runId, connectorInstanceId, "scheduled"));
    assert.ok(event, "run.started succeeds against the migrated-from-legacy table");

    const row = readRunHistoryRow(runId);
    assert.equal(row?.status, "running");
    assert.equal(row?.completed_at, null, "the started row's completed_at is NULL, not a fabricated value");

    // The pre-existing legacy row survives the rebuild with its own
    // (real, non-null) completed_at intact.
    const legacyRow = readRunHistoryRow("run_legacy_history");
    assert.equal(legacyRow?.completed_at, "2026-04-29T03:00:01.000Z", "pre-existing legacy row data is preserved");
    assert.equal(legacyRow?.scheduler_managed, 1, "pre-existing legacy row is marked scheduler_managed");

    await emitSpineEvent(terminalEvent(runId, connectorInstanceId, "run.completed", "succeeded"));
    const finalRow = readRunHistoryRow(runId);
    assert.equal(finalRow?.status, "succeeded");
    assert.ok(finalRow?.completed_at, "the terminal write finalizes completed_at");
  } finally {
    closeDb();
  }
});

test("PostgreSQL: a run.started write succeeds against a database migrated from legacy scheduler_run_history", {
  skip: !POSTGRES_URL && "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  try {
    await postgresQuery("DROP TABLE IF EXISTS run_history CASCADE");
    await postgresQuery("DROP TABLE IF EXISTS scheduler_run_history CASCADE");
    // Reproduce the real pre-migration production shape exactly:
    // completed_at TEXT NOT NULL, no trigger_kind/facts_json/scheduler_managed.
    await postgresQuery(`
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
          attempt INTEGER NOT NULL
        )
      `);
    await postgresQuery(
      `INSERT INTO scheduler_run_history(
           connector_instance_id, connector_id, source_json, status, records_emitted,
           known_gaps_json, run_id, started_at, completed_at, attempt
         ) VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb, $7, $8, $9, $10)`,
      [
        "cin_legacy_history_pg",
        CONNECTOR_ID,
        "{}",
        "succeeded",
        1,
        "[]",
        "run_legacy_history_pg",
        "2026-04-29T03:00:00.000Z",
        "2026-04-29T03:00:01.000Z",
        1,
      ]
    );

    // Re-run the schema bootstrap: drives migratePostgresRunHistoryRename
    // against the legacy table (mirrors what happens on server restart
    // against a real deployed database).
    await closePostgresStorage();
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });

    const notNullBefore = await postgresQuery<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'run_history' AND column_name = 'completed_at'`
    );
    assert.equal(notNullBefore.rows[0]?.is_nullable, "YES", "completed_at is nullable on the migrated table");

    // The exact failure mode the gate reproduced: a run.started INSERT
    // (completed_at unset) against the migrated table.
    const runId = "run_after_legacy_migration_pg";
    const connectorInstanceId = "cin_after_legacy_migration_pg";
    const event = await emitSpineEvent(startedEvent(runId, connectorInstanceId, "scheduled"));
    assert.ok(event, "run.started succeeds against the migrated-from-legacy table");

    const startedRow = await postgresQuery<{ completed_at: string | null; status: string }>(
      "SELECT status, completed_at FROM run_history WHERE run_id = $1",
      [runId]
    );
    assert.equal(startedRow.rows[0]?.status, "running");
    assert.equal(startedRow.rows[0]?.completed_at, null, "the started row's completed_at is NULL");

    // The pre-existing legacy row survives with its own data intact.
    const legacyRow = await postgresQuery<{ completed_at: string; scheduler_managed: boolean }>(
      "SELECT completed_at, scheduler_managed FROM run_history WHERE run_id = $1",
      ["run_legacy_history_pg"]
    );
    assert.equal(legacyRow.rows[0]?.completed_at, "2026-04-29T03:00:01.000Z");
    assert.equal(legacyRow.rows[0]?.scheduler_managed, true);

    await emitSpineEvent(terminalEvent(runId, connectorInstanceId, "run.completed", "succeeded"));
    const finalRow = await postgresQuery<{ completed_at: string | null; status: string }>(
      "SELECT status, completed_at FROM run_history WHERE run_id = $1",
      [runId]
    );
    assert.equal(finalRow.rows[0]?.status, "succeeded");
    assert.ok(finalRow.rows[0]?.completed_at, "the terminal write finalizes completed_at");
  } finally {
    // Best-effort cleanup: swallow errors here so a cleanup failure never
    // masks the test's real assertion failure above.
    await postgresQuery("DELETE FROM spine_events WHERE actor_id = $1", [CONNECTOR_ID]).catch(() => undefined);
    await postgresQuery("DELETE FROM run_history WHERE connector_id = $1", [CONNECTOR_ID]).catch(() => undefined);
    await closePostgresStorage();
  }
});
