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
 *      count and embedding values across batched backfill, and builds the
 *      HNSW index. (Runs in a scratch schema so the shared test database is
 *      untouched.)
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

import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import {
  bootstrapPostgresSchema,
  closePostgresStorage,
  initPostgresStorage,
  isPostgresSemanticVectorEmbedding,
  postgresQuery,
} from '../server/postgres-storage.js';
import {
  postgresSemanticIndexUpsertMany,
  postgresSemanticSearch,
} from '../server/postgres-search.js';

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

function withSearchPath(url, schema) {
  const parsed = new URL(url);
  // Resolve unqualified names in the scratch schema first; keep `public` so
  // the pgvector `vector` type (installed in `public`) stays visible.
  parsed.searchParams.set('options', `-csearch_path=${schema},public`);
  return parsed.toString();
}

// Mirrors the legacy JS scoring path this change replaced, so parity is
// asserted against the genuine pre-migration semantics.
function bruteForceCosineDistance(a, b) {
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
  if (magA === 0 || magB === 0) return Number.POSITIVE_INFINITY;
  return 1 - dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function bruteForceRank(rows, queryVector) {
  return rows
    .map((row) => ({
      recordKey: row.recordKey,
      distance: bruteForceCosineDistance(queryVector, row.vector),
    }))
    .sort((a, b) => a.distance - b.distance || (a.recordKey < b.recordKey ? -1 : 1));
}

function deterministicVector(dimensions, seed) {
  const vec = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    vec[index] = Math.sin(seed * 31 + index * 7) * 0.5;
  }
  return vec;
}

