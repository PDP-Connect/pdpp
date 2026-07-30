// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Terminal-gate re-revision (2026-07-29): the second gate's P0 required
 * eliminating post-hoc best-effort dirty transitions for EVERY
 * summary-governing mutation family, not just connector-instance status/
 * display-name. For schedule mutations and run-lifecycle events, the smaller
 * correct fix — per the gate's own explicit instruction — is NOT a new
 * parallel outbox: `connector_schedules.updated_at` and
 * `spine_events.event_seq` are already durable, transactionally-committed
 * signals written atomically with their governing mutation on both backends.
 * This file proves the maintenance sweep (`reconcileConnectorSummaryEvidence`
 * / `classifyCandidate`'s new `schedule_mismatch`/`lifecycle_checkpoint_lag`
 * reasons, server/connector-summary-evidence-engine.ts) now compares the
 * evidence row's stored checkpoint against these live signals and repairs
 * the drift — SO a swallowed/never-fired best-effort dirty mark for a
 * schedule pause/resume/delete/upsert or a run-lifecycle event (e.g.
 * `run.started`) cannot PERMANENTLY lose that transition: the next
 * maintenance-sweep pass (periodic or startup) still detects and repairs it,
 * with no dependency on the dirty flag ever having fired at all.
 *
 * Each test explicitly simulates "the dirty marker was swallowed" by NEVER
 * calling `markConnectorSummaryEvidenceDirty`/`markAllConnectorSummaryEvidenceDirty`
 * for the mutation under test — the row's `dirty` flag stays 0 throughout —
 * and instead only mutates the canonical table directly, then proves
 * `reconcileConnectorSummaryEvidence` still detects and repairs the drift on
 * its own, purely from the durable checkpoint comparison.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import {
  getConnectorSummaryEvidence,
  rebuildConnectorSummaryEvidence,
} from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  isPostgresStorageBackend,
  postgresQuery,
} from "../server/postgres-storage.ts";
import { invalidateConnectorSummariesCache } from "../server/ref-control.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const OWNER = "owner_local";
const NOW = "2026-07-29T00:00:00.000Z";
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/schedule-lifecycle-checkpoint";
const INSTANCE_ID = "cin_schedule_lifecycle_checkpoint";
const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

function requirePostgresUrl(): string {
  assert.ok(POSTGRES_URL, "PDPP_TEST_POSTGRES_URL is required for this test");
  return POSTGRES_URL;
}

const MANIFEST = {
  capabilities: { public_listing: { listed: true, status: "test" } },
  connector_id: CONNECTOR_ID,
  display_name: "Schedule/Lifecycle Checkpoint Probe",
  protocol_version: "0.1.0",
  streams: [{ name: "messages", primary_key: ["id"] }],
  version: "1.0.0",
};
const MANIFEST_JSON = JSON.stringify(MANIFEST);

async function withSqlite(fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-schedule-lifecycle-checkpoint-"));
  const databasePath = join(dir, "pdpp.sqlite");
  invalidateConnectorSummariesCache();
  initDb(databasePath);
  try {
    await fn();
  } finally {
    invalidateConnectorSummariesCache();
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

async function withPostgres(fn: () => Promise<void>): Promise<void> {
  await initPostgresStorage({ backend: "postgres", databaseUrl: requirePostgresUrl() });
  try {
    await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM connector_schedules WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM spine_events WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
    invalidateConnectorSummariesCache();
    await fn();
  } finally {
    await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM connector_schedules WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM spine_events WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [INSTANCE_ID]);
    await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
    invalidateConnectorSummariesCache();
    await closePostgresStorage();
  }
}

function seedConnectorAndInstanceSqlite(): void {
  const db = getDb();
  db.prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)").run(
    CONNECTOR_ID,
    MANIFEST_JSON,
    NOW
  );
  db.prepare(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
  ).run(INSTANCE_ID, OWNER, CONNECTOR_ID, "Schedule/Lifecycle Checkpoint Probe", INSTANCE_ID, NOW, NOW);
}

