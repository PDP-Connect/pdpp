// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * EXPLAIN-plan proof for `listOwnerVisibleIdentityPage`'s bounded repeated
 * `connector_id` SET scope (design doc add-source-perf-design-agy-0730.md
 * "Server shape and bounds": "two static identity-page query templates for a
 * set membership predicate ... preserving the current rule that SQLite must
 * not rely on a SQLite-only trick or an OR predicate that defeats the
 * composite identity index").
 *
 * Mirrors `ref-connectors-identity-page-filter-explain.test.ts`'s method
 * exactly, for the SET template instead of the single-id FILTERED template:
 * a sparse SET (2 connector types, 2 connections each) inside a large
 * unrelated owner fleet (1000 connections under other connector types) must
 * be seekable on the composite
 * `idx_connector_instances_owner_identity_page(owner_subject_id,
 * connector_id, created_at, connector_instance_id)` index — SQLite's
 * `json_each` membership join must not defeat the index the way the
 * rejected `connector_id = ? OR ? IS NULL` shape did; PostgreSQL's bound
 * `unnest($n::text[])` join must produce an Index Cond, not a Seq Scan.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import {
  closePostgresStorage,
  getPostgresPool,
  isPostgresStorageBackend,
  postgresQuery,
} from "../server/postgres-storage.ts";
import {
  POSTGRES_OWNER_VISIBLE_IDENTITY_PAGE_SET_SQL,
  SQLITE_OWNER_VISIBLE_IDENTITY_PAGE_SET_SQL,
} from "../server/stores/connector-instance-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const OWNER = "owner_local";
const TARGET_CONNECTOR_A = "identity-set-explain-target-a";
const TARGET_CONNECTOR_B = "identity-set-explain-target-b";
const OTHER_CONNECTOR_ID = "identity-set-explain-other";
const OWNER_FLEET_COUNT = 1000;
const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const SQLITE_IDENTITY_PAGE_INDEX = /USING INDEX idx_connector_instances_owner_identity_page/;
// `SCAN json_each VIRTUAL TABLE` is expected and harmless: SQLite always
// materializes the small in-memory JSON array itself as a virtual-table scan
// (the array has at most CONNECTOR_SUMMARY_PAGE_CONNECTOR_ID_SET_MAX=100
// elements — a bounded, request-scoped input, never a table). The forbidden
// outcome is a SCAN of `connector_instances` itself, which would mean the
// composite index was NOT seeked and the query instead walked the owner's
// full row set.
const SQLITE_CONNECTOR_INSTANCES_SCAN = /SCAN connector_instances/;
const POSTGRES_INDEX_COND = /Index Cond/i;
const POSTGRES_OWNER_SUBJECT_ID = /owner_subject_id/;
const POSTGRES_CONNECTOR_ID = /connector_id/;
const POSTGRES_CONNECTOR_INSTANCE_SEQ_SCAN = /Seq Scan on connector_instances/;

process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY ??= "identity set scope explain cursor key";

type StartedServer = Awaited<ReturnType<typeof startServer>>;

async function closeServer(server: StartedServer | null): Promise<void> {
  if (!server) {
    return;
  }
  server.abortStartupBackfill("identity set scope explain proof shutdown");
  server.schedulerManager?.stop?.();
  server.stopBrowserSurfaceLeaseSweep();
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
    server.controller.drainActiveRuns(5000),
    server.startupBackfillDone,
    server.startupSummaryEvidenceSweepDone,
    server.stopClientEventDeliveryWorker(),
  ]);
}

async function withMountedDb(databaseUrl: string | null, fn: () => Promise<void>): Promise<void> {
  const previousDatabaseUrl = process.env.PDPP_DATABASE_URL;
  if (databaseUrl) {
    process.env.PDPP_DATABASE_URL = databaseUrl;
  } else {
    delete process.env.PDPP_DATABASE_URL;
  }
  let server: StartedServer | null = null;
  try {
    server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
    await server.startupBackfillDone.catch(() => undefined);
    await fn();
  } finally {
    await closeServer(server);
    await closePostgresStorage().catch(() => undefined);
    closeDb();
    if (previousDatabaseUrl === undefined) {
      delete process.env.PDPP_DATABASE_URL;
    } else {
      process.env.PDPP_DATABASE_URL = previousDatabaseUrl;
    }
  }
}

function instanceId(connectorId: string, index: number): string {
  return `cin_setexplain_${connectorId.replaceAll("-", "_")}_${String(index).padStart(4, "0")}`;
}

function iso(index: number): string {
  return new Date(Date.UTC(2026, 6, 30, 12, 0, index)).toISOString();
}

