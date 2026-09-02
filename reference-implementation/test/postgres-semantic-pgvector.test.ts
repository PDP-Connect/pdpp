// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Acceptance for `migrate-postgres-semantic-index-to-pgvector`.
 *
 * The Postgres semantic-search path stores embeddings as pgvector `vector`
 * values and scores them in the database (`embedding <=> query` + partial
 * expression HNSW index) instead of fetching candidate JSONB embeddings and
 * brute-force cosine-scoring them in JS. These tests pin:
 *
 *   1. The boot migration converts a seeded legacy JSONB-shape
 *      `semantic_search_blob` to the vector representation, preserving row
 *      count and embedding values across batched backfill. HNSW construction
 *      is tested separately as post-readiness maintenance.
 *   2. The migration resumes safely from a manufactured half-migrated state
 *      (partial `embedding_vec` backfill).
 *   3. `postgresSemanticSearch` ordering and `distance` values match the
 *      pre-migration JS brute-force semantics on a small fixture, including
 *      scope-key scoping and `recordKeys` candidate narrowing.
 *   4. Mixed-dimension rows (test stub backends use 8/64 dims; production
 *      uses 384) coexist in the shared table without cross-talk.
 *
 * Requires PDPP_TEST_POSTGRES_URL (a pgvector-capable Postgres, e.g.
 * pgvector/pgvector:pg16). Skipped otherwise.
 */

import assert from "node:assert/strict";
import test from "node:test";

// biome-ignore lint/correctness/noUnresolvedImports: the test runner resolves this runtime fixture import outside Biome static resolution.
import pg from "pg";
import { postgresSemanticIndexUpsertMany, postgresSemanticSearch } from "../server/postgres-search.ts";
import {
  bootstrapPostgresSchema,
  closePostgresStorage,
  initPostgresStorage,
  isPostgresSemanticVectorEmbedding,
  postgresQuery,
  runPostgresSemanticHnswMaintenance,
} from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const LEGACY_BLOB_DDL = `
  CREATE TABLE semantic_search_blob (
    connector_id TEXT NOT NULL,
    connector_instance_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    record_key TEXT NOT NULL,
    embedding JSONB NOT NULL,
    PRIMARY KEY(connector_instance_id, scope_key, record_key)
  )
`;

function withSearchPath(url: string, schema: string): string {
  const parsed = new URL(url);
  // Resolve unqualified names in the scratch schema first; keep `public` so
  // the pgvector `vector` type (installed in `public`) stays visible.
  parsed.searchParams.set("options", `-csearch_path=${schema},public`);
  return parsed.toString();
}

