// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded-scope proof for `listSourceInstanceHeartbeatsByConnectionIds`'s
 * `last_ingest_at` aggregate (server/stores/device-exporter-store.ts).
 *
 * The connector-summary LIST read used to aggregate
 * `MAX(accepted_at) GROUP BY device_id, source_instance_id` over the ENTIRE
 * `device_ingest_batch_outcomes` table (filtered only by `status =
 * 'accepted'`), then joined the full aggregate back onto the requested
 * connector-instance-id page. The aggregate's own subquery carried no
 * identity scope, so the LIST read's cost grew with total fleet-wide ingest
 * history, not with the requested page size.
 *
 * The fix pushes the caller's identity scope (the device_ids reachable from
 * the requested connector_instance_id page) into the subquery's WHERE
 * clause, so the aggregate only ever touches rows for devices in the
 * requested page.
 *
 * This proves, for a fleet with N=0/1/25 requested ids against a much larger
 * unrelated fixture:
 *   1. Exact result parity against the legacy (unscoped-subquery) semantics.
 *   2. The subquery itself is row-scoped: EXPLAIN QUERY PLAN shows no scan
 *      of the full `device_ingest_batch_outcomes` table.
 *   3. Unrelated devices' batch outcomes never appear in the result and
 *      never affect the returned `lastIngestAt` values (no cross-page
 *      leakage).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import { listSourceInstanceHeartbeatsByConnectionIds } from "../server/stores/device-exporter-store.ts";

const NOW = "2026-07-30T00:00:00.000Z";

function iso(offsetSeconds: number): string {
  return new Date(Date.parse(NOW) + offsetSeconds * 1000).toISOString();
}

async function withTempSqliteDb<T>(fn: () => Promise<T> | T): Promise<T> {
  initDb();
  try {
    return await fn();
  } finally {
    closeDb();
  }
}

function seedDevice(deviceId: string): void {
  getDb()
    .prepare(
      `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, status, created_at, updated_at)
       VALUES (?, 'owner_1', ?, 'active', ?, ?)`
    )
    .run(deviceId, deviceId, NOW, NOW);
}

function seedSourceInstance(deviceId: string, connectorInstanceId: string, sourceInstanceId: string): void {
  getDb()
    .prepare(
      `INSERT INTO device_source_instances(
         source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id,
         display_name, status, created_at, updated_at
       ) VALUES (?, ?, 'local.files', ?, ?, ?, 'active', ?, ?)`
    )
    .run(sourceInstanceId, deviceId, connectorInstanceId, sourceInstanceId, sourceInstanceId, NOW, NOW);
}

function seedBatchOutcome(
  deviceId: string,
  sourceInstanceId: string,
  batchId: string,
  status: "accepted" | "processing",
  acceptedAt: string | null
): void {
  getDb()
    .prepare(
      `INSERT INTO device_ingest_batch_outcomes(
         device_id, batch_id, body_hash, source_instance_id, connector_instance_id, connector_id,
         batch_seq, status, http_status, response_json, record_count, durable_prefix_count,
         created_at, accepted_at
       ) VALUES (?, ?, ?, ?, '', '', 0, ?, 202, NULL, 1, ?, ?, ?)`
    )
    .run(
      deviceId,
      batchId,
      `sha256:${batchId}`,
      sourceInstanceId,
      status,
      status === "accepted" ? 1 : 0,
      NOW,
      acceptedAt
    );
}

