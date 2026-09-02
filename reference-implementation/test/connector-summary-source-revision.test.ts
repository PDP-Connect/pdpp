// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-revision conformance for summary maintenance.
 *
 * These tests keep canonical writes and derived evidence deliberately
 * separate. A projection fault is allowed to leave evidence stale, but it
 * must never reject a record, schedule, or lifecycle write. Repairs then
 * reread canonical state under the connector-instance fence and converge.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { Pool } from "pg";
import { emitSpineEvent } from "../lib/spine.ts";
import { __setConnectorInstanceWritePhaseHookForTest } from "../server/connector-instance-write-coordinator.ts";
import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import { getConnectorSummaryEvidence } from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createAlreadyAdmittedTestDatabaseChildAttachment } from "../server/postgres-test-database-guard.ts";
import { ingestRecord, recordCurrentGenerationUndeclaredWrite } from "../server/records.ts";
import { createPostgresSchedulerStore, createSqliteSchedulerStore } from "../server/stores/scheduler-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const OWNER = "owner_local";
const NOW = "2026-08-11T00:00:00.000Z";
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/source-revision";
const STREAM = "messages";
const MAX_SOURCE_REVISION = "9223372036854775807";
const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const LIVE_WRITER_FIXTURE = new URL("./fixtures/summary-source-revision-live-writer.mjs", import.meta.url);
const FAILURE_FIXTURE = new URL("./fixtures/summary-evidence-failure-publication-fixture.mjs", import.meta.url);

const MANIFEST = {
  capabilities: { public_listing: { tier: "supported" } },
  connector_id: CONNECTOR_ID,
  display_name: "Source Revision Probe",
  protocol_version: "0.1.0",
  streams: [
    {
      coverage_strategy: "full_inventory",
      name: STREAM,
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
  ],
  version: "1.0.0",
};

type TestRow = Record<string, unknown>;
let sqliteTestQueue = Promise.resolve();

async function withSqlite<T>(fn: (databasePath: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "pdpp-summary-source-revision-"));
  const databasePath = join(directory, "pdpp.sqlite");
  const previous = sqliteTestQueue;
  let release!: () => void;
  sqliteTestQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    initDb(databasePath);
    return await fn(databasePath);
  } finally {
    delete process.env.PDPP_TEST_SOURCE_REVISION_INSTALL_LOCK_PATH;
    delete process.env.PDPP_TEST_REPAIR_FAILURE_MARKER_PATH;
    delete process.env.PDPP_TEST_REPAIR_FAILURE_RELEASE_PATH;
    __setConnectorInstanceWritePhaseHookForTest(null);
    closeDb();
    rmSync(directory, { force: true, recursive: true });
    release();
  }
}

function seedConnectorAndInstance(connectorInstanceId: string): void {
  const db = getDb();
  db.prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)").run(
    CONNECTOR_ID,
    JSON.stringify(MANIFEST),
    NOW
  );
  db.prepare(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
  ).run(connectorInstanceId, OWNER, CONNECTOR_ID, MANIFEST.display_name, connectorInstanceId, NOW, NOW);
}

function seedSecondSqliteInstance(connectorInstanceId: string): void {
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(connectorInstanceId, OWNER, CONNECTOR_ID, MANIFEST.display_name, connectorInstanceId, NOW, NOW);
}

function storageTarget(connectorInstanceId: string) {
  return { connector_id: CONNECTOR_ID, connector_instance_id: connectorInstanceId };
}

function sourceRevision(connectorInstanceId: string): string {
  const row = getDb()
    .prepare(
      "SELECT CAST(source_revision AS TEXT) AS source_revision FROM connector_instances WHERE connector_instance_id = ?"
    )
    .get(connectorInstanceId) as { source_revision: string } | undefined;
  assert.ok(row, "the source instance exists");
  return row.source_revision;
}

function evidence(connectorInstanceId: string): TestRow {
  const row = getDb()
    .prepare("SELECT * FROM connector_summary_evidence WHERE connector_instance_id = ?")
    .get(connectorInstanceId) as TestRow | undefined;
  assert.ok(row, "summary evidence exists");
  return row;
}

async function warmEvidence(connectorInstanceId: string): Promise<void> {
  const result = await reconcileConnectorSummaryEvidence([connectorInstanceId]);
  assert.equal(result.repaired, 1, "the initial repair creates a fresh evidence row");
  assert.equal(evidence(connectorInstanceId).dirty, 0);
}

function installSqliteProjectionFault(): void {
  getDb().exec(`
    DROP TRIGGER IF EXISTS pdpp_test_summary_projection_fault;
    CREATE TRIGGER pdpp_test_summary_projection_fault
      BEFORE UPDATE ON connector_summary_evidence
      BEGIN
        SELECT RAISE(ABORT, 'review-fault');
      END;
  `);
}

function removeSqliteProjectionFault(): void {
  getDb().exec("DROP TRIGGER IF EXISTS pdpp_test_summary_projection_fault");
}

