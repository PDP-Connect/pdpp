// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Deterministic fault-injection oracle proving activateDraftAndAttachScheduleAtomically
// (server/authenticated-draft-activation.ts) cannot leave a connection
// stranded active-with-no-schedule when the schedule write fails mid-
// transaction — the owner-gate blocker this module closes. A blind retry or
// a log-and-wait posture would NOT prove this; only observing the actual row
// states after the operation reaches its terminal (thrown) result does.
//
// Covers both storage abstractions this repo supports: SQLite (the default
// backend, always runs) and real PostgreSQL (skipped when
// PDPP_TEST_POSTGRES_URL is unset, matching every other real-Postgres lane
// in this suite, e.g. connector-instance-writer-paths.test.ts).

import assert from "node:assert/strict";
import test from "node:test";
import {
  __setAuthenticatedDraftActivationFaultHookForTest,
  activateDraftAndAttachScheduleAtomically,
} from "../server/authenticated-draft-activation.ts";
import { registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const DEDICATED_POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

const AMAZON_MANIFEST = JSON.parse(
  await (
    await import("node:fs/promises")
  ).readFile(new URL("../../packages/polyfill-connectors/manifests/amazon.json", import.meta.url), "utf8")
);

function seedDraftConnectorInstanceSqlite(connectorInstanceId: string, connectorId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES (?, ?, ?, ?, 'draft', 'account', ?, ?, ?, ?, NULL)`
  ).run(
    connectorInstanceId,
    "owner_1",
    connectorId,
    connectorInstanceId,
    connectorInstanceId,
    JSON.stringify({ kind: "static_secret_draft" }),
    "2026-06-01T00:00:00.000Z",
    "2026-06-01T00:00:00.000Z"
  );
}

function sqliteInstanceStatus(connectorInstanceId: string): string | null {
  const db = getDb();
  const row = db
    .prepare("SELECT status FROM connector_instances WHERE connector_instance_id = ?")
    .get(connectorInstanceId) as { status: string } | undefined;
  return row?.status ?? null;
}

function sqliteScheduleExists(connectorInstanceId: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT connector_instance_id FROM connector_schedules WHERE connector_instance_id = ?")
    .get(connectorInstanceId);
  return Boolean(row);
}

interface SummaryEvidenceRow {
  dirty: number | boolean;
  last_error: string | null;
  state: string;
}

function seedSummaryEvidenceSqlite(
  connectorInstanceId: string,
  connectorId: string,
  { dirty = 0, state = "fresh" }: { dirty?: number; state?: string } = {}
): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO connector_summary_evidence(connector_instance_id, connector_id, dirty, state, last_error) VALUES (?, ?, ?, ?, NULL)"
  ).run(connectorInstanceId, connectorId, dirty, state);
}

function sqliteSummaryEvidence(connectorInstanceId: string): SummaryEvidenceRow | undefined {
  const db = getDb();
  return db
    .prepare("SELECT dirty, state, last_error FROM connector_summary_evidence WHERE connector_instance_id = ?")
    .get(connectorInstanceId) as SummaryEvidenceRow | undefined;
}

async function seedSummaryEvidencePostgres(
  connectorInstanceId: string,
  connectorId: string,
  { dirty = 0, state = "fresh" }: { dirty?: number; state?: string } = {}
): Promise<void> {
  await postgresQuery(
    "INSERT INTO connector_summary_evidence(connector_instance_id, connector_id, dirty, state, last_error) VALUES ($1, $2, $3, $4, NULL)",
    [connectorInstanceId, connectorId, dirty, state]
  );
}

async function postgresSummaryEvidence(connectorInstanceId: string): Promise<SummaryEvidenceRow | undefined> {
  const result = await postgresQuery<SummaryEvidenceRow>(
    "SELECT dirty, state, last_error FROM connector_summary_evidence WHERE connector_instance_id = $1",
    [connectorInstanceId]
  );
  return result.rows[0];
}

test("SQLite: a fault thrown between the activation write and the schedule write rolls back BOTH — no stranded active-unscheduled row", async (t) => {
  closeDb();
  initDb(makeTemporaryDbPath("pdpp-atomic-fault-sqlite-"));
  await registerConnector(AMAZON_MANIFEST);
  seedDraftConnectorInstanceSqlite("cin_fault_sqlite", "amazon");
  t.after(() => {
    __setAuthenticatedDraftActivationFaultHookForTest(null);
    closeDb();
  });

  __setAuthenticatedDraftActivationFaultHookForTest((point) => {
    if (point === "after_activate_before_schedule") {
      throw new Error("injected fault: schedule write failure");
    }
  });

  await assert.rejects(
    () =>
      activateDraftAndAttachScheduleAtomically({
        connectorId: "amazon",
        connectorInstanceId: "cin_fault_sqlite",
        manifest: AMAZON_MANIFEST,
      }),
    /injected fault/
  );

  assert.equal(
    sqliteInstanceStatus("cin_fault_sqlite"),
    "draft",
    "the activation write executed earlier in the SAME transaction must have rolled back too"
  );
  assert.equal(sqliteScheduleExists("cin_fault_sqlite"), false);
});

test("SQLite: after the fault clears, the SAME connection activates and schedules cleanly on a subsequent authenticated run (retry reaches terminal success)", async (t) => {
  closeDb();
  initDb(makeTemporaryDbPath("pdpp-atomic-fault-retry-sqlite-"));
  await registerConnector(AMAZON_MANIFEST);
  seedDraftConnectorInstanceSqlite("cin_fault_retry_sqlite", "amazon");
  t.after(() => {
    __setAuthenticatedDraftActivationFaultHookForTest(null);
    closeDb();
  });

  __setAuthenticatedDraftActivationFaultHookForTest((point) => {
    if (point === "after_activate_before_schedule") {
      throw new Error("injected fault: schedule write failure");
    }
  });
  await assert.rejects(() =>
    activateDraftAndAttachScheduleAtomically({
      connectorId: "amazon",
      connectorInstanceId: "cin_fault_retry_sqlite",
      manifest: AMAZON_MANIFEST,
    })
  );
  assert.equal(sqliteInstanceStatus("cin_fault_retry_sqlite"), "draft", "rolled back after the first, faulted attempt");

  __setAuthenticatedDraftActivationFaultHookForTest(null);
  const result = await activateDraftAndAttachScheduleAtomically({
    connectorId: "amazon",
    connectorInstanceId: "cin_fault_retry_sqlite",
    manifest: AMAZON_MANIFEST,
  });

  assert.equal(result.activated, true);
  assert.equal(result.scheduleAttached, true);
  assert.equal(sqliteInstanceStatus("cin_fault_retry_sqlite"), "active");
  assert.equal(sqliteScheduleExists("cin_fault_retry_sqlite"), true);
});

test(
  "Postgres: after the fault clears, the SAME connection activates and schedules cleanly on a subsequent authenticated run (retry reaches terminal success)",
  { skip: !DEDICATED_POSTGRES_URL && "PDPP_TEST_POSTGRES_URL unset" },
  async (t) => {
    const postgresUrl = DEDICATED_POSTGRES_URL;
    assert.ok(postgresUrl, "DEDICATED_POSTGRES_URL is required for this test");
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl });
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const connectorInstanceId = `cin_fault_retry_pg_${suffix}`;
    t.after(async () => {
      __setAuthenticatedDraftActivationFaultHookForTest(null);
      await postgresQuery("DELETE FROM connector_schedules WHERE connector_instance_id = $1", [connectorInstanceId]);
      await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [connectorInstanceId]);
      await closePostgresStorage();
      closeDb();
    });

    await postgresQuery(
      `INSERT INTO connectors(connector_id, manifest, created_at)
       VALUES ('amazon', $1::jsonb, $2)
       ON CONFLICT (connector_id) DO NOTHING`,
      [JSON.stringify(AMAZON_MANIFEST), "2026-06-01T00:00:00.000Z"]
    );
    await postgresQuery(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES ($1, 'owner_1', 'amazon', $1, 'draft', 'account', $1, $2::jsonb, $3, $3, NULL)`,
      [connectorInstanceId, JSON.stringify({ kind: "static_secret_draft" }), "2026-06-01T00:00:00.000Z"]
    );

    __setAuthenticatedDraftActivationFaultHookForTest((point) => {
      if (point === "after_activate_before_schedule") {
        throw new Error("injected fault: schedule write failure");
      }
    });
    await assert.rejects(() =>
      activateDraftAndAttachScheduleAtomically({ connectorId: "amazon", connectorInstanceId, manifest: AMAZON_MANIFEST })
    );
    let instance = await postgresQuery<{ status: string }>(
      "SELECT status FROM connector_instances WHERE connector_instance_id = $1",
      [connectorInstanceId]
    );
    assert.equal(instance.rows[0]?.status, "draft", "rolled back after the first, faulted attempt");

    __setAuthenticatedDraftActivationFaultHookForTest(null);
    const result = await activateDraftAndAttachScheduleAtomically({
      connectorId: "amazon",
      connectorInstanceId,
      manifest: AMAZON_MANIFEST,
    });

    assert.equal(result.activated, true);
    assert.equal(result.scheduleAttached, true);
    instance = await postgresQuery<{ status: string }>(
      "SELECT status FROM connector_instances WHERE connector_instance_id = $1",
      [connectorInstanceId]
    );
    assert.equal(instance.rows[0]?.status, "active");
    const schedule = await postgresQuery(
      "SELECT connector_instance_id FROM connector_schedules WHERE connector_instance_id = $1",
      [connectorInstanceId]
    );
    assert.equal(schedule.rows.length, 1);
  }
);

