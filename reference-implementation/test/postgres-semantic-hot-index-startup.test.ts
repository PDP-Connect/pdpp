// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Production defect: `bootstrapPostgresSchema` used to synchronously await
 * `ensureSemanticHotHnswIndexes` — a per-connector-instance "hot source"
 * partial HNSW index build — before startServer's HTTP listeners could
 * accept traffic. `CREATE INDEX CONCURRENTLY` on a large partition can run
 * for tens of minutes; a canceled build left an invalid index that was
 * retried (still blocking) on every subsequent restart, so the server could
 * stay unhealthy for a very long time.
 *
 * These tests pin the terminal correction:
 *
 *   1. Bootstrap (and therefore startup readiness) never calls
 *      `CREATE INDEX CONCURRENTLY` for a hot index, even when there is a
 *      qualifying hot source sitting above the row-count threshold.
 *   2. The background reconciler (`reconcileSemanticHotHnswIndexesInBackground`)
 *      is the only owner of that work, and at most one caller — across
 *      concurrent ticks, processes, or replicas — actually builds at a time;
 *      a losing caller returns without touching the index.
 *   3. An index left invalid by a canceled build (reproduced here the same
 *      way a real deploy restart would: `pg_cancel_backend` mid-`CREATE INDEX
 *      CONCURRENTLY`) is dropped and rebuilt to valid on the next
 *      reconcile, instead of silently no-op'ing forever behind
 *      `IF NOT EXISTS`.
 *
 * Requires PDPP_TEST_POSTGRES_URL (a pgvector-capable Postgres, e.g.
 * pgvector/pgvector:pg16). Skipped otherwise.
 */

import assert from "node:assert/strict";
import test from "node:test";

// biome-ignore lint/correctness/noUnresolvedImports: the test runner resolves this runtime fixture import outside Biome static resolution.
import pg from "pg";
import {
  bootstrapPostgresSchema,
  closePostgresStorage,
  getPostgresPool,
  initPostgresStorage,
  reconcileSemanticHotHnswIndexesInBackground,
} from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const SEMANTIC_HOT_INDEX_LOCK = [482_571, 152];
const HOT_INDEX_MIN_ROWS_ENV = "PDPP_PG_SEMANTIC_HOT_INDEX_MIN_ROWS";
const HOT_INDEX_MAX_CONNECTIONS_ENV = "PDPP_PG_SEMANTIC_HOT_INDEX_MAX_CONNECTIONS";
const HOT_INDEX_MAX_TABLE_SHARE_ENV = "PDPP_PG_SEMANTIC_HOT_INDEX_MAX_TABLE_SHARE";

function deterministicVector(dimensions: number, seed: number): number[] {
  const vec = new Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    vec[index] = Math.sin(seed * 31 + index * 7) * 0.5;
  }
  return vec;
}

async function seedHotSourceEmbeddings(
  connectorInstanceId: string,
  connectorId: string,
  rowCount: number
): Promise<void> {
  const pool = getPostgresPool();
  const batchSize = 500;
  for (let start = 0; start < rowCount; start += batchSize) {
    const end = Math.min(start + batchSize, rowCount);
    const values: string[] = [];
    const params: unknown[] = [];
    for (let index = start; index < end; index += 1) {
      const base = params.length;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::vector)`);
      params.push(
        connectorId,
        connectorInstanceId,
        "scope",
        `rec_${index}`,
        JSON.stringify(deterministicVector(384, index))
      );
    }
    // biome-ignore lint/performance/noAwaitInLoops: batches must land in order so the row-count seeded into retained_size_stream below matches what is actually committed.
    await pool.query(
      `INSERT INTO semantic_search_blob (connector_id, connector_instance_id, scope_key, record_key, embedding)
       VALUES ${values.join(", ")}
       ON CONFLICT (connector_instance_id, scope_key, record_key) DO NOTHING`,
      params
    );
  }
  await pool.query(
    `INSERT INTO retained_size_stream (connector_instance_id, connector_id, stream, record_count, dirty)
     VALUES ($1, $2, 'records', $3, 0)
     ON CONFLICT (connector_instance_id, stream)
     DO UPDATE SET record_count = EXCLUDED.record_count, dirty = 0`,
    [connectorInstanceId, connectorId, rowCount]
  );
}

async function countPgLocks(admin: InstanceType<typeof pg.Pool>): Promise<number> {
  const result = await admin.query(
    `SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 AND objid = $2`,
    SEMANTIC_HOT_INDEX_LOCK
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function hotIndexNames(admin: InstanceType<typeof pg.Pool>): Promise<string[]> {
  const result = await admin.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname LIKE 'idx_pg_semantic_hnsw_hot_%'`
  );
  return result.rows.map((row) => row.indexname);
}