// Sparse SET target (2 connector types, 2 connections each) inside a large
// unrelated owner fleet (OWNER_FLEET_COUNT other connections, one per
// distinct connector_id) — the same shape `ref-connectors-identity-page-
// filter-explain.test.ts` uses for the single-id filter, doubled for a SET.
async function seedSparseFleet(): Promise<void> {
  if (isPostgresStorageBackend()) {
    for (const connectorId of [TARGET_CONNECTOR_A, TARGET_CONNECTOR_B, OTHER_CONNECTOR_ID]) {
      // biome-ignore lint/performance/noAwaitInLoops: fixture setup is intentionally sequential.
      await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
        connectorId,
        JSON.stringify({ connector_id: connectorId, protocol_version: "0.1.0", version: "1.0.0" }),
        iso(0),
      ]);
    }
    for (const connectorId of [TARGET_CONNECTOR_A, TARGET_CONNECTOR_B]) {
      // biome-ignore lint/performance/noAwaitInLoops: fixture setup is intentionally sequential.
      await Promise.all(
        Array.from({ length: 2 }, async (_, index) => {
          const id = instanceId(connectorId, index);
          await postgresQuery(
            `INSERT INTO connector_instances(
               connector_instance_id, owner_subject_id, connector_id, display_name, status,
               source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
             ) VALUES($1, $2, $3, $4, 'active', 'account', $5, '{}'::jsonb, $6, $6, NULL)`,
            [id, OWNER, connectorId, `Target ${connectorId} ${index}`, id, iso(index)]
          );
        })
      );
    }
    for (let index = 0; index < OWNER_FLEET_COUNT; index += 1) {
      const fleetConnectorId = `${OTHER_CONNECTOR_ID}-${index}`;
      const id = instanceId(fleetConnectorId, 0);
      // biome-ignore lint/performance/noAwaitInLoops: fixture setup is intentionally sequential.
      await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
        fleetConnectorId,
        JSON.stringify({ connector_id: fleetConnectorId, protocol_version: "0.1.0", version: "1.0.0" }),
        iso(0),
      ]);
      await postgresQuery(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         ) VALUES($1, $2, $3, $4, 'active', 'account', $5, '{}'::jsonb, $6, $6, NULL)`,
        [id, OWNER, fleetConnectorId, `Fleet ${index}`, id, iso(index + 10)]
      );
    }
    return;
  }

  const db = getDb();
  const insertConnector = db.prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)");
  const insertInstance = db.prepare(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES(?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
  );
  const insertAll = db.transaction(() => {
    for (const connectorId of [TARGET_CONNECTOR_A, TARGET_CONNECTOR_B, OTHER_CONNECTOR_ID]) {
      insertConnector.run(connectorId, JSON.stringify({ connector_id: connectorId }), iso(0));
    }
    for (const connectorId of [TARGET_CONNECTOR_A, TARGET_CONNECTOR_B]) {
      for (let index = 0; index < 2; index += 1) {
        const id = instanceId(connectorId, index);
        insertInstance.run(id, OWNER, connectorId, `Target ${connectorId} ${index}`, id, iso(index), iso(index));
      }
    }
    for (let index = 0; index < OWNER_FLEET_COUNT; index += 1) {
      const fleetConnectorId = `${OTHER_CONNECTOR_ID}-${index}`;
      const id = instanceId(fleetConnectorId, 0);
      insertConnector.run(fleetConnectorId, JSON.stringify({ connector_id: fleetConnectorId }), iso(0));
      insertInstance.run(id, OWNER, fleetConnectorId, `Fleet ${index}`, id, iso(index + 10), iso(index + 10));
    }
  });
  insertAll();
}

// Mirrors `listOwnerVisibleIdentityPage`'s SET-template bind order (via
// `ownerVisibleIdentityPageParams`): [ownerSubjectId, connectorIdSetParam,
// cursorConnectorId x3, cursorCreatedAt, cursorConnectorId, cursorCreatedAt,
// cursorInstanceId, limit + 1].
function setBindParams(
  connectorIdSetParam: string | readonly string[],
  cursor: { connectorId: string; createdAt: string; connectorInstanceId: string } | null,
  limit: number
): readonly (string | number | null | readonly string[])[] {
  const cursorConnectorId = cursor === null ? null : cursor.connectorId;
  const cursorCreatedAt = cursor === null ? null : cursor.createdAt;
  const cursorInstanceId = cursor === null ? null : cursor.connectorInstanceId;
  return [
    OWNER,
    connectorIdSetParam,
    cursorConnectorId,
    cursorConnectorId,
    cursorConnectorId,
    cursorCreatedAt,
    cursorConnectorId,
    cursorCreatedAt,
    cursorInstanceId,
    limit + 1,
  ];
}

test("SQLite: SET-scoped identity page seeks the composite index on both owner_subject_id and connector_id via json_each", async () => {
  await withMountedDb(null, async () => {
    await seedSparseFleet();
    const db = getDb();
    const setJson = JSON.stringify([TARGET_CONNECTOR_A, TARGET_CONNECTOR_B]);

    for (const cursor of [
      null,
      { connectorId: TARGET_CONNECTOR_A, connectorInstanceId: instanceId(TARGET_CONNECTOR_A, 0), createdAt: iso(0) },
    ]) {
      const params = setBindParams(setJson, cursor, 100);
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${SQLITE_OWNER_VISIBLE_IDENTITY_PAGE_SET_SQL}`)
        .all(...(params as (string | number | null)[])) as readonly { detail?: string }[];
      const detail = plan.map((row) => row.detail ?? "").join(" | ");
      assert.match(
        detail,
        SQLITE_IDENTITY_PAGE_INDEX,
        `SET-scoped identity page must use the composite index; got: ${detail}`
      );
      assert.doesNotMatch(
        detail,
        SQLITE_CONNECTOR_INSTANCES_SCAN,
        `SET-scoped identity page must not fall back to a full scan of connector_instances; got: ${detail}`
      );
    }
  });
});

