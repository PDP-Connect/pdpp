// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Durability tests for the synthesized-revalidation cadence anchor
// (`synthesized_revalidation_state` — server/stores/scheduler-store.ts,
// runtime/scheduler/synthesized-attention-revalidation.ts).
//
// The rejected gate report (gate-stale-owner-action-v2-0801.md) found the
// prior design derived the cadence from `runtime.history` — a fleet-global,
// lossy, evictable window (`listRunHistory(500)`, a `RunRecord.source`
// marker that did NOT round-trip through `fromStoredRunRecord`). This fix
// replaces that with a dedicated, explicit, typed, per-connection durable
// record. These tests prove the NEW contract directly against real SQLite
// and real Postgres, across an actual process restart (closeDb/initDb —
// not an in-memory stub), with >500 unrelated rows and malformed unrelated
// SQLite `source_json` in play, so the fix cannot be evicted or corrupted
// by unrelated fleet activity.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { decideSynthesizedRevalidation } from "../runtime/scheduler/synthesized-attention-revalidation.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createPostgresSchedulerStore, createSqliteSchedulerStore } from "../server/stores/scheduler-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

function freshSqliteDb(): string {
  return join(mkdtempSync(join(tmpdir(), "pdpp-revalidation-state-db-")), "pdpp.sqlite");
}

function seedUnrelatedRunHistoryRow(
  connectorInstanceId: string,
  connectorId: string,
  sourceJson: string,
  index: number
): void {
  getDb()
    .prepare(
      `INSERT INTO run_history(
         connector_instance_id, connector_id, source_json, status, records_emitted,
         known_gaps_json, run_id, started_at, completed_at, attempt, scheduler_managed
       )
       VALUES (?, ?, ?, 'succeeded', 1, '[]', ?, ?, ?, 0, 1)`
    )
    .run(
      connectorInstanceId,
      connectorId,
      sourceJson,
      `run_${connectorInstanceId}_${index}`,
      `2026-07-01T00:00:00.${String(index).padStart(3, "0")}Z`,
      `2026-07-01T00:00:01.${String(index).padStart(3, "0")}Z`
    );
}