if (POSTGRES_URL) {
  test("bootstrap readiness is never gated by hot-index construction, even with a qualifying hot source", async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const databaseName = `pdpp_hotidx_ready_${suffix}`;
    const previousMinRows = process.env[HOT_INDEX_MIN_ROWS_ENV];
    const previousMaxTableShare = process.env[HOT_INDEX_MAX_TABLE_SHARE_ENV];
    process.env[HOT_INDEX_MIN_ROWS_ENV] = "50";
    // Default max-table-share (0.1) would exclude a 200-row hot source out of
    // a 200-row table (floor(200*0.1)=20 < 200); widen it so the seeded
    // candidate genuinely qualifies and this assertion exercises the real
    // "would have built it" path, not an accidental early-return.
    process.env[HOT_INDEX_MAX_TABLE_SHARE_ENV] = "1";
    await withTemporaryPostgresDatabase(
      { closeConnections: closePostgresStorage, connectionString: POSTGRES_URL, databaseName },
      async (url) => {
        const admin = new pg.Pool({ connectionString: url });
        try {
          await initPostgresStorage({ backend: "postgres", databaseUrl: url });
          // Seed a hot-source candidate comfortably above the (lowered) min-rows
          // threshold so ensureSemanticHotHnswIndexes would have real work to do
          // if it ran on this path.
          await seedHotSourceEmbeddings("cin_hot1", "connector_hot", 200);

          const startedAt = Date.now();
          // Re-running bootstrap must return promptly. If the defect were
          // still present, this await would race a multi-second-plus
          // CREATE INDEX CONCURRENTLY build for the seeded rows above.
          await bootstrapPostgresSchema({});
          const elapsedMs = Date.now() - startedAt;
          assert.ok(
            elapsedMs < 5000,
            `bootstrap took ${elapsedMs}ms; readiness must not wait on hot-index construction`
          );

          // The mutation-sensitive half of this proof: bootstrap must not have
          // built the hot index as a side effect. Without the fix, this
          // assertion fails because the synchronous call inside
          // migratePostgresSemanticEmbeddingToVector already created it.
          const names = await hotIndexNames(admin);
          assert.deepEqual(names, [], "bootstrap must not construct any hot-source HNSW index inline");
        } finally {
          await admin.end();
        }
      }
    );
    if (previousMinRows === undefined) {
      delete process.env[HOT_INDEX_MIN_ROWS_ENV];
    } else {
      process.env[HOT_INDEX_MIN_ROWS_ENV] = previousMinRows;
    }
    if (previousMaxTableShare === undefined) {
      delete process.env[HOT_INDEX_MAX_TABLE_SHARE_ENV];
    } else {
      process.env[HOT_INDEX_MAX_TABLE_SHARE_ENV] = previousMaxTableShare;
    }
  });

  test("background reconcile is the only owner: concurrent callers do not double-build, and the lock is released", async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const databaseName = `pdpp_hotidx_singleowner_${suffix}`;
    const previousMinRows = process.env[HOT_INDEX_MIN_ROWS_ENV];
    const previousMaxConnections = process.env[HOT_INDEX_MAX_CONNECTIONS_ENV];
    const previousMaxTableShare = process.env[HOT_INDEX_MAX_TABLE_SHARE_ENV];
    process.env[HOT_INDEX_MIN_ROWS_ENV] = "50";
    process.env[HOT_INDEX_MAX_CONNECTIONS_ENV] = "1";
    process.env[HOT_INDEX_MAX_TABLE_SHARE_ENV] = "1";
    await withTemporaryPostgresDatabase(
      { closeConnections: closePostgresStorage, connectionString: POSTGRES_URL, databaseName },
      async (url) => {
        const admin = new pg.Pool({ connectionString: url });
        try {
          await initPostgresStorage({ backend: "postgres", databaseUrl: url });
          await seedHotSourceEmbeddings("cin_hot1", "connector_hot", 200);

          // Fire two reconcile passes concurrently. Only the lock-winner may
          // build; the loser must observe the try-lock fail and return
          // without racing the same CREATE INDEX CONCURRENTLY (which would
          // otherwise deadlock/serialize unpredictably against itself).
          const logsA: string[] = [];
          const logsB: string[] = [];
          await Promise.all([
            reconcileSemanticHotHnswIndexesInBackground((msg) => logsA.push(msg)),
            reconcileSemanticHotHnswIndexesInBackground((msg) => logsB.push(msg)),
          ]);

          const buildLogCount = [logsA, logsB].filter((logs) =>
            logs.some((msg) => msg.includes("ensuring hot-source HNSW index"))
          ).length;
          assert.equal(buildLogCount, 1, "exactly one of the two concurrent reconcile calls must own the build");

          const names = await hotIndexNames(admin);
          assert.equal(names.length, 1, "the hot index must be built exactly once, not duplicated or skipped");

          const validity = await admin.query<{ indisvalid: boolean }>(
            "SELECT indisvalid FROM pg_index WHERE indexrelid = $1::regclass",
            [names[0]]
          );
          assert.equal(validity.rows[0]?.indisvalid, true, "the built hot index must end up valid");

          const remainingLocks = await countPgLocks(admin);
          assert.equal(remainingLocks, 0, "the reconcile advisory lock must not be left held after both calls settle");
        } finally {
          await admin.end();
        }
      }
    );
    if (previousMinRows === undefined) {
      delete process.env[HOT_INDEX_MIN_ROWS_ENV];
    } else {
      process.env[HOT_INDEX_MIN_ROWS_ENV] = previousMinRows;
    }
    if (previousMaxConnections === undefined) {
      delete process.env[HOT_INDEX_MAX_CONNECTIONS_ENV];
    } else {
      process.env[HOT_INDEX_MAX_CONNECTIONS_ENV] = previousMaxConnections;
    }
    if (previousMaxTableShare === undefined) {
      delete process.env[HOT_INDEX_MAX_TABLE_SHARE_ENV];
    } else {
      process.env[HOT_INDEX_MAX_TABLE_SHARE_ENV] = previousMaxTableShare;
    }
  });

  test("an invalid hot index from a canceled build is dropped and rebuilt to valid on the next reconcile", async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const databaseName = `pdpp_hotidx_invalid_${suffix}`;
    const previousMinRows = process.env[HOT_INDEX_MIN_ROWS_ENV];
    const previousMaxConnections = process.env[HOT_INDEX_MAX_CONNECTIONS_ENV];
    const previousMaxTableShare = process.env[HOT_INDEX_MAX_TABLE_SHARE_ENV];
    process.env[HOT_INDEX_MIN_ROWS_ENV] = "50";
    process.env[HOT_INDEX_MAX_CONNECTIONS_ENV] = "1";
    process.env[HOT_INDEX_MAX_TABLE_SHARE_ENV] = "1";
    await withTemporaryPostgresDatabase(
      { closeConnections: closePostgresStorage, connectionString: POSTGRES_URL, databaseName },
      async (url) => {
        const admin = new pg.Pool({ connectionString: url });
        const canceler = new pg.Pool({ connectionString: url });
        try {
          await initPostgresStorage({ backend: "postgres", databaseUrl: url });
          await seedHotSourceEmbeddings("cin_hot1", "connector_hot", 3000);

          const indexName = "idx_pg_semantic_hnsw_hot_connector_hot_hot1";

          // Reproduce the real production failure mode: start the exact same
          // CREATE INDEX CONCURRENTLY the reconciler would run, then cancel it
          // mid-flight — mirroring a deploy restart interrupting a live build —
          // and confirm Postgres leaves it invalid, same as the live incident.
          const buildPromise = canceler
            .query(
              `CREATE INDEX CONCURRENTLY ${indexName}
                 ON semantic_search_blob
                 USING hnsw ((embedding::vector(384)) vector_cosine_ops)
                 WHERE connector_instance_id = 'cin_hot1' AND vector_dims(embedding) = 384`
            )
            .catch(() => undefined);
          const activity = await pollForActiveBuild(admin, indexName, Date.now() + 5000);
          assert.ok(activity, "the concurrent build must be observable in pg_stat_activity before it is canceled");
          await admin.query("SELECT pg_cancel_backend($1)", [activity]);
          await buildPromise;

          const beforeValidity = await admin.query<{ indisvalid: boolean }>(
            "SELECT indisvalid FROM pg_index WHERE indexrelid = $1::regclass",
            [indexName]
          );
          assert.equal(
            beforeValidity.rows[0]?.indisvalid,
            false,
            "the canceled build must leave an invalid index (test setup check)"
          );

          const logs: string[] = [];
          await reconcileSemanticHotHnswIndexesInBackground((msg) => logs.push(msg));

          assert.ok(
            logs.some((msg) => msg.includes("dropping invalid hot-source HNSW index")),
            "the reconciler must detect and drop the invalid index before rebuilding"
          );

          const afterValidity = await admin.query<{ indisvalid: boolean }>(
            "SELECT indisvalid FROM pg_index WHERE indexrelid = $1::regclass",
            [indexName]
          );
          assert.equal(
            afterValidity.rows[0]?.indisvalid,
            true,
            "the rebuilt hot index must end up valid, not stay wedged"
          );
        } finally {
          await canceler.end();
          await admin.end();
        }
      }
    );
    if (previousMinRows === undefined) {
      delete process.env[HOT_INDEX_MIN_ROWS_ENV];
    } else {
      process.env[HOT_INDEX_MIN_ROWS_ENV] = previousMinRows;
    }
    if (previousMaxConnections === undefined) {
      delete process.env[HOT_INDEX_MAX_CONNECTIONS_ENV];
    } else {
      process.env[HOT_INDEX_MAX_CONNECTIONS_ENV] = previousMaxConnections;
    }
    if (previousMaxTableShare === undefined) {
      delete process.env[HOT_INDEX_MAX_TABLE_SHARE_ENV];
    } else {
      process.env[HOT_INDEX_MAX_TABLE_SHARE_ENV] = previousMaxTableShare;
    }
  });

  test("reconcile is a no-op when the storage backend is not Postgres", async () => {
    await closePostgresStorage();
    // With no Postgres storage initialized, this must resolve immediately
    // without throwing (there is no pool to connect from).
    await reconcileSemanticHotHnswIndexesInBackground();
  });
}

async function pollForActiveBuild(
  admin: InstanceType<typeof pg.Pool>,
  indexName: string,
  deadlineMs: number
): Promise<number | null> {
  const result = await admin.query<{ pid: number }>(
    `SELECT pid FROM pg_stat_activity WHERE query LIKE $1 AND query LIKE 'CREATE INDEX CONCURRENTLY%'`,
    [`%${indexName}%`]
  );
  const pid = result.rows[0]?.pid;
  if (pid !== undefined) {
    return pid;
  }
  if (Date.now() >= deadlineMs) {
    return null;
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
  return pollForActiveBuild(admin, indexName, deadlineMs);
}
