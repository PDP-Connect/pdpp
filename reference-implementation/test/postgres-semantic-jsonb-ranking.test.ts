/**
 * Regression test for the Postgres JSONB semantic-search fallback ranking bug.
 *
 * `postgresSemanticSearch` (server/postgres-search.js) has two code paths:
 *   - pgvector enabled: `postgresSemanticSearchVector` orders and limits
 *     entirely inside Postgres (correct by construction).
 *   - pgvector NOT enabled (the live default when the `vector` extension
 *     is unavailable/not installed): a JSONB fallback fetches candidate rows
 *     and scores cosine distance in JS.
 *
 * The JSONB fallback previously applied `LIMIT` in SQL BEFORE scoring:
 *
 *     SELECT ... FROM semantic_search_blob WHERE ... LIMIT $3   -- $3 = requested limit
 *     -- THEN map through cosineDistance(...), sort, .slice(0, limit)
 *
 * Postgres has no ORDER BY on that fetch, so `LIMIT` returns an arbitrary
 * (physical-order) slice of the in-scope rows. If the true nearest neighbour
 * is not in that arbitrary slice, it is silently dropped before scoring even
 * happens — the caller gets plausible-looking but wrong results, no error.
 *
 * The fix fetches a candidate window bounded by the existing
 * `postgresSemanticCandidateLimit` helper (shared with the pgvector ANN
 * overscan path), scores/sorts the WHOLE window, then slices to the
 * requested limit.
 *
 * This test seeds more rows than the (env-overridden, small) candidate
 * limit, and inserts the true best match LAST — after the noise rows in
 * table order — so a naive `LIMIT` on the raw fetch does not include it and
 * the bug is unambiguous. It also seeds more rows than a naive
 * `LIMIT <requested limit>` would ever fetch, since the requested limit
 * itself is 1.
 *
 * Forcing the JSONB path: `bootstrapPostgresSchema()` always attempts
 * `CREATE EXTENSION IF NOT EXISTS vector` and silently swallows failure
 * (server/postgres-storage.js), so on a server where pgvector IS available
 * (as in local dev), any normally-privileged connection ends up in pgvector
 * mode regardless of which database it targets. This test instead connects
 * as a role that lacks CREATE EXTENSION privilege (`PDPP_TEST_POSTGRES_URL`
 * pointed at a throwaway low-privilege role/database), so the extension
 * install fails, is swallowed, and the runtime falls back to the JSONB
 * path under test. See top-level task setup: throwaway `pdpp_semrank`
 * database owned by a non-superuser role, never the shared `pdpp` database.
 *
 * Requires PDPP_TEST_POSTGRES_URL (skipped cleanly otherwise).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  closePostgresStorage,
  initPostgresStorage,
  isPostgresSemanticVectorEmbedding,
  postgresQuery,
} from '../server/postgres-storage.ts';
import { postgresSemanticSearch } from '../server/postgres-search.ts';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

function deterministicVector(dimensions, seed) {
  const vec = new Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    vec[index] = Math.sin(seed * 31 + index * 7) * 0.5;
  }
  return vec;
}

if (!POSTGRES_URL) {
  test('postgres JSONB semantic-search ranking (skipped: PDPP_TEST_POSTGRES_URL unset)', {
    skip: true,
  }, () => {});
} else {
  test('JSONB fallback ranks the full in-scope candidate window before limiting, not an arbitrary pre-scoring slice', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_jsonb_rank_${suffix}`;
    const connectorInstanceId = `cin_jsonb_rank_${suffix}`;
    const scope = '["messages","body"]';
    const dimensions = 8;

    // Force a small candidate window so the test does not need hundreds of
    // rows to exercise the truncation-before-scoring bug. Must comfortably
    // exceed noiseCount (below) so the FIXED code's wider fetch reliably
    // includes the true best match, while the PRE-FIX code's fetch (LIMIT
    // boundedLimit = the requested limit, 1) reliably does not.
    const previousCandidateLimit = process.env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_CANDIDATE_LIMIT;
    process.env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_CANDIDATE_LIMIT = '10';

    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      assert.equal(
        isPostgresSemanticVectorEmbedding(),
        false,
        'this test must exercise the JSONB fallback, not the pgvector path (throwaway DB must not have the vector extension installed)',
      );

      const queryVector = deterministicVector(dimensions, 42);

      // "Noise" rows, none of them the true nearest neighbour, inserted FIRST
      // so they occupy the front of table/physical order. Count sits strictly
      // between the requested limit (1, the pre-fix fetch size) and the
      // overridden candidate limit (10, the post-fix fetch size), so the
      // pre-fix `LIMIT 1` fetch can only ever land on a noise row, while the
      // post-fix `LIMIT 10` fetch always includes every noise row plus the
      // true match below.
      const noiseCount = 6;
      for (let index = 0; index < noiseCount; index += 1) {
        const vector = deterministicVector(dimensions, 900 + index); // unrelated seeds -> far from queryVector
        await postgresQuery(
          `INSERT INTO semantic_search_blob (connector_id, connector_instance_id, scope_key, record_key, embedding)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [connectorId, connectorInstanceId, scope, `noise_${index}`, JSON.stringify(vector)],
        );
      }

      // The TRUE nearest neighbour: identical to the query vector (distance
      // ~0), inserted LAST — after all 6 noise rows — and requested with
      // limit=1. Under the pre-fix code, SQL `LIMIT 1` (the requested limit,
      // applied before scoring) fetches only 1 row from a 7-row table with no
      // ORDER BY, so it can only ever land on a noise row, never this one.
      await postgresQuery(
        `INSERT INTO semantic_search_blob (connector_id, connector_instance_id, scope_key, record_key, embedding)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [connectorId, connectorInstanceId, scope, 'true_best_match', JSON.stringify(queryVector)],
      );

      const hits = await postgresSemanticSearch({
        connectorId,
        connectorInstanceId,
        scopeKeys: [scope],
        queryVector,
        limit: 1,
      });

      assert.equal(hits.length, 1, 'requested limit is honored');
      assert.equal(
        hits[0].recordKey,
        'true_best_match',
        `expected the true nearest neighbour to be ranked first, got ${JSON.stringify(hits.map((h) => h.recordKey))}`,
      );
      assert.ok(hits[0].distance < 1e-9, `true best match should have ~0 distance, got ${hits[0].distance}`);
    } finally {
      await postgresQuery('DELETE FROM semantic_search_blob WHERE connector_id = $1', [connectorId]);
      await closePostgresStorage();
      if (previousCandidateLimit === undefined) {
        delete process.env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_CANDIDATE_LIMIT;
      } else {
        process.env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_CANDIDATE_LIMIT = previousCandidateLimit;
      }
    }
  });
}
