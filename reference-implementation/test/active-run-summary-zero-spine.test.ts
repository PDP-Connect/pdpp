// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// G1 closure (REVISE, terminal-read-architecture-fable-0730.md §9 gate
// second pass, 2026-07-30): `readLatestCollectionRateForRun`'s spine
// fallback (`spine_events WHERE event_type = 'run.progress_reported'`)
// fired on every one of the five connector-summary routes whenever a
// connection had a currently-running run with no terminal facts_json yet
// — reproduced live against the sanctioned Postgres instance by the gate.
// Closed by merging `collection_rate` into the running row's `facts_json`
// at `run.progress_reported` write time (run-history-writer.ts) and
// deleting the spine fallback entirely.
//
// Proves, on BOTH SQLite and real sanctioned PostgreSQL: an
// authenticated GET on the product connector-summary route
// (getConnectorSummaryForRoute) issues ZERO spine_events statements for
// (a) an in-progress run that has reported collection_rate progress,
// (b) a terminal run, and (c) a connection with no run at all — closing
// the shipped suite's prior SQLite-only gap for this specific assertion.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { emitSpineEvent } from "../lib/spine.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { getConnectorSummaryForRoute } from "../server/ref-control.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

// Test isolation (2026-07-30, gate second-pass correction): every
// Postgres proof in this file runs against its own disposable, uniquely
// named database (withTemporaryPostgresDatabase), never the shared
// pdpp_test base database.
let tempDbCounter = 0;
function tempDbName(label: string): string {
  tempDbCounter += 1;
  return `pdpp_test_zero_spine_${label}_${process.pid}_${tempDbCounter}`;
}

// Same CJS module instance server/db.ts requires — patching this prototype
// method observes every `db.prepare(...)` call the Proxy cache wrapper
// (withCachedPrepare, server/db.ts) delegates to.
const BetterSqlite3Database = createRequire(import.meta.url)("better-sqlite3") as {
  readonly prototype: { prepare: (this: unknown, sql: string) => unknown };
};

// Same module instance server/postgres-storage.ts requires (`import {
// Pool } from "pg"`) — patching the prototype observes every query the
// storage layer issues through any Pool instance, matching the gate's own
// probe technique.
const PgModule = createRequire(import.meta.url)("pg") as {
  readonly Pool: { readonly prototype: { query: (this: unknown, ...args: unknown[]) => unknown } };
};

const SPINE_EVENTS_STATEMENT_PATTERN = /\bspine_events\b/i;
const CONNECTOR_ID = "test_zero_spine_connector";
const NOW = "2026-07-30T00:00:00.000Z";

function seedManifestConnectorSqlite(connectorId: string = CONNECTOR_ID): void {
  const manifest = {
    capabilities: { public_listing: { tier: "supported" } },
    connector_id: connectorId,
    display_name: connectorId,
    protocol_version: "0.1.0",
    streams: [],
    version: "1.0.0",
  };
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify(manifest), NOW);
}

function seedInstanceSqlite(connectorInstanceId: string, connectorId: string = CONNECTOR_ID): void {
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(connectorInstanceId, "owner_local", connectorId, connectorId, connectorInstanceId, NOW, NOW);
}

async function seedManifestConnectorPostgres(connectorId: string): Promise<void> {
  const manifest = {
    capabilities: { public_listing: { tier: "supported" } },
    connector_id: connectorId,
    display_name: connectorId,
    protocol_version: "0.1.0",
    streams: [],
    version: "1.0.0",
  };
  await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
    connectorId,
    JSON.stringify(manifest),
    NOW,
  ]);
}

