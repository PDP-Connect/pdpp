// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the device-source-instance-duplicate-binding-repair tool.
 *
 * Two layers:
 *
 *   1. Pure-unit tests (no DB) for grouping, authoritative-row selection,
 *      and repair-plan construction. These pin the exact decision logic:
 *      group by (owner, connector, source_kind, binding), keep only
 *      groups with > 1 non-revoked row, prefer the most-recently-
 *      heartbeated row (falling back to most-recently-created when no
 *      row in the group has ever heartbeated), and never mix distinct
 *      binding names into one group.
 *
 *   2. End-to-end tests that reproduce the EXACT live-incident shape
 *      (pdpp.vivid.fish's vivid-fish Codex connection) against the real
 *      SQLite device-exporter store and the real connection-health outbox-
 *      axis projection (`getConnectorOutboxAxis`):
 *        - BEFORE repair: two non-revoked device_source_instances rows
 *          share one binding — one heartbeating, one dead-stub-never-
 *          heartbeated — and the outbox axis reads `unknown` (poisoned),
 *          proving the untrusted-gap safety guard is doing exactly what
 *          it is designed to do given the bad data.
 *        - AFTER repair (applying the exact revoke cascade the script
 *          uses, via the real store): the dead stub is revoked, the
 *          heartbeating device and its connector_instance are untouched,
 *          and the outbox axis now reads `active`/`idle` — no longer
 *          poisoned.
 *        - A genuinely distinct device under a DIFFERENT binding name is
 *          never touched by the repair.
 *      This is the path-bound regression: it fails before the fix exists
 *      and (for the DB-backed proof) exercises the identical cascade a
 *      live repair run would use.
 *
 *   3. A real-Postgres integration test (skipped cleanly when
 *      PDPP_TEST_POSTGRES_URL is unset) that runs the actual scan +
 *      apply path end-to-end against a throwaway database.
 */

import assert from "node:assert/strict";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: localized test assertion preserves its explicit contract.
import pg from "pg";
import {
  applyRepairPlanEntry,
  buildRepairPlan,
  type DuplicateBindingRow,
  groupDuplicateBindingRows,
  scanDuplicateBindings,
  selectAuthoritativeRow,
} from "../scripts/repair/device-source-instance-duplicate-binding-repair.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import { getConnectorOutboxAxis } from "../server/ref-control.ts";
import { ensureReferenceConnectorCatalogEntry } from "../server/reference-local-connector-catalog.ts";
import { createPostgresConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { createPostgresDeviceExporterStore } from "../server/stores/device-exporter-store.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

function fakeRow(overrides: Partial<DuplicateBindingRow> & Pick<DuplicateBindingRow, "deviceId">): DuplicateBindingRow {
  return {
    connectorId: "codex",
    deviceStatus: "active",
    lastHeartbeatAt: null,
    localBindingId: "vivid-fish",
    ownerSubjectId: "owner_ref",
    sourceInstanceCreatedAt: "2026-07-24T19:27:38.004Z",
    sourceInstanceId: `dsrc_${overrides.deviceId}`,
    sourceKind: "local_device",
    ...overrides,
  };
}

// ─── Pure-unit tests (no DB) ─────────────────────────────────────────────

test("groupDuplicateBindingRows: groups by (owner, connector, source_kind, binding), keeps only groups with >1 row", () => {
  const rows: DuplicateBindingRow[] = [
    fakeRow({ deviceId: "dexp_a" }),
    fakeRow({ deviceId: "dexp_b" }),
    // A different binding name — must be its own group, and being a
    // singleton, must NOT appear in the output at all.
    fakeRow({ deviceId: "dexp_c", localBindingId: "laptop-other" }),
    // A different connector — must never merge with the codex group.
    fakeRow({ connectorId: "claude_code", deviceId: "dexp_d" }),
  ];
  const groups = groupDuplicateBindingRows(rows);
  assert.equal(groups.length, 1, "only the genuinely duplicated binding forms a group");
  const [group] = groups;
  assert.ok(group);
  assert.equal(group.connectorId, "codex");
  assert.equal(group.localBindingId, "vivid-fish");
  assert.equal(group.rows.length, 2);
  assert.deepEqual(group.rows.map((r) => r.deviceId).sort(), ["dexp_a", "dexp_b"]);
});

test("groupDuplicateBindingRows: no duplicates at all yields an empty plan", () => {
  const rows: DuplicateBindingRow[] = [
    fakeRow({ deviceId: "dexp_a" }),
    fakeRow({ deviceId: "dexp_b", localBindingId: "laptop-other" }),
  ];
  assert.deepEqual(groupDuplicateBindingRows(rows), []);
});

test("selectAuthoritativeRow: prefers the most recently heartbeated row over one that never heartbeated", () => {
  const stale = fakeRow({ deviceId: "dexp_dead", lastHeartbeatAt: null });
  const healthy = fakeRow({ deviceId: "dexp_live", lastHeartbeatAt: "2026-07-31T19:15:02.056Z" });
  const winner = selectAuthoritativeRow([stale, healthy]);
  assert.equal(winner.deviceId, "dexp_live");
});

test("selectAuthoritativeRow: prefers the MOST RECENT heartbeat when multiple rows have heartbeated", () => {
  const older = fakeRow({ deviceId: "dexp_older", lastHeartbeatAt: "2026-07-25T13:03:56.454Z" });
  const newer = fakeRow({ deviceId: "dexp_newer", lastHeartbeatAt: "2026-07-31T19:15:02.056Z" });
  const winner = selectAuthoritativeRow([older, newer]);
  assert.equal(winner.deviceId, "dexp_newer");
});

test("selectAuthoritativeRow: falls back to most-recently-created when NO row has ever heartbeated", () => {
  const older = fakeRow({
    deviceId: "dexp_older",
    lastHeartbeatAt: null,
    sourceInstanceCreatedAt: "2026-07-24T19:27:38.004Z",
  });
  const newer = fakeRow({
    deviceId: "dexp_newer",
    lastHeartbeatAt: null,
    sourceInstanceCreatedAt: "2026-07-25T06:51:11.845Z",
  });
  const winner = selectAuthoritativeRow([older, newer]);
  assert.equal(winner.deviceId, "dexp_newer", "newest enrollment attempt wins when nothing has ever heartbeated");
});

test("selectAuthoritativeRow: deterministic tie-break by device_id when timestamps are identical", () => {
  const a = fakeRow({ deviceId: "dexp_aaa", lastHeartbeatAt: "2026-07-31T19:15:02.056Z" });
  const b = fakeRow({ deviceId: "dexp_bbb", lastHeartbeatAt: "2026-07-31T19:15:02.056Z" });
  assert.equal(selectAuthoritativeRow([a, b]).deviceId, "dexp_aaa");
  assert.equal(selectAuthoritativeRow([b, a]).deviceId, "dexp_aaa", "order-independent");
});

test("buildRepairPlan: the exact live-incident shape supersedes only the dead stub", () => {
  const deadStub = fakeRow({ deviceId: "dexp_b07c56a6e71de9ae", lastHeartbeatAt: null });
  const liveDevice = fakeRow({ deviceId: "dexp_3fab667e951ed1d7", lastHeartbeatAt: "2026-07-31T19:15:02.056Z" });
  const groups = groupDuplicateBindingRows([deadStub, liveDevice]);
  const plan = buildRepairPlan(groups);
  assert.equal(plan.length, 1);
  const [entry] = plan;
  assert.ok(entry);
  assert.equal(entry.authoritative.deviceId, "dexp_3fab667e951ed1d7");
  assert.equal(entry.superseded.length, 1);
  assert.equal(entry.superseded[0]?.deviceId, "dexp_b07c56a6e71de9ae");
});

// ─── End-to-end (SQLite): reproduce the exact live-incident shape ────────

test("live-incident shape: a dead never-heartbeated stub poisons the outbox axis to 'unknown' before repair, and repair clears it without touching the healthy device", async () => {
  initDb(":memory:");
  try {
    const { createSqliteDeviceExporterStore } = await import("../server/stores/device-exporter-store.ts");
    const { createSqliteConnectorInstanceStore } = await import("../server/stores/connector-instance-store.ts");
    const deviceStore = createSqliteDeviceExporterStore();
    const connectorStore = createSqliteConnectorInstanceStore();

    const owner = "owner_ref";
    const connectorId = "codex";
    const sourceKind = "local_device";
    const bindingId = "vivid-fish";
    const now = new Date().toISOString();
    await ensureReferenceConnectorCatalogEntry(connectorId, "vivid-fish Codex");

    // First device enrolls, completes (code consumed), but never heartbeats
    // — the exact shape of the abandoned 2026-07-24 enrollment attempt.
    const first = deviceStore.resolveOrCreateEnrollmentDevice({
      candidateDeviceId: "dexp_b07c56a6e71de9ae",
      candidateSourceInstanceId: "dsrc_fbff3caefba6c972",
      collectorProtocolVersion: null,
      connectorId,
      displayName: "vivid-fish Codex",
      localBindingId: bindingId,
      now,
      ownerSubjectId: owner,
      sourceKind,
    });
    assert.equal(first.adopted, false);

    const connectorInstanceOrNull = await connectorStore.upsertForEnrollment({
      connectorId,
      createdAt: now,
      displayName: "vivid-fish Codex",
      ownerSubjectId: owner,
      sourceBinding: {
        device_id: first.deviceId,
        kind: sourceKind,
        local_binding_name: bindingId,
        source_instance_id: first.sourceInstanceId,
      },
      sourceBindingKey: `local_device:${bindingId}`,
      sourceKind,
      status: "active",
      updatedAt: now,
    });
    assert.ok(connectorInstanceOrNull, "connector instance upsert must succeed");
    const connectorInstance = connectorInstanceOrNull;
    deviceStore.upsertSourceInstance({
      connectorId,
      connectorInstanceId: connectorInstance.connectorInstanceId,
      createdAt: now,
      deviceId: first.deviceId,
      displayName: null,
      localBindingId: bindingId,
      sourceInstanceId: first.sourceInstanceId,
      sourceKind,
      updatedAt: now,
    });
    deviceStore.createEnrollmentCode({
      codeHash: "hash1",
      connectorId,
      createdAt: now,
      displayName: null,
      enrollmentCodeId: "denroll_1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      localBindingId: bindingId,
      ownerSubjectId: owner,
    });
    deviceStore.consumeEnrollmentCode("denroll_1", first.deviceId, now);
    // First device NEVER heartbeats — this is the defect shape.

    // A live device re-enrolls under the SAME binding, resumes the SAME
    // connector_instance (the fix in performFirstEnrollment prevents this
    // NEW device from ever creating this problem going forward — but this
    // test seeds the PRE-fix duplicate directly, to prove the repair tool
    // handles rows that already exist).
    const second = deviceStore.resolveOrCreateEnrollmentDevice({
      candidateDeviceId: "dexp_3fab667e951ed1d7",
      candidateSourceInstanceId: "dsrc_83b8eae8f40c5b86",
      collectorProtocolVersion: null,
      connectorId,
      displayName: "vivid-fish Codex",
      localBindingId: bindingId,
      now,
      ownerSubjectId: owner,
      sourceKind,
    });
    assert.equal(second.adopted, false);
    assert.notEqual(second.deviceId, first.deviceId);
    deviceStore.upsertSourceInstance({
      connectorId,
      connectorInstanceId: connectorInstance.connectorInstanceId,
      createdAt: now,
      deviceId: second.deviceId,
      displayName: null,
      localBindingId: bindingId,
      sourceInstanceId: second.sourceInstanceId,
      sourceKind,
      updatedAt: now,
    });
    // The live device heartbeats regularly.
    deviceStore.markDeviceHeartbeat(second.deviceId, {
      agentVersion: null,
      lastError: undefined,
      receivedAt: now,
    });
    deviceStore.markSourceInstanceHeartbeat(second.deviceId, second.sourceInstanceId, {
      lastError: undefined,
      outboxDiagnostics: undefined,
      receivedAt: now,
      recordsPending: 0,
      status: "healthy",
    });

    // A genuinely distinct device under a DIFFERENT binding must never be
    // touched by anything below.
    const distinct = deviceStore.resolveOrCreateEnrollmentDevice({
      candidateDeviceId: "dexp_office_desktop",
      candidateSourceInstanceId: "dsrc_office_desktop",
      collectorProtocolVersion: null,
      connectorId,
      displayName: "vivid-fish office desktop",
      localBindingId: "vivid-fish-office-desktop",
      now,
      ownerSubjectId: owner,
      sourceKind,
    });
    deviceStore.upsertSourceInstance({
      connectorId,
      connectorInstanceId: "cin_office_desktop_placeholder",
      createdAt: now,
      deviceId: distinct.deviceId,
      displayName: null,
      localBindingId: "vivid-fish-office-desktop",
      sourceInstanceId: distinct.sourceInstanceId,
      sourceKind,
      updatedAt: now,
    });

    // ── BEFORE repair: the outbox axis is poisoned to `unknown` ──
    const before = await getConnectorOutboxAxis(connectorId, {
      connectorInstanceId: connectorInstance.connectorInstanceId,
    });
    assert.equal(
      before.axis,
      "unknown",
      "the dead never-heartbeated stub correctly poisons the aggregation before repair — proves the untrusted-gap guard is conservative, not broken"
    );

    // ── Scan (against the same in-memory SQLite db via raw queries,
    // since scanDuplicateBindings is Postgres-only by design; here we
    // prove the SAME grouping/selection decision the tool would make,
    // reading the rows directly) ──
    const rawRows = getDb()
      .prepare(
        `SELECT de.owner_subject_id AS ownerSubjectId, dsi.connector_id AS connectorId, dsi.source_kind AS sourceKind,
                dsi.local_binding_id AS localBindingId, dsi.device_id AS deviceId, dsi.source_instance_id AS sourceInstanceId,
                dsi.last_heartbeat_at AS lastHeartbeatAt, dsi.created_at AS sourceInstanceCreatedAt, de.status AS deviceStatus
           FROM device_source_instances dsi
           JOIN device_exporters de ON de.device_id = dsi.device_id
          WHERE dsi.status != 'revoked' AND de.status != 'revoked'`
      )
      .all() as DuplicateBindingRow[];
    const groups = groupDuplicateBindingRows(rawRows);
    assert.equal(groups.length, 1, "exactly one duplicate-binding group exists — the office desktop is a singleton");
    const plan = buildRepairPlan(groups);
    assert.equal(plan.length, 1);
    const [entry] = plan;
    assert.ok(entry);
    assert.equal(entry.authoritative.deviceId, second.deviceId, "the heartbeating device is authoritative");
    assert.equal(entry.superseded.length, 1);
    assert.equal(entry.superseded[0]?.deviceId, first.deviceId, "the dead stub is the one superseded");

    // ── Apply the repair (same cascade the script's applyRepairPlanEntry
    // uses; exercised here via the real SQLite store's revokeDevice so
    // the test also proves the cascade itself, not just the plan) ──
    deviceStore.revokeDevice(first.deviceId, new Date().toISOString());

    const firstDeviceRow = deviceStore.getDevice(first.deviceId);
    assert.equal(firstDeviceRow?.status, "revoked");
    const secondDeviceRow = deviceStore.getDevice(second.deviceId);
    assert.equal(secondDeviceRow?.status, "active", "the live device must be untouched");
    const connectorInstanceRow = await connectorStore.get(connectorInstance.connectorInstanceId);
    assert.equal(connectorInstanceRow?.status, "active", "the shared connector_instance must survive the repair");
    const distinctDeviceRow = deviceStore.getDevice(distinct.deviceId);
    assert.equal(distinctDeviceRow?.status, "active", "a genuinely distinct binding must never be touched");

    // ── AFTER repair: the outbox axis reads active/idle, no longer unknown ──
    const after = await getConnectorOutboxAxis(connectorId, {
      connectorInstanceId: connectorInstance.connectorInstanceId,
    });
    assert.notEqual(after.axis, "unknown", "the stale duplicate no longer poisons the aggregation");
    assert.ok(after.axis === "active" || after.axis === "idle", `expected active or idle, got ${after.axis}`);
  } finally {
    closeDb();
  }
});

// ─── Real-Postgres integration test ──────────────────────────────────────

test("PostgreSQL: scanDuplicateBindings + buildRepairPlan + applyRepairPlanEntry repairs the live shape end-to-end", {
  skip: POSTGRES_URL ? false : "skipped: PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  const postgresUrl = POSTGRES_URL as string;
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: postgresUrl,
      databaseName: `pdpp_test_dupbind_${process.pid}_${Date.now()}`,
    },
    async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      await ensureReferenceConnectorCatalogEntry("codex", "vivid-fish Codex");

      const deviceStore = createPostgresDeviceExporterStore();
      const connectorStore = createPostgresConnectorInstanceStore();
      const owner = "owner_ref";
      const connectorId = "codex";
      const sourceKind = "local_device";
      const bindingId = "vivid-fish";
      const now = new Date().toISOString();

      const first = await deviceStore.resolveOrCreateEnrollmentDevice({
        candidateDeviceId: "dexp_first_pg",
        candidateSourceInstanceId: "dsrc_first_pg",
        collectorProtocolVersion: null,
        connectorId,
        displayName: "vivid-fish Codex",
        localBindingId: bindingId,
        now,
        ownerSubjectId: owner,
        sourceKind,
      });
      const connectorInstanceOrNull = await connectorStore.upsertForEnrollment({
        connectorId,
        createdAt: now,
        displayName: "vivid-fish Codex",
        ownerSubjectId: owner,
        sourceBinding: {
          device_id: first.deviceId,
          kind: sourceKind,
          local_binding_name: bindingId,
          source_instance_id: first.sourceInstanceId,
        },
        sourceBindingKey: `local_device:${bindingId}`,
        sourceKind,
        status: "active",
        updatedAt: now,
      });
      assert.ok(connectorInstanceOrNull, "connector instance upsert must succeed");
      const connectorInstance = connectorInstanceOrNull;
      await deviceStore.upsertSourceInstance({
        connectorId,
        connectorInstanceId: connectorInstance.connectorInstanceId,
        createdAt: now,
        deviceId: first.deviceId,
        displayName: null,
        localBindingId: bindingId,
        sourceInstanceId: first.sourceInstanceId,
        sourceKind,
        updatedAt: now,
      });
      await deviceStore.createEnrollmentCode({
        codeHash: "hash1",
        connectorId,
        createdAt: now,
        displayName: null,
        enrollmentCodeId: "denroll_pg_1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        localBindingId: bindingId,
        ownerSubjectId: owner,
      });
      await deviceStore.consumeEnrollmentCode("denroll_pg_1", first.deviceId, now);
      // first never heartbeats.

      const second = await deviceStore.resolveOrCreateEnrollmentDevice({
        candidateDeviceId: "dexp_second_pg",
        candidateSourceInstanceId: "dsrc_second_pg",
        collectorProtocolVersion: null,
        connectorId,
        displayName: "vivid-fish Codex",
        localBindingId: bindingId,
        now,
        ownerSubjectId: owner,
        sourceKind,
      });
      await deviceStore.upsertSourceInstance({
        connectorId,
        connectorInstanceId: connectorInstance.connectorInstanceId,
        createdAt: now,
        deviceId: second.deviceId,
        displayName: null,
        localBindingId: bindingId,
        sourceInstanceId: second.sourceInstanceId,
        sourceKind,
        updatedAt: now,
      });
      await deviceStore.markDeviceHeartbeat(second.deviceId, {
        agentVersion: null,
        lastError: undefined,
        receivedAt: now,
      });
      await deviceStore.markSourceInstanceHeartbeat(second.deviceId, second.sourceInstanceId, {
        lastError: undefined,
        outboxDiagnostics: undefined,
        receivedAt: now,
        recordsPending: 0,
        status: "healthy",
      });

      const pool = new pg.Pool({ connectionString: url });
      try {
        const groups = await scanDuplicateBindings(pool, { connectorId, ownerSubjectId: owner });
        assert.equal(groups.length, 1);
        const plan = buildRepairPlan(groups);
        assert.equal(plan.length, 1);
        const [entry] = plan;
        assert.ok(entry);
        assert.equal(entry.authoritative.deviceId, second.deviceId);
        assert.equal(entry.superseded[0]?.deviceId, first.deviceId);

        const applied = await applyRepairPlanEntry(pool, entry, new Date().toISOString());
        assert.equal(applied.authoritativeDeviceId, second.deviceId);
        assert.deepEqual(applied.supersededDeviceIds, [first.deviceId]);

        const firstDevice = await deviceStore.getDevice(first.deviceId);
        assert.equal(firstDevice?.status, "revoked");
        const secondDevice = await deviceStore.getDevice(second.deviceId);
        assert.equal(secondDevice?.status, "active");
        const connectorInstanceRow = await connectorStore.get(connectorInstance.connectorInstanceId);
        assert.equal(connectorInstanceRow?.status, "active");

        // Idempotent: re-running the scan finds nothing left to repair.
        const groupsAfter = await scanDuplicateBindings(pool, { connectorId, ownerSubjectId: owner });
        assert.equal(groupsAfter.length, 0, "re-running after apply finds zero duplicate groups");
      } finally {
        await pool.end();
      }
    }
  );
});

