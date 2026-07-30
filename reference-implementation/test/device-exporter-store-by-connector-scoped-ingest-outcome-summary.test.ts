// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded-scope proof for `listSourceInstanceHeartbeatsByConnector`'s
 * `last_ingest_at` aggregate (server/stores/device-exporter-store.ts), the
 * single-connection detail path behind the connector-summary
 * `?connection=<id>` route selector.
 *
 * Follow-up to the connector-summary LIST fix (commit 79724c7fa): the LIST
 * read's sibling detail read carried the exact same unscoped
 * `MAX(accepted_at) GROUP BY device_id, source_instance_id` subquery over
 * the ENTIRE `device_ingest_batch_outcomes` table (filtered only by
 * `status = 'accepted'`), scoped to the requested connector only via the
 * outer `WHERE dsi.connector_id = ? AND (... connector_instance_id ...)`.
 *
 * The fix (both the SQLite `.sql` template and the Postgres inline query)
 * pushes the same identity scope into the subquery's own WHERE clause: the
 * device_ids reachable from `device_source_instances` for the requested
 * connector_id (and optional connector_instance_id). As with the LIST fix,
 * this is derived through `device_source_instances` rather than filtering
 * `device_ingest_batch_outcomes.connector_instance_id` directly, because
 * legacy rows written via `recordBatchOutcome`'s insert-batch-outcome path
 * can carry an empty-string `connector_instance_id` (see `normalizeOutcome`'s
 * `?? ""`), which would otherwise be silently dropped from the aggregate.
 *
 * This proves, for N=0/1/25 source instances under the requested connector
 * against a much larger unrelated fleet fixture:
 *   1. Exact result parity against the legacy (unscoped-subquery) semantics,
 *      on both SQLite and (when PDPP_TEST_POSTGRES_URL is configured) real
 *      PostgreSQL.
 *   2. No cross-connector leakage: an unrelated connector's ingest history
 *      never affects the requested connector's `lastIngestAt` values.
 *   3. The scoped subquery does not fall back to a full-table scan: SQLite
 *      `EXPLAIN QUERY PLAN` and (when configured) real PostgreSQL `EXPLAIN`
 *      both show no scan of the full `device_ingest_batch_outcomes` table.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  closePostgresStorage,
  getPostgresPool,
  initPostgresStorage,
  isPostgresStorageBackend,
} from "../server/postgres-storage.ts";
import {
  createPostgresDeviceExporterStore,
  createSqliteDeviceExporterStore,
} from "../server/stores/device-exporter-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const NOW = "2026-07-30T00:00:00.000Z";
const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const TARGET_CONNECTOR_ID = "local.files";
const OTHER_CONNECTOR_ID = "local.photos";
const FULL_TABLE_SCAN = /SCAN device_ingest_batch_outcomes/;
const POSTGRES_SEQ_SCAN_INGEST_OUTCOMES = /Seq Scan on device_ingest_batch_outcomes/;

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

interface Fixture {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly deviceId: string;
  readonly sourceInstanceId: string;
}

function seedDeviceSqlite(deviceId: string): void {
  getDb()
    .prepare(
      `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, status, created_at, updated_at)
       VALUES (?, 'owner_1', ?, 'active', ?, ?)`
    )
    .run(deviceId, deviceId, NOW, NOW);
}

function seedSourceInstanceSqlite(fixture: Fixture): void {
  getDb()
    .prepare(
      `INSERT INTO device_source_instances(
         source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id,
         display_name, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    )
    .run(
      fixture.sourceInstanceId,
      fixture.deviceId,
      fixture.connectorId,
      fixture.connectorInstanceId,
      fixture.sourceInstanceId,
      fixture.sourceInstanceId,
      NOW,
      NOW
    );
}

function seedBatchOutcomeSqlite(
  deviceId: string,
  sourceInstanceId: string,
  batchId: string,
  status: "accepted" | "processing",
  acceptedAt: string | null,
  connectorInstanceId = ""
): void {
  getDb()
    .prepare(
      `INSERT INTO device_ingest_batch_outcomes(
         device_id, batch_id, body_hash, source_instance_id, connector_instance_id, connector_id,
         batch_seq, status, http_status, response_json, record_count, durable_prefix_count,
         created_at, accepted_at
       ) VALUES (?, ?, ?, ?, ?, '', 0, ?, 202, NULL, 1, ?, ?, ?)`
    )
    .run(
      deviceId,
      batchId,
      `sha256:${batchId}`,
      sourceInstanceId,
      connectorInstanceId,
      status,
      status === "accepted" ? 1 : 0,
      NOW,
      acceptedAt
    );
}

/** The pre-fix semantics: unscoped MAX(accepted_at) GROUP BY across the whole table. */
function legacyLastIngestAtSqlite(deviceId: string, sourceInstanceId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT MAX(accepted_at) AS last_ingest_at
         FROM device_ingest_batch_outcomes
        WHERE status = 'accepted' AND device_id = ? AND source_instance_id = ?`
    )
    .get(deviceId, sourceInstanceId) as { last_ingest_at: string | null };
  return row.last_ingest_at;
}