function spawnLineFixture(dbPath: string, connectorInstanceId: string, markerPath: string) {
  const child = spawn(process.execPath, [new URL(LIVE_WRITER_FIXTURE).pathname], {
    env: {
      ...process.env,
      PDPP_SUMMARY_LIVE_WRITER_CONNECTOR_INSTANCE_ID: connectorInstanceId,
      PDPP_SUMMARY_LIVE_WRITER_DB_PATH: dbPath,
      PDPP_TEST_SOURCE_REVISION_INSTALL_LOCK_PATH: markerPath,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (!child.stdout) {
    throw new Error("the SQLite live-writer fixture did not expose stdout");
  }
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const nextLine = async (): Promise<string> => {
    const next = await iterator.next();
    if (next.done) {
      throw new Error("the SQLite live-writer fixture exited before reporting its result");
    }
    return next.value;
  };
  const exitCode = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  return { child, exitCode, lines, nextLine };
}

function spawnFailureFixture(
  dbPath: string | null,
  connectorInstanceId: string,
  postgresUrl?: string,
  postgresChildAttachment?: string
) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== "PDPP_SUMMARY_FAILURE_FIXTURE_POSTGRES_CHILD_ATTACHMENT")
  );
  // Do not let a capability from an unrelated parent fixture survive through
  // the ambient environment. The parent passes this one directly and only to
  // its PostgreSQL child.
  if (postgresChildAttachment) {
    env.PDPP_SUMMARY_FAILURE_FIXTURE_POSTGRES_CHILD_ATTACHMENT = postgresChildAttachment;
  }
  const child = spawn(process.execPath, [new URL(FAILURE_FIXTURE).pathname], {
    env: {
      ...env,
      PDPP_SUMMARY_FAILURE_FIXTURE_CONNECTOR_INSTANCE_ID: connectorInstanceId,
      ...(dbPath ? { PDPP_SUMMARY_FAILURE_FIXTURE_DB_PATH: dbPath } : {}),
      ...(postgresUrl ? { PDPP_SUMMARY_FAILURE_FIXTURE_POSTGRES_URL: postgresUrl } : {}),
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (!child.stdout) {
    throw new Error("the SQLite failure fixture did not expose stdout");
  }
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const nextLine = async (): Promise<string> => {
    const next = await iterator.next();
    if (next.done) {
      throw new Error("the SQLite failure fixture exited before reporting its result");
    }
    return next.value;
  };
  const exitCode = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  return { child, exitCode, lines, nextLine };
}

function waitForFile(path: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const interval = setInterval(() => {
      if (existsSync(path)) {
        clearInterval(interval);
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(interval);
        reject(new Error(`timed out waiting for ${path}`));
      }
    }, 5);
  });
}

test("SQLite projection faults do not reject canonical record, schedule, or lifecycle writes, then repair passes after recovery", () =>
  withSqlite(async () => {
    const instanceId = "cin_source_revision_fault_isolation";
    seedConnectorAndInstance(instanceId);
    await warmEvidence(instanceId);
    installSqliteProjectionFault();
    const before = sourceRevision(instanceId);
    const scheduler = createSqliteSchedulerStore();

    await ingestRecord(
      storageTarget(instanceId),
      {
        data: { id: "message-1" },
        emitted_at: NOW,
        key: "message-1",
        stream: STREAM,
      },
      { deferIndexes: true }
    );
    scheduler.createSchedule({
      connector_id: CONNECTOR_ID,
      connector_instance_id: instanceId,
      created_at: NOW,
      enabled: true,
      interval_seconds: 900,
      jitter_seconds: 0,
      updated_at: "2026-08-11T00:01:00.000Z",
    });
    await emitSpineEvent({
      data: { connector_instance_id: instanceId },
      event_id: "evt_source_revision_fault_isolation",
      event_type: "run.completed",
    });
    await recordCurrentGenerationUndeclaredWrite(storageTarget(instanceId), {
      provenance: "source-revision-fault-test",
      stream: "undeclared-stream",
    });

    assert.equal(
      (
        getDb().prepare("SELECT COUNT(*) AS count FROM records WHERE connector_instance_id = ?").get(instanceId) as {
          count: number;
        }
      ).count,
      1,
      "the canonical record commit survives the projection fault"
    );
    assert.equal(
      (
        getDb()
          .prepare("SELECT COUNT(*) AS count FROM connector_schedules WHERE connector_instance_id = ?")
          .get(instanceId) as {
          count: number;
        }
      ).count,
      1,
      "the canonical schedule commit survives the projection fault"
    );
    assert.equal(
      (
        getDb()
          .prepare("SELECT COUNT(*) AS count FROM spine_events WHERE event_id = ?")
          .get("evt_source_revision_fault_isolation") as {
          count: number;
        }
      ).count,
      1,
      "the canonical lifecycle event survives the projection fault"
    );
    assert.equal(
      (
        getDb()
          .prepare("SELECT COUNT(*) AS count FROM manifest_write_violations WHERE connector_instance_id = ?")
          .get(instanceId) as { count: number }
      ).count,
      1,
      "canonical rejected-write provenance survives the projection fault"
    );
    assert.notEqual(sourceRevision(instanceId), before, "the canonical receipt is independent of evidence writes");

    const failed = await reconcileConnectorSummaryEvidence([instanceId]);
    assert.equal(failed.failed, 1, "the repair reports the derived projection fault");
    removeSqliteProjectionFault();
    const passed = await reconcileConnectorSummaryEvidence([instanceId]);
    assert.equal(passed.failed, 0);
    const repaired = evidence(instanceId);
    assert.equal(repaired.total_records, 1);
    assert.equal(repaired.schedule_checkpoint, "2026-08-11T00:01:00.000Z");
    assert.equal(repaired.dirty, 0);
    assert.equal(repaired.state, "fresh");
    assert.notEqual(repaired.run_lifecycle_event_seq, null);
  }));

test("SQLite trigger omission fails before migration and the atomic reinstall barrier restores safe convergence", () =>
  withSqlite(async (databasePath) => {
    const instanceId = "cin_source_revision_installation";
    seedConnectorAndInstance(instanceId);
    await warmEvidence(instanceId);
    const scheduler = createSqliteSchedulerStore();
    getDb().exec("DROP TRIGGER IF EXISTS pdpp_source_revision_connector_schedules_insert");
    const beforeOmission = sourceRevision(instanceId);

    scheduler.createSchedule({
      connector_id: CONNECTOR_ID,
      connector_instance_id: instanceId,
      created_at: NOW,
      enabled: true,
      interval_seconds: 900,
      jitter_seconds: 0,
      updated_at: "2026-08-11T00:01:00.000Z",
    });
    assert.equal(sourceRevision(instanceId), beforeOmission, "the deliberately omitted trigger misses the writer");
    assert.equal(evidence(instanceId).dirty, 0, "the omission can leave a stale-clean row before migration");

    closeDb();
    initDb(databasePath);
    const migrated = evidence(instanceId);
    assert.equal(migrated.dirty, 0, "disposable evidence normalization never blocks trigger installation");
    assert.notEqual(migrated.list_summary_projection_reason_code, "canonical_source_revision_installation");
    const installed = getDb()
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = ?")
      .get("pdpp_source_revision_connector_schedules_insert") as { count: number };
    assert.equal(installed.count, 1);

    const afterInstall = sourceRevision(instanceId);
    scheduler.updateSchedule(instanceId, {
      enabled: true,
      interval_seconds: 901,
      jitter_seconds: 0,
      updated_at: "2026-08-11T00:02:00.000Z",
    });
    assert.notEqual(sourceRevision(instanceId), afterInstall, "a live writer sees the restored trigger");
    await reconcileConnectorSummaryEvidence([instanceId]);
    assert.equal(evidence(instanceId).schedule_checkpoint, "2026-08-11T00:02:00.000Z");
    assert.equal(evidence(instanceId).dirty, 0);
  }));

test("SQLite installation lock excludes a live writer until the restored trigger is committed", () =>
  withSqlite(async (databasePath) => {
    const instanceId = "cin_source_revision_live_writer";
    seedConnectorAndInstance(instanceId);
    await warmEvidence(instanceId);
    getDb().exec("DROP TRIGGER IF EXISTS pdpp_source_revision_connector_schedules_insert");
    closeDb();

    const directory = mkdtempSync(join(tmpdir(), "pdpp-summary-source-install-lock-"));
    const markerPath = join(directory, "install.locked");
    const fixture = spawnLineFixture(databasePath, instanceId, markerPath);
    try {
      assert.equal(JSON.parse(await fixture.nextLine()).ready, true);
      fixture.child.stdin?.write("go\n");
      process.env.PDPP_TEST_SOURCE_REVISION_INSTALL_LOCK_PATH = markerPath;
      initDb(databasePath);
      const outcome = JSON.parse(await fixture.nextLine());
      assert.equal(outcome.ok, true);
      assert.equal(await fixture.exitCode, 0);
      assert.equal(
        existsSync(markerPath),
        true,
        "the writer started only after the installation transaction held its lock"
      );
      assert.equal(sourceRevision(instanceId), "1", "the live writer ran after the restored insert trigger");
      assert.equal(evidence(instanceId).dirty, 0, "a disposable projection barrier cannot block boot or installation");
      await reconcileConnectorSummaryEvidence([instanceId]);
      assert.equal(evidence(instanceId).dirty, 0);
    } finally {
      fixture.lines.close();
      if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
        fixture.child.kill("SIGKILL");
      }
      delete process.env.PDPP_TEST_SOURCE_REVISION_INSTALL_LOCK_PATH;
      rmSync(directory, { force: true, recursive: true });
    }
  }));