test(
  "Postgres: a fault thrown between the activation write and the schedule write rolls back BOTH — no stranded active-unscheduled row",
  { skip: !DEDICATED_POSTGRES_URL && "PDPP_TEST_POSTGRES_URL unset" },
  async (t) => {
    const postgresUrl = DEDICATED_POSTGRES_URL;
    assert.ok(postgresUrl, "DEDICATED_POSTGRES_URL is required for this test");
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl });
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const connectorInstanceId = `cin_fault_pg_${suffix}`;
    t.after(async () => {
      __setAuthenticatedDraftActivationFaultHookForTest(null);
      await postgresQuery("DELETE FROM connector_schedules WHERE connector_instance_id = $1", [connectorInstanceId]);
      await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [connectorInstanceId]);
      await closePostgresStorage();
      closeDb();
    });

    await postgresQuery(
      `INSERT INTO connectors(connector_id, manifest, created_at)
       VALUES ('amazon', $1::jsonb, $2)
       ON CONFLICT (connector_id) DO NOTHING`,
      [JSON.stringify(AMAZON_MANIFEST), "2026-06-01T00:00:00.000Z"]
    );
    await postgresQuery(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES ($1, 'owner_1', 'amazon', $1, 'draft', 'account', $1, $2::jsonb, $3, $3, NULL)`,
      [connectorInstanceId, JSON.stringify({ kind: "static_secret_draft" }), "2026-06-01T00:00:00.000Z"]
    );

    __setAuthenticatedDraftActivationFaultHookForTest((point) => {
      if (point === "after_activate_before_schedule") {
        throw new Error("injected fault: schedule write failure");
      }
    });

    await assert.rejects(
      () =>
        activateDraftAndAttachScheduleAtomically({
          connectorId: "amazon",
          connectorInstanceId,
          manifest: AMAZON_MANIFEST,
        }),
      /injected fault/
    );

    const instance = await postgresQuery<{ status: string }>(
      "SELECT status FROM connector_instances WHERE connector_instance_id = $1",
      [connectorInstanceId]
    );
    assert.equal(
      instance.rows[0]?.status,
      "draft",
      "the activation write executed earlier in the SAME transaction must have rolled back too"
    );
    const schedule = await postgresQuery("SELECT connector_instance_id FROM connector_schedules WHERE connector_instance_id = $1", [
      connectorInstanceId,
    ]);
    assert.equal(schedule.rows.length, 0);
  }
);

test("SQLite: an owner-paused, custom-interval schedule row is untouched by a faulted attempt AND by the successful retry that follows it", async (t) => {
  closeDb();
  initDb(makeTemporaryDbPath("pdpp-atomic-owner-pause-sqlite-"));
  await registerConnector(AMAZON_MANIFEST);
  const connectorInstanceId = "cin_owner_paused_sqlite";
  seedDraftConnectorInstanceSqlite(connectorInstanceId, "amazon");
  // Simulate: this connection was already activated by an earlier run, and
  // the owner has since paused it and set a custom interval/jitter.
  const db = getDb();
  db.prepare("UPDATE connector_instances SET status = 'active' WHERE connector_instance_id = ?").run(
    connectorInstanceId
  );
  db.prepare(
    `INSERT INTO connector_schedules(connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at)
     VALUES (?, 'amazon', 999999, 42, 0, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`
  ).run(connectorInstanceId);
  t.after(() => {
    __setAuthenticatedDraftActivationFaultHookForTest(null);
    closeDb();
  });

  function readSchedule() {
    return db
      .prepare(
        "SELECT interval_seconds, jitter_seconds, enabled FROM connector_schedules WHERE connector_instance_id = ?"
      )
      .get(connectorInstanceId) as { interval_seconds: number; jitter_seconds: number; enabled: number } | undefined;
  }

  __setAuthenticatedDraftActivationFaultHookForTest((point) => {
    if (point === "after_activate_before_schedule") {
      throw new Error("injected fault: schedule write failure");
    }
  });
  await assert.rejects(() =>
    activateDraftAndAttachScheduleAtomically({
      connectorId: "amazon",
      connectorInstanceId,
      manifest: AMAZON_MANIFEST,
    })
  );
  let schedule = readSchedule();
  assert.ok(schedule, "owner-paused row must survive the faulted attempt (never deleted, never touched)");
  assert.equal(schedule.enabled, 0, "owner pause must survive the faulted attempt");
  assert.equal(schedule.interval_seconds, 999_999, "owner custom interval must survive the faulted attempt");
  assert.equal(schedule.jitter_seconds, 42, "owner custom jitter must survive the faulted attempt");

  __setAuthenticatedDraftActivationFaultHookForTest(null);
  const result = await activateDraftAndAttachScheduleAtomically({
    connectorId: "amazon",
    connectorInstanceId,
    manifest: AMAZON_MANIFEST,
  });
  assert.equal(result.activated, false, "already active — this call's own activation is a no-op");
  assert.equal(result.scheduleAttached, false, "an existing schedule row is never replaced");
  schedule = readSchedule();
  assert.ok(schedule);
  assert.equal(schedule.enabled, 0, "owner pause must survive the successful retry too");
  assert.equal(schedule.interval_seconds, 999_999, "owner custom interval must survive the successful retry too");
  assert.equal(schedule.jitter_seconds, 42, "owner custom jitter must survive the successful retry too");
});

test("SQLite: a manual-mode manifest never gets a schedule row, with or without the fault injected", async (t) => {
  closeDb();
  initDb(makeTemporaryDbPath("pdpp-atomic-manual-mode-sqlite-"));
  const manualManifest = {
    ...AMAZON_MANIFEST,
    capabilities: {
      ...AMAZON_MANIFEST.capabilities,
      refresh_policy: { ...AMAZON_MANIFEST.capabilities.refresh_policy, recommended_mode: "manual" },
    },
  };
  await registerConnector(manualManifest);
  const connectorInstanceId = "cin_manual_mode_sqlite";
  seedDraftConnectorInstanceSqlite(connectorInstanceId, "amazon");
  t.after(() => {
    __setAuthenticatedDraftActivationFaultHookForTest(null);
    closeDb();
  });

  // The fault hook fires between the activation write and the (skipped,
  // manual-mode) schedule write — arming it here proves the fault point is
  // reached (and therefore exercised) even when there is no schedule write
  // to fault, i.e. the hook does not accidentally get skipped for manual
  // manifests.
  let faultPointReached = false;
  __setAuthenticatedDraftActivationFaultHookForTest((point) => {
    if (point === "after_activate_before_schedule") {
      faultPointReached = true;
    }
  });

  const result = await activateDraftAndAttachScheduleAtomically({
    connectorId: "amazon",
    connectorInstanceId,
    manifest: manualManifest,
  });

  assert.equal(faultPointReached, true, "the fault-injection point must still be reached for a manual manifest");
  assert.equal(result.activated, true, "the draft still activates on genuine authenticated success");
  assert.equal(result.scheduleAttached, false, "a manual-mode manifest never gets a schedule attached");
  assert.equal(sqliteInstanceStatus(connectorInstanceId), "active");
  assert.equal(sqliteScheduleExists(connectorInstanceId), false, "no schedule row for a manual-mode manifest");
});

test(
  "Postgres: an owner-paused, custom-interval schedule row is untouched by a faulted attempt AND by the successful retry that follows it",
  { skip: !DEDICATED_POSTGRES_URL && "PDPP_TEST_POSTGRES_URL unset" },
  async (t) => {
    const postgresUrl = DEDICATED_POSTGRES_URL;
    assert.ok(postgresUrl, "DEDICATED_POSTGRES_URL is required for this test");
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl });
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const connectorInstanceId = `cin_owner_paused_pg_${suffix}`;
    t.after(async () => {
      __setAuthenticatedDraftActivationFaultHookForTest(null);
      await postgresQuery("DELETE FROM connector_schedules WHERE connector_instance_id = $1", [connectorInstanceId]);
      await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [connectorInstanceId]);
      await closePostgresStorage();
      closeDb();
    });

    await postgresQuery(
      `INSERT INTO connectors(connector_id, manifest, created_at)
       VALUES ('amazon', $1::jsonb, $2)
       ON CONFLICT (connector_id) DO NOTHING`,
      [JSON.stringify(AMAZON_MANIFEST), "2026-06-01T00:00:00.000Z"]
    );
    await postgresQuery(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES ($1, 'owner_1', 'amazon', $1, 'active', 'account', $1, $2::jsonb, $3, $3, NULL)`,
      [connectorInstanceId, JSON.stringify({ kind: "static_secret_draft" }), "2026-06-01T00:00:00.000Z"]
    );
    await postgresQuery(
      `INSERT INTO connector_schedules(connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at)
       VALUES ($1, 'amazon', 999999, 42, false, $2, $2)`,
      [connectorInstanceId, "2026-06-01T00:00:00.000Z"]
    );

    async function readSchedule() {
      const result = await postgresQuery<{ interval_seconds: number; jitter_seconds: number; enabled: boolean }>(
        "SELECT interval_seconds, jitter_seconds, enabled FROM connector_schedules WHERE connector_instance_id = $1",
        [connectorInstanceId]
      );
      return result.rows[0];
    }

    __setAuthenticatedDraftActivationFaultHookForTest((point) => {
      if (point === "after_activate_before_schedule") {
        throw new Error("injected fault: schedule write failure");
      }
    });
    await assert.rejects(() =>
      activateDraftAndAttachScheduleAtomically({
        connectorId: "amazon",
        connectorInstanceId,
        manifest: AMAZON_MANIFEST,
      })
    );
    let schedule = await readSchedule();
    assert.ok(schedule, "owner-paused row must survive the faulted attempt");
    assert.equal(schedule.enabled, false);
    assert.equal(Number(schedule.interval_seconds), 999_999);
    assert.equal(Number(schedule.jitter_seconds), 42);

    __setAuthenticatedDraftActivationFaultHookForTest(null);
    const result = await activateDraftAndAttachScheduleAtomically({
      connectorId: "amazon",
      connectorInstanceId,
      manifest: AMAZON_MANIFEST,
    });
    assert.equal(result.scheduleAttached, false, "an existing schedule row is never replaced");
    schedule = await readSchedule();
    assert.ok(schedule);
    assert.equal(schedule.enabled, false, "owner pause must survive the successful retry too");
    assert.equal(Number(schedule.interval_seconds), 999_999);
    assert.equal(Number(schedule.jitter_seconds), 42);
  }
);

