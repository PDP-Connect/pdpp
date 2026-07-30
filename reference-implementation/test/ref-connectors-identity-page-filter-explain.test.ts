// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * EXPLAIN-plan proof for `listOwnerVisibleIdentityPage`'s connector_id filter
 * (terminal-gate revision, 2026-07-29).
 *
 * The independent gate found that the prior single fixed-shape query —
 * `(? IS NULL OR connector_id = ?)` — defeated SQLite's ability to seek the
 * composite `idx_connector_instances_owner_identity_page(owner_subject_id,
 * connector_id, created_at, connector_instance_id)` index on its second
 * column: a sparse filtered connector_id still walked every row the owner
 * has under `owner_subject_id`. Real PostgreSQL's planner already saw
 * through the same OR shape onto both index columns.
 *
 * The fix (in `server/stores/connector-instance-store.ts`) replaces the one
 * dynamic-shape query with two static, separately-defined templates chosen
 * at the application layer: `..._FILTERED_SQL` (a plain sargable
 * `connector_id = ?` equality) and `..._UNFILTERED_SQL` (no connector_id
 * predicate at all). This file proves the FILTERED template is seekable on
 * both index columns on SQLite (not just "does not regress to a table scan"
 * — it must actually use the connector_id column of the composite index,
 * confirmed via `EXPLAIN QUERY PLAN`'s "SEARCH ... USING INDEX ... (owner_subject_id=? AND connector_id=?)"
 * shape) and on real PostgreSQL (`EXPLAIN`'s Index Cond mentioning both
 * columns), for both a first page and a continuation page, against a sparse
 * filter on a large owner fixture — exactly the scenario the gate measured.
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
  POSTGRES_OWNER_VISIBLE_IDENTITY_PAGE_FILTERED_SQL,
  SQLITE_OWNER_VISIBLE_IDENTITY_PAGE_FILTERED_SQL,
} from "../server/stores/connector-instance-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const OWNER = "owner_local";
const TARGET_CONNECTOR_ID = "identity-page-explain-target";
const OTHER_CONNECTOR_ID = "identity-page-explain-other";
const OWNER_FLEET_COUNT = 1000;
const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const SQLITE_IDENTITY_PAGE_INDEX = /USING INDEX idx_connector_instances_owner_identity_page/;
const SQLITE_IDENTITY_PAGE_SEEK = /owner_subject_id=\?\s+AND\s+connector_id=\?/;
const SQLITE_SCAN = /SCAN/;
const POSTGRES_INDEX_COND = /Index Cond/i;
const POSTGRES_OWNER_SUBJECT_ID = /owner_subject_id/;
const POSTGRES_CONNECTOR_ID = /connector_id/;
const POSTGRES_CONNECTOR_INSTANCE_SEQ_SCAN = /Seq Scan on connector_instances/;

process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY ??= "identity page explain cursor key";

type StartedServer = Awaited<ReturnType<typeof startServer>>;

async function closeServer(server: StartedServer | null): Promise<void> {
  if (!server) {
    return;
  }
  server.abortStartupBackfill("identity page explain proof shutdown");
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
  return `cin_explain_${connectorId.replaceAll("-", "_")}_${String(index).padStart(4, "0")}`;
}

function iso(index: number): string {
  return new Date(Date.UTC(2026, 6, 29, 12, 0, index)).toISOString();
}