test("SQLite stale failure publication cannot overwrite newer evidence", () =>
  withSqlite(async (databasePath) => {
    const instanceId = "cin_source_revision_stale_failure";
    seedConnectorAndInstance(instanceId);
    await warmEvidence(instanceId);
    installSqliteProjectionFault();
    await ingestRecord(
      storageTarget(instanceId),
      { data: { id: "stale-failure-message" }, emitted_at: NOW, key: "stale-failure-message", stream: STREAM },
      { deferIndexes: true }
    );

    const directory = mkdtempSync(join(tmpdir(), "pdpp-summary-stale-failure-"));
    const markerPath = join(directory, "failure.paused");
    const releasePath = join(directory, "failure.release");
    process.env.PDPP_TEST_REPAIR_FAILURE_MARKER_PATH = markerPath;
    process.env.PDPP_TEST_REPAIR_FAILURE_RELEASE_PATH = releasePath;
    const fixture = spawnFailureFixture(databasePath, instanceId);
    try {
      assert.equal(JSON.parse(await fixture.nextLine()).ready, true);
      fixture.child.stdin?.write("go\n");
      await waitForFile(markerPath, 15_000);

      removeSqliteProjectionFault();
      const scheduler = createSqliteSchedulerStore();
      scheduler.createSchedule({
        connector_id: CONNECTOR_ID,
        connector_instance_id: instanceId,
        created_at: NOW,
        enabled: true,
        interval_seconds: 900,
        jitter_seconds: 0,
        updated_at: "2026-08-11T00:06:00.000Z",
      });
      const newer = await reconcileConnectorSummaryEvidence([instanceId]);
      assert.equal(newer.failed, 0);
      assert.equal(evidence(instanceId).dirty, 0);
      assert.equal(evidence(instanceId).state, "fresh");

      writeFileSync(releasePath, "release\n", "utf8");
      const staleFailure = JSON.parse(await fixture.nextLine());
      assert.equal(staleFailure.result.failed, 1);
      assert.equal(await fixture.exitCode, 0);
      assert.equal(evidence(instanceId).dirty, 0, "the old failure did not overwrite newer evidence");
      assert.equal(evidence(instanceId).state, "fresh");
    } finally {
      removeSqliteProjectionFault();
      writeFileSync(releasePath, "release\n", "utf8");
      fixture.lines.close();
      if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
        fixture.child.kill("SIGKILL");
      }
      delete process.env.PDPP_TEST_REPAIR_FAILURE_MARKER_PATH;
      delete process.env.PDPP_TEST_REPAIR_FAILURE_RELEASE_PATH;
      rmSync(directory, { force: true, recursive: true });
    }
  }));