test("SQLite: SET-scoped identity page returns only the two sparse target connectors' rows from a large fleet", async () => {
  await withMountedDb(null, async () => {
    await seedSparseFleet();
    const db = getDb();
    const setJson = JSON.stringify([TARGET_CONNECTOR_A, TARGET_CONNECTOR_B]);
    const rows = db
      .prepare(SQLITE_OWNER_VISIBLE_IDENTITY_PAGE_SET_SQL)
      .all(...(setBindParams(setJson, null, 100) as (string | number | null)[])) as readonly {
      connector_id: string;
    }[];
    assert.equal(rows.length, 4, "the two sparse target connectors have exactly 2 connections each");
    assert.ok(
      rows.every((row) => row.connector_id === TARGET_CONNECTOR_A || row.connector_id === TARGET_CONNECTOR_B),
      "no fleet connector's rows leak into the SET-scoped page"
    );
  });
});

if (POSTGRES_URL) {
  test("PostgreSQL: SET-scoped identity page uses an Index Cond on both owner_subject_id and connector_id via unnest", async () => {
    assert.ok(POSTGRES_URL, "PDPP_TEST_POSTGRES_URL must target the disposable PostgreSQL proof service");
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_identity_set_explain_${process.pid}_${Date.now()}`,
      },
      async (url) =>
        await withMountedDb(url, async () => {
          await seedSparseFleet();
          const pool = getPostgresPool();
          const setArray = [TARGET_CONNECTOR_A, TARGET_CONNECTOR_B];

          await Promise.all(
            [
              null,
              {
                connectorId: TARGET_CONNECTOR_A,
                connectorInstanceId: instanceId(TARGET_CONNECTOR_A, 0),
                createdAt: iso(0),
              },
            ].map(async (cursor) => {
              const params = setBindParams(setArray, cursor, 100);
              const result = await pool.query(
                `EXPLAIN ${POSTGRES_OWNER_VISIBLE_IDENTITY_PAGE_SET_SQL}`,
                params as unknown[]
              );
              const planText = (result.rows as readonly { "QUERY PLAN"?: string }[])
                .map((row) => row["QUERY PLAN"] ?? "")
                .join(" | ");
              assert.match(
                planText,
                POSTGRES_INDEX_COND,
                `SET-scoped identity page must use an index condition, not a Seq Scan; got: ${planText}`
              );
              assert.match(
                planText,
                POSTGRES_OWNER_SUBJECT_ID,
                `SET-scoped identity page's index condition must include owner_subject_id; got: ${planText}`
              );
              assert.match(
                planText,
                POSTGRES_CONNECTOR_ID,
                `SET-scoped identity page's index condition must include connector_id; got: ${planText}`
              );
              assert.doesNotMatch(
                planText,
                POSTGRES_CONNECTOR_INSTANCE_SEQ_SCAN,
                `must not sequentially scan connector_instances; got: ${planText}`
              );
            })
          );
        })
    );
  });

  test("PostgreSQL: SET-scoped identity page returns only the two sparse target connectors' rows from a large fleet", async () => {
    assert.ok(POSTGRES_URL, "PDPP_TEST_POSTGRES_URL must target the disposable PostgreSQL proof service");
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_identity_set_explain_rows_${process.pid}_${Date.now()}`,
      },
      async (url) =>
        await withMountedDb(url, async () => {
          await seedSparseFleet();
          const pool = getPostgresPool();
          const setArray = [TARGET_CONNECTOR_A, TARGET_CONNECTOR_B];
          const params = setBindParams(setArray, null, 100);
          const result = await pool.query(POSTGRES_OWNER_VISIBLE_IDENTITY_PAGE_SET_SQL, params as unknown[]);
          const rows = result.rows as readonly { connector_id: string }[];
          assert.equal(rows.length, 4, "the two sparse target connectors have exactly 2 connections each");
          assert.ok(
            rows.every((row) => row.connector_id === TARGET_CONNECTOR_A || row.connector_id === TARGET_CONNECTOR_B),
            "no fleet connector's rows leak into the SET-scoped page"
          );
        })
    );
  });
}