// Independent-gate regression: `applyRepairPlanEntry` must never trust a
// candidate plan's authoritative pick — it must revalidate under a fresh
// lock immediately before writing. This test builds a STALE plan (captured
// from an earlier scan) that names the WRONG device as authoritative, then
// mutates the database so the OTHER device becomes genuinely authoritative
// (a real heartbeat lands) BEFORE `applyRepairPlanEntry` runs — simulating
// exactly the race a concurrent heartbeat, re-enrollment, or another repair
// run could cause between scan and apply. Proves the newly-authoritative
// device is NEVER revoked, contradicting the stale plan, because the
// transaction re-derives truth from a `SELECT ... FOR UPDATE` read taken
// inside the transaction, not from the plan object passed in.
test("PostgreSQL: applyRepairPlanEntry revalidates under lock and never revokes a device that became authoritative after the plan was built", {
  skip: POSTGRES_URL ? false : "skipped: PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  const postgresUrl = POSTGRES_URL as string;
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: postgresUrl,
      databaseName: `pdpp_test_dupbind_stale_${process.pid}_${Date.now()}`,
    },
    async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      await ensureReferenceConnectorCatalogEntry("codex", "vivid-fish Codex");

      const deviceStore = createPostgresDeviceExporterStore();
      const connectorStore = createPostgresConnectorInstanceStore();
      const owner = "owner_ref";
      const connectorId = "codex";
      const sourceKind = "local_device";
      const bindingId = "vivid-fish";
      const now = new Date().toISOString();

      // Neither device has heartbeated yet: authoritative selection falls
      // back to most-recently-created, so `second` (created after `first`)
      // is the candidate authoritative row at scan time.
      const first = await deviceStore.resolveOrCreateEnrollmentDevice({
        candidateDeviceId: "dexp_stale_first",
        candidateSourceInstanceId: "dsrc_stale_first",
        collectorProtocolVersion: null,
        connectorId,
        displayName: "vivid-fish Codex",
        localBindingId: bindingId,
        now,
        ownerSubjectId: owner,
        sourceKind,
      });
      const connectorInstanceOrNull = await connectorStore.upsertForEnrollment({
        connectorId,
        createdAt: now,
        displayName: "vivid-fish Codex",
        ownerSubjectId: owner,
        sourceBinding: {
          device_id: first.deviceId,
          kind: sourceKind,
          local_binding_name: bindingId,
          source_instance_id: first.sourceInstanceId,
        },
        sourceBindingKey: `local_device:${bindingId}`,
        sourceKind,
        status: "active",
        updatedAt: now,
      });
      assert.ok(connectorInstanceOrNull);
      const connectorInstance = connectorInstanceOrNull;
      await deviceStore.upsertSourceInstance({
        connectorId,
        connectorInstanceId: connectorInstance.connectorInstanceId,
        createdAt: now,
        deviceId: first.deviceId,
        displayName: null,
        localBindingId: bindingId,
        sourceInstanceId: first.sourceInstanceId,
        sourceKind,
        updatedAt: now,
      });
      await deviceStore.createEnrollmentCode({
        codeHash: "hash_stale_1",
        connectorId,
        createdAt: now,
        displayName: null,
        enrollmentCodeId: "denroll_stale_1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        localBindingId: bindingId,
        ownerSubjectId: owner,
      });
      await deviceStore.consumeEnrollmentCode("denroll_stale_1", first.deviceId, now);

      const later = new Date(Date.now() + 1000).toISOString();
      const second = await deviceStore.resolveOrCreateEnrollmentDevice({
        candidateDeviceId: "dexp_stale_second",
        candidateSourceInstanceId: "dsrc_stale_second",
        collectorProtocolVersion: null,
        connectorId,
        displayName: "vivid-fish Codex",
        localBindingId: bindingId,
        now: later,
        ownerSubjectId: owner,
        sourceKind,
      });
      await deviceStore.upsertSourceInstance({
        connectorId,
        connectorInstanceId: connectorInstance.connectorInstanceId,
        createdAt: later,
        deviceId: second.deviceId,
        displayName: null,
        localBindingId: bindingId,
        sourceInstanceId: second.sourceInstanceId,
        sourceKind,
        updatedAt: later,
      });

      const pool = new pg.Pool({ connectionString: url });
      try {
        // Build the CANDIDATE plan now: neither device has heartbeated, so
        // `second` (most recently created) is the stale plan's pick.
        const groups = await scanDuplicateBindings(pool, { connectorId, ownerSubjectId: owner });
        assert.equal(groups.length, 1);
        const plan = buildRepairPlan(groups);
        const [staleEntry] = plan;
        assert.ok(staleEntry);
        assert.equal(
          staleEntry.authoritative.deviceId,
          second.deviceId,
          "the stale plan (correctly, at scan time) names `second` authoritative"
        );
        assert.equal(staleEntry.superseded[0]?.deviceId, first.deviceId);

        // THE RACE: between scan and apply, `first` heartbeats — a real
        // collector coming back online, or a concurrent enrollment
        // completing. `first` is now the genuinely authoritative device,
        // even though the plan captured above still names `second`.
        const raceHeartbeatAt = new Date(Date.now() + 2000).toISOString();
        await deviceStore.markDeviceHeartbeat(first.deviceId, {
          agentVersion: null,
          lastError: undefined,
          receivedAt: raceHeartbeatAt,
        });
        await deviceStore.markSourceInstanceHeartbeat(first.deviceId, first.sourceInstanceId, {
          lastError: undefined,
          outboxDiagnostics: undefined,
          receivedAt: raceHeartbeatAt,
          recordsPending: 0,
          status: "healthy",
        });

        // Apply the STALE plan. It must revalidate under lock and protect
        // `first` (now genuinely authoritative) instead of blindly
        // executing what the stale plan said.
        const applied = await applyRepairPlanEntry(pool, staleEntry, new Date().toISOString());
        assert.equal(
          applied.authoritativeDeviceId,
          first.deviceId,
          "revalidation under lock must pick the NOW-authoritative device, not the stale plan's pick"
        );
        assert.deepEqual(
          applied.supersededDeviceIds,
          [second.deviceId],
          "only the now-non-authoritative device is revoked — never the newly-authoritative one"
        );

        const firstDevice = await deviceStore.getDevice(first.deviceId);
        assert.equal(
          firstDevice?.status,
          "active",
          "the newly-authoritative device must survive, contradicting the stale plan's pick"
        );
        const secondDevice = await deviceStore.getDevice(second.deviceId);
        assert.equal(secondDevice?.status, "revoked");
        const connectorInstanceRow = await connectorStore.get(connectorInstance.connectorInstanceId);
        assert.equal(connectorInstanceRow?.status, "active", "the shared connector_instance must survive");

        // Idempotent under the race too: re-scanning finds nothing left.
        const groupsAfter = await scanDuplicateBindings(pool, { connectorId, ownerSubjectId: owner });
        assert.equal(groupsAfter.length, 0);
      } finally {
        await pool.end();
      }
    }
  );
});

