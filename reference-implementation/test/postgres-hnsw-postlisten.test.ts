// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

// biome-ignore lint/correctness/noUnresolvedImports: the test runner resolves this runtime fixture import outside Biome static resolution.
import pg from "pg";
import { closeDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
  runPostgresSemanticHnswMaintenance,
} from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const RE_HNSW_FAILURE = /semantic_search_blob|relation|does not exist/i;
const RE_HNSW_TIMEOUT = /statement timeout|canceling statement/i;
const RE_BOOTSTRAP_TIMEOUT = /Timed out waiting for PostgreSQL bootstrap serialization lock/;
const RE_INCOMPATIBLE_SCHEMA = /foreign key constraint.*cannot be implemented|incompatible/i;
let databaseCounter = 0;

function databaseName(prefix: string): string {
  databaseCounter += 1;
  return `pdpp_hnsw_postlisten_${prefix}_${process.pid}_${databaseCounter}`;
}

async function withTempDatabase(fn: (url: string) => Promise<void>): Promise<void> {
  if (!POSTGRES_URL) {
    throw new Error("withTempDatabase requires PDPP_TEST_POSTGRES_URL");
  }
  await withTemporaryPostgresDatabase(
    { closeConnections: closePostgresStorage, connectionString: POSTGRES_URL, databaseName: databaseName("test") },
    fn
  );
}

async function closeStartedServer(server: Awaited<ReturnType<typeof startServer>>): Promise<void> {
  await Promise.allSettled(
    [server.asServer, server.rsServer].map(
      (httpServer) =>
        new Promise<void>((resolve) => {
          httpServer.closeAllConnections?.();
          httpServer.close(() => resolve());
          setTimeout(resolve, 2000);
        })
    )
  );
  closeDb();
  await closePostgresStorage();
}