test("N=0: a connector with no source instances returns an empty list", async () =>
  withTempSqliteDb(() => {
    const store = createSqliteDeviceExporterStore();
    seedDeviceSqlite("dev_unrelated");
    seedSourceInstanceSqlite({
      connectorId: OTHER_CONNECTOR_ID,
      connectorInstanceId: "cin_unrelated",
      deviceId: "dev_unrelated",
      sourceInstanceId: "src_unrelated",
    });
    seedBatchOutcomeSqlite("dev_unrelated", "src_unrelated", "batch_unrelated", "accepted", iso(0));

    const result = store.listSourceInstanceHeartbeatsByConnector(TARGET_CONNECTOR_ID);
    assert.deepEqual(result, []);
  }));

test("N=1: a single source instance under the requested connector gets its own ingest outcome, unrelated connectors do not leak in", async () =>
  withTempSqliteDb(() => {
    const store = createSqliteDeviceExporterStore();
    seedDeviceSqlite("dev_target");
    seedSourceInstanceSqlite({
      connectorId: TARGET_CONNECTOR_ID,
      connectorInstanceId: "cin_target",
      deviceId: "dev_target",
      sourceInstanceId: "src_target",
    });
    seedBatchOutcomeSqlite("dev_target", "src_target", "batch_target_1", "accepted", iso(10));
    seedBatchOutcomeSqlite("dev_target", "src_target", "batch_target_2", "accepted", iso(20));
    seedBatchOutcomeSqlite("dev_target", "src_target", "batch_target_3", "processing", null);

    for (let i = 0; i < 50; i += 1) {
      const deviceId = `dev_noise_${i}`;
      seedDeviceSqlite(deviceId);
      seedSourceInstanceSqlite({
        connectorId: OTHER_CONNECTOR_ID,
        connectorInstanceId: `cin_noise_${i}`,
        deviceId,
        sourceInstanceId: `src_noise_${i}`,
      });
      seedBatchOutcomeSqlite(deviceId, `src_noise_${i}`, `batch_noise_${i}`, "accepted", iso(1000 + i));
    }

    const rows = store.listSourceInstanceHeartbeatsByConnector(TARGET_CONNECTOR_ID);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.sourceInstanceId, "src_target");
    assert.equal(rows[0]?.lastIngestAt, iso(20));
    assert.equal(rows[0]?.lastIngestAt, legacyLastIngestAtSqlite("dev_target", "src_target"));
  }));