if (!POSTGRES_URL) {
  test('postgres semantic pgvector migration (skipped: PDPP_TEST_POSTGRES_URL unset)', {
    skip: true,
  }, () => {});
} else {
  test('boot migration converts a legacy JSONB embedding table to pgvector with batched backfill', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const schema = `pdpp_semvec_mig_${suffix}`;
    const seeded = [];
    const adminPool = new pg.Pool({ connectionString: POSTGRES_URL });
    const previousBatchSize = process.env.PDPP_PG_SEMANTIC_MIGRATION_BATCH_SIZE;
    process.env.PDPP_PG_SEMANTIC_MIGRATION_BATCH_SIZE = '3';
    try {
      const admin = await adminPool.connect();
      try {
        await admin.query(`CREATE SCHEMA ${schema}`);
        // Raw fixtures bypass bootstrapPostgresSchema, so ensure the pgvector
        // extension exists in public for fresh-database runs.
        await admin.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
        await admin.query(`SET search_path = ${schema}, public`);
        // Seed the legacy shape BEFORE the runtime ever bootstraps this
        // schema, exactly like a pre-pgvector deployment.
        await admin.query(LEGACY_BLOB_DDL);
        for (let index = 0; index < 8; index += 1) {
          const vector = Array.from(deterministicVector(5, index + 1), (value) => Number(value));
          seeded.push({ recordKey: `rec_${index}`, vector });
          await admin.query(
            `INSERT INTO semantic_search_blob (connector_id, connector_instance_id, scope_key, record_key, embedding)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            ['legacy_conn', 'cin_legacy', '["messages","body"]', `rec_${index}`, JSON.stringify(vector)],
          );
        }
        // A non-castable garbage row must be dropped, not wedge the boot.
        await admin.query(
          `INSERT INTO semantic_search_blob (connector_id, connector_instance_id, scope_key, record_key, embedding)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          ['legacy_conn', 'cin_legacy', '["messages","body"]', 'rec_garbage', JSON.stringify({ not: 'an array' })],
        );
      } finally {
        admin.release();
      }

      const logLines = [];
      await initPostgresStorage(
        { backend: 'postgres', databaseUrl: withSearchPath(POSTGRES_URL, schema) },
        { log: (line) => logLines.push(String(line)) },
      );
      try {
        assert.equal(isPostgresSemanticVectorEmbedding(), true, 'mode flag must report pgvector after migration');

        const column = await postgresQuery(
          `SELECT udt_name, is_nullable FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = 'semantic_search_blob' AND column_name = 'embedding'`,
          [schema],
        );
        assert.equal(column.rows[0]?.udt_name, 'vector', 'embedding column must be pgvector');
        assert.equal(column.rows[0]?.is_nullable, 'NO', 'embedding column must be NOT NULL again');

        const index = await postgresQuery(
          `SELECT 1 FROM pg_indexes
            WHERE schemaname = $1 AND tablename = 'semantic_search_blob'
              AND indexname = 'idx_pg_semantic_search_embedding_hnsw'`,
          [schema],
        );
        assert.equal(index.rowCount, 1, 'HNSW index must exist after migration');

        const rows = await postgresQuery(
          'SELECT record_key, embedding::text AS embedding FROM semantic_search_blob ORDER BY record_key',
        );
        assert.deepEqual(
          rows.rows.map((row) => row.record_key),
          seeded.map((row) => row.recordKey),
          'every castable row survives; the garbage row is dropped',
        );
        for (const [position, row] of rows.rows.entries()) {
          const migrated = JSON.parse(row.embedding);
          const original = seeded[position].vector;
          assert.equal(migrated.length, original.length);
          for (let index2 = 0; index2 < original.length; index2 += 1) {
            assert.ok(
              Math.abs(migrated[index2] - original[index2]) < 1e-5,
              `embedding value preserved for ${row.record_key}[${index2}]`,
            );
          }
        }

        assert.ok(
          logLines.some((line) => line.includes('JSONB → pgvector (8 rows)')),
          `migration start logged (got: ${JSON.stringify(logLines)})`,
        );
        assert.ok(
          logLines.some((line) => line.includes('dropped 1 non-castable')),
          'garbage drop logged',
        );
        assert.ok(
          logLines.filter((line) => line.includes('backfilled')).length >= 3,
          'batched backfill (batch size 3 over 8 rows) logs multiple batches',
        );

        // Post-migration query semantics match the brute-force replica.
        const queryVector = Array.from(deterministicVector(5, 99), (value) => Number(value));
        const hits = await postgresSemanticSearch({
          connectorId: 'legacy_conn',
          connectorInstanceId: 'cin_legacy',
          scopeKeys: ['["messages","body"]'],
          queryVector,
          limit: 8,
        });
        const expected = bruteForceRank(seeded, queryVector);
        assert.deepEqual(
          hits.map((hit) => hit.recordKey),
          expected.map((row) => row.recordKey),
          'pgvector ordering matches brute-force ordering',
        );
        for (const [position, hit] of hits.entries()) {
          assert.ok(
            Math.abs(hit.distance - expected[position].distance) < 1e-5,
            `distance parity for ${hit.recordKey}: ${hit.distance} vs ${expected[position].distance}`,
          );
        }

        // Idempotence: a second bootstrap over the migrated schema is a no-op.
        await bootstrapPostgresSchema();
        const recount = await postgresQuery('SELECT COUNT(*) AS n FROM semantic_search_blob');
        assert.equal(Number(recount.rows[0].n), seeded.length);
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

  test('boot migration resumes a half-migrated table without duplicating or dropping rows', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const schema = `pdpp_semvec_resume_${suffix}`;
    const adminPool = new pg.Pool({ connectionString: POSTGRES_URL });
    const seeded = [];
    try {
      const admin = await adminPool.connect();
      try {
        await admin.query(`CREATE SCHEMA ${schema}`);
        // Raw fixtures bypass bootstrapPostgresSchema, so ensure the pgvector
        // extension exists in public for fresh-database runs.
        await admin.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
        await admin.query(`SET search_path = ${schema}, public`);
        await admin.query(LEGACY_BLOB_DDL);
        for (let index = 0; index < 6; index += 1) {
          const vector = Array.from(deterministicVector(4, index + 11), (value) => Number(value));
          seeded.push({ recordKey: `rec_${index}`, vector });
          await admin.query(
            `INSERT INTO semantic_search_blob (connector_id, connector_instance_id, scope_key, record_key, embedding)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            ['resume_conn', 'cin_resume', '["messages","body"]', `rec_${index}`, JSON.stringify(vector)],
          );
        }
        // Manufacture the interrupted state: vector column added, only half
        // the rows backfilled, JSONB column still present (the swap never
        // ran).
        await admin.query('ALTER TABLE semantic_search_blob ADD COLUMN embedding_vec vector');
        await admin.query(
          `UPDATE semantic_search_blob SET embedding_vec = (embedding::text)::vector
            WHERE record_key IN ('rec_0', 'rec_1', 'rec_2')`,
        );
      } finally {
        admin.release();
      }

      await initPostgresStorage({ backend: 'postgres', databaseUrl: withSearchPath(POSTGRES_URL, schema) });
      try {
        const column = await postgresQuery(
          `SELECT udt_name FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = 'semantic_search_blob' AND column_name = 'embedding'`,
          [schema],
        );
        assert.equal(column.rows[0]?.udt_name, 'vector');
        const leftover = await postgresQuery(
          `SELECT 1 FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = 'semantic_search_blob' AND column_name = 'embedding_vec'`,
          [schema],
        );
        assert.equal(leftover.rowCount, 0, 'temporary embedding_vec column is gone after the swap');

        const rows = await postgresQuery(
          'SELECT record_key, embedding::text AS embedding FROM semantic_search_blob ORDER BY record_key',
        );
        assert.deepEqual(rows.rows.map((row) => row.record_key), seeded.map((row) => row.recordKey));
        for (const [position, row] of rows.rows.entries()) {
          const migrated = JSON.parse(row.embedding);
          for (let index2 = 0; index2 < seeded[position].vector.length; index2 += 1) {
            assert.ok(Math.abs(migrated[index2] - seeded[position].vector[index2]) < 1e-5);
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

  test('vector search matches brute-force ordering and scores, with scope and recordKeys narrowing', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pgvec_parity_${suffix}`;
    const connectorInstanceId = `cin_pgvec_parity_${suffix}`;
    const bodyScope = '["messages","body"]';
    const subjectScope = '["messages","subject"]';
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      assert.equal(isPostgresSemanticVectorEmbedding(), true, 'shared test database must be in pgvector mode');

      const dimensions = 8;
      const bodyRows = [];
      for (let index = 0; index < 12; index += 1) {
        bodyRows.push({
          recordKey: `msg_${String(index).padStart(2, '0')}`,
          vector: Array.from(deterministicVector(dimensions, index + 1), (value) => Number(value)),
        });
      }
      for (const row of bodyRows) {
        await postgresSemanticIndexUpsertMany({
          connectorId,
          connectorInstanceId,
          stream: 'messages',
          recordKey: row.recordKey,
          entries: [
            { scopeKey: bodyScope, recordKey: row.recordKey, vector: Float32Array.from(row.vector) },
          ],
        });
      }
      // A row in a different scope must never leak into body-scoped queries.
      await postgresSemanticIndexUpsertMany({
        connectorId,
        connectorInstanceId,
        stream: 'messages',
        recordKey: 'subject_only',
        entries: [
          { scopeKey: subjectScope, recordKey: 'subject_only', vector: deterministicVector(dimensions, 77) },
        ],
      });

      const queryVector = Array.from(deterministicVector(dimensions, 42), (value) => Number(value));
      const expected = bruteForceRank(bodyRows, queryVector);

      const hits = await postgresSemanticSearch({
        connectorId,
        connectorInstanceId,
        scopeKeys: [bodyScope],
        queryVector,
        limit: 200,
      });
      assert.deepEqual(
        hits.map((hit) => hit.recordKey),
        expected.map((row) => row.recordKey),
        'ordering parity with the JS brute-force path',
      );
      for (const [position, hit] of hits.entries()) {
        assert.ok(
          Math.abs(hit.distance - expected[position].distance) < 1e-5,
          `distance parity for ${hit.recordKey}: ${hit.distance} vs ${expected[position].distance}`,
        );
        assert.equal(hit.connectorId, connectorId);
        assert.equal(hit.connectorInstanceId, connectorInstanceId);
        assert.equal(hit.scopeKey, bodyScope);
      }

      // limit applies after exact ordering.
      const topThree = await postgresSemanticSearch({
        connectorId,
        connectorInstanceId,
        scopeKeys: [bodyScope],
        queryVector,
        limit: 3,
      });
      assert.deepEqual(
        topThree.map((hit) => hit.recordKey),
        expected.slice(0, 3).map((row) => row.recordKey),
      );

      // recordKeys candidate narrowing filters identically.
      const candidates = [expected[4].recordKey, expected[1].recordKey, 'absent_key'];
      const narrowed = await postgresSemanticSearch({
        connectorId,
        connectorInstanceId,
        scopeKeys: [bodyScope],
        queryVector,
        limit: 200,
        recordKeys: candidates,
      });
      assert.deepEqual(
        narrowed.map((hit) => hit.recordKey),
        [expected[1].recordKey, expected[4].recordKey],
        'recordKeys narrowing preserves distance order over the candidate set',
      );
      const emptyNarrowed = await postgresSemanticSearch({
        connectorId,
        connectorInstanceId,
        scopeKeys: [bodyScope],
        queryVector,
        limit: 200,
        recordKeys: [],
      });
      assert.deepEqual(emptyNarrowed, []);
    } finally {
      await postgresQuery('DELETE FROM semantic_search_blob WHERE connector_id = $1', [connectorId]);
      await closePostgresStorage();
    }
  });

  test('mixed-dimension embeddings coexist in the shared table without cross-talk', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pgvec_mixed_${suffix}`;
    const instanceEight = `cin_pgvec_mixed8_${suffix}`;
    const instanceSix = `cin_pgvec_mixed6_${suffix}`;
    const scope = '["messages","body"]';
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await postgresSemanticIndexUpsertMany({
        connectorId,
        connectorInstanceId: instanceEight,
        stream: 'messages',
        recordKey: 'eight',
        entries: [{ scopeKey: scope, recordKey: 'eight', vector: deterministicVector(8, 5) }],
      });
      await postgresSemanticIndexUpsertMany({
        connectorId,
        connectorInstanceId: instanceSix,
        stream: 'messages',
        recordKey: 'six',
        entries: [{ scopeKey: scope, recordKey: 'six', vector: deterministicVector(6, 5) }],
      });

      const eightHits = await postgresSemanticSearch({
        connectorId,
        connectorInstanceId: instanceEight,
        scopeKeys: [scope],
        queryVector: deterministicVector(8, 5),
        limit: 10,
      });
      assert.deepEqual(eightHits.map((hit) => hit.recordKey), ['eight']);
      assert.ok(eightHits[0].distance < 1e-5, 'self-match distance is ~0');

      const sixHits = await postgresSemanticSearch({
        connectorId,
        connectorInstanceId: instanceSix,
        scopeKeys: [scope],
        queryVector: deterministicVector(6, 5),
        limit: 10,
      });
      assert.deepEqual(sixHits.map((hit) => hit.recordKey), ['six']);
    } finally {
      await postgresQuery('DELETE FROM semantic_search_blob WHERE connector_id = $1', [connectorId]);
      await closePostgresStorage();
    }
  });

  test('production-dimension semantic search enforces scope after ANN candidate retrieval', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const schema = `pdpp_semvec_scope_${suffix}`;
    const connectorId = `pgvec_scope_ann_${suffix}`;
    const connectorInstanceId = `cin_pgvec_scope_ann_${suffix}`;
    const bodyScope = '["messages","body"]';
    const subjectScope = '["messages","subject"]';
    const queryVector = deterministicVector(384, 91);
    const adminPool = new pg.Pool({ connectionString: POSTGRES_URL });
    try {
      const admin = await adminPool.connect();
      try {
        await admin.query(`CREATE SCHEMA ${schema}`);
        await admin.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
      } finally {
        admin.release();
      }
      await initPostgresStorage({ backend: 'postgres', databaseUrl: withSearchPath(POSTGRES_URL, schema) });
      // Force the production-dimension broad-search path to use the ANN
      // candidate window without requiring a large fixture.
      await postgresQuery(
        `INSERT INTO retained_size_stream(connector_instance_id, connector_id, stream, record_count, dirty, computed_at)
         VALUES($1, $2, $3, $4, 0, $5)`,
        [connectorInstanceId, connectorId, 'messages', 6000, new Date().toISOString()],
      );
      await postgresSemanticIndexUpsertMany({
        connectorId,
        connectorInstanceId,
        stream: 'messages',
        recordKey: 'body_match',
        entries: [{ scopeKey: bodyScope, recordKey: 'body_match', vector: queryVector }],
      });
      await postgresSemanticIndexUpsertMany({
        connectorId,
        connectorInstanceId,
        stream: 'messages',
        recordKey: 'subject_match',
        entries: [{ scopeKey: subjectScope, recordKey: 'subject_match', vector: queryVector }],
      });
      for (let index = 0; index < 8; index += 1) {
        await postgresSemanticIndexUpsertMany({
          connectorId,
          connectorInstanceId,
          stream: 'messages',
          recordKey: `body_noise_${index}`,
          entries: [{
            scopeKey: bodyScope,
            recordKey: `body_noise_${index}`,
            vector: deterministicVector(384, 200 + index),
          }],
        });
      }

      const hits = await postgresSemanticSearch({
        connectorId,
        connectorInstanceId,
        scopeKeys: [bodyScope],
        queryVector,
        limit: 5,
      });

      assert.ok(hits.length > 0, 'ANN candidate search returns scoped hits');
      assert.equal(hits[0].recordKey, 'body_match', 'nearest hit survives scope filtering');
      assert.ok(
        hits.every((hit) => hit.scopeKey === bodyScope),
        `all hits stay inside the requested scope: ${hits.map((hit) => hit.scopeKey).join(', ')}`,
      );
      assert.ok(!hits.some((hit) => hit.recordKey === 'subject_match'), 'unrequested semantic scope does not leak');
    } finally {
      await closePostgresStorage();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
}