// Mirrors the legacy JS scoring path this change replaced, so parity is
// asserted against the genuine pre-migration semantics.
function bruteForceCosineDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  const len = Math.min(a.length, b.length);
  for (let index = 0; index < len; index += 1) {
    const av = Number(a[index]) || 0;
    const bv = Number(b[index]) || 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  if (magA === 0 || magB === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return 1 - dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function bruteForceRank(
  rows: { recordKey: string; vector: ArrayLike<number> }[],
  queryVector: ArrayLike<number>
): { recordKey: string; distance: number }[] {
  return rows
    .map((row) => ({
      distance: bruteForceCosineDistance(queryVector, row.vector),
      recordKey: row.recordKey,
    }))
    .sort((a, b) => a.distance - b.distance || (a.recordKey < b.recordKey ? -1 : 1));
}

function deterministicVector(dimensions: number, seed: number): Float32Array {
  const vec = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    vec[index] = Math.sin(seed * 31 + index * 7) * 0.5;
  }
  return vec;
}

if (POSTGRES_URL) {
  test("Postgres bootstrap migrates browser surface leases in the current schema", async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const databaseName = `pdpp_surface_lease_schema_${suffix}`;
    const schema = `pdpp_surface_lease_schema_${suffix}`;
    await withTemporaryPostgresDatabase(
      { closeConnections: closePostgresStorage, connectionString: POSTGRES_URL, databaseName },
      async (url) => {
        const adminPool = new pg.Pool({ connectionString: url });
        try {
          await adminPool.query(`CREATE SCHEMA ${schema}`);
          await initPostgresStorage({ backend: "postgres", databaseUrl: withSearchPath(url, schema) });
          const column = await postgresQuery(
            `SELECT 1
               FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'browser_surface_leases'
                AND column_name = 'surface_subject_id'`
          );
          assert.equal(column.rowCount, 1, "bootstrap must retain the lease subject column in its active schema");
        } finally {
          await closePostgresStorage().catch(() => undefined);
          await adminPool.end();
        }
      }
    );
  });

  test("boot migration converts a legacy JSONB embedding table to pgvector with batched backfill", async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const schema = `pdpp_semvec_mig_${suffix}`;
    const seeded: { recordKey: string; vector: number[] }[] = [];
    const adminPool = new pg.Pool({ connectionString: POSTGRES_URL });
    const previousBatchSize = process.env.PDPP_PG_SEMANTIC_MIGRATION_BATCH_SIZE;
    process.env.PDPP_PG_SEMANTIC_MIGRATION_BATCH_SIZE = "3";
    try {
      const admin = await adminPool.connect();
      try {
        await admin.query(`CREATE SCHEMA ${schema}`);
        // Raw fixtures bypass bootstrapPostgresSchema, so ensure the pgvector
        // extension exists in public for fresh-database runs.
        await admin.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
        await admin.query(`SET search_path = ${schema}, public`);
        // Seed the legacy shape BEFORE the runtime ever bootstraps this
        // schema, exactly like a pre-pgvector deployment.
        await admin.query(LEGACY_BLOB_DDL);
        for (let index = 0; index < 8; index += 1) {
          const vector = Array.from(deterministicVector(5, index + 1), (value) => Number(value));
          seeded.push({ recordKey: `rec_${index}`, vector });
        }
        await Promise.all(
          seeded.map(({ recordKey, vector }) =>
            admin.query(
              `INSERT INTO semantic_search_blob (connector_id, connector_instance_id, scope_key, record_key, embedding)
               VALUES ($1, $2, $3, $4, $5::jsonb)`,
              ["legacy_conn", "cin_legacy", '["messages","body"]', recordKey, JSON.stringify(vector)]
            )
          )
        );
        // A non-castable garbage row must be dropped, not wedge the boot.
        await admin.query(
          `INSERT INTO semantic_search_blob (connector_id, connector_instance_id, scope_key, record_key, embedding)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          ["legacy_conn", "cin_legacy", '["messages","body"]', "rec_garbage", JSON.stringify({ not: "an array" })]
        );
      } finally {
        admin.release();
      }

      const logLines: string[] = [];
      await initPostgresStorage(
        { backend: "postgres", databaseUrl: withSearchPath(POSTGRES_URL, schema) },
        { log: (line) => logLines.push(String(line)) }
      );
      try {
        assert.equal(isPostgresSemanticVectorEmbedding(), true, "mode flag must report pgvector after migration");

        const column = await postgresQuery(
          `SELECT udt_name, is_nullable FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = 'semantic_search_blob' AND column_name = 'embedding'`,
          [schema]
        );
        assert.equal(column.rows[0]?.udt_name, "vector", "embedding column must be pgvector");
        assert.equal(column.rows[0]?.is_nullable, "NO", "embedding column must be NOT NULL again");

        const rows = await postgresQuery(
          "SELECT record_key, embedding::text AS embedding FROM semantic_search_blob ORDER BY record_key"
        );
        assert.deepEqual(
          rows.rows.map((row) => row.record_key),
          seeded.map((row) => row.recordKey),
          "every castable row survives; the garbage row is dropped"
        );
        for (const [position, row] of rows.rows.entries()) {
          const migrated = JSON.parse(row.embedding) as number[];
          const original = seeded[position]?.vector ?? [];
          assert.equal(migrated.length, original.length);
          for (let index2 = 0; index2 < original.length; index2 += 1) {
            assert.ok(
              Math.abs((migrated[index2] ?? 0) - (original[index2] ?? 0)) < 1e-5,
              `embedding value preserved for ${row.record_key}[${index2}]`
            );
          }
        }

        assert.ok(
          logLines.some((line) => line.includes("JSONB → pgvector (8 rows)")),
          `migration start logged (got: ${JSON.stringify(logLines)})`
        );
        assert.ok(
          logLines.some((line) => line.includes("dropped 1 non-castable")),
          "garbage drop logged"
        );
        assert.ok(
          logLines.filter((line) => line.includes("backfilled")).length >= 3,
          "batched backfill (batch size 3 over 8 rows) logs multiple batches"
        );

        // Post-migration query semantics match the brute-force replica.
        const queryVector = Array.from(deterministicVector(5, 99), (value) => Number(value));
        const hits = await postgresSemanticSearch({
          connectorId: "legacy_conn",
          connectorInstanceId: "cin_legacy",
          limit: 8,
          queryVector,
          scopeKeys: ['["messages","body"]'],
          stream: "messages",
        });
        const expected = bruteForceRank(seeded, queryVector);
        assert.deepEqual(
          hits.map((hit) => hit.recordKey),
          expected.map((row) => row.recordKey),
          "pgvector ordering matches brute-force ordering"
        );
        for (const [position, hit] of hits.entries()) {
          const expectedItem = expected[position];
          assert.ok(
            Math.abs(hit.distance - (expectedItem?.distance ?? 0)) < 1e-5,
            `distance parity for ${hit.recordKey}: ${hit.distance} vs ${expectedItem?.distance}`
          );
        }

        const indexBeforeMaintenance = await postgresQuery(
          `SELECT 1 FROM pg_indexes
            WHERE schemaname = $1 AND tablename = 'semantic_search_blob'
              AND indexname = 'idx_pg_semantic_search_embedding_hnsw'`,
          [schema]
        );
        assert.equal(indexBeforeMaintenance.rowCount, 0, "HNSW is optional and absent before post-listen maintenance");

        await runPostgresSemanticHnswMaintenance({ log: (line) => logLines.push(String(line)) });
        const indexAfterMaintenance = await postgresQuery(
          `SELECT 1 FROM pg_indexes
            WHERE schemaname = $1 AND tablename = 'semantic_search_blob'
              AND indexname = 'idx_pg_semantic_search_embedding_hnsw'`,
          [schema]
        );
        assert.equal(indexAfterMaintenance.rowCount, 1, "post-readiness maintenance builds HNSW");

        // Idempotence: a second bootstrap over the migrated schema is a no-op.
        await bootstrapPostgresSchema();
        const recount = await postgresQuery("SELECT COUNT(*) AS n FROM semantic_search_blob");
        assert.equal(Number(recount.rows[0]?.n ?? 0), seeded.length);
      } finally {
        await closePostgresStorage();
      }
    } finally {
      if (previousBatchSize === undefined) {
        delete process.env.PDPP_PG_SEMANTIC_MIGRATION_BATCH_SIZE;
      } else {
        process.env.PDPP_PG_SEMANTIC_MIGRATION_BATCH_SIZE = previousBatchSize;
      }
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  test("boot migration resumes a half-migrated table without duplicating or dropping rows", async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const schema = `pdpp_semvec_resume_${suffix}`;
    const adminPool = new pg.Pool({ connectionString: POSTGRES_URL });
    const seeded: { recordKey: string; vector: number[] }[] = [];
    try {
      const admin = await adminPool.connect();
      try {
        await admin.query(`CREATE SCHEMA ${schema}`);
        // Raw fixtures bypass bootstrapPostgresSchema, so ensure the pgvector
        // extension exists in public for fresh-database runs.
        await admin.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
        await admin.query(`SET search_path = ${schema}, public`);
        await admin.query(LEGACY_BLOB_DDL);
        for (let index = 0; index < 6; index += 1) {
          const vector = Array.from(deterministicVector(4, index + 11), (value) => Number(value));
          seeded.push({ recordKey: `rec_${index}`, vector });
        }
        await Promise.all(
          seeded.map(({ recordKey, vector }) =>
            admin.query(
              `INSERT INTO semantic_search_blob (connector_id, connector_instance_id, scope_key, record_key, embedding)
               VALUES ($1, $2, $3, $4, $5::jsonb)`,
              ["resume_conn", "cin_resume", '["messages","body"]', recordKey, JSON.stringify(vector)]
            )
          )
        );
        // Manufacture the interrupted state: vector column added, only half
        // the rows backfilled, JSONB column still present (the swap never
        // ran).
        await admin.query("ALTER TABLE semantic_search_blob ADD COLUMN embedding_vec vector");
        await admin.query(
          `UPDATE semantic_search_blob SET embedding_vec = (embedding::text)::vector
            WHERE record_key IN ('rec_0', 'rec_1', 'rec_2')`
        );
      } finally {
        admin.release();
      }

      await initPostgresStorage({ backend: "postgres", databaseUrl: withSearchPath(POSTGRES_URL, schema) });
      try {
        const column = await postgresQuery(
          `SELECT udt_name FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = 'semantic_search_blob' AND column_name = 'embedding'`,
          [schema]
        );
        assert.equal(column.rows[0]?.udt_name, "vector");
        const leftover = await postgresQuery(
          `SELECT 1 FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = 'semantic_search_blob' AND column_name = 'embedding_vec'`,
          [schema]
        );
        assert.equal(leftover.rowCount, 0, "temporary embedding_vec column is gone after the swap");

        const rows = await postgresQuery(
          "SELECT record_key, embedding::text AS embedding FROM semantic_search_blob ORDER BY record_key"
        );
        assert.deepEqual(
          rows.rows.map((row) => row.record_key),
          seeded.map((row) => row.recordKey)
        );
        for (const [position, row] of rows.rows.entries()) {
          const migrated = JSON.parse(row.embedding) as number[];
          const seededItem = seeded[position];
          for (let index2 = 0; seededItem && index2 < seededItem.vector.length; index2 += 1) {
            assert.ok(Math.abs((migrated[index2] ?? 0) - (seededItem.vector[index2] ?? 0)) < 1e-5);
          }
        }
      } finally {
        await closePostgresStorage();
      }
    } finally {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  test("vector search matches brute-force ordering and scores, with scope and recordKeys narrowing", async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pgvec_parity_${suffix}`;
    const connectorInstanceId = `cin_pgvec_parity_${suffix}`;
    const bodyScope = '["messages","body"]';
    const subjectScope = '["messages","subject"]';
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      assert.equal(isPostgresSemanticVectorEmbedding(), true, "shared test database must be in pgvector mode");

      const dimensions = 8;
      const bodyRows: { recordKey: string; vector: number[] }[] = [];
      for (let index = 0; index < 12; index += 1) {
        bodyRows.push({
          recordKey: `msg_${String(index).padStart(2, "0")}`,
          vector: Array.from(deterministicVector(dimensions, index + 1), (value) => Number(value)),
        });
      }
      await Promise.all(
        bodyRows.map((row) =>
          postgresSemanticIndexUpsertMany({
            connectorId,
            connectorInstanceId,
            entries: [{ recordKey: row.recordKey, scopeKey: bodyScope, vector: Float32Array.from(row.vector) }],
            recordKey: row.recordKey,
            stream: "messages",
          })
        )
      );
      // A row in a different scope must never leak into body-scoped queries.
      await postgresSemanticIndexUpsertMany({
        connectorId,
        connectorInstanceId,
        entries: [{ recordKey: "subject_only", scopeKey: subjectScope, vector: deterministicVector(dimensions, 77) }],
        recordKey: "subject_only",
        stream: "messages",
      });

      const queryVector = Array.from(deterministicVector(dimensions, 42), (value) => Number(value));
      const expected = bruteForceRank(bodyRows, queryVector);

      const hits = await postgresSemanticSearch({
        connectorId,
        connectorInstanceId,
        limit: 200,
        queryVector,
        scopeKeys: [bodyScope],
        stream: "messages",
      });
      assert.deepEqual(
        hits.map((hit) => hit.recordKey),
        expected.map((row) => row.recordKey),
        "ordering parity with the JS brute-force path"
      );
      for (const [position, hit] of hits.entries()) {
        const expectedItem = expected[position];
        assert.ok(
          Math.abs(hit.distance - (expectedItem?.distance ?? 0)) < 1e-5,
          `distance parity for ${hit.recordKey}: ${hit.distance} vs ${expectedItem?.distance}`
        );
        assert.equal(hit.connectorId, connectorId);
        assert.equal(hit.connectorInstanceId, connectorInstanceId);
        assert.equal(hit.scopeKey, bodyScope);
      }

      // limit applies after exact ordering.
      const topThree = await postgresSemanticSearch({
        connectorId,
        connectorInstanceId,
        limit: 3,
        queryVector,
        scopeKeys: [bodyScope],
        stream: "messages",
      });
      assert.deepEqual(
        topThree.map((hit) => hit.recordKey),
        expected.slice(0, 3).map((row) => row.recordKey)
      );

      // recordKeys candidate narrowing filters identically.
      const [, exp1, , , exp4] = expected;
      assert.ok(exp1, "expected[1] must exist");
      assert.ok(exp4, "expected[4] must exist");
      const candidates = [exp4.recordKey, exp1.recordKey, "absent_key"];
      const narrowed = await postgresSemanticSearch({
        connectorId,
        connectorInstanceId,
        limit: 200,
        queryVector,
        recordKeys: candidates,
        scopeKeys: [bodyScope],
        stream: "messages",
      });
      assert.deepEqual(
        narrowed.map((hit) => hit.recordKey),
        [exp1.recordKey, exp4.recordKey],
        "recordKeys narrowing preserves distance order over the candidate set"
      );
      const emptyNarrowed = await postgresSemanticSearch({
        connectorId,
        connectorInstanceId,
        limit: 200,
        queryVector,
        recordKeys: [],
        scopeKeys: [bodyScope],
        stream: "messages",
      });
      assert.deepEqual(emptyNarrowed, []);
    } finally {
      await postgresQuery("DELETE FROM semantic_search_blob WHERE connector_id = $1", [connectorId]);
      await closePostgresStorage();
    }
  });

  test("mixed-dimension embeddings coexist in the shared table without cross-talk", async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pgvec_mixed_${suffix}`;
    const instanceEight = `cin_pgvec_mixed8_${suffix}`;
    const instanceSix = `cin_pgvec_mixed6_${suffix}`;
    const scope = '["messages","body"]';
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await postgresSemanticIndexUpsertMany({
        connectorId,
        connectorInstanceId: instanceEight,
        entries: [{ recordKey: "eight", scopeKey: scope, vector: deterministicVector(8, 5) }],
        recordKey: "eight",
        stream: "messages",
      });
      await postgresSemanticIndexUpsertMany({
        connectorId,
        connectorInstanceId: instanceSix,
        entries: [{ recordKey: "six", scopeKey: scope, vector: deterministicVector(6, 5) }],
        recordKey: "six",
        stream: "messages",
      });

      const eightHits = await postgresSemanticSearch({
        connectorId,
        connectorInstanceId: instanceEight,
        limit: 10,
        queryVector: Array.from(deterministicVector(8, 5)),
        scopeKeys: [scope],
        stream: "messages",
      });
      assert.deepEqual(
        eightHits.map((hit) => hit.recordKey),
        ["eight"]
      );
      const [eightHit0] = eightHits;
      assert.ok(eightHit0, "eightHits[0] must exist");
      assert.ok(eightHit0.distance < 1e-5, "self-match distance is ~0");

      const sixHits = await postgresSemanticSearch({
        connectorId,
        connectorInstanceId: instanceSix,
        limit: 10,
        queryVector: Array.from(deterministicVector(6, 5)),
        scopeKeys: [scope],
        stream: "messages",
      });
      assert.deepEqual(
        sixHits.map((hit) => hit.recordKey),
        ["six"]
      );
    } finally {
      await postgresQuery("DELETE FROM semantic_search_blob WHERE connector_id = $1", [connectorId]);
      await closePostgresStorage();
    }
  });

  test("production-dimension semantic search enforces scope after ANN candidate retrieval", async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const schema = `pdpp_semvec_scope_${suffix}`;
    const connectorId = `pgvec_scope_ann_${suffix}`;
    const connectorInstanceId = `cin_pgvec_scope_ann_${suffix}`;
    const bodyScope = '["messages","body"]';
    const subjectScope = '["messages","subject"]';
    const queryVector = Array.from(deterministicVector(384, 91));
    const adminPool = new pg.Pool({ connectionString: POSTGRES_URL });
    try {
      const admin = await adminPool.connect();
      try {
        await admin.query(`CREATE SCHEMA ${schema}`);
        await admin.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
      } finally {
        admin.release();
      }
      await initPostgresStorage({ backend: "postgres", databaseUrl: withSearchPath(POSTGRES_URL, schema) });
      // Force the production-dimension broad-search path to use the ANN
      // candidate window without requiring a large fixture.
      await postgresQuery(
        `INSERT INTO retained_size_stream(connector_instance_id, connector_id, stream, record_count, dirty, computed_at)
         VALUES($1, $2, $3, $4, 0, $5)`,
        [connectorInstanceId, connectorId, "messages", 6000, new Date().toISOString()]
      );
      await postgresSemanticIndexUpsertMany({
        connectorId,
        connectorInstanceId,
        entries: [{ recordKey: "body_match", scopeKey: bodyScope, vector: queryVector }],
        recordKey: "body_match",
        stream: "messages",
      });
      await postgresSemanticIndexUpsertMany({
        connectorId,
        connectorInstanceId,
        entries: [{ recordKey: "subject_match", scopeKey: subjectScope, vector: queryVector }],
        recordKey: "subject_match",
        stream: "messages",
      });
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          postgresSemanticIndexUpsertMany({
            connectorId,
            connectorInstanceId,
            entries: [
              {
                recordKey: `body_noise_${index}`,
                scopeKey: bodyScope,
                vector: deterministicVector(384, 200 + index),
              },
            ],
            recordKey: `body_noise_${index}`,
            stream: "messages",
          })
        )
      );

      const hits = await postgresSemanticSearch({
        connectorId,
        connectorInstanceId,
        limit: 5,
        queryVector,
        scopeKeys: [bodyScope],
        stream: "messages",
      });

      assert.ok(hits.length > 0, "ANN candidate search returns scoped hits");
      assert.equal(hits[0]?.recordKey, "body_match", "nearest hit survives scope filtering");
      assert.ok(
        hits.every((hit) => hit.scopeKey === bodyScope),
        `all hits stay inside the requested scope: ${hits.map((hit) => hit.scopeKey).join(", ")}`
      );
      assert.ok(!hits.some((hit) => hit.recordKey === "subject_match"), "unrequested semantic scope does not leak");
    } finally {
      await closePostgresStorage();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  // The ANN candidate window takes a connector-wide `LIMIT` before the grant
  // scope filter. When the requested scope is rare inside a connector, every
  // candidate slot can be consumed by rows in scopes the caller cannot see,
  // and the authorized row is silently dropped: the caller gets an empty
  // result that is indistinguishable from "nothing matched". This is the
  // read path used while the optional HNSW index is absent, building, failed,
  // or wrong-shaped, so the search must not under-return in that window.
  test("a rare authorized scope is not truncated by the pre-scope ANN candidate window", async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const schema = `pdpp_semvec_starve_${suffix}`;
    const connectorId = `pgvec_starve_${suffix}`;
    const connectorInstanceId = `cin_pgvec_starve_${suffix}`;
    const rareScope = '["messages","rare"]';
    const crowdScope = '["messages","crowd"]';
    const queryVector = Array.from(deterministicVector(384, 91));
    const previousCandidateLimit = process.env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_CANDIDATE_LIMIT;
    const previousExactMaxRows = process.env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_EXACT_MAX_ROWS;
    // A small candidate window makes the starvation reachable with a tiny
    // fixture; at production scale the same shape occurs with a rare scope in
    // a multi-million-row connector. The exact-scan ceiling must drop below
    // the seeded retained estimate too, or the search stays on the exact path
    // and never exercises the window at all.
    process.env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_CANDIDATE_LIMIT = "1";
    process.env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_EXACT_MAX_ROWS = "1";
    const adminPool = new pg.Pool({ connectionString: POSTGRES_URL });
    try {
      const admin = await adminPool.connect();
      try {
        await admin.query(`CREATE SCHEMA ${schema}`);
        await admin.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
      } finally {
        admin.release();
      }
      await initPostgresStorage({ backend: "postgres", databaseUrl: withSearchPath(POSTGRES_URL, schema) });
      await postgresQuery(
        `INSERT INTO retained_size_stream(connector_instance_id, connector_id, stream, record_count, dirty, computed_at)
         VALUES($1, $2, $3, $4, 0, $5)`,
        [connectorInstanceId, connectorId, "messages", 6000, new Date().toISOString()]
      );
      // Eight rows in an unrequested scope, all nearer the query than the one
      // authorized row, so they fill every slot of a 4-wide candidate window.
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          postgresSemanticIndexUpsertMany({
            connectorId,
            connectorInstanceId,
            entries: [{ recordKey: `crowd_${index}`, scopeKey: crowdScope, vector: queryVector }],
            recordKey: `crowd_${index}`,
            stream: "messages",
          })
        )
      );
      await postgresSemanticIndexUpsertMany({
        connectorId,
        connectorInstanceId,
        entries: [{ recordKey: "rare_match", scopeKey: rareScope, vector: deterministicVector(384, 404) }],
        recordKey: "rare_match",
        stream: "messages",
      });

      const hits = await postgresSemanticSearch({
        connectorId,
        connectorInstanceId,
        limit: 5,
        queryVector,
        scopeKeys: [rareScope],
        stream: "messages",
      });

      assert.deepEqual(
        hits.map((hit) => hit.recordKey),
        ["rare_match"],
        "the authorized row survives even though nearer unauthorized rows fill the candidate window"
      );
      assert.ok(
        hits.every((hit) => hit.scopeKey === rareScope),
        `no unrequested scope leaks into the fallback: ${hits.map((hit) => hit.scopeKey).join(", ")}`
      );
    } finally {
      if (previousCandidateLimit === undefined) {
        delete process.env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_CANDIDATE_LIMIT;
      } else {
        process.env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_CANDIDATE_LIMIT = previousCandidateLimit;
      }
      if (previousExactMaxRows === undefined) {
        delete process.env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_EXACT_MAX_ROWS;
      } else {
        process.env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_EXACT_MAX_ROWS = previousExactMaxRows;
      }
      await closePostgresStorage();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  // Same starvation shape, but after the canonical HNSW index exists, so the
  // candidate window is actually permitted. The truncation probe must still
  // fall back to the exact scoped scan rather than trusting a starved window.
  test("a rare authorized scope survives the candidate window once HNSW is built", async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const schema = `pdpp_semvec_starve_hnsw_${suffix}`;
    const connectorId = `pgvec_starve_hnsw_${suffix}`;
    const connectorInstanceId = `cin_pgvec_starve_hnsw_${suffix}`;
    const rareScope = '["messages","rare"]';
    const crowdScope = '["messages","crowd"]';
    const queryVector = Array.from(deterministicVector(384, 91));
    const previousCandidateLimit = process.env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_CANDIDATE_LIMIT;
    const previousExactMaxRows = process.env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_EXACT_MAX_ROWS;
    process.env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_CANDIDATE_LIMIT = "1";
    process.env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_EXACT_MAX_ROWS = "1";
    const adminPool = new pg.Pool({ connectionString: POSTGRES_URL });
    try {
      const admin = await adminPool.connect();
      try {
        await admin.query(`CREATE SCHEMA ${schema}`);
        await admin.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
      } finally {
        admin.release();
      }
      await initPostgresStorage({ backend: "postgres", databaseUrl: withSearchPath(POSTGRES_URL, schema) });
      await postgresQuery(
        `INSERT INTO retained_size_stream(connector_instance_id, connector_id, stream, record_count, dirty, computed_at)
         VALUES($1, $2, $3, $4, 0, $5)`,
        [connectorInstanceId, connectorId, "messages", 6000, new Date().toISOString()]
      );
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          postgresSemanticIndexUpsertMany({
            connectorId,
            connectorInstanceId,
            entries: [{ recordKey: `crowd_${index}`, scopeKey: crowdScope, vector: queryVector }],
            recordKey: `crowd_${index}`,
            stream: "messages",
          })
        )
      );
      await postgresSemanticIndexUpsertMany({
        connectorId,
        connectorInstanceId,
        entries: [{ recordKey: "rare_match", scopeKey: rareScope, vector: deterministicVector(384, 404) }],
        recordKey: "rare_match",
        stream: "messages",
      });
      await runPostgresSemanticHnswMaintenance();
      const built = await postgresQuery<{ definition: string }>(
        `SELECT pg_get_indexdef(idx.oid) AS definition
           FROM pg_class idx JOIN pg_namespace ns ON ns.oid = idx.relnamespace
          WHERE ns.nspname = current_schema() AND idx.relname = 'idx_pg_semantic_search_embedding_hnsw'`
      );
      assert.equal(built.rowCount, 1, "the canonical HNSW index exists for this case");

      const hits = await postgresSemanticSearch({
        connectorId,
        connectorInstanceId,
        limit: 5,
        queryVector,
        scopeKeys: [rareScope],
        stream: "messages",
      });

      assert.deepEqual(
        hits.map((hit) => hit.recordKey),
        ["rare_match"],
        "an indexed candidate window still cannot drop the authorized row"
      );
    } finally {
      if (previousCandidateLimit === undefined) {
        delete process.env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_CANDIDATE_LIMIT;
      } else {
        process.env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_CANDIDATE_LIMIT = previousCandidateLimit;
      }
      if (previousExactMaxRows === undefined) {
        delete process.env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_EXACT_MAX_ROWS;
      } else {
        process.env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_EXACT_MAX_ROWS = previousExactMaxRows;
      }
      await closePostgresStorage();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
} else {
  test("postgres semantic pgvector migration (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
  }, () => {
    /* skip */
  });
}