if (POSTGRES_URL) {
  test("Postgres listeners bind while the optional HNSW builder is still running", async () => {
    await withTempDatabase(async (url) => {
      let releaseBuilder = () => {
        /* assigned below */
      };
      const builderGate = new Promise<void>((resolve) => {
        releaseBuilder = resolve;
      });
      let builderStarted = false;
      const postgresSemanticHnswMaintenanceImpl = () => {
        builderStarted = true;
        return builderGate;
      };
      const server = await startServer({
        asPort: 0,
        autoEnrollEligibleSchedules: false,
        databaseUrl: url,
        postgresSemanticHnswMaintenanceImpl,
        reconcilePolyfillManifests: false,
        rsPort: 0,
        storageBackend: "postgres",
      });
      try {
        assert.equal(builderStarted, true, "the optional builder is scheduled during post-listen startup");
        const [asResponse, rsResponse] = await Promise.all([
          fetch(`http://127.0.0.1:${server.asPort}/.well-known/oauth-authorization-server`),
          fetch(`http://127.0.0.1:${server.rsPort}/.well-known/oauth-protected-resource`),
        ]);
        assert.equal(asResponse.status, 200, "AS is ready before HNSW maintenance completes");
        assert.equal(rsResponse.status, 200, "RS is ready before HNSW maintenance completes");
      } finally {
        releaseBuilder();
        await server.postgresSemanticHnswMaintenanceDone;
        await Promise.allSettled([
          server.manifestReconciliationDone,
          server.startupBackfillDone,
          server.startupRunHistoryBackfillDone,
          server.startupSummaryEvidenceSweepDone,
        ]);
        await closeStartedServer(server);
      }
    });
  });

  test("the durable HNSW builder is single-owner, restart-safe, and idempotent", async () => {
    await withTempDatabase(async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const admin = new pg.Pool({ connectionString: url });
      const holder = await admin.connect();
      try {
        await holder.query("SELECT pg_advisory_lock($1, $2)", [482_571, 152]);
        const ownerLogs: string[] = [];
        await runPostgresSemanticHnswMaintenance({ log: (line) => ownerLogs.push(line) });
        assert.ok(ownerLogs.some((line) => line.includes("already owned by another process")));
      } finally {
        await holder.query("SELECT pg_advisory_unlock($1, $2)", [482_571, 152]).catch(() => undefined);
        holder.release();
        await admin.end();
      }
      await Promise.all([runPostgresSemanticHnswMaintenance(), runPostgresSemanticHnswMaintenance()]);
      const first = await postgresQuery<{ oid: string }>(
        `SELECT idx.oid::text AS oid
           FROM pg_class idx
           JOIN pg_namespace ns ON ns.oid = idx.relnamespace
          WHERE ns.nspname = current_schema()
            AND idx.relname = 'idx_pg_semantic_search_embedding_hnsw'`
      );
      assert.equal(first.rowCount, 1, "concurrent maintenance leaves one global HNSW index");

      await postgresQuery(
        "UPDATE semantic_hnsw_index_build SET state = 'running', completed_at = NULL, last_error = NULL WHERE build_key = 'semantic_hnsw'"
      );
      await postgresQuery("DROP INDEX IF EXISTS idx_pg_semantic_search_embedding_hnsw");
      await postgresQuery("CREATE INDEX idx_pg_semantic_search_embedding_hnsw ON semantic_search_blob(record_key)");
      const logs: string[] = [];
      await runPostgresSemanticHnswMaintenance({ log: (line) => logs.push(line) });
      const retry = await postgresQuery<{ state: string; last_error: string | null }>(
        "SELECT state, last_error FROM semantic_hnsw_index_build WHERE build_key = 'semantic_hnsw'"
      );
      assert.equal(retry.rows[0]?.state, "ready", "a stale running row retries after a crash/restart");
      assert.equal(retry.rows[0]?.last_error, null);
      assert.ok(logs.some((line) => line.includes("HNSW builder completed")));

      const second = await postgresQuery<{ oid: string }>(
        `SELECT idx.oid::text AS oid
           FROM pg_class idx
           JOIN pg_namespace ns ON ns.oid = idx.relnamespace
          WHERE ns.nspname = current_schema()
            AND idx.relname = 'idx_pg_semantic_search_embedding_hnsw'`
      );
      assert.equal(second.rowCount, 1, "retry still leaves one global HNSW index");
      await runPostgresSemanticHnswMaintenance();
      const third = await postgresQuery<{ oid: string }>(
        `SELECT idx.oid::text AS oid
           FROM pg_class idx
           JOIN pg_namespace ns ON ns.oid = idx.relnamespace
          WHERE ns.nspname = current_schema()
            AND idx.relname = 'idx_pg_semantic_search_embedding_hnsw'`
      );
      assert.equal(third.rows[0]?.oid, second.rows[0]?.oid, "a ready index is not rebuilt on restart");
    });
  });

  test("optional HNSW failure is durable and observable while required bootstrap remains fail-closed", async () => {
    await withTempDatabase(async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      await postgresQuery("DROP TABLE semantic_search_blob CASCADE");
      const logs: string[] = [];
      await runPostgresSemanticHnswMaintenance({ log: (line) => logs.push(line) });
      const failure = await postgresQuery<{ state: string; last_error: string | null }>(
        "SELECT state, last_error FROM semantic_hnsw_index_build WHERE build_key = 'semantic_hnsw'"
      );
      assert.equal(failure.rows[0]?.state, "failed");
      assert.match(failure.rows[0]?.last_error ?? "", RE_HNSW_FAILURE);
      assert.ok(logs.some((line) => line.includes("HNSW builder failed (retryable)")));
    });
  });

  test("a blocked HNSW build is canceled at the attempt deadline", async () => {
    await withTempDatabase(async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const admin = new pg.Pool({ connectionString: url });
      const holder = await admin.connect();
      const previousTimeout = process.env.PDPP_PG_SEMANTIC_HNSW_BUILD_TIMEOUT_MS;
      process.env.PDPP_PG_SEMANTIC_HNSW_BUILD_TIMEOUT_MS = "100";
      try {
        await holder.query("BEGIN");
        await holder.query("LOCK TABLE semantic_search_blob IN ACCESS EXCLUSIVE MODE");
        const startedAt = Date.now();
        await runPostgresSemanticHnswMaintenance();
        assert.ok(Date.now() - startedAt < 5000, "a blocked optional build does not run past its deadline");
        const failure = await postgresQuery<{ state: string; last_error: string | null }>(
          "SELECT state, last_error FROM semantic_hnsw_index_build WHERE build_key = 'semantic_hnsw'"
        );
        assert.equal(failure.rows[0]?.state, "failed");
        assert.match(failure.rows[0]?.last_error ?? "", RE_HNSW_TIMEOUT);
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        holder.release();
        await admin.end();
        if (previousTimeout === undefined) {
          delete process.env.PDPP_PG_SEMANTIC_HNSW_BUILD_TIMEOUT_MS;
        } else {
          process.env.PDPP_PG_SEMANTIC_HNSW_BUILD_TIMEOUT_MS = previousTimeout;
        }
      }
    });
  });

  test("required PostgreSQL bootstrap errors reject instead of claiming readiness", async () => {
    await withTempDatabase(async (url) => {
      const admin = new pg.Pool({ connectionString: url });
      const holder = await admin.connect();
      try {
        await holder.query("SELECT pg_advisory_lock($1, $2)", [482_571, 150]);
        await assert.rejects(
          initPostgresStorage({ backend: "postgres", databaseUrl: url }, { bootstrapLockTimeoutMs: 1 }),
          RE_BOOTSTRAP_TIMEOUT
        );
      } finally {
        await holder.query("SELECT pg_advisory_unlock($1, $2)", [482_571, 150]).catch(() => undefined);
        holder.release();
        await admin.end();
      }
    });
  });

  test("required PostgreSQL schema migrations fail closed on an incompatible existing table", async () => {
    await withTempDatabase(async (url) => {
      const admin = new pg.Pool({ connectionString: url });
      try {
        await admin.query("CREATE TABLE connectors (connector_id INTEGER PRIMARY KEY)");
      } finally {
        await admin.end();
      }
      await assert.rejects(initPostgresStorage({ backend: "postgres", databaseUrl: url }), RE_INCOMPATIBLE_SCHEMA);
    });
  });
} else {
  test("Postgres HNSW post-listen tests (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {
    // skip
  });
}