test("SQLite: an owner-paused (non-draft, non-active) connection never gets a schedule attached, even for an automatic manifest", async (t) => {
  closeDb();
  initDb(makeTemporaryDbPath("pdpp-atomic-paused-not-draft-sqlite-"));
  await registerConnector(AMAZON_MANIFEST);
  const connectorInstanceId = "cin_paused_not_draft_sqlite";
  seedDraftConnectorInstanceSqlite(connectorInstanceId, "amazon");
  const db = getDb();
  db.prepare("UPDATE connector_instances SET status = 'paused' WHERE connector_instance_id = ?").run(
    connectorInstanceId
  );
  t.after(() => closeDb());

  const result = await activateDraftAndAttachScheduleAtomically({
    connectorId: "amazon",
    connectorInstanceId,
    manifest: AMAZON_MANIFEST,
  });

  assert.equal(result.activated, false, "a paused connection is never flipped to active by this call");
  assert.equal(result.scheduleAttached, false, "a paused connection must never get a schedule attached");
  assert.equal(sqliteInstanceStatus(connectorInstanceId), "paused", "status must remain paused, untouched");
  assert.equal(sqliteScheduleExists(connectorInstanceId), false);
});

test(
  "Postgres: an owner-paused (non-draft, non-active) connection never gets a schedule attached, even for an automatic manifest",
  { skip: !DEDICATED_POSTGRES_URL && "PDPP_TEST_POSTGRES_URL unset" },
  async (t) => {
    const postgresUrl = DEDICATED_POSTGRES_URL;
    assert.ok(postgresUrl, "DEDICATED_POSTGRES_URL is required for this test");
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl });
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const connectorInstanceId = `cin_paused_not_draft_pg_${suffix}`;
    t.after(async () => {
      await postgresQuery("DELETE FROM connector_schedules WHERE connector_instance_id = $1", [connectorInstanceId]);
      await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [connectorInstanceId]);
      await closePostgresStorage();
      closeDb();
    });

    await postgresQuery(
      `INSERT INTO connectors(connector_id, manifest, created_at)
       VALUES ('amazon', $1::jsonb, $2)
       ON CONFLICT (connector_id) DO NOTHING`,
      [JSON.stringify(AMAZON_MANIFEST), "2026-06-01T00:00:00.000Z"]
    );
    await postgresQuery(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES ($1, 'owner_1', 'amazon', $1, 'paused', 'account', $1, $2::jsonb, $3, $3, NULL)`,
      [connectorInstanceId, JSON.stringify({ kind: "static_secret_draft" }), "2026-06-01T00:00:00.000Z"]
    );

    const result = await activateDraftAndAttachScheduleAtomically({
      connectorId: "amazon",
      connectorInstanceId,
      manifest: AMAZON_MANIFEST,
    });

    assert.equal(result.activated, false, "a paused connection is never flipped to active by this call");
    assert.equal(result.scheduleAttached, false, "a paused connection must never get a schedule attached");
    const instance = await postgresQuery<{ status: string }>(
      "SELECT status FROM connector_instances WHERE connector_instance_id = $1",
      [connectorInstanceId]
    );
    assert.equal(instance.rows[0]?.status, "paused", "status must remain paused, untouched");
    const schedule = await postgresQuery(
      "SELECT connector_instance_id FROM connector_schedules WHERE connector_instance_id = $1",
      [connectorInstanceId]
    );
    assert.equal(schedule.rows.length, 0);
  }
);

test(
  "Postgres: a manual-mode manifest never gets a schedule row, with or without the fault injected",
  { skip: !DEDICATED_POSTGRES_URL && "PDPP_TEST_POSTGRES_URL unset" },
  async (t) => {
    const postgresUrl = DEDICATED_POSTGRES_URL;
    assert.ok(postgresUrl, "DEDICATED_POSTGRES_URL is required for this test");
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl });
    const manualManifest = {
      ...AMAZON_MANIFEST,
      capabilities: {
        ...AMAZON_MANIFEST.capabilities,
        refresh_policy: { ...AMAZON_MANIFEST.capabilities.refresh_policy, recommended_mode: "manual" },
      },
    };
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const connectorInstanceId = `cin_manual_mode_pg_${suffix}`;
    t.after(async () => {
      __setAuthenticatedDraftActivationFaultHookForTest(null);
      await postgresQuery("DELETE FROM connector_schedules WHERE connector_instance_id = $1", [connectorInstanceId]);
      await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [connectorInstanceId]);
      await closePostgresStorage();
      closeDb();
    });

    await postgresQuery(
      `INSERT INTO connectors(connector_id, manifest, created_at)
       VALUES ('amazon', $1::jsonb, $2)
       ON CONFLICT (connector_id) DO UPDATE SET manifest = $1::jsonb`,
      [JSON.stringify(manualManifest), "2026-06-01T00:00:00.000Z"]
    );
    await postgresQuery(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES ($1, 'owner_1', 'amazon', $1, 'draft', 'account', $1, $2::jsonb, $3, $3, NULL)`,
      [connectorInstanceId, JSON.stringify({ kind: "static_secret_draft" }), "2026-06-01T00:00:00.000Z"]
    );

    let faultPointReached = false;
    __setAuthenticatedDraftActivationFaultHookForTest((point) => {
      if (point === "after_activate_before_schedule") {
        faultPointReached = true;
      }
    });

    const result = await activateDraftAndAttachScheduleAtomically({
      connectorId: "amazon",
      connectorInstanceId,
      manifest: manualManifest,
    });

    assert.equal(faultPointReached, true, "the fault-injection point must still be reached for a manual manifest");
    assert.equal(result.activated, true, "the draft still activates on genuine authenticated success");
    assert.equal(result.scheduleAttached, false, "a manual-mode manifest never gets a schedule attached");
    const instance = await postgresQuery<{ status: string }>(
      "SELECT status FROM connector_instances WHERE connector_instance_id = $1",
      [connectorInstanceId]
    );
    assert.equal(instance.rows[0]?.status, "active");
    const schedule = await postgresQuery(
      "SELECT connector_instance_id FROM connector_schedules WHERE connector_instance_id = $1",
      [connectorInstanceId]
    );
    assert.equal(schedule.rows.length, 0, "no schedule row for a manual-mode manifest");
  }
);

