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

  // A same-name index that is `indisvalid`/`indisready` and really is an HNSW
  // index can still accelerate nothing: the wrong dimension, operator class,
  // or partial predicate all leave the production query unindexed while the
  // catalog looks healthy. Each case below is a *valid* index, so a repair
  // check that only tests validity plus the substring "hnsw" accepts it and
  // reports a build that never happened.
  const WRONG_GLOBAL_DEFINITIONS = [
    {
      label: "wrong dimension",
      sql: `CREATE INDEX idx_pg_semantic_search_embedding_hnsw ON semantic_search_blob
              USING hnsw ((embedding::vector(3)) vector_cosine_ops)
              WHERE (vector_dims(embedding) = 3)`,
    },
    {
      label: "wrong operator class",
      sql: `CREATE INDEX idx_pg_semantic_search_embedding_hnsw ON semantic_search_blob
              USING hnsw ((embedding::vector(384)) vector_l2_ops)
              WHERE (vector_dims(embedding) = 384)`,
    },
    {
      label: "missing partial predicate",
      sql: `CREATE INDEX idx_pg_semantic_search_embedding_hnsw ON semantic_search_blob
              USING hnsw ((embedding::vector(384)) vector_cosine_ops)`,
    },
    {
      label: "wrong partial predicate",
      sql: `CREATE INDEX idx_pg_semantic_search_embedding_hnsw ON semantic_search_blob
              USING hnsw ((embedding::vector(384)) vector_cosine_ops)
              WHERE (vector_dims(embedding) = 384 AND record_key <> '')`,
    },
  ];

  for (const wrong of WRONG_GLOBAL_DEFINITIONS) {
    test(`a valid but semantically wrong global HNSW index is rebuilt (${wrong.label})`, async () => {
      await withTempDatabase(async (url) => {
        await initPostgresStorage({ backend: "postgres", databaseUrl: url });
        await postgresQuery("DROP INDEX IF EXISTS idx_pg_semantic_search_embedding_hnsw");
        await postgresQuery(wrong.sql);
        const planted = await postgresQuery<{ valid: boolean; definition: string }>(
          `SELECT ix.indisvalid AS valid, pg_get_indexdef(idx.oid) AS definition
             FROM pg_class idx
             JOIN pg_namespace ns ON ns.oid = idx.relnamespace
             JOIN pg_index ix ON ix.indexrelid = idx.oid
            WHERE ns.nspname = current_schema()
              AND idx.relname = 'idx_pg_semantic_search_embedding_hnsw'`
        );
        // Guard the test's own premise: the planted index must be the hard
        // case (valid, and genuinely HNSW), not an easy invalid/non-HNSW one.
        assert.equal(planted.rows[0]?.valid, true, "the planted wrong index is valid");
        assert.ok(planted.rows[0]?.definition.includes("hnsw"), "the planted wrong index is genuinely an HNSW index");

        const logs: string[] = [];
        await runPostgresSemanticHnswMaintenance({ log: (line) => logs.push(line) });

        const repaired = await postgresQuery<{ definition: string }>(
          `SELECT pg_get_indexdef(idx.oid) AS definition
             FROM pg_class idx
             JOIN pg_namespace ns ON ns.oid = idx.relnamespace
            WHERE ns.nspname = current_schema()
              AND idx.relname = 'idx_pg_semantic_search_embedding_hnsw'`
        );
        assert.equal(repaired.rowCount, 1, "exactly one global HNSW index remains after repair");
        const definition = repaired.rows[0]?.definition ?? "";
        assert.ok(definition.includes("vector(384)"), `repaired index is 384-dimensional: ${definition}`);
        assert.ok(definition.includes("vector_cosine_ops"), `repaired index uses cosine ops: ${definition}`);
        assert.ok(
          definition.includes("WHERE (vector_dims(embedding) = 384)"),
          `repaired index carries the canonical predicate: ${definition}`
        );
        assert.ok(
          logs.some((line) => line.includes("dropping unusable HNSW index")),
          `the repair says why it rebuilt: ${logs.join(" | ")}`
        );
        const state = await postgresQuery<{ state: string }>(
          "SELECT state FROM semantic_hnsw_index_build WHERE build_key = 'semantic_hnsw'"
        );
        assert.equal(state.rows[0]?.state, "ready", "the durable state reports ready only after a real rebuild");
      });
    });
  }

  test("a correct global HNSW index carrying operator tuning options is not rebuilt", async () => {
    await withTempDatabase(async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      await postgresQuery("DROP INDEX IF EXISTS idx_pg_semantic_search_embedding_hnsw");
      // `WITH (m = ...)` changes the generated `pg_get_indexdef` text but not
      // what the index means. Repair must keep an operator's deliberate tuning
      // instead of dropping and rebuilding it on every startup.
      await postgresQuery(
        `CREATE INDEX idx_pg_semantic_search_embedding_hnsw ON semantic_search_blob
           USING hnsw ((embedding::vector(384)) vector_cosine_ops) WITH (m = 32)
           WHERE (vector_dims(embedding) = 384)`
      );
      const before = await postgresQuery<{ oid: string }>(
        `SELECT idx.oid::text AS oid FROM pg_class idx JOIN pg_namespace ns ON ns.oid = idx.relnamespace
          WHERE ns.nspname = current_schema() AND idx.relname = 'idx_pg_semantic_search_embedding_hnsw'`
      );
      await runPostgresSemanticHnswMaintenance();
      const after = await postgresQuery<{ oid: string; definition: string }>(
        `SELECT idx.oid::text AS oid, pg_get_indexdef(idx.oid) AS definition
           FROM pg_class idx JOIN pg_namespace ns ON ns.oid = idx.relnamespace
          WHERE ns.nspname = current_schema() AND idx.relname = 'idx_pg_semantic_search_embedding_hnsw'`
      );
      assert.equal(after.rows[0]?.oid, before.rows[0]?.oid, "a tuned but correct index is preserved");
      assert.ok(after.rows[0]?.definition.includes("m='32'"), "the operator's tuning survives maintenance");
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

  // A hot-source index is per-connection: its whole value is the partial
  // predicate pinning it to ONE connector_instance_id. An index built for a
  // different connection is valid, is genuinely HNSW, and carries the right
  // dimension and operator class — so every check except the identity
  // comparison accepts it, while the queries it is supposed to accelerate scan
  // unindexed. This is the "wrong hot-source identity" case the R1 review asked
  // for and the R2 review recorded as still untested (P2-1).
  test("a hot-source HNSW index built for the wrong connector identity is dropped and rebuilt", async () => {
    await withTempDatabase(async (url) => {
      // Make one connection "hot" without seeding 10k rows.
      const previousMinRows = process.env.PDPP_PG_SEMANTIC_HOT_INDEX_MIN_ROWS;
      process.env.PDPP_PG_SEMANTIC_HOT_INDEX_MIN_ROWS = "1";
      try {
        await initPostgresStorage({ backend: "postgres", databaseUrl: url });

        const HOT_CONNECTOR = "hotconn";
        const HOT_INSTANCE = "cin_hot0001";
        const OTHER_INSTANCE = "cin_other999";
        const embedding = JSON.stringify(Array.from({ length: 384 }, (_, i) => (i % 7) / 7));

        // After the pgvector migration `embedding` is a `vector`, not JSONB.
        await postgresQuery(
          `INSERT INTO semantic_search_blob (connector_id, connector_instance_id, scope_key, record_key, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)`,
          [HOT_CONNECTOR, HOT_INSTANCE, '["messages","body"]', "rec_hot_1", embedding]
        );
        await postgresQuery(
          `INSERT INTO retained_size_stream (connector_instance_id, connector_id, stream, record_count, dirty)
           VALUES ($1, $2, $3, $4, 0)`,
          [HOT_INSTANCE, HOT_CONNECTOR, "messages", 1]
        );

        // Learn the exact index name from a clean maintenance pass rather than
        // reimplementing semanticHotHnswIndexName's slug/truncation rules here;
        // a hand-derived name that silently missed would make this test pass
        // vacuously against no index at all.
        await runPostgresSemanticHnswMaintenance();
        const created = await postgresQuery<{ name: string }>(
          `SELECT idx.relname AS name
             FROM pg_class idx
             JOIN pg_namespace ns ON ns.oid = idx.relnamespace
            WHERE ns.nspname = current_schema()
              AND idx.relname LIKE 'idx_pg_semantic_hnsw_hot_%'`
        );
        assert.equal(created.rowCount, 1, "the hot path built exactly one index for the hot connection");
        const indexName = created.rows[0]?.name ?? "";

        // Replace it with an index that is correct in every respect EXCEPT the
        // identity it is pinned to.
        await postgresQuery(`DROP INDEX ${indexName}`);
        await postgresQuery(
          `CREATE INDEX ${indexName} ON semantic_search_blob
             USING hnsw ((embedding::vector(384)) vector_cosine_ops)
             WHERE connector_instance_id = '${OTHER_INSTANCE}'
               AND vector_dims(embedding) = 384`
        );

        const planted = await postgresQuery<{ valid: boolean; definition: string }>(
          `SELECT ix.indisvalid AS valid, pg_get_indexdef(idx.oid) AS definition
             FROM pg_class idx
             JOIN pg_namespace ns ON ns.oid = idx.relnamespace
             JOIN pg_index ix ON ix.indexrelid = idx.oid
            WHERE ns.nspname = current_schema()
              AND idx.relname = $1`,
          [indexName]
        );
        // Guard the test's own premise: this must be the hard case — a valid,
        // genuinely-HNSW, correctly-dimensioned index that is wrong ONLY in
        // whose rows it covers.
        assert.equal(planted.rows[0]?.valid, true, "the planted wrong-identity index is valid");
        const plantedDefinition = planted.rows[0]?.definition ?? "";
        assert.ok(plantedDefinition.includes("hnsw"), `planted index is genuinely HNSW: ${plantedDefinition}`);
        assert.ok(plantedDefinition.includes("vector(384)"), `planted index is 384-dimensional: ${plantedDefinition}`);
        assert.ok(
          plantedDefinition.includes("vector_cosine_ops"),
          `planted index uses cosine ops: ${plantedDefinition}`
        );
        assert.ok(
          plantedDefinition.includes(OTHER_INSTANCE),
          `planted index is pinned to the WRONG connection: ${plantedDefinition}`
        );

        const logs: string[] = [];
        await runPostgresSemanticHnswMaintenance({ log: (line) => logs.push(line) });

        // THE DISCRIMINATING ORACLE. The rebuild's CREATE INDEX derives its
        // predicate straight from `row.connector_instance_id`, independently of
        // `semanticHotHnswPredicate` — so asserting only that the final index
        // looks right passes even when the identity comparison is removed
        // entirely (verified: that mutant survives a rebuilt-shape-only
        // assertion). What a broken identity check actually changes is whether
        // the wrong index is RECOGNISED as unusable, so assert on the drop
        // decision and its stated reason.
        assert.ok(
          logs.some((line) => line.includes("dropping unusable hot-source index") && line.includes(indexName)),
          `the wrong-identity index was recognised as unusable and dropped: ${logs.join(" | ")}`
        );
        assert.ok(
          logs.some((line) => line.includes(OTHER_INSTANCE) || line.includes("predicate")),
          `the drop names the predicate mismatch as the reason, not something else: ${logs.join(" | ")}`
        );

        const repaired = await postgresQuery<{ definition: string }>(
          `SELECT pg_get_indexdef(idx.oid) AS definition
             FROM pg_class idx
             JOIN pg_namespace ns ON ns.oid = idx.relnamespace
            WHERE ns.nspname = current_schema()
              AND idx.relname = $1`,
          [indexName]
        );
        assert.equal(repaired.rowCount, 1, "exactly one hot-source index remains after repair");
        const definition = repaired.rows[0]?.definition ?? "";
        assert.ok(definition.includes(HOT_INSTANCE), `repaired index is pinned to the hot connection: ${definition}`);
        assert.ok(
          !definition.includes(OTHER_INSTANCE),
          `the wrong-identity predicate is gone, not merely appended to: ${definition}`
        );
        assert.ok(definition.includes("vector(384)"), `repaired index is 384-dimensional: ${definition}`);
        assert.ok(definition.includes("vector_cosine_ops"), `repaired index uses cosine ops: ${definition}`);

        // Second pass over the now-correct index must be a no-op. This is the
        // half a removed identity comparison actually breaks: with the
        // comparison gone, the expected predicate no longer matches the
        // correctly-rebuilt index either, so maintenance drops and rebuilds it
        // on every startup instead of leaving it alone.
        const secondPassLogs: string[] = [];
        await runPostgresSemanticHnswMaintenance({ log: (line) => secondPassLogs.push(line) });
        assert.ok(
          !secondPassLogs.some((line) => line.includes("dropping unusable hot-source index")),
          `a correct hot-source index is left alone on the next pass: ${secondPassLogs.join(" | ")}`
        );
      } finally {
        if (previousMinRows === undefined) {
          delete process.env.PDPP_PG_SEMANTIC_HOT_INDEX_MIN_ROWS;
        } else {
          process.env.PDPP_PG_SEMANTIC_HOT_INDEX_MIN_ROWS = previousMinRows;
        }
      }
    });
  });
} else {
  test("Postgres HNSW post-listen tests (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {
    // skip
  });
}
