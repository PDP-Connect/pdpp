// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-revision conformance for summary maintenance.
 *
 * The repair build deliberately runs without the instance writer fence. These
 * tests pause after that build, perform a real production mutation, and then
 * release the publish. The old pre-revision design could publish the stale
 * build; the source-revision primitive must leave the row stale and let the
 * next pass converge it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import {
  __setConnectorSummaryEvidenceRepairPhaseHookForTest,
  reconcileConnectorSummaryEvidence,
} from "../server/connector-summary-evidence-engine.ts";
import { getConnectorSummaryEvidence } from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { ingestRecord } from "../server/records.ts";
import { createPostgresSchedulerStore, createSqliteSchedulerStore } from "../server/stores/scheduler-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const OWNER = "owner_local";
const NOW = "2026-08-11T00:00:00.000Z";
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/source-revision";
const STREAM = "messages";
const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const DECIMAL_TEXT_RE = /^\d+$/;

const MANIFEST = {
  capabilities: { public_listing: { listed: true, status: "test" } },
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
    __setConnectorSummaryEvidenceRepairPhaseHookForTest(null);
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

function evidence(connectorInstanceId: string): Record<string, any> {
  const row = getDb()
    .prepare("SELECT * FROM connector_summary_evidence WHERE connector_instance_id = ?")
    .get(connectorInstanceId) as Record<string, any> | undefined;
  assert.ok(row, "summary evidence exists");
  return row;
}

async function warmEvidence(connectorInstanceId: string): Promise<void> {
  const result = await reconcileConnectorSummaryEvidence([connectorInstanceId]);
  assert.equal(result.repaired, 1, "the initial repair creates a fresh evidence row");
  assert.equal(evidence(connectorInstanceId).dirty, 0);
}

async function runPausedRepair(
  connectorInstanceId: string,
  mutation: () => Promise<void> | void
): Promise<Awaited<ReturnType<typeof reconcileConnectorSummaryEvidence>>> {
  getDb()
    .prepare("UPDATE connector_summary_evidence SET dirty = 1, state = 'stale' WHERE connector_instance_id = ?")
    .run(connectorInstanceId);
  let builtResolve!: () => void;
  const built = new Promise<void>((resolve) => {
    builtResolve = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paused = false;
  __setConnectorSummaryEvidenceRepairPhaseHookForTest(async (phase, currentInstanceId) => {
    if (phase === "after_build_before_publish" && currentInstanceId === connectorInstanceId && !paused) {
      paused = true;
      builtResolve();
      await released;
    }
  });

  const repair = reconcileConnectorSummaryEvidence([connectorInstanceId]);
  await built;
  await mutation();
  release();
  const result = await repair;
  __setConnectorSummaryEvidenceRepairPhaseHookForTest(null);
  return result;
}

function markEvidenceCleanForProbe(connectorInstanceId: string): void {
  getDb()
    .prepare("UPDATE connector_summary_evidence SET dirty = 0, state = 'fresh' WHERE connector_instance_id = ?")
    .run(connectorInstanceId);
}

test("records production writer cannot publish a build captured before ingest", () =>
  withSqlite(async () => {
    const instanceId = "cin_source_revision_records";
    seedConnectorAndInstance(instanceId);
    await warmEvidence(instanceId);
    const before = sourceRevision(instanceId);

    const result = await runPausedRepair(instanceId, async () => {
      await ingestRecord(storageTarget(instanceId), {
        data: { id: "message-1" },
        emitted_at: NOW,
        key: "message-1",
        stream: STREAM,
      });
    });

    assert.equal(result.repaired, 0, "the candidate is deferred after the source moves");
    const afterRace = evidence(instanceId);
    assert.equal(afterRace.dirty, 1);
    assert.equal(afterRace.state, "stale");
    assert.notEqual(sourceRevision(instanceId), before);
    assert.equal(afterRace.total_records, 0, "the pre-ingest build was not published");

    await reconcileConnectorSummaryEvidence([instanceId]);
    assert.equal(evidence(instanceId).total_records, 1, "the next pass converges the record mutation");
    assert.equal(evidence(instanceId).dirty, 0);
  }));

test("schedule production writer cannot publish a build captured before schedule creation", () =>
  withSqlite(async () => {
    const instanceId = "cin_source_revision_schedule";
    seedConnectorAndInstance(instanceId);
    await warmEvidence(instanceId);
    const before = sourceRevision(instanceId);
    const scheduler = createSqliteSchedulerStore();

    const result = await runPausedRepair(instanceId, () => {
      scheduler.createSchedule({
        connector_id: CONNECTOR_ID,
        connector_instance_id: instanceId,
        created_at: NOW,
        enabled: true,
        interval_seconds: 900,
        jitter_seconds: 0,
        updated_at: "2026-08-11T00:01:00.000Z",
      });
    });

    assert.equal(result.repaired, 0);
    assert.equal(evidence(instanceId).dirty, 1);
    assert.equal(evidence(instanceId).state, "stale");
    assert.notEqual(sourceRevision(instanceId), before);
    await reconcileConnectorSummaryEvidence([instanceId]);
    assert.equal(evidence(instanceId).schedule_checkpoint, "2026-08-11T00:01:00.000Z");
    assert.equal(evidence(instanceId).dirty, 0);
  }));

test("manifest production writer cannot publish a build captured before manifest refresh", () =>
  withSqlite(async () => {
    const instanceId = "cin_source_revision_manifest";
    seedConnectorAndInstance(instanceId);
    await warmEvidence(instanceId);
    const before = sourceRevision(instanceId);
    const refreshedManifest = { ...MANIFEST, display_name: "Source Revision Probe v2", version: "2.0.0" };

    const result = await runPausedRepair(instanceId, async () => {
      await registerConnector(refreshedManifest, { backfillRetrievalIndexes: false });
    });

    assert.equal(result.repaired, 0);
    assert.equal(evidence(instanceId).dirty, 1);
    assert.equal(evidence(instanceId).state, "stale");
    assert.notEqual(sourceRevision(instanceId), before);
    await reconcileConnectorSummaryEvidence([instanceId]);
    assert.equal(evidence(instanceId).dirty, 0);
    assert.equal(evidence(instanceId).state, "fresh");
  }));

test("active-run production writer defers a clean candidate and persists dirty/stale", () =>
  withSqlite(async () => {
    const instanceId = "cin_source_revision_active_run";
    seedConnectorAndInstance(instanceId);
    await warmEvidence(instanceId);
    const scheduler = createSqliteSchedulerStore();
    const accepted = scheduler.upsertActiveRun({
      connector_id: CONNECTOR_ID,
      connector_instance_id: instanceId,
      run_generation: 1,
      run_id: "run_source_revision_active",
      scenario_id: "source-revision-test",
      started_at: NOW,
      trace_id: "trace_source_revision_active",
    });
    assert.equal(accepted, true);
    markEvidenceCleanForProbe(instanceId);

    const result = await reconcileConnectorSummaryEvidence([instanceId]);
    assert.equal(result.repaired, 0, "the active run is deferred");
    assert.equal(evidence(instanceId).dirty, 1);
    assert.equal(evidence(instanceId).state, "stale");

    scheduler.deleteActiveRun(instanceId, "run_source_revision_active");
    await reconcileConnectorSummaryEvidence([instanceId]);
    assert.equal(evidence(instanceId).dirty, 0, "the candidate converges after the active run ends");
  }));

test("A→B→A schedule writes still invalidate the candidate because the receipt never reuses a revision", () =>
  withSqlite(async () => {
    const instanceId = "cin_source_revision_aba";
    seedConnectorAndInstance(instanceId);
    const scheduler = createSqliteSchedulerStore();
    scheduler.createSchedule({
      connector_id: CONNECTOR_ID,
      connector_instance_id: instanceId,
      created_at: NOW,
      enabled: true,
      interval_seconds: 900,
      jitter_seconds: 0,
      updated_at: "2026-08-11T00:01:00.000Z",
    });
    await warmEvidence(instanceId);
    const evidenceRevision = evidence(instanceId).source_revision;
    const before = sourceRevision(instanceId);

    const result = await runPausedRepair(instanceId, () => {
      scheduler.updateSchedule(instanceId, {
        enabled: true,
        interval_seconds: 901,
        jitter_seconds: 0,
        updated_at: "2026-08-11T00:02:00.000Z",
      });
      scheduler.updateSchedule(instanceId, {
        enabled: true,
        interval_seconds: 900,
        jitter_seconds: 0,
        updated_at: "2026-08-11T00:01:00.000Z",
      });
    });

    assert.equal(result.repaired, 0, "the stale build is rejected even though the schedule returned to A");
    assert.equal(evidence(instanceId).dirty, 1);
    assert.notEqual(sourceRevision(instanceId), before);
    assert.notEqual(String(evidence(instanceId).source_revision), sourceRevision(instanceId));
    assert.notEqual(String(evidenceRevision), sourceRevision(instanceId));
    await reconcileConnectorSummaryEvidence([instanceId]);
    assert.equal(evidence(instanceId).dirty, 0);
    assert.equal(String(evidence(instanceId).source_revision), sourceRevision(instanceId));
  }));

test("a clean candidate with an active run is detected from source revision and stays stale until the run ends", () =>
  withSqlite(async () => {
    const instanceId = "cin_source_revision_clean_deferred";
    seedConnectorAndInstance(instanceId);
    await warmEvidence(instanceId);
    const scheduler = createSqliteSchedulerStore();
    assert.equal(
      scheduler.upsertActiveRun({
        connector_id: CONNECTOR_ID,
        connector_instance_id: instanceId,
        run_generation: 1,
        run_id: "run_source_revision_deferred",
        scenario_id: "source-revision-test",
        started_at: NOW,
        trace_id: "trace_source_revision_deferred",
      }),
      true
    );
    // Model a lost best-effort dirty marker. The source receipt remains newer
    // than the row, while the active run makes the build intentionally defer.
    markEvidenceCleanForProbe(instanceId);

    const result = await reconcileConnectorSummaryEvidence([instanceId]);
    assert.equal(result.repaired, 0);
    assert.equal(evidence(instanceId).dirty, 1);
    assert.equal(evidence(instanceId).state, "stale");

    scheduler.deleteActiveRun(instanceId, "run_source_revision_deferred");
    await reconcileConnectorSummaryEvidence([instanceId]);
    assert.equal(evidence(instanceId).dirty, 0);
  }));

test("source revisions are isolated per connector instance", () =>
  withSqlite(async () => {
    const firstInstanceId = "cin_source_revision_isolation_a";
    const secondInstanceId = "cin_source_revision_isolation_b";
    seedConnectorAndInstance(firstInstanceId);
    // The connector row is shared by design; only the instance receipt must
    // move for the instance whose canonical records changed.
    getDb()
      .prepare(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
      )
      .run(secondInstanceId, OWNER, CONNECTOR_ID, MANIFEST.display_name, secondInstanceId, NOW, NOW);
    await reconcileConnectorSummaryEvidence([firstInstanceId, secondInstanceId]);
    const firstBefore = sourceRevision(firstInstanceId);
    const secondBefore = { revision: sourceRevision(secondInstanceId), row: evidence(secondInstanceId) };

    await ingestRecord(storageTarget(firstInstanceId), {
      data: { id: "isolated-message" },
      emitted_at: NOW,
      key: "isolated-message",
      stream: STREAM,
    });
    await reconcileConnectorSummaryEvidence([firstInstanceId]);

    assert.notEqual(sourceRevision(firstInstanceId), firstBefore);
    assert.equal(String(evidence(firstInstanceId).source_revision), sourceRevision(firstInstanceId));
    assert.equal(sourceRevision(secondInstanceId), secondBefore.revision);
    assert.equal(evidence(secondInstanceId).source_revision, secondBefore.row.source_revision);
    assert.equal(evidence(secondInstanceId).dirty, 0);
  }));

test("legacy evidence without source_revision renders stale on migration and converges", () =>
  withSqlite(async (databasePath) => {
    const instanceId = "cin_source_revision_legacy";
    seedConnectorAndInstance(instanceId);
    await warmEvidence(instanceId);

    // Recreate the relevant legacy condition without depending on a separate
    // historical database fixture: an old SQLite table had no source_revision
    // column. The next initDb migration adds it as NULL and marks the row stale.
    getDb().exec("ALTER TABLE connector_summary_evidence DROP COLUMN source_revision");
    closeDb();
    initDb(databasePath);
    const migrated = evidence(instanceId);
    assert.equal(migrated.source_revision, null, "legacy evidence has an unknown receipt immediately after migration");
    assert.equal(migrated.dirty, 1);
    assert.equal(migrated.state, "stale");
    const rendered = await getConnectorSummaryEvidence(instanceId);
    assert.equal(rendered?.source_revision, null);
    assert.equal(rendered?.dirty, true);
    assert.equal(rendered?.state, "stale");

    await reconcileConnectorSummaryEvidence([instanceId]);
    const converged = evidence(instanceId);
    assert.match(String(converged.source_revision), DECIMAL_TEXT_RE);
    assert.equal(converged.dirty, 0);
    assert.equal(converged.state, "fresh");
  }));

const POSTGRES_CONNECTOR_ID = "https://test.pdpp.dev/connectors/source-revision-pg";
const POSTGRES_INSTANCE_ID = "cin_source_revision_pg";
const POSTGRES_MANIFEST = { ...MANIFEST, connector_id: POSTGRES_CONNECTOR_ID };

async function postgresEvidence(): Promise<Record<string, any>> {
  const result = await postgresQuery("SELECT * FROM connector_summary_evidence WHERE connector_instance_id = $1", [
    POSTGRES_INSTANCE_ID,
  ]);
  const row = result.rows[0] as Record<string, any> | undefined;
  assert.ok(row, "Postgres summary evidence exists");
  return row;
}

async function postgresSourceRevision(): Promise<string> {
  const result = await postgresQuery(
    "SELECT source_revision::text AS source_revision FROM connector_instances WHERE connector_instance_id = $1",
    [POSTGRES_INSTANCE_ID]
  );
  const row = result.rows[0] as { source_revision: string } | undefined;
  assert.ok(row, "the Postgres source instance exists");
  return row.source_revision;
}

async function cleanupPostgresSourceRevisionProbe(): Promise<void> {
  await postgresQuery("DELETE FROM controller_active_runs WHERE connector_instance_id = $1", [POSTGRES_INSTANCE_ID]);
  await postgresQuery("DELETE FROM connector_schedules WHERE connector_instance_id = $1", [POSTGRES_INSTANCE_ID]);
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

async function seedPostgresSourceRevisionProbe(): Promise<void> {
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

async function runPausedPostgresRepair(
  mutation: () => Promise<void>
): Promise<Awaited<ReturnType<typeof reconcileConnectorSummaryEvidence>>> {
  await postgresQuery(
    "UPDATE connector_summary_evidence SET dirty = 1, state = 'stale' WHERE connector_instance_id = $1",
    [POSTGRES_INSTANCE_ID]
  );
  let builtResolve!: () => void;
  const built = new Promise<void>((resolve) => {
    builtResolve = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paused = false;
  __setConnectorSummaryEvidenceRepairPhaseHookForTest(async (phase, connectorInstanceId) => {
    if (phase === "after_build_before_publish" && connectorInstanceId === POSTGRES_INSTANCE_ID && !paused) {
      paused = true;
      builtResolve();
      await released;
    }
  });
  try {
    const repair = reconcileConnectorSummaryEvidence([POSTGRES_INSTANCE_ID]);
    await built;
    await mutation();
    release();
    return await repair;
  } finally {
    __setConnectorSummaryEvidenceRepairPhaseHookForTest(null);
  }
}

test("PostgreSQL production writers advance the receipt and reject pre-writer builds", {
  skip: !POSTGRES_URL,
}, async () => {
  if (!POSTGRES_URL) {
    return;
  }
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  try {
    await cleanupPostgresSourceRevisionProbe();
    await seedPostgresSourceRevisionProbe();
    const initial = await reconcileConnectorSummaryEvidence([POSTGRES_INSTANCE_ID]);
    assert.equal(initial.repaired, 1);

    const beforeRecord = await postgresSourceRevision();
    const recordRace = await runPausedPostgresRepair(async () => {
      await ingestRecord(
        { connector_id: POSTGRES_CONNECTOR_ID, connector_instance_id: POSTGRES_INSTANCE_ID },
        { data: { id: "pg-message-1" }, emitted_at: NOW, key: "pg-message-1", stream: STREAM }
      );
    });
    assert.equal(recordRace.repaired, 0);
    assert.equal((await postgresEvidence()).dirty, 1);
    assert.notEqual(await postgresSourceRevision(), beforeRecord);
    await reconcileConnectorSummaryEvidence([POSTGRES_INSTANCE_ID]);

    const scheduler = createPostgresSchedulerStore();
    const beforeSchedule = await postgresSourceRevision();
    const scheduleRace = await runPausedPostgresRepair(async () => {
      await scheduler.createSchedule({
        connector_id: POSTGRES_CONNECTOR_ID,
        connector_instance_id: POSTGRES_INSTANCE_ID,
        created_at: NOW,
        enabled: true,
        interval_seconds: 900,
        jitter_seconds: 0,
        updated_at: "2026-08-11T00:01:00.000Z",
      });
    });
    assert.equal(scheduleRace.repaired, 0);
    assert.equal((await postgresEvidence()).state, "stale");
    assert.notEqual(await postgresSourceRevision(), beforeSchedule);
    await reconcileConnectorSummaryEvidence([POSTGRES_INSTANCE_ID]);

    const beforeAba = await postgresSourceRevision();
    const abaRace = await runPausedPostgresRepair(async () => {
      await scheduler.updateSchedule(POSTGRES_INSTANCE_ID, {
        enabled: true,
        interval_seconds: 901,
        jitter_seconds: 0,
        updated_at: "2026-08-11T00:02:00.000Z",
      });
      await scheduler.updateSchedule(POSTGRES_INSTANCE_ID, {
        enabled: true,
        interval_seconds: 900,
        jitter_seconds: 0,
        updated_at: "2026-08-11T00:01:00.000Z",
      });
    });
    assert.equal(abaRace.repaired, 0);
    assert.equal((await postgresEvidence()).dirty, 1);
    assert.notEqual(await postgresSourceRevision(), beforeAba);
    await reconcileConnectorSummaryEvidence([POSTGRES_INSTANCE_ID]);

    const beforeManifest = await postgresSourceRevision();
    const manifestRace = await runPausedPostgresRepair(async () => {
      await registerConnector(
        { ...POSTGRES_MANIFEST, display_name: "Source Revision Probe PG v2", version: "2.0.0" },
        { backfillRetrievalIndexes: false }
      );
    });
    assert.equal(manifestRace.repaired, 0);
    assert.equal((await postgresEvidence()).dirty, 1);
    assert.notEqual(await postgresSourceRevision(), beforeManifest);
    await reconcileConnectorSummaryEvidence([POSTGRES_INSTANCE_ID]);

    assert.equal(
      await scheduler.upsertActiveRun({
        connector_id: POSTGRES_CONNECTOR_ID,
        connector_instance_id: POSTGRES_INSTANCE_ID,
        run_generation: 1,
        run_id: "run_source_revision_pg",
        scenario_id: "source-revision-test",
        started_at: NOW,
        trace_id: "trace_source_revision_pg",
      }),
      true
    );
    await postgresQuery(
      "UPDATE connector_summary_evidence SET dirty = 0, state = 'fresh' WHERE connector_instance_id = $1",
      [POSTGRES_INSTANCE_ID]
    );
    const deferred = await reconcileConnectorSummaryEvidence([POSTGRES_INSTANCE_ID]);
    assert.equal(deferred.repaired, 0);
    assert.equal((await postgresEvidence()).state, "stale");
    await scheduler.deleteActiveRun(POSTGRES_INSTANCE_ID, "run_source_revision_pg");
    await reconcileConnectorSummaryEvidence([POSTGRES_INSTANCE_ID]);
    assert.equal((await postgresEvidence()).dirty, 0);

    await postgresQuery(
      "UPDATE connector_summary_evidence SET source_revision = NULL, dirty = 0, state = 'fresh' WHERE connector_instance_id = $1",
      [POSTGRES_INSTANCE_ID]
    );
    const legacyRendered = await getConnectorSummaryEvidence(POSTGRES_INSTANCE_ID);
    assert.equal(legacyRendered?.source_revision, null);
    assert.equal(legacyRendered?.dirty, true);
    assert.equal(legacyRendered?.state, "stale");
    await reconcileConnectorSummaryEvidence([POSTGRES_INSTANCE_ID]);
    const converged = await postgresEvidence();
    assert.match(String(converged.source_revision), DECIMAL_TEXT_RE);
    assert.equal(converged.dirty, 0);
  } finally {
    await cleanupPostgresSourceRevisionProbe();
    await closePostgresStorage();
  }
});