test("SQLite: a successful activation marks connector_summary_evidence dirty/stale in the SAME transaction", async (t) => {
  closeDb();
  initDb(makeTemporaryDbPath("pdpp-atomic-dirty-mark-sqlite-"));
  await registerConnector(AMAZON_MANIFEST);
  const connectorInstanceId = "cin_dirty_mark_sqlite";
  seedDraftConnectorInstanceSqlite(connectorInstanceId, "amazon");
  seedSummaryEvidenceSqlite(connectorInstanceId, "amazon", { dirty: 0, state: "fresh" });
  t.after(() => closeDb());

  const result = await activateDraftAndAttachScheduleAtomically({
    connectorId: "amazon",
    connectorInstanceId,
    manifest: AMAZON_MANIFEST,
  });

  assert.equal(result.activated, true);
  const evidence = sqliteSummaryEvidence(connectorInstanceId);
  assert.ok(evidence, "evidence row must still exist");
  assert.equal(Number(evidence.dirty), 1, "activation must mark evidence dirty");
  assert.equal(evidence.state, "stale", "activation must mark evidence state stale");
  assert.equal(evidence.last_error, "connector instance status changed to active");
});

test("SQLite: a faulted attempt leaves connector_summary_evidence in its PRIOR state, unchanged (dirty-mark rolls back too)", async (t) => {
  closeDb();
  initDb(makeTemporaryDbPath("pdpp-atomic-dirty-mark-rollback-sqlite-"));
  await registerConnector(AMAZON_MANIFEST);
  const connectorInstanceId = "cin_dirty_mark_rollback_sqlite";
  seedDraftConnectorInstanceSqlite(connectorInstanceId, "amazon");
  seedSummaryEvidenceSqlite(connectorInstanceId, "amazon", { dirty: 0, state: "fresh" });
  t.after(() => {
    __setAuthenticatedDraftActivationFaultHookForTest(null);
    closeDb();
  });

  __setAuthenticatedDraftActivationFaultHookForTest((point) => {
    if (point === "after_activate_before_schedule") {
      throw new Error("injected fault: schedule write failure");
    }
  });

  await assert.rejects(() =>
    activateDraftAndAttachScheduleAtomically({
      connectorId: "amazon",
      connectorInstanceId,
      manifest: AMAZON_MANIFEST,
    })
  );

  assert.equal(sqliteInstanceStatus(connectorInstanceId), "draft", "status rolled back");
  const evidence = sqliteSummaryEvidence(connectorInstanceId);
  assert.ok(evidence, "evidence row must still exist");
  assert.equal(Number(evidence.dirty), 0, "the dirty-mark write must roll back along with the status flip");
  assert.equal(evidence.state, "fresh", "prior evidence state must be unchanged after rollback");
  assert.equal(evidence.last_error, null, "prior evidence last_error must be unchanged after rollback");
});