// Independent-gate regression: applying the SAME (now-stale) plan a second
// time — simulating two concurrent repair runs, or a retried repair after a
// transient failure — must be a safe no-op, never double-revoking or
// erroring. Proves idempotency holds even when the group has already
// converged to a single survivor by the time this call's lock acquires.
test("PostgreSQL: applyRepairPlanEntry is a safe no-op when the group already converged to one survivor", {
  skip: POSTGRES_URL ? false : "skipped: PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  const postgresUrl = POSTGRES_URL as string;
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: postgresUrl,
      databaseName: `pdpp_test_dupbind_reapply_${process.pid}_${Date.now()}`,
    },
    async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      await ensureReferenceConnectorCatalogEntry("codex", "vivid-fish Codex");

      const deviceStore = createPostgresDeviceExporterStore();
      const connectorStore = createPostgresConnectorInstanceStore();
      const owner = "owner_ref";
      const connectorId = "codex";
      const sourceKind = "local_device";
      const bindingId = "vivid-fish";
      const now = new Date().toISOString();

      const first = await deviceStore.resolveOrCreateEnrollmentDevice({
        candidateDeviceId: "dexp_reapply_first",
        candidateSourceInstanceId: "dsrc_reapply_first",
        collectorProtocolVersion: null,
        connectorId,
        displayName: "vivid-fish Codex",
        localBindingId: bindingId,
        now,
        ownerSubjectId: owner,
        sourceKind,
      });
      const connectorInstanceOrNull = await connectorStore.upsertForEnrollment({
        connectorId,
        createdAt: now,
        displayName: "vivid-fish Codex",
        ownerSubjectId: owner,
        sourceBinding: {
          device_id: first.deviceId,
          kind: sourceKind,
          local_binding_name: bindingId,
          source_instance_id: first.sourceInstanceId,
        },
        sourceBindingKey: `local_device:${bindingId}`,
        sourceKind,
        status: "active",
        updatedAt: now,
      });
      assert.ok(connectorInstanceOrNull);
      const connectorInstance = connectorInstanceOrNull;
      await deviceStore.upsertSourceInstance({
        connectorId,
        connectorInstanceId: connectorInstance.connectorInstanceId,
        createdAt: now,
        deviceId: first.deviceId,
        displayName: null,
        localBindingId: bindingId,
        sourceInstanceId: first.sourceInstanceId,
        sourceKind,
        updatedAt: now,
      });
      await deviceStore.createEnrollmentCode({
        codeHash: "hash_reapply_1",
        connectorId,
        createdAt: now,
        displayName: null,
        enrollmentCodeId: "denroll_reapply_1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        localBindingId: bindingId,
        ownerSubjectId: owner,
      });
      await deviceStore.consumeEnrollmentCode("denroll_reapply_1", first.deviceId, now);

      const second = await deviceStore.resolveOrCreateEnrollmentDevice({
        candidateDeviceId: "dexp_reapply_second",
        candidateSourceInstanceId: "dsrc_reapply_second",
        collectorProtocolVersion: null,
        connectorId,
        displayName: "vivid-fish Codex",
        localBindingId: bindingId,
        now,
        ownerSubjectId: owner,
        sourceKind,
      });
      await deviceStore.upsertSourceInstance({
        connectorId,
        connectorInstanceId: connectorInstance.connectorInstanceId,
        createdAt: now,
        deviceId: second.deviceId,
        displayName: null,
        localBindingId: bindingId,
        sourceInstanceId: second.sourceInstanceId,
        sourceKind,
        updatedAt: now,
      });
      await deviceStore.markDeviceHeartbeat(second.deviceId, {
        agentVersion: null,
        lastError: undefined,
        receivedAt: now,
      });
      await deviceStore.markSourceInstanceHeartbeat(second.deviceId, second.sourceInstanceId, {
        lastError: undefined,
        outboxDiagnostics: undefined,
        receivedAt: now,
        recordsPending: 0,
        status: "healthy",
      });

      const pool = new pg.Pool({ connectionString: url });
      try {
        const groups = await scanDuplicateBindings(pool, { connectorId, ownerSubjectId: owner });
        const plan = buildRepairPlan(groups);
        const [entry] = plan;
        assert.ok(entry);

        const firstApply = await applyRepairPlanEntry(pool, entry, new Date().toISOString());
        assert.deepEqual(firstApply.supersededDeviceIds, [first.deviceId]);

        // Re-apply the SAME (now-stale) plan entry a second time — the
        // group has already converged to one non-revoked survivor
        // (`second`). This must be a safe no-op: no error, nothing
        // additionally revoked, `second` still active.
        const secondApply = await applyRepairPlanEntry(pool, entry, new Date().toISOString());
        assert.deepEqual(secondApply.supersededDeviceIds, [], "a converged group has nothing left to revoke");
        assert.equal(secondApply.authoritativeDeviceId, second.deviceId);

        const secondDevice = await deviceStore.getDevice(second.deviceId);
        assert.equal(secondDevice?.status, "active", "the sole survivor must remain active after a redundant re-apply");
      } finally {
        await pool.end();
      }
    }
  );
});