test("SQLite failed publication cannot overwrite newer evidence, and deletion rechecks same-id reuse under the fence", () =>
  withSqlite(async () => {
    const failureId = "cin_source_revision_failed_publication";
    seedConnectorAndInstance(failureId);
    await warmEvidence(failureId);
    installSqliteProjectionFault();
    await ingestRecord(
      storageTarget(failureId),
      {
        data: { id: "failure-message" },
        emitted_at: NOW,
        key: "failure-message",
        stream: STREAM,
      },
      { deferIndexes: true }
    );
    const failed = await reconcileConnectorSummaryEvidence([failureId]);
    assert.equal(failed.failed, 1);
    removeSqliteProjectionFault();
    await reconcileConnectorSummaryEvidence([failureId]);
    assert.equal(evidence(failureId).total_records, 1, "the old failure did not replace the recovered publication");

    const deleteId = "cin_source_revision_deleted_publication";
    seedSecondSqliteInstance(deleteId);
    await warmEvidence(deleteId);
    const insertRepairChunk = () =>
      getDb()
        .prepare(
          `INSERT INTO connector_summary_evidence_repair_chunk(
             connector_instance_id, resume_after_id, accumulator_json, source_revision, started_at, updated_at
           ) VALUES(?, 1, '{}', ?, ?, ?)`
        )
        .run(deleteId, sourceRevision(deleteId), NOW, NOW);
    const repairChunkCount = () =>
      (
        getDb()
          .prepare(
            "SELECT COUNT(*) AS count FROM connector_summary_evidence_repair_chunk WHERE connector_instance_id = ?"
          )
          .get(deleteId) as { count: number }
      ).count;
    insertRepairChunk();
    getDb().prepare("DELETE FROM connector_instances WHERE connector_instance_id = ?").run(deleteId);
    let recreated = false;
    __setConnectorInstanceWritePhaseHookForTest((stage, context) => {
      if (stage === "before_key_acquire" && context.connectorInstanceId === deleteId && !recreated) {
        recreated = true;
        seedSecondSqliteInstance(deleteId);
      }
    });
    await reconcileConnectorSummaryEvidence([deleteId]);
    __setConnectorInstanceWritePhaseHookForTest(null);
    assert.equal(recreated, true);
    assert.ok(evidence(deleteId), "a reused connector instance keeps its evidence");
    assert.equal(repairChunkCount(), 0, "a reused id cannot resume scan state from before its recreation");

    insertRepairChunk();
    getDb().prepare("DELETE FROM connector_instances WHERE connector_instance_id = ?").run(deleteId);
    const deleted = await reconcileConnectorSummaryEvidence([deleteId]);
    assert.equal(deleted.repaired, 1, "the fenced orphan delete publishes only after the second absence check");
    assert.equal(
      (
        getDb()
          .prepare("SELECT COUNT(*) AS count FROM connector_summary_evidence WHERE connector_instance_id = ?")
          .get(deleteId) as {
          count: number;
        }
      ).count,
      0
    );
    assert.equal(repairChunkCount(), 0, "orphan cleanup deletes the absent instance's scan state");
  }));