test(
  "Postgres: a successful activation marks connector_summary_evidence dirty/stale in the SAME transaction",
  { skip: !DEDICATED_POSTGRES_URL && "PDPP_TEST_POSTGRES_URL unset" },
  async (t) => {
    const postgresUrl = DEDICATED_POSTGRES_URL;
    assert.ok(postgresUrl, "DEDICATED_POSTGRES_URL is required for this test");
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl });
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const connectorInstanceId = `cin_dirty_mark_pg_${suffix}`;
    t.after(async () => {
      await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [
        connectorInstanceId,
      ]);
      await postgresQuery("DELETE FROM connector_schedules WHERE connector_instance_id = $1", [connectorInstanceId]);
      await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [connectorInstanceId]);
      await closePostgresStorage();
      closeDb();
    });

    await postgresQuery(
      `INSERT INTO connectors(connector_id, manifest, created_at)
       VALUES ('amazon', $1::jsonb, $2)
       ON CONFLICT (connector_id) DO NOTHING`,
      [JSON.stringify(AMAZON_MANIFEST), "2026-06-01T00:00:00.000Z"]
    );
    await postgresQuery(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES ($1, 'owner_1', 'amazon', $1, 'draft', 'account', $1, $2::jsonb, $3, $3, NULL)`,
      [connectorInstanceId, JSON.stringify({ kind: "static_secret_draft" }), "2026-06-01T00:00:00.000Z"]
    );
    await seedSummaryEvidencePostgres(connectorInstanceId, "amazon", { dirty: 0, state: "fresh" });

    const result = await activateDraftAndAttachScheduleAtomically({
      connectorId: "amazon",
      connectorInstanceId,
      manifest: AMAZON_MANIFEST,
    });

    assert.equal(result.activated, true);
    const evidence = await postgresSummaryEvidence(connectorInstanceId);
    assert.ok(evidence, "evidence row must still exist");
    assert.equal(evidence.dirty === true || Number(evidence.dirty) === 1, true, "activation must mark evidence dirty");
    assert.equal(evidence.state, "stale", "activation must mark evidence state stale");
    assert.equal(evidence.last_error, "connector instance status changed to active");
  }
);

test(
  "Postgres: a faulted attempt leaves connector_summary_evidence in its PRIOR state, unchanged (dirty-mark rolls back too)",
  { skip: !DEDICATED_POSTGRES_URL && "PDPP_TEST_POSTGRES_URL unset" },
  async (t) => {
    const postgresUrl = DEDICATED_POSTGRES_URL;
    assert.ok(postgresUrl, "DEDICATED_POSTGRES_URL is required for this test");
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl });
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const connectorInstanceId = `cin_dirty_mark_rollback_pg_${suffix}`;
    t.after(async () => {
      __setAuthenticatedDraftActivationFaultHookForTest(null);
      await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [
        connectorInstanceId,
      ]);
      await postgresQuery("DELETE FROM connector_schedules WHERE connector_instance_id = $1", [connectorInstanceId]);
      await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [connectorInstanceId]);
      await closePostgresStorage();
      closeDb();
    });

    await postgresQuery(
      `INSERT INTO connectors(connector_id, manifest, created_at)
       VALUES ('amazon', $1::jsonb, $2)
       ON CONFLICT (connector_id) DO NOTHING`,
      [JSON.stringify(AMAZON_MANIFEST), "2026-06-01T00:00:00.000Z"]
    );
    await postgresQuery(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES ($1, 'owner_1', 'amazon', $1, 'draft', 'account', $1, $2::jsonb, $3, $3, NULL)`,
      [connectorInstanceId, JSON.stringify({ kind: "static_secret_draft" }), "2026-06-01T00:00:00.000Z"]
    );
    await seedSummaryEvidencePostgres(connectorInstanceId, "amazon", { dirty: 0, state: "fresh" });

    __setAuthenticatedDraftActivationFaultHookForTest((point) => {
      if (point === "after_activate_before_schedule") {
        throw new Error("injected fault: schedule write failure");
      }
    });

    await assert.rejects(() =>
      activateDraftAndAttachScheduleAtomically({
        connectorId: "amazon",
        connectorInstanceId,
        manifest: AMAZON_MANIFEST,
      })
    );

    const instance = await postgresQuery<{ status: string }>(
      "SELECT status FROM connector_instances WHERE connector_instance_id = $1",
      [connectorInstanceId]
    );
    assert.equal(instance.rows[0]?.status, "draft", "status rolled back");
    const evidence = await postgresSummaryEvidence(connectorInstanceId);
    assert.ok(evidence, "evidence row must still exist");
    assert.equal(
      evidence.dirty === false || Number(evidence.dirty) === 0,
      true,
      "the dirty-mark write must roll back along with the status flip"
    );
    assert.equal(evidence.state, "fresh", "prior evidence state must be unchanged after rollback");
    assert.equal(evidence.last_error, null, "prior evidence last_error must be unchanged after rollback");
  }
);