async function seedConnectorAndInstancePostgres(): Promise<void> {
  await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
    CONNECTOR_ID,
    MANIFEST_JSON,
    NOW,
  ]);
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES($1, $2, $3, $4, 'active', 'account', $1, '{}'::jsonb, $5, $5, NULL)`,
    [INSTANCE_ID, OWNER, CONNECTOR_ID, "Schedule/Lifecycle Checkpoint Probe", NOW]
  );
}

async function requireEvidence(): Promise<Record<string, unknown>> {
  const evidence = await getConnectorSummaryEvidence(INSTANCE_ID);
  if (evidence === null) {
    throw new TypeError(`Expected summary evidence for ${INSTANCE_ID}`);
  }
  return evidence as unknown as Record<string, unknown>;
}

/**
 * The Postgres test lane shares one long-lived disposable database across
 * every test FILE in the suite (`pdpp_test`). Seeding and converging a
 * terminal event for THIS connection gives the lifecycle checkpoint a stable
 * local baseline before this file advances it again.
 *
 * Convergence requires `rebuildConnectorSummaryEvidence` (the full
 * maintenance-sweep entry point, which folds terminal facts via
 * `foldConnectorSummaryStreamFacts` in ADDITION to the repair engine's own
 * `reconcileConnectorSummaryEvidence`) — the repair engine alone advances
 * `stream_facts_event_seq` only through the fold, never on its own, by
 * design (component independence: a record-snapshot repair must never
 * launder a failed/pending terminal fold). One rebuild pass is enough here
 * since this connection's own terminal high-water is exactly the event just
 * inserted.
 */
async function seedAndConvergeTerminalEventPostgres(): Promise<void> {
  const nextSeq = await postgresQuery("SELECT COALESCE(MAX(event_seq), 0) + 1 AS next_seq FROM spine_events");
  const eventSeq = Number((nextSeq.rows[0] as { next_seq: number }).next_seq);
  await postgresQuery(
    `INSERT INTO spine_events(
       event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
       actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
     ) VALUES($1, $2, 'run.completed', $3, $3, 'test', $4, 'runtime', 'test-connector', 'run', $5, 'succeeded', $5, $6, $7::jsonb, '1')`,
    [
      `evt_seed_terminal_${eventSeq}`,
      eventSeq,
      NOW,
      `trace_seed_terminal_${eventSeq}`,
      `run_seed_terminal_${eventSeq}`,
      INSTANCE_ID,
      JSON.stringify({
        collection_facts: { reference_only: true, schema_version: 1, streams: [] },
        connection_id: INSTANCE_ID,
        connector_instance_id: INSTANCE_ID,
      }),
    ]
  );
  await rebuildConnectorSummaryEvidence();
}

test("SQLite: a schedule mutation with a swallowed dirty marker is still detected and repaired via connector_schedules.updated_at", () =>
  withSqlite(async () => {
    seedConnectorAndInstanceSqlite();
    // First maintenance pass: no schedule row yet, converges the row to
    // schedule_checkpoint = 'absent'.
    await reconcileConnectorSummaryEvidence();
    const firstEvidence = await requireEvidence();
    assert.equal(firstEvidence.schedule_checkpoint, "absent", "no schedule row yet: checkpoint is the absent sentinel");

    // Simulate a schedule upsert whose dirty marker was swallowed: insert the
    // schedule row directly, WITHOUT touching connector_summary_evidence at
    // all (dirty stays 0 — the row still reads 'fresh').
    const scheduleUpdatedAt = "2026-07-29T00:05:00.000Z";
    getDb()
      .prepare(
        `INSERT INTO connector_schedules(connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at)
         VALUES (?, ?, 900, 0, 1, ?, ?)`
      )
      .run(INSTANCE_ID, CONNECTOR_ID, scheduleUpdatedAt, scheduleUpdatedAt);
    const stillClean = await requireEvidence();
    assert.equal(stillClean.dirty, false, "premise: the dirty marker for this schedule mutation was never fired");

    // A second maintenance pass, with NO dirty marker ever having fired,
    // must still detect the drift purely from connector_schedules.updated_at
    // and repair the row.
    const result = await reconcileConnectorSummaryEvidence();
    assert.ok(
      result.candidateReasonCounts.schedule_mismatch >= 1,
      "the schedule mutation is classified as schedule_mismatch even though dirty was never set"
    );
    const repaired = await requireEvidence();
    assert.equal(
      repaired.schedule_checkpoint,
      scheduleUpdatedAt,
      "the repaired row absorbs the live connector_schedules.updated_at"
    );

    // Stability: a third pass with no further schedule change repairs zero.
    const stableResult = await reconcileConnectorSummaryEvidence();
    assert.equal(
      stableResult.candidateReasonCounts.schedule_mismatch ?? 0,
      0,
      "a converged schedule checkpoint does not keep re-triggering repair"
    );
  }));

test("SQLite: a run-lifecycle event with a swallowed dirty marker is still detected and repaired via spine_events.event_seq", () =>
  withSqlite(async () => {
    seedConnectorAndInstanceSqlite();
    await reconcileConnectorSummaryEvidence();
    const firstEvidence = await requireEvidence();
    assert.equal(firstEvidence.run_lifecycle_event_seq, null, "no spine events yet: lifecycle checkpoint is null");

    // Simulate a run-lifecycle event (e.g. run.started) whose dirty marker
    // was swallowed: insert the spine event directly, WITHOUT touching
    // connector_summary_evidence.
    getDb()
      .prepare(
        `INSERT INTO spine_events(
           event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
           actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
         ) VALUES ('evt_run_started_1', 1, 'run.started', ?, ?, 'test', 'trace_run_started_1', 'runtime', 'test-connector', 'run', 'run_1', 'started', 'run_1', ?, '{}', '1')`
      )
      .run(NOW, NOW, INSTANCE_ID);
    const stillClean = await requireEvidence();
    assert.equal(stillClean.dirty, false, "premise: the dirty marker for this run-lifecycle event was never fired");

    const result = await reconcileConnectorSummaryEvidence();
    assert.ok(
      result.candidateReasonCounts.lifecycle_checkpoint_lag >= 1,
      "the run-lifecycle event is classified as lifecycle_checkpoint_lag even though dirty was never set"
    );
    const repaired = await requireEvidence();
    assert.equal(repaired.run_lifecycle_event_seq, 1, "the repaired row absorbs the live spine_events.event_seq");

    const stableResult = await reconcileConnectorSummaryEvidence();
    assert.equal(
      stableResult.candidateReasonCounts.lifecycle_checkpoint_lag ?? 0,
      0,
      "a converged lifecycle checkpoint does not keep re-triggering repair"
    );
  }));

if (POSTGRES_URL) {
  test("PostgreSQL: a schedule mutation with a swallowed dirty marker is still detected and repaired via connector_schedules.updated_at", () =>
    withPostgres(async () => {
      assert.ok(isPostgresStorageBackend(), "must run against the real Postgres backend");
      await seedConnectorAndInstancePostgres();
      await seedAndConvergeTerminalEventPostgres();
      const firstEvidence = await requireEvidence();
      assert.equal(
        firstEvidence.schedule_checkpoint,
        "absent",
        "no schedule row yet: checkpoint is the absent sentinel"
      );

      const scheduleUpdatedAt = "2026-07-29T00:05:00.000Z";
      await postgresQuery(
        `INSERT INTO connector_schedules(connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at)
         VALUES($1, $2, 900, 0, TRUE, $3, $3)`,
        [INSTANCE_ID, CONNECTOR_ID, scheduleUpdatedAt]
      );
      const stillClean = await requireEvidence();
      assert.equal(stillClean.dirty, false, "premise: the dirty marker for this schedule mutation was never fired");

      const result = await reconcileConnectorSummaryEvidence();
      assert.ok(
        result.candidateReasonCounts.schedule_mismatch >= 1,
        "the schedule mutation is classified as schedule_mismatch even though dirty was never set"
      );
      const repaired = await requireEvidence();
      assert.equal(
        repaired.schedule_checkpoint,
        scheduleUpdatedAt,
        "the repaired row absorbs the live connector_schedules.updated_at"
      );

      const stableResult = await reconcileConnectorSummaryEvidence();
      assert.equal(
        stableResult.candidateReasonCounts.schedule_mismatch ?? 0,
        0,
        "a converged schedule checkpoint does not keep re-triggering repair"
      );
    }));

  test("PostgreSQL: a run-lifecycle event with a swallowed dirty marker is still detected and repaired via spine_events.event_seq", () =>
    withPostgres(async () => {
      assert.ok(isPostgresStorageBackend(), "must run against the real Postgres backend");
      await seedConnectorAndInstancePostgres();
      // Converge a terminal event first and confirm the row reaches a stable
      // local baseline before testing the run-lifecycle checkpoint.
      await seedAndConvergeTerminalEventPostgres();
      await reconcileConnectorSummaryEvidence();
      const firstEvidence = await requireEvidence();
      assert.ok(
        typeof firstEvidence.run_lifecycle_event_seq === "number",
        "the converged terminal seed event already advanced the lifecycle checkpoint"
      );
      const baselineLifecycleSeq = Number(firstEvidence.run_lifecycle_event_seq);

      const nextSeq = await postgresQuery("SELECT COALESCE(MAX(event_seq), 0) + 1 AS next_seq FROM spine_events");
      const eventSeq = Number((nextSeq.rows[0] as { next_seq: number }).next_seq);
      assert.ok(
        eventSeq > baselineLifecycleSeq,
        "the new run.started event is strictly newer than the converged baseline"
      );
      await postgresQuery(
        `INSERT INTO spine_events(
           event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
           actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
         ) VALUES($1, $2, 'run.started', $3, $3, 'test', $4, 'runtime', 'test-connector', 'run', $5, 'started', $5, $6, '{}'::jsonb, '1')`,
        [
          `evt_run_started_pg_${eventSeq}`,
          eventSeq,
          NOW,
          `trace_run_started_pg_${eventSeq}`,
          `run_pg_${eventSeq}`,
          INSTANCE_ID,
        ]
      );
      const stillClean = await requireEvidence();
      assert.equal(stillClean.dirty, false, "premise: the dirty marker for this run-lifecycle event was never fired");

      const result = await reconcileConnectorSummaryEvidence();
      assert.ok(
        result.candidateReasonCounts.lifecycle_checkpoint_lag >= 1,
        "the run-lifecycle event is classified as lifecycle_checkpoint_lag even though dirty was never set"
      );
      const repaired = await requireEvidence();
      assert.equal(
        Number(repaired.run_lifecycle_event_seq),
        eventSeq,
        "the repaired row absorbs the live spine_events.event_seq"
      );

      const stableResult = await reconcileConnectorSummaryEvidence();
      assert.equal(
        stableResult.candidateReasonCounts.lifecycle_checkpoint_lag ?? 0,
        0,
        "a converged lifecycle checkpoint does not keep re-triggering repair"
      );
    }));
}