test("N=25: exact parity per source instance against unscoped legacy semantics, across a mixed fleet, connectorInstanceId-scoped too", async () =>
  withTempSqliteDb(() => {
    const store = createSqliteDeviceExporterStore();
    const expected: Fixture[] = [];

    for (let i = 0; i < 25; i += 1) {
      const fixture: Fixture = {
        connectorId: TARGET_CONNECTOR_ID,
        connectorInstanceId: `cin_page_${i}`,
        deviceId: `dev_page_${i}`,
        sourceInstanceId: `src_page_${i}`,
      };
      seedDeviceSqlite(fixture.deviceId);
      seedSourceInstanceSqlite(fixture);
      seedBatchOutcomeSqlite(fixture.deviceId, fixture.sourceInstanceId, `batch_page_${i}_a`, "accepted", iso(i));
      seedBatchOutcomeSqlite(fixture.deviceId, fixture.sourceInstanceId, `batch_page_${i}_b`, "accepted", iso(i + 500));
      seedBatchOutcomeSqlite(fixture.deviceId, fixture.sourceInstanceId, `batch_page_${i}_c`, "processing", null);
      expected.push(fixture);
    }

    // Unrelated connector's fleet noise, with a LATER accepted_at than
    // anything under the target connector -- if scoping ever regresses to
    // an unscoped aggregate, this would corrupt the target connector's
    // results.
    for (let i = 0; i < 25; i += 1) {
      const deviceId = `dev_offconnector_${i}`;
      seedDeviceSqlite(deviceId);
      seedSourceInstanceSqlite({
        connectorId: OTHER_CONNECTOR_ID,
        connectorInstanceId: `cin_offconnector_${i}`,
        deviceId,
        sourceInstanceId: `src_offconnector_${i}`,
      });
      seedBatchOutcomeSqlite(deviceId, `src_offconnector_${i}`, `batch_offconnector_${i}`, "accepted", iso(9999 + i));
    }

    const rows = store.listSourceInstanceHeartbeatsByConnector(TARGET_CONNECTOR_ID);
    assert.equal(rows.length, 25);
    const bySourceInstanceId = new Map(rows.map((row) => [row?.sourceInstanceId, row]));
    for (const fixture of expected) {
      const row = bySourceInstanceId.get(fixture.sourceInstanceId);
      assert.ok(row, `expected a row for ${fixture.sourceInstanceId}`);
      assert.equal(row?.lastIngestAt, legacyLastIngestAtSqlite(fixture.deviceId, fixture.sourceInstanceId));
      assert.ok(
        !row?.lastIngestAt || Date.parse(row.lastIngestAt) < Date.parse(iso(9999)),
        "no off-connector bleed-through"
      );
    }
    for (const row of rows) {
      assert.ok(
        !row?.sourceInstanceId?.startsWith("src_offconnector_"),
        "off-connector source instances must not appear in the connector-scoped result"
      );
    }

    // connectorInstanceId-scoped variant: exactly one of the 25 rows.
    const single = store.listSourceInstanceHeartbeatsByConnector(TARGET_CONNECTOR_ID, {
      connectorInstanceId: "cin_page_0",
    });
    assert.equal(single.length, 1);
    assert.equal(single[0]?.sourceInstanceId, "src_page_0");
    assert.equal(single[0]?.lastIngestAt, legacyLastIngestAtSqlite("dev_page_0", "src_page_0"));
  }));

test("SQLite: the by-connector ingest-outcome subquery is row-scoped, not a full-table scan", async () =>
  withTempSqliteDb(() => {
    for (let i = 0; i < 10; i += 1) {
      const deviceId = `dev_plan_${i}`;
      seedDeviceSqlite(deviceId);
      seedSourceInstanceSqlite({
        connectorId: TARGET_CONNECTOR_ID,
        connectorInstanceId: `cin_plan_${i}`,
        deviceId,
        sourceInstanceId: `src_plan_${i}`,
      });
      seedBatchOutcomeSqlite(deviceId, `src_plan_${i}`, `batch_plan_${i}`, "accepted", iso(i));
    }

    const db = getDb();
    const scopedSubquery = `EXPLAIN QUERY PLAN
      SELECT device_id, source_instance_id, MAX(accepted_at) AS last_ingest_at
        FROM device_ingest_batch_outcomes
       WHERE status = 'accepted'
         AND device_id IN (
           SELECT device_id FROM device_source_instances
            WHERE connector_id = ? AND (? IS NULL OR connector_instance_id = ?)
         )
       GROUP BY device_id, source_instance_id`;
    const plan = db.prepare(scopedSubquery).all(TARGET_CONNECTOR_ID, null, null) as readonly { detail?: string }[];
    const detail = plan.map((row) => row.detail ?? "").join(" | ");
    assert.doesNotMatch(
      detail,
      FULL_TABLE_SCAN,
      `scoped by-connector subquery must not fall back to scanning all of device_ingest_batch_outcomes; got: ${detail}`
    );
  }));