test("SQLite: concurrent activation attempts against the SAME draft connection produce exactly one activation and exactly one schedule row", async (t) => {
  closeDb();
  initDb(makeTemporaryDbPath("pdpp-atomic-concurrency-sqlite-"));
  await registerConnector(AMAZON_MANIFEST);
  const connectorInstanceId = "cin_concurrency_sqlite";
  seedDraftConnectorInstanceSqlite(connectorInstanceId, "amazon");
  t.after(() => closeDb());

  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      activateDraftAndAttachScheduleAtomically({ connectorId: "amazon", connectorInstanceId, manifest: AMAZON_MANIFEST })
    )
  );

  const activatedCount = results.filter((r) => r.activated).length;
  const scheduleAttachedCount = results.filter((r) => r.scheduleAttached).length;
  assert.equal(activatedCount, 1, "exactly one of the concurrent calls performs the activation");
  assert.equal(scheduleAttachedCount, 1, "exactly one of the concurrent calls attaches the schedule");
  assert.equal(sqliteInstanceStatus(connectorInstanceId), "active");

  const db = getDb();
  const scheduleRows = db
    .prepare("SELECT connector_instance_id FROM connector_schedules WHERE connector_instance_id = ?")
    .all(connectorInstanceId);
  assert.equal(scheduleRows.length, 1, "no duplicate schedule row from the race");
});

