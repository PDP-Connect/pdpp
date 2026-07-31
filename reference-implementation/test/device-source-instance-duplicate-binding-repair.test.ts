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
    connectorInstanceId: "cin_fake_shared",
    deviceStatus: "active",
    lastHeartbeatAt: null,
    localBindingId: "vivid-fish",
    ownerSubjectId: "owner_ref",
    sourceInstanceCreatedAt: "2026-07-24T19:27:38.004Z",
    sourceInstanceId: `dsrc_${overrides.deviceId}`,
    sourceKind: "local_device",
    sourceKindWasLegacyNull: false,
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

test("groupDuplicateBindingRows: two genuinely DISTINCT identity 4-tuples that collide under a plain space-join must NOT be merged into one group", () => {
  // Hardening regression (independent-gate non-blocking finding): the
  // grouping key used to be `[owner, connector, sourceKind, binding].join(" ")`
  // — a non-injective encoding. Shifting a space across the owner/connector
  // field boundary produces two DIFFERENT 4-tuples that join to the IDENTICAL
  // string:
  //   owner="a b", connector="c"   -> joined "a b c local_device x"
  //   owner="a",   connector="b c" -> joined "a b c local_device x"
  // Under the old join-based key these two rows — which belong to two
  // completely unrelated owners/connectors — would have been merged into one
  // "duplicate" group, and buildRepairPlan would then propose superseding one
  // real device on behalf of an unrelated owner: a misleading, unsafe
  // candidate plan (the actual write path in applyRepairPlanEntry revalidates
  // against the exact discrete SQL fields under lock, so this class of bug
  // was confined to the candidate-plan grouping, never a live write — but a
  // misleading plan is still a real defect this test closes).
  const collidingA = fakeRow({
    connectorId: "c",
    deviceId: "dexp_collide_a",
    localBindingId: "x",
    ownerSubjectId: "a b",
    sourceKind: "local_device",
  });
  const collidingB = fakeRow({
    connectorId: "b c",
    deviceId: "dexp_collide_b",
    localBindingId: "x",
    ownerSubjectId: "a",
    sourceKind: "local_device",
  });
  // Sanity: prove the two rows genuinely collide under the OLD (rejected)
  // space-join encoding, so this test would have caught the original defect.
  const oldSpaceJoinKey = (row: DuplicateBindingRow) =>
    [row.ownerSubjectId, row.connectorId, row.sourceKind, row.localBindingId].join(" ");
  assert.equal(
    oldSpaceJoinKey(collidingA),
    oldSpaceJoinKey(collidingB),
    "these two rows must genuinely collide under a plain space-join — otherwise this is not the counterexample the fix addresses"
  );

  // The FIXED (JSON.stringify-based) grouping must treat them as two
  // distinct, unrelated singleton owners — never merged into one group.
  const groups = groupDuplicateBindingRows([collidingA, collidingB]);
  assert.deepEqual(
    groups,
    [],
    "two distinct identity 4-tuples must never be merged into a duplicate group merely because they collide under a naive delimiter join"
  );
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

// Live-shape correction regression (this follow-up): a dry-run against the
// ACTUAL deployed pdpp.vivid.fish database found ZERO duplicate groups —
// disproving an earlier report's claim to reproduce the exact live shape.
// Direct DB inspection showed why: the dead stub row
// (dsrc_fbff3caefba6c972 / dexp_b07c56a6e71de9ae) has `source_kind IS
// NULL` (a legacy row that predates the source_kind column, never
// backfilled), while the healthy row has `source_kind = 'local_device'`.
// The prior scan query filtered `dsi.source_kind IS NOT NULL`, silently
// excluding the NULL row from ever being scanned — the live duplicate was
// invisible to the tool that exists to find it. This test builds that
// EXACT shape with raw SQL (the store's own resolveOrCreateEnrollmentDevice
// always writes a non-NULL kind, so a legacy NULL row can only be
// constructed directly) and proves the fixed scan finds it, correctly
// resolves its effective kind from connector_instances.source_kind, and
// the full dry-run/apply/idempotency cycle repairs it — normalizing the
// legacy NULL to a real value in the same transaction as the revoke.
test("PostgreSQL: exact live-incident shape — a legacy NULL-source_kind row is found, resolved via connector_instances, and repaired (dry-run / apply / idempotency)", {
  skip: POSTGRES_URL ? false : "skipped: PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  const postgresUrl = POSTGRES_URL as string;
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: postgresUrl,
      databaseName: `pdpp_test_dupbind_nullkind_${process.pid}_${Date.now()}`,
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

      // The dead stub: enrolled the normal way (which always writes a
      // non-NULL source_kind), then its source_kind is forced to NULL
      // via raw SQL — reproducing the legacy pre-column-backfill shape
      // exactly, since the store itself cannot write a NULL kind.
      const deadStub = await deviceStore.resolveOrCreateEnrollmentDevice({
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
      const connectorInstanceOrNull = await connectorStore.upsertForEnrollment({
        connectorId,
        createdAt: now,
        displayName: "vivid-fish Codex",
        ownerSubjectId: owner,
        sourceBinding: {
          device_id: deadStub.deviceId,
          kind: sourceKind,
          local_binding_name: bindingId,
          source_instance_id: deadStub.sourceInstanceId,
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
        deviceId: deadStub.deviceId,
        displayName: null,
        localBindingId: bindingId,
        sourceInstanceId: deadStub.sourceInstanceId,
        sourceKind,
        updatedAt: now,
      });
      // deadStub never heartbeats — the abandoned-enrollment shape.

      const pool = new pg.Pool({ connectionString: url });
      try {
        // Force the legacy shape: source_kind NULL on the dead stub's row.
        await pool.query("UPDATE device_source_instances SET source_kind = NULL WHERE source_instance_id = $1", [
          deadStub.sourceInstanceId,
        ]);
        const forcedNull = await pool.query(
          "SELECT source_kind FROM device_source_instances WHERE source_instance_id = $1",
          [deadStub.sourceInstanceId]
        );
        assert.equal(forcedNull.rows[0]?.source_kind, null, "the dead stub's raw source_kind must genuinely be NULL");

        // The healthy device: normal enrollment, real heartbeat, real
        // non-NULL source_kind — exactly the live shape's other row.
        const healthy = await deviceStore.resolveOrCreateEnrollmentDevice({
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
        await deviceStore.upsertSourceInstance({
          connectorId,
          connectorInstanceId: connectorInstance.connectorInstanceId,
          createdAt: now,
          deviceId: healthy.deviceId,
          displayName: null,
          localBindingId: bindingId,
          sourceInstanceId: healthy.sourceInstanceId,
          sourceKind,
          updatedAt: now,
        });
        await deviceStore.markDeviceHeartbeat(healthy.deviceId, {
          agentVersion: null,
          lastError: undefined,
          receivedAt: now,
        });
        await deviceStore.markSourceInstanceHeartbeat(healthy.deviceId, healthy.sourceInstanceId, {
          lastError: undefined,
          outboxDiagnostics: undefined,
          receivedAt: now,
          recordsPending: 0,
          status: "healthy",
        });

        // ── MUTATION PROOF: the OLD filter (source_kind IS NOT NULL)
        // would find zero groups here, exactly reproducing the false
        // "no groups" dry-run result the live incident report caught. ──
        const oldFilterRows = await pool.query(
          `SELECT dsi.source_instance_id
               FROM device_source_instances dsi
               JOIN device_exporters de ON de.device_id = dsi.device_id
              WHERE dsi.status != 'revoked'
                AND de.status != 'revoked'
                AND dsi.source_kind IS NOT NULL
                AND dsi.connector_id = $1
                AND dsi.local_binding_id = $2`,
          [connectorId, bindingId]
        );
        assert.equal(
          oldFilterRows.rows.length,
          1,
          "the OLD (rejected) source_kind IS NOT NULL filter must find only the healthy row, missing the dead stub entirely — proving the old code would have reported zero duplicate groups for this exact live shape"
        );

        // ── THE FIX: scanDuplicateBindings must find BOTH rows and
        // group them, resolving the NULL row's kind via connector_
        // instances. ──
        const groups = await scanDuplicateBindings(pool, { connectorId, ownerSubjectId: owner });
        assert.equal(groups.length, 1, "the fixed scan must find the duplicate group the old filter missed");
        const [group] = groups;
        assert.ok(group);
        assert.equal(group.connectorInstanceId, connectorInstance.connectorInstanceId);
        assert.equal(
          group.sourceKind,
          "local_device",
          "the group's effective kind is resolved from connector_instances, never left NULL or guessed"
        );
        assert.equal(group.rows.length, 2);

        const plan = buildRepairPlan(groups);
        assert.equal(plan.length, 1);
        const [entry] = plan;
        assert.ok(entry);
        assert.equal(
          entry.authoritative.deviceId,
          healthy.deviceId,
          "the heartbeating device is authoritative regardless of the other row's legacy-NULL kind"
        );
        assert.equal(entry.superseded[0]?.deviceId, deadStub.deviceId);

        // Dry-run (scan + plan) must not have mutated anything.
        const preApplyStub = await deviceStore.getDevice(deadStub.deviceId);
        assert.equal(preApplyStub?.status, "active", "a dry-run scan/plan must never mutate any row");

        // ── APPLY: revoke cascade + legacy-NULL normalization in the
        // SAME transaction. ──
        const applied = await applyRepairPlanEntry(pool, entry, new Date().toISOString());
        assert.equal(applied.authoritativeDeviceId, healthy.deviceId);
        assert.deepEqual(applied.supersededDeviceIds, [deadStub.deviceId]);

        const deadStubDevice = await deviceStore.getDevice(deadStub.deviceId);
        assert.equal(deadStubDevice?.status, "revoked");
        const healthyDevice = await deviceStore.getDevice(healthy.deviceId);
        assert.equal(healthyDevice?.status, "active");
        const connectorInstanceRow = await connectorStore.get(connectorInstance.connectorInstanceId);
        assert.equal(connectorInstanceRow?.status, "active", "the shared connector_instance must survive");

        // Normalization: the dead stub's row now carries a real,
        // non-NULL source_kind — the terminal invariant, not a
        // perpetual NULL the tool must keep re-resolving.
        const normalizedRow = await pool.query(
          "SELECT source_kind FROM device_source_instances WHERE source_instance_id = $1",
          [deadStub.sourceInstanceId]
        );
        assert.equal(
          normalizedRow.rows[0]?.source_kind,
          "local_device",
          "the legacy NULL row must be normalized to the resolved effective kind in the same transaction as the revoke"
        );

        // ── IDEMPOTENCY: re-running the scan after apply finds zero
        // groups (the live incident's outbox axis and freshness now
        // read correctly, with no duplicate left to poison them). ──
        const groupsAfter = await scanDuplicateBindings(pool, { connectorId, ownerSubjectId: owner });
        assert.equal(groupsAfter.length, 0, "re-running after apply finds zero duplicate groups");

        // A second apply attempt on the same (now-stale) entry must
        // also be a safe no-op.
        const reapplied = await applyRepairPlanEntry(pool, entry, new Date().toISOString());
        assert.deepEqual(reapplied.supersededDeviceIds, []);
      } finally {
        await pool.end();
      }
    }
  );
});

// Negative regression (this follow-up, prompted by an explicit review of
// the normalization UPDATE's targeting): a single device can legitimately
// own MULTIPLE device_source_instances rows (different connectors/
// bindings — reproduced here as an entirely unrelated claude-code
// connector_instance that ALSO happens to have a legacy-NULL
// source_kind). The normalization UPDATE inside applyRepairPlanEntry must
// key on `source_instance_id` (the true PRIMARY KEY), never `device_id`
// alone — a device_id-scoped UPDATE would reach past the locked group and
// silently GUESS a kind for an unrelated row that happens to share the
// same device_id, fabricating data for a connector_instance the repair
// never even read. This test proves that normalization stays scoped to
// exactly the locked group's row: the unrelated row's `source_kind`
// stays NULL throughout. (Its `status` DOES legitimately become
// `revoked` — that is the correct, pre-existing device-wide revoke
// cascade, unrelated to and unaffected by this normalization-scoping
// fix; see the in-test comment at that assertion for why.)
test("PostgreSQL: source_kind normalization touches ONLY the locked group's source_instance_id row — an unrelated NULL-kind row owned by the same device is never guessed at", {
  skip: POSTGRES_URL ? false : "skipped: PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  const postgresUrl = POSTGRES_URL as string;
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: postgresUrl,
      databaseName: `pdpp_test_dupbind_crossrow_${process.pid}_${Date.now()}`,
    },
    async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      await ensureReferenceConnectorCatalogEntry("codex", "vivid-fish Codex");
      await ensureReferenceConnectorCatalogEntry("claude-code", "vivid-fish Claude Code");

      const deviceStore = createPostgresDeviceExporterStore();
      const connectorStore = createPostgresConnectorInstanceStore();
      const owner = "owner_ref";
      const now = new Date().toISOString();

      // ── The target group: codex/vivid-fish, the same live-incident
      // shape (one legacy-NULL dead stub, one healthy heartbeating row). ──
      const deadStub = await deviceStore.resolveOrCreateEnrollmentDevice({
        candidateDeviceId: "dexp_shared_device",
        candidateSourceInstanceId: "dsrc_codex_stub",
        collectorProtocolVersion: null,
        connectorId: "codex",
        displayName: "vivid-fish Codex",
        localBindingId: "vivid-fish",
        now,
        ownerSubjectId: owner,
        sourceKind: "local_device",
      });
      const codexInstanceOrNull = await connectorStore.upsertForEnrollment({
        connectorId: "codex",
        createdAt: now,
        displayName: "vivid-fish Codex",
        ownerSubjectId: owner,
        sourceBinding: {
          device_id: deadStub.deviceId,
          kind: "local_device",
          local_binding_name: "vivid-fish",
          source_instance_id: deadStub.sourceInstanceId,
        },
        sourceBindingKey: "local_device:vivid-fish",
        sourceKind: "local_device",
        status: "active",
        updatedAt: now,
      });
      assert.ok(codexInstanceOrNull);
      const codexInstance = codexInstanceOrNull;
      await deviceStore.upsertSourceInstance({
        connectorId: "codex",
        connectorInstanceId: codexInstance.connectorInstanceId,
        createdAt: now,
        deviceId: deadStub.deviceId,
        displayName: null,
        localBindingId: "vivid-fish",
        sourceInstanceId: deadStub.sourceInstanceId,
        sourceKind: "local_device",
        updatedAt: now,
      });
      // deadStub's code MUST be consumed before the second device
      // resolves, or resolveOrCreateEnrollmentDevice adopts deadStub as
      // an unconsumed orphan instead of minting a genuinely new device
      // — collapsing this test back to a single row.
      await deviceStore.createEnrollmentCode({
        codeHash: "hash_crossrow_1",
        connectorId: "codex",
        createdAt: now,
        displayName: null,
        enrollmentCodeId: "denroll_crossrow_1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        localBindingId: "vivid-fish",
        ownerSubjectId: owner,
      });
      await deviceStore.consumeEnrollmentCode("denroll_crossrow_1", deadStub.deviceId, now);

      const healthy = await deviceStore.resolveOrCreateEnrollmentDevice({
        candidateDeviceId: "dexp_codex_healthy",
        candidateSourceInstanceId: "dsrc_codex_healthy",
        collectorProtocolVersion: null,
        connectorId: "codex",
        displayName: "vivid-fish Codex",
        localBindingId: "vivid-fish",
        now,
        ownerSubjectId: owner,
        sourceKind: "local_device",
      });
      await deviceStore.upsertSourceInstance({
        connectorId: "codex",
        connectorInstanceId: codexInstance.connectorInstanceId,
        createdAt: now,
        deviceId: healthy.deviceId,
        displayName: null,
        localBindingId: "vivid-fish",
        sourceInstanceId: healthy.sourceInstanceId,
        sourceKind: "local_device",
        updatedAt: now,
      });
      await deviceStore.markDeviceHeartbeat(healthy.deviceId, {
        agentVersion: null,
        lastError: undefined,
        receivedAt: now,
      });
      await deviceStore.markSourceInstanceHeartbeat(healthy.deviceId, healthy.sourceInstanceId, {
        lastError: undefined,
        outboxDiagnostics: undefined,
        receivedAt: now,
        recordsPending: 0,
        status: "healthy",
      });

      // ── The UNRELATED row: the SAME device_id as the dead stub
      // (`deadStub.deviceId`), but a DIFFERENT connector (claude-code),
      // a DIFFERENT binding, and its OWN legacy-NULL source_kind. This
      // is not part of the codex/vivid-fish duplicate group at all —
      // it must never be touched by repairing that group. ──
      const unrelatedInstanceOrNull = await connectorStore.upsertForEnrollment({
        connectorId: "claude-code",
        createdAt: now,
        displayName: "vivid-fish Claude Code",
        ownerSubjectId: owner,
        sourceBinding: {
          device_id: deadStub.deviceId,
          kind: "local_device",
          local_binding_name: "vivid-fish-claude",
          source_instance_id: "dsrc_unrelated_claude",
        },
        sourceBindingKey: "local_device:vivid-fish-claude",
        sourceKind: "local_device",
        status: "active",
        updatedAt: now,
      });
      assert.ok(unrelatedInstanceOrNull);
      const unrelatedInstance = unrelatedInstanceOrNull;
      await deviceStore.upsertSourceInstance({
        connectorId: "claude-code",
        connectorInstanceId: unrelatedInstance.connectorInstanceId,
        createdAt: now,
        deviceId: deadStub.deviceId,
        displayName: null,
        localBindingId: "vivid-fish-claude",
        sourceInstanceId: "dsrc_unrelated_claude",
        sourceKind: "local_device",
        updatedAt: now,
      });

      const pool = new pg.Pool({ connectionString: url });
      try {
        // Force BOTH the target dead stub AND the unrelated row to
        // legacy-NULL — same device_id, different source_instance_id,
        // different connector_instance_id.
        await pool.query("UPDATE device_source_instances SET source_kind = NULL WHERE source_instance_id = $1", [
          deadStub.sourceInstanceId,
        ]);
        await pool.query("UPDATE device_source_instances SET source_kind = NULL WHERE source_instance_id = $1", [
          "dsrc_unrelated_claude",
        ]);
        const bothNull = await pool.query(
          "SELECT source_instance_id, source_kind FROM device_source_instances WHERE device_id = $1 ORDER BY source_instance_id",
          [deadStub.deviceId]
        );
        assert.equal(
          bothNull.rows.length,
          2,
          "the shared device must own exactly two source-instance rows for this test to be meaningful"
        );
        assert.ok(
          bothNull.rows.every((row) => row.source_kind === null),
          "both rows must genuinely start NULL"
        );

        // Repair ONLY the codex/vivid-fish group.
        const groups = await scanDuplicateBindings(pool, { connectorId: "codex", ownerSubjectId: owner });
        assert.equal(groups.length, 1);
        const [group] = groups;
        assert.ok(group);
        assert.equal(group.connectorInstanceId, codexInstance.connectorInstanceId);
        const plan = buildRepairPlan(groups);
        const [entry] = plan;
        assert.ok(entry);

        await applyRepairPlanEntry(pool, entry, new Date().toISOString());

        // The TARGET row (dead stub, inside the repaired group) is
        // normalized.
        const targetRow = await pool.query(
          "SELECT source_kind, status FROM device_source_instances WHERE source_instance_id = $1",
          [deadStub.sourceInstanceId]
        );
        assert.equal(
          targetRow.rows[0]?.source_kind,
          "local_device",
          "the target row inside the repaired group must be normalized"
        );
        assert.equal(targetRow.rows[0]?.status, "revoked", "the target row must also be revoked (it was superseded)");

        // The UNRELATED row (same device_id, DIFFERENT connector_instance,
        // never part of the locked group). Its `status` legitimately
        // becomes `revoked` too — that is the PRE-EXISTING, intentional
        // device-wide revoke cascade (a device_exporters row going
        // `revoked` correctly cascades to every device_source_instances
        // row for that device_id, not just the one in the repaired
        // group; a physical device being decommissioned really is
        // decommissioned everywhere, matching revokeDevice's own
        // semantics). What must NEVER happen is source_kind
        // NORMALIZATION reaching this row: it belongs to a DIFFERENT
        // connector_instance (claude-code, not codex) that could in
        // principle resolve to an entirely different kind, so guessing
        // its kind from the codex group's resolved value would be
        // fabrication, not resolution. This is the exact defect the
        // source_instance_id-scoped (never device_id-scoped) UPDATE in
        // applyRepairPlanEntry exists to prevent.
        const unrelatedRow = await pool.query(
          "SELECT source_kind, status FROM device_source_instances WHERE source_instance_id = $1",
          ["dsrc_unrelated_claude"]
        );
        assert.equal(
          unrelatedRow.rows[0]?.source_kind,
          null,
          "an unrelated NULL-kind row owned by the SAME device_id but a DIFFERENT connector_instance must NEVER be normalized by repairing a different group"
        );
        assert.equal(
          unrelatedRow.rows[0]?.status,
          "revoked",
          "device-wide revocation is the pre-existing, correct cascade semantics (a decommissioned device is decommissioned everywhere) — only source_kind normalization must stay scoped to the locked group"
        );
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