test("SQLite source receipts avoid terminal trigger amplification and preserve exact BIGINT exhaustion", () =>
  withSqlite(async () => {
    const instanceId = "cin_source_revision_bigint";
    seedConnectorAndInstance(instanceId);
    await warmEvidence(instanceId);
    const beforeTerminal = BigInt(sourceRevision(instanceId));
    await emitSpineEvent({
      data: { connector_instance_id: instanceId },
      event_id: "evt_source_revision_terminal_amplification",
      event_type: "run.completed",
    });
    assert.equal(BigInt(sourceRevision(instanceId)) - beforeTerminal, 1n);

    getDb()
      .prepare("UPDATE connector_instances SET source_revision = ? WHERE connector_instance_id = ?")
      .run(MAX_SOURCE_REVISION, instanceId);
    assert.equal(
      (
        getDb()
          .prepare("SELECT typeof(source_revision) AS type FROM connector_instances WHERE connector_instance_id = ?")
          .get(instanceId) as { type: string }
      ).type,
      "integer",
      "SQLite keeps the maximum receipt as an integer, not a rounded REAL"
    );
    const scheduler = createSqliteSchedulerStore();
    scheduler.createSchedule({
      connector_id: CONNECTOR_ID,
      connector_instance_id: instanceId,
      created_at: NOW,
      enabled: true,
      interval_seconds: 900,
      jitter_seconds: 0,
      updated_at: "2026-08-11T00:03:00.000Z",
    });
    scheduler.updateSchedule(instanceId, {
      enabled: true,
      interval_seconds: 901,
      jitter_seconds: 0,
      updated_at: "2026-08-11T00:04:00.000Z",
    });
    assert.equal(sourceRevision(instanceId), MAX_SOURCE_REVISION);
    getDb()
      .prepare(
        "UPDATE connector_summary_evidence SET source_revision = ?, dirty = 0, state = 'fresh' WHERE connector_instance_id = ?"
      )
      .run(MAX_SOURCE_REVISION, instanceId);
    const exhausted = await getConnectorSummaryEvidence(instanceId);
    assert.ok(exhausted);
    assert.equal(exhausted.source_revision, MAX_SOURCE_REVISION);
    assert.equal(exhausted.dirty, true);
    assert.equal(exhausted.state, "stale");
    assert.equal(exhausted.list_summary_projection.reason_code, "canonical_source_revision_exhausted");
  }));

const POSTGRES_CONNECTOR_ID = "https://test.pdpp.dev/connectors/source-revision-pg";
const POSTGRES_INSTANCE_ID = "cin_source_revision_pg";
const POSTGRES_MANIFEST = { ...MANIFEST, connector_id: POSTGRES_CONNECTOR_ID };

async function postgresEvidence(): Promise<TestRow> {
  const result = await postgresQuery("SELECT * FROM connector_summary_evidence WHERE connector_instance_id = $1", [
    POSTGRES_INSTANCE_ID,
  ]);
  const row = result.rows[0] as TestRow | undefined;
  assert.ok(row, "PostgreSQL summary evidence exists");
  return row;
}

async function postgresSourceRevision(): Promise<string> {
  const result = await postgresQuery(
    "SELECT source_revision::text AS source_revision FROM connector_instances WHERE connector_instance_id = $1",
    [POSTGRES_INSTANCE_ID]
  );
  const row = result.rows[0] as { source_revision: string } | undefined;
  assert.ok(row, "the PostgreSQL source instance exists");
  return row.source_revision;
}

async function cleanupPostgresProbe(): Promise<void> {
  await postgresQuery("DELETE FROM controller_active_runs WHERE connector_instance_id = $1", [POSTGRES_INSTANCE_ID]);
  await postgresQuery("DELETE FROM connector_schedules WHERE connector_instance_id = $1", [POSTGRES_INSTANCE_ID]);
  await postgresQuery("DELETE FROM run_history WHERE connector_instance_id = $1", [POSTGRES_INSTANCE_ID]);
  await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [
    POSTGRES_INSTANCE_ID,
  ]);
  await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1", [POSTGRES_INSTANCE_ID]);
  await postgresQuery("DELETE FROM record_changes WHERE connector_instance_id = $1", [POSTGRES_INSTANCE_ID]);
  await postgresQuery("DELETE FROM version_counter WHERE connector_instance_id = $1", [POSTGRES_INSTANCE_ID]);
  await postgresQuery("DELETE FROM spine_events WHERE connector_instance_id = $1", [POSTGRES_INSTANCE_ID]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [POSTGRES_INSTANCE_ID]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [POSTGRES_CONNECTOR_ID]);
}