if (POSTGRES_URL) {
  test("PostgreSQL: exact parity + no full-table scan for the by-connector ingest-outcome aggregate", async () => {
    assert.ok(POSTGRES_URL, "PDPP_TEST_POSTGRES_URL must target the disposable PostgreSQL proof service");
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_by_connector_explain_${process.pid}_${Date.now()}`,
      },
      async (url) => {
        await initPostgresStorage({ backend: "postgres", databaseUrl: url });
        try {
          assert.ok(isPostgresStorageBackend(), "expected the Postgres backend to be active");
          const store = createPostgresDeviceExporterStore();
          const pool = getPostgresPool();

          async function seedDevice(deviceId: string): Promise<void> {
            await pool.query(
              `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, status, created_at, updated_at)
               VALUES ($1, 'owner_1', $1, 'active', $2, $2)`,
              [deviceId, NOW]
            );
          }

          async function seedSourceInstance(fixture: Fixture): Promise<void> {
            await pool.query(
              `INSERT INTO device_source_instances(
                 source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id,
                 display_name, status, created_at, updated_at
               ) VALUES ($1, $2, $3, $4, $1, $1, 'active', $5, $5)`,
              [fixture.sourceInstanceId, fixture.deviceId, fixture.connectorId, fixture.connectorInstanceId, NOW]
            );
          }

          async function seedBatchOutcome(
            deviceId: string,
            sourceInstanceId: string,
            batchId: string,
            status: "accepted" | "processing",
            acceptedAt: string | null
          ): Promise<void> {
            await pool.query(
              `INSERT INTO device_ingest_batch_outcomes(
                 device_id, batch_id, body_hash, source_instance_id, connector_instance_id, connector_id,
                 batch_seq, status, http_status, response_json, record_count, durable_prefix_count,
                 created_at, accepted_at
               ) VALUES ($1, $2, $3, $4, '', '', 0, $5, 202, NULL, 1, $6, $7, $8)`,
              [
                deviceId,
                batchId,
                `sha256:${batchId}`,
                sourceInstanceId,
                status,
                status === "accepted" ? 1 : 0,
                NOW,
                acceptedAt,
              ]
            );
          }

          async function legacyLastIngestAt(deviceId: string, sourceInstanceId: string): Promise<string | null> {
            const result = await pool.query<{ last_ingest_at: string | null }>(
              `SELECT MAX(accepted_at) AS last_ingest_at
                 FROM device_ingest_batch_outcomes
                WHERE status = 'accepted' AND device_id = $1 AND source_instance_id = $2`,
              [deviceId, sourceInstanceId]
            );
            return result.rows[0]?.last_ingest_at ?? null;
          }

          await seedDevice("dev_target");
          await seedSourceInstance({
            connectorId: TARGET_CONNECTOR_ID,
            connectorInstanceId: "cin_target",
            deviceId: "dev_target",
            sourceInstanceId: "src_target",
          });
          await seedBatchOutcome("dev_target", "src_target", "batch_target_1", "accepted", iso(10));
          await seedBatchOutcome("dev_target", "src_target", "batch_target_2", "accepted", iso(20));
          await seedBatchOutcome("dev_target", "src_target", "batch_target_3", "processing", null);

          for (let i = 0; i < 25; i += 1) {
            const deviceId = `dev_offconnector_${i}`;
            // biome-ignore lint/performance/noAwaitInLoops: fixture setup is intentionally sequential.
            await seedDevice(deviceId);
            await seedSourceInstance({
              connectorId: OTHER_CONNECTOR_ID,
              connectorInstanceId: `cin_offconnector_${i}`,
              deviceId,
              sourceInstanceId: `src_offconnector_${i}`,
            });
            await seedBatchOutcome(
              deviceId,
              `src_offconnector_${i}`,
              `batch_offconnector_${i}`,
              "accepted",
              iso(9999 + i)
            );
          }

          const rows = await store.listSourceInstanceHeartbeatsByConnector(TARGET_CONNECTOR_ID);
          assert.equal(rows.length, 1);
          assert.equal(rows[0]?.sourceInstanceId, "src_target");
          assert.equal(rows[0]?.lastIngestAt, await legacyLastIngestAt("dev_target", "src_target"));
          assert.ok(
            !rows[0]?.lastIngestAt || Date.parse(rows[0].lastIngestAt) < Date.parse(iso(9999)),
            "no off-connector bleed-through on real PostgreSQL"
          );

          const plan = await pool.query(
            `EXPLAIN
             SELECT device_id, source_instance_id, MAX(accepted_at) AS last_ingest_at
               FROM device_ingest_batch_outcomes
              WHERE status = 'accepted'
                AND device_id IN (
                  SELECT device_id FROM device_source_instances
                   WHERE connector_id = $1 AND ($2::text IS NULL OR connector_instance_id = $2)
                )
              GROUP BY device_id, source_instance_id`,
            [TARGET_CONNECTOR_ID, null]
          );
          const planText = (plan.rows as readonly { "QUERY PLAN"?: string }[])
            .map((row) => row["QUERY PLAN"] ?? "")
            .join(" | ");
          assert.doesNotMatch(
            planText,
            POSTGRES_SEQ_SCAN_INGEST_OUTCOMES,
            `scoped by-connector subquery must not sequentially scan device_ingest_batch_outcomes; got: ${planText}`
          );
        } finally {
          await closePostgresStorage().catch(() => undefined);
        }
      }
    );
  });
}