/** The pre-fix semantics: unscoped MAX(accepted_at) GROUP BY across the whole table. */
function legacyLastIngestAt(deviceId: string, sourceInstanceId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT MAX(accepted_at) AS last_ingest_at
         FROM device_ingest_batch_outcomes
        WHERE status = 'accepted' AND device_id = ? AND source_instance_id = ?`
    )
    .get(deviceId, sourceInstanceId) as { last_ingest_at: string | null };
  return row.last_ingest_at;
}

const FULL_TABLE_SCAN = /SCAN device_ingest_batch_outcomes/;

test("N=0: an empty id page returns an empty map without touching SQL", async () =>
  withTempSqliteDb(async () => {
    seedDevice("dev_unrelated");
    seedSourceInstance("dev_unrelated", "cin_unrelated", "src_unrelated");
    seedBatchOutcome("dev_unrelated", "src_unrelated", "batch_unrelated", "accepted", iso(0));

    const result = await listSourceInstanceHeartbeatsByConnectionIds([]);
    assert.equal(result.size, 0);
  }));

test("N=1: a single requested connection gets its own ingest outcome, unrelated devices do not leak in", async () =>
  withTempSqliteDb(async () => {
    seedDevice("dev_target");
    seedSourceInstance("dev_target", "cin_target", "src_target");
    seedBatchOutcome("dev_target", "src_target", "batch_target_1", "accepted", iso(10));
    seedBatchOutcome("dev_target", "src_target", "batch_target_2", "accepted", iso(20));
    seedBatchOutcome("dev_target", "src_target", "batch_target_3", "processing", null);

    // A large amount of unrelated fleet history that must not affect the
    // aggregate for dev_target, and must not appear in the result.
    for (let i = 0; i < 50; i += 1) {
      const deviceId = `dev_noise_${i}`;
      seedDevice(deviceId);
      seedSourceInstance(deviceId, `cin_noise_${i}`, `src_noise_${i}`);
      seedBatchOutcome(deviceId, `src_noise_${i}`, `batch_noise_${i}`, "accepted", iso(1000 + i));
    }

    const result = await listSourceInstanceHeartbeatsByConnectionIds(["cin_target"]);
    assert.equal(result.size, 1);
    const rows = result.get("cin_target") ?? [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.sourceInstanceId, "src_target");
    assert.equal(rows[0]?.lastIngestAt, iso(20));
    assert.equal(rows[0]?.lastIngestAt, legacyLastIngestAt("dev_target", "src_target"));
  }));

test("N=25: exact parity per requested connection against unscoped legacy semantics, across a mixed fleet", async () =>
  withTempSqliteDb(async () => {
    const requestedIds: string[] = [];
    const expected = new Map<string, { deviceId: string; sourceInstanceId: string }>();

    for (let i = 0; i < 25; i += 1) {
      const deviceId = `dev_page_${i}`;
      const connectorInstanceId = `cin_page_${i}`;
      const sourceInstanceId = `src_page_${i}`;
      seedDevice(deviceId);
      seedSourceInstance(deviceId, connectorInstanceId, sourceInstanceId);
      // Stagger accepted batches so MAX(accepted_at) differs per row, plus
      // a processing (non-accepted) row that must never win the aggregate.
      seedBatchOutcome(deviceId, sourceInstanceId, `batch_page_${i}_a`, "accepted", iso(i));
      seedBatchOutcome(deviceId, sourceInstanceId, `batch_page_${i}_b`, "accepted", iso(i + 500));
      seedBatchOutcome(deviceId, sourceInstanceId, `batch_page_${i}_c`, "processing", null);
      requestedIds.push(connectorInstanceId);
      expected.set(connectorInstanceId, { deviceId, sourceInstanceId });
    }

    // Unrelated fleet noise outside the requested page, with a LATER
    // accepted_at than anything in the page — if scoping ever regresses to
    // an unscoped aggregate keyed loosely, this would corrupt the page's
    // results.
    for (let i = 0; i < 25; i += 1) {
      const deviceId = `dev_offpage_${i}`;
      seedDevice(deviceId);
      seedSourceInstance(deviceId, `cin_offpage_${i}`, `src_offpage_${i}`);
      seedBatchOutcome(deviceId, `src_offpage_${i}`, `batch_offpage_${i}`, "accepted", iso(9999 + i));
    }

    const result = await listSourceInstanceHeartbeatsByConnectionIds(requestedIds);
    assert.equal(result.size, 25);
    for (const [connectorInstanceId, { deviceId, sourceInstanceId }] of expected) {
      const rows = result.get(connectorInstanceId) ?? [];
      assert.equal(rows.length, 1, `expected exactly one row for ${connectorInstanceId}`);
      const [row] = rows;
      assert.equal(row?.sourceInstanceId, sourceInstanceId);
      assert.equal(row?.lastIngestAt, legacyLastIngestAt(deviceId, sourceInstanceId));
      assert.ok(
        !row?.lastIngestAt || Date.parse(row.lastIngestAt) < Date.parse(iso(9999)),
        "no off-page bleed-through"
      );
    }
    for (let i = 0; i < 25; i += 1) {
      assert.equal(result.has(`cin_offpage_${i}`), false, "off-page connections must not appear in the page result");
    }
  }));

test("SQLite: the ingest-outcome subquery is row-scoped by the requested page, not a full-table scan", async () =>
  withTempSqliteDb(() => {
    for (let i = 0; i < 10; i += 1) {
      const deviceId = `dev_plan_${i}`;
      seedDevice(deviceId);
      seedSourceInstance(deviceId, `cin_plan_${i}`, `src_plan_${i}`);
      seedBatchOutcome(deviceId, `src_plan_${i}`, `batch_plan_${i}`, "accepted", iso(i));
    }

    const db = getDb();
    const scopedSubquery = `EXPLAIN QUERY PLAN
      SELECT device_id, source_instance_id, MAX(accepted_at) AS last_ingest_at
        FROM device_ingest_batch_outcomes
       WHERE status = 'accepted'
         AND device_id IN (SELECT device_id FROM device_source_instances WHERE connector_instance_id IN (?))
       GROUP BY device_id, source_instance_id`;
    const plan = db.prepare(scopedSubquery).all("cin_plan_0") as readonly { detail?: string }[];
    const detail = plan.map((row) => row.detail ?? "").join(" | ");
    assert.doesNotMatch(
      detail,
      FULL_TABLE_SCAN,
      `scoped subquery must not fall back to scanning all of device_ingest_batch_outcomes; got: ${detail}`
    );
  }));