async function seedPostgresProbe(): Promise<void> {
  await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
    POSTGRES_CONNECTOR_ID,
    JSON.stringify(POSTGRES_MANIFEST),
    NOW,
  ]);
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES ($1, $2, $3, $4, 'active', 'account', $1, '{}'::jsonb, $5, $5, NULL)`,
    [POSTGRES_INSTANCE_ID, OWNER, POSTGRES_CONNECTOR_ID, POSTGRES_MANIFEST.display_name, NOW]
  );
}

async function withPostgres<T>(fn: () => Promise<T>): Promise<T> {
  assert.ok(POSTGRES_URL);
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  try {
    await cleanupPostgresProbe();
    await seedPostgresProbe();
    return await fn();
  } finally {
    await cleanupPostgresProbe();
    delete process.env.PDPP_TEST_REPAIR_FAILURE_MARKER_PATH;
    delete process.env.PDPP_TEST_REPAIR_FAILURE_RELEASE_PATH;
    await closePostgresStorage();
  }
}

async function installPostgresProjectionFault(): Promise<void> {
  await postgresQuery(`
    CREATE OR REPLACE FUNCTION pdpp_test_summary_projection_fault()
    RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      RAISE EXCEPTION 'review-fault';
    END;
    $function$;
    DROP TRIGGER IF EXISTS pdpp_test_summary_projection_fault ON connector_summary_evidence;
    CREATE TRIGGER pdpp_test_summary_projection_fault
      BEFORE UPDATE ON connector_summary_evidence
      FOR EACH ROW EXECUTE FUNCTION pdpp_test_summary_projection_fault();
  `);
}

async function removePostgresProjectionFault(): Promise<void> {
  await postgresQuery("DROP TRIGGER IF EXISTS pdpp_test_summary_projection_fault ON connector_summary_evidence");
  await postgresQuery("DROP FUNCTION IF EXISTS pdpp_test_summary_projection_fault()");
}

test("PostgreSQL projection faults preserve canonical record, schedule, and lifecycle writes, then repair passes after recovery", {
  skip: !POSTGRES_URL,
}, async () => {
  await withPostgres(async () => {
    await reconcileConnectorSummaryEvidence([POSTGRES_INSTANCE_ID]);
    await installPostgresProjectionFault();
    const before = await postgresSourceRevision();
    const scheduler = createPostgresSchedulerStore();
    await ingestRecord(
      { connector_id: POSTGRES_CONNECTOR_ID, connector_instance_id: POSTGRES_INSTANCE_ID },
      { data: { id: "pg-message-1" }, emitted_at: NOW, key: "pg-message-1", stream: STREAM },
      { deferIndexes: true }
    );
    await scheduler.createSchedule({
      connector_id: POSTGRES_CONNECTOR_ID,
      connector_instance_id: POSTGRES_INSTANCE_ID,
      created_at: NOW,
      enabled: true,
      interval_seconds: 900,
      jitter_seconds: 0,
      updated_at: "2026-08-11T00:01:00.000Z",
    });
    await emitSpineEvent({
      data: { connector_instance_id: POSTGRES_INSTANCE_ID },
      event_id: "evt_source_revision_fault_isolation_pg",
      event_type: "run.completed",
    });
    await recordCurrentGenerationUndeclaredWrite(
      { connector_id: POSTGRES_CONNECTOR_ID, connector_instance_id: POSTGRES_INSTANCE_ID },
      { provenance: "source-revision-fault-test", stream: "undeclared-stream" }
    );
    const recordCount = (
      await postgresQuery("SELECT COUNT(*)::int AS count FROM records WHERE connector_instance_id = $1", [
        POSTGRES_INSTANCE_ID,
      ])
    ).rows[0] as { count: number } | undefined;
    const scheduleCount = (
      await postgresQuery("SELECT COUNT(*)::int AS count FROM connector_schedules WHERE connector_instance_id = $1", [
        POSTGRES_INSTANCE_ID,
      ])
    ).rows[0] as { count: number } | undefined;
    const lifecycleCount = (
      await postgresQuery("SELECT COUNT(*)::int AS count FROM spine_events WHERE event_id = $1", [
        "evt_source_revision_fault_isolation_pg",
      ])
    ).rows[0] as { count: number } | undefined;
    const violationCount = (
      await postgresQuery(
        "SELECT COUNT(*)::int AS count FROM manifest_write_violations WHERE connector_instance_id = $1",
        [POSTGRES_INSTANCE_ID]
      )
    ).rows[0] as { count: number } | undefined;
    assert.equal(recordCount?.count, 1);
    assert.equal(scheduleCount?.count, 1);
    assert.equal(lifecycleCount?.count, 1);
    assert.equal(violationCount?.count, 1);
    assert.notEqual(await postgresSourceRevision(), before);
    const failed = await reconcileConnectorSummaryEvidence([POSTGRES_INSTANCE_ID]);
    assert.equal(failed.failed, 1);
    await removePostgresProjectionFault();
    const passed = await reconcileConnectorSummaryEvidence([POSTGRES_INSTANCE_ID]);
    assert.equal(passed.failed, 0);
    const repaired = await postgresEvidence();
    assert.equal(Number(repaired.total_records), 1);
    assert.equal(repaired.dirty, 0);
    assert.equal(repaired.state, "fresh");
  });
});

test("PostgreSQL stale failure publication cannot overwrite newer evidence", {
  skip: !POSTGRES_URL,
}, async () => {
  await withPostgres(async () => {
    await reconcileConnectorSummaryEvidence([POSTGRES_INSTANCE_ID]);
    assert.ok(POSTGRES_URL);
    const childAttachment = await createAlreadyAdmittedTestDatabaseChildAttachment(POSTGRES_URL);
    await installPostgresProjectionFault();
    await ingestRecord(
      { connector_id: POSTGRES_CONNECTOR_ID, connector_instance_id: POSTGRES_INSTANCE_ID },
      { data: { id: "pg-stale-failure-message" }, emitted_at: NOW, key: "pg-stale-failure-message", stream: STREAM },
      { deferIndexes: true }
    );

    const directory = mkdtempSync(join(tmpdir(), "pdpp-summary-pg-stale-failure-"));
    const markerPath = join(directory, "failure.paused");
    const releasePath = join(directory, "failure.release");
    process.env.PDPP_TEST_REPAIR_FAILURE_MARKER_PATH = markerPath;
    process.env.PDPP_TEST_REPAIR_FAILURE_RELEASE_PATH = releasePath;
    const fixture = spawnFailureFixture(null, POSTGRES_INSTANCE_ID, POSTGRES_URL ?? undefined, childAttachment);
    try {
      assert.equal(JSON.parse(await fixture.nextLine()).ready, true);
      fixture.child.stdin?.write("go\n");
      await waitForFile(markerPath, 15_000);

      await removePostgresProjectionFault();
      const scheduler = createPostgresSchedulerStore();
      await scheduler.createSchedule({
        connector_id: POSTGRES_CONNECTOR_ID,
        connector_instance_id: POSTGRES_INSTANCE_ID,
        created_at: NOW,
        enabled: true,
        interval_seconds: 900,
        jitter_seconds: 0,
        updated_at: "2026-08-11T00:06:00.000Z",
      });
      const newer = await reconcileConnectorSummaryEvidence([POSTGRES_INSTANCE_ID]);
      assert.equal(newer.failed, 0);
      assert.equal((await postgresEvidence()).dirty, 0);
      assert.equal((await postgresEvidence()).state, "fresh");

      writeFileSync(releasePath, "release\n", "utf8");
      const staleFailure = JSON.parse(await fixture.nextLine());
      assert.equal(staleFailure.result.failed, 1);
      assert.equal(await fixture.exitCode, 0);
      assert.equal((await postgresEvidence()).dirty, 0, "the old failure did not overwrite newer evidence");
      assert.equal((await postgresEvidence()).state, "fresh");

      await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [POSTGRES_INSTANCE_ID]);
      let recreated = false;
      __setConnectorInstanceWritePhaseHookForTest(async (stage, context) => {
        if (stage === "before_key_acquire" && context.connectorInstanceId === POSTGRES_INSTANCE_ID && !recreated) {
          recreated = true;
          await postgresQuery(
            `INSERT INTO connector_instances(
               connector_instance_id, owner_subject_id, connector_id, display_name, status,
               source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
             ) VALUES ($1, $2, $3, $4, 'active', 'account', $1, '{}'::jsonb, $5, $5, NULL)`,
            [POSTGRES_INSTANCE_ID, OWNER, POSTGRES_CONNECTOR_ID, POSTGRES_MANIFEST.display_name, NOW]
          );
        }
      });
      try {
        await reconcileConnectorSummaryEvidence([POSTGRES_INSTANCE_ID]);
      } finally {
        __setConnectorInstanceWritePhaseHookForTest(null);
      }
      assert.equal(recreated, true);
      assert.ok(await postgresEvidence(), "a reused connector instance keeps its evidence");

      await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [POSTGRES_INSTANCE_ID]);
      const deleted = await reconcileConnectorSummaryEvidence([POSTGRES_INSTANCE_ID]);
      assert.equal(deleted.repaired, 1);
      const remaining = await postgresQuery(
        "SELECT COUNT(*)::int AS count FROM connector_summary_evidence WHERE connector_instance_id = $1",
        [POSTGRES_INSTANCE_ID]
      );
      assert.equal((remaining.rows[0] as { count: number }).count, 0);
    } finally {
      await removePostgresProjectionFault();
      writeFileSync(releasePath, "release\n", "utf8");
      fixture.lines.close();
      if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
        fixture.child.kill("SIGKILL");
      }
      delete process.env.PDPP_TEST_REPAIR_FAILURE_MARKER_PATH;
      delete process.env.PDPP_TEST_REPAIR_FAILURE_RELEASE_PATH;
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

test("PostgreSQL trigger omission fails before migration and a live writer waits for the atomic reinstall", {
  skip: !POSTGRES_URL,
}, async () => {
  await withPostgres(async () => {
    await reconcileConnectorSummaryEvidence([POSTGRES_INSTANCE_ID]);
    const scheduler = createPostgresSchedulerStore();
    await postgresQuery("DROP TRIGGER IF EXISTS pdpp_source_revision_connector_schedules ON connector_schedules");
    const beforeOmission = await postgresSourceRevision();
    await scheduler.createSchedule({
      connector_id: POSTGRES_CONNECTOR_ID,
      connector_instance_id: POSTGRES_INSTANCE_ID,
      created_at: NOW,
      enabled: true,
      interval_seconds: 900,
      jitter_seconds: 0,
      updated_at: "2026-08-11T00:01:00.000Z",
    });
    assert.equal(await postgresSourceRevision(), beforeOmission);

    const directory = mkdtempSync(join(tmpdir(), "pdpp-summary-postgres-install-lock-"));
    const markerPath = join(directory, "install.locked");
    const postgresUrl = POSTGRES_URL;
    assert.ok(postgresUrl);
    const writerPool = new Pool({ connectionString: postgresUrl });
    process.env.PDPP_TEST_SOURCE_REVISION_INSTALL_LOCK_PATH = markerPath;
    try {
      const writer = (async () => {
        await waitForFile(markerPath, 15_000);
        await writerPool.query("UPDATE connector_schedules SET updated_at = $1 WHERE connector_instance_id = $2", [
          "2026-08-11T00:02:00.000Z",
          POSTGRES_INSTANCE_ID,
        ]);
      })();
      const bootstrap = initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl });
      await writer;
      await bootstrap;
      assert.notEqual(await postgresSourceRevision(), beforeOmission);
      assert.equal((await postgresEvidence()).dirty, 0, "a disposable projection barrier cannot block installation");
      await reconcileConnectorSummaryEvidence([POSTGRES_INSTANCE_ID]);
      assert.equal((await postgresEvidence()).dirty, 0);
    } finally {
      delete process.env.PDPP_TEST_SOURCE_REVISION_INSTALL_LOCK_PATH;
      await writerPool.end();
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

test("PostgreSQL manifest receipt changes once and BIGINT exhaustion remains canonical", {
  skip: !POSTGRES_URL,
}, async () => {
  await withPostgres(async () => {
    await reconcileConnectorSummaryEvidence([POSTGRES_INSTANCE_ID]);
    const beforeManifest = BigInt(await postgresSourceRevision());
    await postgresQuery("UPDATE connectors SET manifest = manifest WHERE connector_id = $1", [POSTGRES_CONNECTOR_ID]);
    assert.equal(BigInt(await postgresSourceRevision()) - beforeManifest, 1n);

    await postgresQuery(
      "UPDATE connector_instances SET source_revision = $1::bigint WHERE connector_instance_id = $2",
      [MAX_SOURCE_REVISION, POSTGRES_INSTANCE_ID]
    );
    const scheduler = createPostgresSchedulerStore();
    await scheduler.createSchedule({
      connector_id: POSTGRES_CONNECTOR_ID,
      connector_instance_id: POSTGRES_INSTANCE_ID,
      created_at: NOW,
      enabled: true,
      interval_seconds: 900,
      jitter_seconds: 0,
      updated_at: "2026-08-11T00:03:00.000Z",
    });
    await scheduler.updateSchedule(POSTGRES_INSTANCE_ID, {
      enabled: true,
      interval_seconds: 901,
      jitter_seconds: 0,
      updated_at: "2026-08-11T00:04:00.000Z",
    });
    assert.equal(await postgresSourceRevision(), MAX_SOURCE_REVISION);
    await postgresQuery(
      "UPDATE connector_summary_evidence SET source_revision = $1::bigint, dirty = 0, state = 'fresh' WHERE connector_instance_id = $2",
      [MAX_SOURCE_REVISION, POSTGRES_INSTANCE_ID]
    );
    const rendered = await getConnectorSummaryEvidence(POSTGRES_INSTANCE_ID);
    assert.ok(rendered);
    assert.equal(rendered.source_revision, MAX_SOURCE_REVISION);
    assert.equal(rendered.dirty, true);
    assert.equal(rendered.state, "stale");
    assert.equal(rendered.list_summary_projection.reason_code, "canonical_source_revision_exhausted");
  });
});