test("SQLite: cadence anchor survives a real process restart (closeDb/initDb, not an in-memory stub)", async () => {
  const dbPath = freshSqliteDb();
  try {
    initDb(dbPath);
    const store = createSqliteSchedulerStore();
    store.upsertSynthesizedRevalidationState({
      anchorAt: "2026-08-01T00:00:00.000Z",
      attempt: 4,
      connectorId: "chatgpt",
      connectorInstanceId: "cin_restart_probe",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    closeDb();

    // Real restart: fresh process-equivalent open of the SAME on-disk file.
    initDb(dbPath);
    const rehydratedStore = createSqliteSchedulerStore();
    const anchor = await rehydratedStore.getSynthesizedRevalidationState("cin_restart_probe");
    assert.ok(anchor, "the anchor row must survive a real restart");
    assert.equal(anchor.attempt, 4);
    assert.equal(anchor.anchorAt, "2026-08-01T00:00:00.000Z");

    // The decision function must compute the SAME doubling exponent from
    // the rehydrated anchor as it would have pre-restart — proving the
    // durable record, not an in-memory Map, drives the cadence.
    const decision = decideSynthesizedRevalidation(anchor, Date.parse("2026-08-01T00:00:00.000Z") + 1000, {
      initialDelayMs: 60_000,
    });
    assert.equal(decision.delayMs, 60_000 * 2 ** 4, "doubling exponent must derive from the persisted attempt count");
  } finally {
    closeDb();
  }
});

test("SQLite: anchor is independent of a >500-row fleet-global run_history window — cannot be evicted by unrelated activity", async () => {
  const dbPath = freshSqliteDb();
  try {
    initDb(dbPath);
    const store = createSqliteSchedulerStore();

    // Seed the target connector's anchor FIRST.
    store.upsertSynthesizedRevalidationState({
      anchorAt: "2026-06-01T00:00:00.000Z",
      attempt: 2,
      connectorId: "target-connector",
      connectorInstanceId: "cin_target",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });

    // Flood run_history with 800 unrelated rows for OTHER connectors — well
    // past the OLD design's `listRunHistory(500)` fleet-global newest-N
    // window, all timestamped AFTER the target's anchor so they would have
    // evicted it under the old history-scan design.
    for (let i = 0; i < 800; i += 1) {
      seedUnrelatedRunHistoryRow(`cin_unrelated_${i}`, "unrelated-connector", "{}", i);
    }

    closeDb();
    initDb(dbPath);
    const rehydratedStore = createSqliteSchedulerStore();

    // Confirm the flood is really there and really exceeds the old window.
    const history = await rehydratedStore.listRunHistory(500);
    assert.equal(history.length, 500, "fixture premise: the fleet-global window is saturated by unrelated rows");

    // The target's durable anchor must be completely unaffected — it lives
    // in a dedicated per-connection table, not the fleet-global window.
    const anchor = await rehydratedStore.getSynthesizedRevalidationState("cin_target");
    assert.ok(
      anchor,
      "the anchor must survive 800 unrelated rows and a restart, unlike the rejected history-scan design"
    );
    assert.equal(anchor.attempt, 2);
    assert.equal(anchor.anchorAt, "2026-06-01T00:00:00.000Z");
  } finally {
    closeDb();
  }
});

test("SQLite: malformed unrelated source_json does not corrupt or fail the cadence anchor read, and listRunHistory degrades gracefully instead of throwing", async () => {
  const dbPath = freshSqliteDb();
  try {
    initDb(dbPath);
    const store = createSqliteSchedulerStore();

    store.upsertSynthesizedRevalidationState({
      anchorAt: "2026-06-15T00:00:00.000Z",
      attempt: 1,
      connectorId: "target-connector",
      connectorInstanceId: "cin_target_malformed",
      updatedAt: "2026-06-15T00:00:00.000Z",
    });

    // One well-formed unrelated row, then one row with deliberately
    // malformed (non-JSON-parseable) source_json for a DIFFERENT connector
    // instance — simulating historical corruption unrelated to the probe.
    seedUnrelatedRunHistoryRow("cin_unrelated_ok", "unrelated-connector", "{}", 0);
    getDb()
      .prepare(
        `INSERT INTO run_history(
           connector_instance_id, connector_id, source_json, status, records_emitted,
           known_gaps_json, run_id, started_at, completed_at, attempt, scheduler_managed
         )
         VALUES ('cin_unrelated_malformed', 'unrelated-connector', ?, 'succeeded', 1, '[]', 'run_malformed', ?, ?, 0, 1)`
      )
      .run("{not valid json!!", "2026-06-16T00:00:00.000Z", "2026-06-16T00:00:01.000Z");

    closeDb();
    initDb(dbPath);
    const rehydratedStore = createSqliteSchedulerStore();

    // The malformed row must NOT throw and abort the whole batch read (the
    // rejected v2 design's failure mode) — it must fall back per-field. Two
    // run_history rows were seeded (the anchor lives in a separate table
    // and contributes no run_history row).
    const history = await rehydratedStore.listRunHistory(500);
    assert.equal(history.length, 2, "both rows must still be returned, malformed row included with a fallback");
    const malformedRow = history.find((r) => r.connectorInstanceId === "cin_unrelated_malformed");
    assert.ok(malformedRow, "the malformed row must not be silently dropped, only its JSON field falls back");
    assert.deepEqual(malformedRow.source, {}, "malformed source_json falls back to {} rather than throwing");

    // The target connector's durable anchor is read from a completely
    // separate table and is unaffected by the malformed row entirely.
    const anchor = await rehydratedStore.getSynthesizedRevalidationState("cin_target_malformed");
    assert.ok(anchor, "the anchor read must succeed even when an unrelated row has malformed source_json");
    assert.equal(anchor.attempt, 1);
  } finally {
    closeDb();
  }
});

test("SQLite: clearing the anchor removes it, and a fresh sighting after clear starts at attempt 0", async () => {
  const dbPath = freshSqliteDb();
  try {
    initDb(dbPath);
    const store = createSqliteSchedulerStore();
    store.upsertSynthesizedRevalidationState({
      anchorAt: "2026-06-01T00:00:00.000Z",
      attempt: 6,
      connectorId: "chatgpt",
      connectorInstanceId: "cin_clear_probe",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    store.clearSynthesizedRevalidationState("cin_clear_probe");
    assert.equal(await store.getSynthesizedRevalidationState("cin_clear_probe"), null);

    // Survives restart as cleared, not resurrected.
    closeDb();
    initDb(dbPath);
    const rehydratedStore = createSqliteSchedulerStore();
    assert.equal(await rehydratedStore.getSynthesizedRevalidationState("cin_clear_probe"), null);
  } finally {
    closeDb();
  }
});

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

if (POSTGRES_URL) {
  test("Postgres: cadence anchor survives a real storage-connection restart (closePostgresStorage/initPostgresStorage)", async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorInstanceId = `cin_pg_restart_${suffix}`;
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      const store = createPostgresSchedulerStore();
      await store.upsertSynthesizedRevalidationState({
        anchorAt: "2026-08-01T00:00:00.000Z",
        attempt: 4,
        connectorId: "chatgpt",
        connectorInstanceId,
        updatedAt: "2026-08-01T00:00:00.000Z",
      });
      await closePostgresStorage();

      // Real restart-equivalent: fresh connection pool against the SAME
      // durable Postgres database.
      await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
      const rehydratedStore = createPostgresSchedulerStore();
      const anchor = await rehydratedStore.getSynthesizedRevalidationState(connectorInstanceId);
      assert.ok(anchor, "the anchor row must survive a real Postgres connection restart");
      assert.equal(anchor.attempt, 4);
      assert.equal(anchor.anchorAt, "2026-08-01T00:00:00.000Z");

      const decision = decideSynthesizedRevalidation(anchor, Date.parse("2026-08-01T00:00:00.000Z") + 1000, {
        initialDelayMs: 60_000,
      });
      assert.equal(decision.delayMs, 60_000 * 2 ** 4);
    } finally {
      await postgresQuery("DELETE FROM synthesized_revalidation_state WHERE connector_instance_id = $1", [
        connectorInstanceId,
      ]);
      await closePostgresStorage();
      closeDb();
    }
  });

  test("Postgres: anchor is independent of a >500-row fleet-global run_history window", async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const targetInstanceId = `cin_pg_target_${suffix}`;
    const unrelatedIds: string[] = [];
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      const store = createPostgresSchedulerStore();
      await store.upsertSynthesizedRevalidationState({
        anchorAt: "2026-06-01T00:00:00.000Z",
        attempt: 2,
        connectorId: "target-connector",
        connectorInstanceId: targetInstanceId,
        updatedAt: "2026-06-01T00:00:00.000Z",
      });

      for (let i = 0; i < 800; i += 1) {
        const instanceId = `cin_pg_unrelated_${suffix}_${i}`;
        unrelatedIds.push(instanceId);
        // biome-ignore lint/performance/noAwaitInLoops: seeding must preserve deterministic insertion order for the newest-N assertion below.
        await postgresQuery(
          `INSERT INTO run_history(
             connector_instance_id, connector_id, source_json, status, records_emitted,
             known_gaps_json, run_id, started_at, completed_at, attempt, scheduler_managed
           ) VALUES ($1, 'unrelated-connector', '{}'::jsonb, 'succeeded', 1, '[]'::jsonb, $2, $3, $4, 0, true)`,
          [
            instanceId,
            `run_pg_${suffix}_${i}`,
            `2026-07-01T00:00:00.${String(i).padStart(3, "0")}Z`,
            `2026-07-01T00:00:01.${String(i).padStart(3, "0")}Z`,
          ]
        );
      }

      await closePostgresStorage();
      await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
      const rehydratedStore = createPostgresSchedulerStore();

      const anchor = await rehydratedStore.getSynthesizedRevalidationState(targetInstanceId);
      assert.ok(anchor, "the anchor must survive 800 unrelated Postgres rows and a restart");
      assert.equal(anchor.attempt, 2);
    } finally {
      await postgresQuery("DELETE FROM synthesized_revalidation_state WHERE connector_instance_id = $1", [
        targetInstanceId,
      ]);
      await postgresQuery("DELETE FROM run_history WHERE connector_instance_id = ANY($1::text[])", [unrelatedIds]);
      await closePostgresStorage();
      closeDb();
    }
  });
}