async function seedInstancePostgres(connectorInstanceId: string, connectorId: string): Promise<void> {
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES ($1, 'owner_local', $2, $3, 'active', 'account', $4, '{}'::jsonb, $5, $6, NULL)`,
    [connectorInstanceId, connectorId, connectorId, connectorInstanceId, NOW, NOW]
  );
}

function startedEvent(runId: string, connectorInstanceId: string) {
  return {
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      boot_epoch: "boot-zero-spine",
      connection_id: connectorInstanceId,
      connector_instance_id: connectorInstanceId,
      seq: 1,
      source: { id: CONNECTOR_ID, kind: "connector" },
      trigger_kind: "manual",
    },
    event_id: `evt_${runId}_started`,
    event_type: "run.started",
    object_id: runId,
    object_type: "run",
    run_id: runId,
    status: "started",
  };
}

function progressEvent(runId: string, connectorInstanceId: string, recordsPerSec: number) {
  return {
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      collection_rate: { records_per_sec: recordsPerSec },
      connection_id: connectorInstanceId,
      connector_instance_id: connectorInstanceId,
      source: { id: CONNECTOR_ID, kind: "connector" },
    },
    event_id: `evt_${runId}_progress`,
    event_type: "run.progress_reported",
    object_id: runId,
    object_type: "run",
    run_id: runId,
    status: "in_progress",
  };
}

function terminalEvent(runId: string, connectorInstanceId: string, recordsPerSec: number) {
  return {
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      collection_rate: { records_per_sec: recordsPerSec },
      connection_id: connectorInstanceId,
      connector_instance_id: connectorInstanceId,
      records_emitted: 3,
      source: { id: CONNECTOR_ID, kind: "connector" },
    },
    event_id: `evt_${runId}_terminal`,
    event_type: "run.completed",
    object_id: runId,
    object_type: "run",
    run_id: runId,
    status: "succeeded",
  };
}

function withSqlitePrepareInstrumentation<T>(fn: () => Promise<T>): Promise<{ result: T; observedSql: string[] }> {
  const observedSql: string[] = [];
  const originalPrepare = BetterSqlite3Database.prototype.prepare;
  BetterSqlite3Database.prototype.prepare = function patchedPrepare(this: unknown, sql: string) {
    observedSql.push(sql);
    return originalPrepare.call(this, sql);
  };
  return fn()
    .then((result) => ({ observedSql, result }))
    .finally(() => {
      BetterSqlite3Database.prototype.prepare = originalPrepare;
    });
}

function withPostgresQueryInstrumentation<T>(fn: () => Promise<T>): Promise<{ result: T; observedSql: string[] }> {
  const observedSql: string[] = [];
  const originalQuery = PgModule.Pool.prototype.query;
  PgModule.Pool.prototype.query = function patchedQuery(this: unknown, ...args: unknown[]) {
    const first = args[0] as string | { text?: string } | undefined;
    const sql = typeof first === "string" ? first : (first?.text ?? "");
    observedSql.push(sql);
    return originalQuery.apply(this, args);
  };
  return fn()
    .then((result) => ({ observedSql, result }))
    .finally(() => {
      PgModule.Pool.prototype.query = originalQuery;
    });
}

function spineStatements(observedSql: readonly string[]): string[] {
  return observedSql.filter((sql) => SPINE_EVENTS_STATEMENT_PATTERN.test(sql));
}

test("SQLite: zero spine_events statements for an in-progress run's GET (collection_rate merged via run.progress_reported)", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-zero-spine-active-sqlite-");
  initDb(dbPath);
  try {
    seedManifestConnectorSqlite();
    seedInstanceSqlite("cin_sqlite_active");
    const runId = "run_sqlite_active";
    await emitSpineEvent(startedEvent(runId, "cin_sqlite_active"));
    await emitSpineEvent(progressEvent(runId, "cin_sqlite_active", 7));

    const historyRow = getDb().prepare("SELECT status, facts_json FROM run_history WHERE run_id = ?").get(runId) as {
      facts_json: string | null;
      status: string;
    };
    assert.equal(historyRow.status, "running", "precondition: the row is still running");
    assert.equal(
      historyRow.facts_json,
      '{"collection_rate":{"records_per_sec":7}}',
      "precondition: collection_rate was merged into facts_json at progress-event write time"
    );

    const { observedSql, result: summary } = await withSqlitePrepareInstrumentation(() =>
      getConnectorSummaryForRoute("cin_sqlite_active")
    );

    assert.ok(summary, "the route resolves the connection");
    assert.deepEqual(spineStatements(observedSql), [], "zero spine_events statements for an in-progress run's GET");
  } finally {
    closeDb();
  }
});

test("SQLite: zero spine_events statements for a terminal run's GET", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-zero-spine-terminal-sqlite-");
  initDb(dbPath);
  try {
    seedManifestConnectorSqlite();
    seedInstanceSqlite("cin_sqlite_terminal");
    const runId = "run_sqlite_terminal";
    await emitSpineEvent(startedEvent(runId, "cin_sqlite_terminal"));
    await emitSpineEvent(terminalEvent(runId, "cin_sqlite_terminal", 9));

    const { observedSql, result: summary } = await withSqlitePrepareInstrumentation(() =>
      getConnectorSummaryForRoute("cin_sqlite_terminal")
    );

    assert.ok(summary, "the route resolves the connection");
    assert.deepEqual(spineStatements(observedSql), [], "zero spine_events statements for a terminal run's GET");
  } finally {
    closeDb();
  }
});

test("SQLite: zero spine_events statements for a connection with no run at all", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-zero-spine-norun-sqlite-");
  initDb(dbPath);
  try {
    seedManifestConnectorSqlite();
    seedInstanceSqlite("cin_sqlite_norun");

    const { observedSql, result: summary } = await withSqlitePrepareInstrumentation(() =>
      getConnectorSummaryForRoute("cin_sqlite_norun")
    );

    assert.ok(summary, "the route resolves the connection");
    assert.deepEqual(spineStatements(observedSql), [], "zero spine_events statements for a no-run connection's GET");
  } finally {
    closeDb();
  }
});

test("PostgreSQL: zero spine_events statements for an in-progress run's GET (collection_rate merged via run.progress_reported)", {
  skip: !POSTGRES_URL,
}, async () => {
  assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: tempDbName("active"),
    },
    async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const connectorId = `${CONNECTOR_ID}_pg_active`;
      const connectorInstanceId = "cin_pg_active";
      const runId = "run_pg_active";
      await seedManifestConnectorPostgres(connectorId);
      await seedInstancePostgres(connectorInstanceId, connectorId);
      await emitSpineEvent({
        ...startedEvent(runId, connectorInstanceId),
        actor_id: connectorId,
        data: { ...startedEvent(runId, connectorInstanceId).data, source: { id: connectorId, kind: "connector" } },
      });
      await emitSpineEvent({
        ...progressEvent(runId, connectorInstanceId, 11),
        actor_id: connectorId,
        data: {
          ...progressEvent(runId, connectorInstanceId, 11).data,
          source: { id: connectorId, kind: "connector" },
        },
      });

      const historyCheck = await postgresQuery<{ facts_json: unknown; status: string }>(
        "SELECT status, facts_json FROM run_history WHERE run_id = $1",
        [runId]
      );
      assert.equal(historyCheck.rows[0]?.status, "running", "precondition: the row is still running");
      assert.deepEqual(
        historyCheck.rows[0]?.facts_json,
        { collection_rate: { records_per_sec: 11 } },
        "precondition: collection_rate was merged into facts_json at progress-event write time"
      );

      const { observedSql, result: summary } = await withPostgresQueryInstrumentation(() =>
        getConnectorSummaryForRoute(connectorInstanceId)
      );

      assert.ok(summary, "the route resolves the connection");
      assert.deepEqual(
        spineStatements(observedSql),
        [],
        "zero spine_events statements for an in-progress run's GET (live Postgres)"
      );
    }
  );
});

test("PostgreSQL: zero spine_events statements for a terminal run's GET", { skip: !POSTGRES_URL }, async () => {
  assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: tempDbName("terminal"),
    },
    async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const connectorId = `${CONNECTOR_ID}_pg_terminal`;
      const connectorInstanceId = "cin_pg_terminal";
      const runId = "run_pg_terminal";
      await seedManifestConnectorPostgres(connectorId);
      await seedInstancePostgres(connectorInstanceId, connectorId);
      await emitSpineEvent({
        ...startedEvent(runId, connectorInstanceId),
        actor_id: connectorId,
        data: { ...startedEvent(runId, connectorInstanceId).data, source: { id: connectorId, kind: "connector" } },
      });
      await emitSpineEvent({
        ...terminalEvent(runId, connectorInstanceId, 13),
        actor_id: connectorId,
        data: {
          ...terminalEvent(runId, connectorInstanceId, 13).data,
          source: { id: connectorId, kind: "connector" },
        },
      });

      const { observedSql, result: summary } = await withPostgresQueryInstrumentation(() =>
        getConnectorSummaryForRoute(connectorInstanceId)
      );

      assert.ok(summary, "the route resolves the connection");
      assert.deepEqual(
        spineStatements(observedSql),
        [],
        "zero spine_events statements for a terminal run's GET (live Postgres)"
      );
    }
  );
});

test("PostgreSQL: zero spine_events statements for a connection with no run at all", {
  skip: !POSTGRES_URL,
}, async () => {
  assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: tempDbName("norun"),
    },
    async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const connectorId = `${CONNECTOR_ID}_pg_norun`;
      const connectorInstanceId = "cin_pg_norun";
      await seedManifestConnectorPostgres(connectorId);
      await seedInstancePostgres(connectorInstanceId, connectorId);

      const { observedSql, result: summary } = await withPostgresQueryInstrumentation(() =>
        getConnectorSummaryForRoute(connectorInstanceId)
      );

      assert.ok(summary, "the route resolves the connection");
      assert.deepEqual(
        spineStatements(observedSql),
        [],
        "zero spine_events statements for a no-run connection's GET (live Postgres)"
      );
    }
  );
});