test(
  "Postgres: concurrent activation attempts against the SAME draft connection produce exactly one activation and exactly one schedule row",
  { skip: !DEDICATED_POSTGRES_URL && "PDPP_TEST_POSTGRES_URL unset" },
  async (t) => {
    const postgresUrl = DEDICATED_POSTGRES_URL;
    assert.ok(postgresUrl, "DEDICATED_POSTGRES_URL is required for this test");
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl });
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const connectorInstanceId = `cin_concurrency_pg_${suffix}`;
    t.after(async () => {
      await postgresQuery("DELETE FROM connector_schedules WHERE connector_instance_id = $1", [connectorInstanceId]);
      await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [connectorInstanceId]);
      await closePostgresStorage();
      closeDb();
    });

    await postgresQuery(
      `INSERT INTO connectors(connector_id, manifest, created_at)
       VALUES ('amazon', $1::jsonb, $2)
       ON CONFLICT (connector_id) DO NOTHING`,
      [JSON.stringify(AMAZON_MANIFEST), "2026-06-01T00:00:00.000Z"]
    );
    await postgresQuery(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES ($1, 'owner_1', 'amazon', $1, 'draft', 'account', $1, $2::jsonb, $3, $3, NULL)`,
      [connectorInstanceId, JSON.stringify({ kind: "static_secret_draft" }), "2026-06-01T00:00:00.000Z"]
    );

    // Real concurrent transactions against the SAME row, exercising the
    // SELECT ... FOR UPDATE lock on connector_instances that this module's
    // Postgres branch takes: without it, two concurrent callers could both
    // observe status='draft', both attempt the INSERT into
    // connector_schedules (whose PRIMARY KEY on connector_instance_id would
    // only catch that as a last-resort 23505, not a clean serialized
    // no-op) — this test proves the lock, not just the constraint, is doing
    // the serializing.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        activateDraftAndAttachScheduleAtomically({ connectorId: "amazon", connectorInstanceId, manifest: AMAZON_MANIFEST })
      )
    );

    const activatedCount = results.filter((r) => r.activated).length;
    const scheduleAttachedCount = results.filter((r) => r.scheduleAttached).length;
    assert.equal(activatedCount, 1, "exactly one of the concurrent calls performs the activation");
    assert.equal(scheduleAttachedCount, 1, "exactly one of the concurrent calls attaches the schedule");

    const instance = await postgresQuery<{ status: string }>(
      "SELECT status FROM connector_instances WHERE connector_instance_id = $1",
      [connectorInstanceId]
    );
    assert.equal(instance.rows[0]?.status, "active");
    const scheduleRows = await postgresQuery(
      "SELECT connector_instance_id FROM connector_schedules WHERE connector_instance_id = $1",
      [connectorInstanceId]
    );
    assert.equal(scheduleRows.rows.length, 1, "no duplicate schedule row from the race");
  }
);