// Seeds a SPARSE filtered connector (2 connections) inside a LARGE owner
// fleet of unrelated connectors (OWNER_FLEET_COUNT other connections, one
// per distinct connector_id) — the exact shape that exposes a fleet scan:
// if the planner cannot seek connector_id, it must walk every one of the
// owner's OWNER_FLEET_COUNT+2 rows to find the target connector_id's 2 rows.
async function seedSparseFleet(): Promise<void> {
  if (isPostgresStorageBackend()) {
    for (const connectorId of [TARGET_CONNECTOR_ID, OTHER_CONNECTOR_ID]) {
      // biome-ignore lint/performance/noAwaitInLoops: fixture setup is intentionally sequential.
      await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
        connectorId,
        JSON.stringify({ connector_id: connectorId, protocol_version: "0.1.0", version: "1.0.0" }),
        iso(0),
      ]);
    }
    await Promise.all(
      Array.from({ length: 2 }, async (_, index) => {
        const id = instanceId(TARGET_CONNECTOR_ID, index);
        await postgresQuery(
          `INSERT INTO connector_instances(
             connector_instance_id, owner_subject_id, connector_id, display_name, status,
             source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
           ) VALUES($1, $2, $3, $4, 'active', 'account', $5, '{}'::jsonb, $6, $6, NULL)`,
          [id, OWNER, TARGET_CONNECTOR_ID, `Target ${index}`, id, iso(index)]
        );
      })
    );
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
    for (const connectorId of [TARGET_CONNECTOR_ID, OTHER_CONNECTOR_ID]) {
      insertConnector.run(connectorId, JSON.stringify({ connector_id: connectorId }), iso(0));
    }
    for (let index = 0; index < 2; index += 1) {
      const id = instanceId(TARGET_CONNECTOR_ID, index);
      insertInstance.run(id, OWNER, TARGET_CONNECTOR_ID, `Target ${index}`, id, iso(index), iso(index));
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

// Mirrors `listOwnerVisibleIdentityPage`'s exact filtered-template bind
// order: [ownerSubjectId, connectorId, cursorConnectorId x3, cursorCreatedAt,
// cursorConnectorId, cursorCreatedAt, cursorInstanceId, limit + 1].
function filteredBindParams(
  cursor: { connectorId: string; createdAt: string; connectorInstanceId: string } | null,
  limit: number
): readonly (string | number | null)[] {
  const cursorConnectorId = cursor === null ? null : cursor.connectorId;
  const cursorCreatedAt = cursor === null ? null : cursor.createdAt;
  const cursorInstanceId = cursor === null ? null : cursor.connectorInstanceId;
  return [
    OWNER,
    TARGET_CONNECTOR_ID,
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

test("SQLite: connector_id-filtered identity page seeks the composite index on both owner_subject_id and connector_id", async () => {
  await withMountedDb(null, async () => {
    await seedSparseFleet();
    const db = getDb();

    for (const cursor of [
      null,
      { connectorId: TARGET_CONNECTOR_ID, connectorInstanceId: instanceId(TARGET_CONNECTOR_ID, 0), createdAt: iso(0) },
    ]) {
      const params = filteredBindParams(cursor, 100);
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${SQLITE_OWNER_VISIBLE_IDENTITY_PAGE_FILTERED_SQL}`)
        .all(...params) as readonly { detail?: string }[];
      const detail = plan.map((row) => row.detail ?? "").join(" | ");
      assert.match(
        detail,
        SQLITE_IDENTITY_PAGE_INDEX,
        `filtered identity page must use the composite index; got: ${detail}`
      );
      assert.match(
        detail,
        SQLITE_IDENTITY_PAGE_SEEK,
        `filtered identity page must seek on BOTH owner_subject_id and connector_id, not owner_subject_id alone; got: ${detail}`
      );
      assert.doesNotMatch(
        detail,
        SQLITE_SCAN,
        `filtered identity page must not fall back to a table/index scan; got: ${detail}`
      );
    }
  });
});

test("SQLite: connector_id-filtered identity page returns only the sparse target connector's rows from a large fleet", async () => {
  await withMountedDb(null, async () => {
    await seedSparseFleet();
    const db = getDb();
    const rows = db
      .prepare(SQLITE_OWNER_VISIBLE_IDENTITY_PAGE_FILTERED_SQL)
      .all(...filteredBindParams(null, 100)) as readonly { connector_id: string }[];
    assert.equal(rows.length, 2, "the sparse target connector has exactly 2 connections");
    assert.ok(
      rows.every((row) => row.connector_id === TARGET_CONNECTOR_ID),
      "no fleet connector's rows leak into the filtered page"
    );
  });
});

if (POSTGRES_URL) {
  test("PostgreSQL: connector_id-filtered identity page uses an Index Cond on both owner_subject_id and connector_id", async () => {
    assert.ok(POSTGRES_URL, "PDPP_TEST_POSTGRES_URL must target the disposable PostgreSQL proof service");
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_identity_page_explain_${process.pid}_${Date.now()}`,
      },
      async (url) =>
        await withMountedDb(url, async () => {
          await seedSparseFleet();
          const pool = getPostgresPool();

          await Promise.all(
            [
              null,
              {
                connectorId: TARGET_CONNECTOR_ID,
                connectorInstanceId: instanceId(TARGET_CONNECTOR_ID, 0),
                createdAt: iso(0),
              },
            ].map(async (cursor) => {
              const params = filteredBindParams(cursor, 100);
              const result = await pool.query(
                `EXPLAIN ${POSTGRES_OWNER_VISIBLE_IDENTITY_PAGE_FILTERED_SQL}`,
                params as unknown[]
              );
              const planText = (result.rows as readonly { "QUERY PLAN"?: string }[])
                .map((row) => row["QUERY PLAN"] ?? "")
                .join(" | ");
              assert.match(
                planText,
                POSTGRES_INDEX_COND,
                `filtered identity page must use an index condition, not a Seq Scan; got: ${planText}`
              );
              assert.match(
                planText,
                POSTGRES_OWNER_SUBJECT_ID,
                `filtered identity page's index condition must include owner_subject_id; got: ${planText}`
              );
              assert.match(
                planText,
                POSTGRES_CONNECTOR_ID,
                `filtered identity page's index condition must include connector_id; got: ${planText}`
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
}
