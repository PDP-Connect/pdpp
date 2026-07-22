// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * N-slope on real PostgreSQL: fixed-query discovery, K-only repair
 * (openspec/changes/reconcile-active-summary-evidence/design.md
 * "An instrumented N-slope oracle proves discovery/evidence query count is
 * fixed for N=1 and N=25 current connections; repair adds work only for K
 * actual candidates").
 *
 * Mirrors `connector-summary-evidence-engine-n-slope.test.js` (SQLite),
 * proving the SAME two properties against the real Postgres discovery path
 * (`readPostgresDiscoveryContext`), which task 6.4 documented as not
 * independently re-run against Postgres:
 *
 *   1. Steady-state discovery (zero repair candidates) issues a FIXED small
 *      set of batched queries regardless of N — proven by counting real
 *      `pool.query` calls, not wall-clock timing.
 *   2. Repair work is proportional to K (candidates), not N (total
 *      connections).
 *
 * Gated on `PDPP_TEST_POSTGRES_URL` pointing at the dedicated, loopback-only
 * test listener (see `test/helpers/dedicated-postgres-test-url.js`); skips
 * (never fails) when unset, matching every other Postgres-gated test in
 * this suite.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { dedicatedPostgresTestUrl } from './helpers/dedicated-postgres-test-url.js';
import {
  closePostgresStorage,
  getPostgresPool,
  initPostgresStorage,
  postgresQuery,
} from '../server/postgres-storage.js';
import { reconcileConnectorSummaryEvidence } from '../server/connector-summary-evidence-engine.ts';

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const NOW = '2026-07-17T00:00:00.000Z';
const CONNECTOR_ID = 'https://test.pdpp.dev/connectors/n-slope-postgres';

async function seedConnections(n) {
  await postgresQuery('DELETE FROM connectors WHERE connector_id = $1', [CONNECTOR_ID]);
  await postgresQuery(
    `INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)`,
    [CONNECTOR_ID, '{}', NOW],
  );
  for (let i = 0; i < n; i += 1) {
    const id = `cin_nslope_pg_${i}`;
    await postgresQuery(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES($1, 'owner_local', $2, 'x', 'active', 'account', $1, '{}'::jsonb, $3, $3, NULL)`,
      [id, CONNECTOR_ID, NOW],
    );
  }
}

async function cleanupConnections() {
  await postgresQuery('DELETE FROM connector_summary_evidence WHERE connector_id = $1', [CONNECTOR_ID]);
  await postgresQuery('DELETE FROM connector_instances WHERE connector_id = $1', [CONNECTOR_ID]);
  await postgresQuery('DELETE FROM connectors WHERE connector_id = $1', [CONNECTOR_ID]);
}

function countPoolQueries(fn) {
  const pool = getPostgresPool();
  const original = pool.query.bind(pool);
  let calls = 0;
  pool.query = (...args) => {
    calls += 1;
    return original(...args);
  };
  return fn().finally(() => {
    pool.query = original;
  }).then((result) => ({ calls, result }));
}

test(
  'real PostgreSQL: discovery query count for N=25 is within a small constant factor of N=1, never N=25x',
  { skip: !POSTGRES_URL },
  async () => {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await cleanupConnections();
      await seedConnections(1);
      await reconcileConnectorSummaryEvidence(null);
      const { calls: calls1 } = await countPoolQueries(() => reconcileConnectorSummaryEvidence(null));
      await cleanupConnections();

      await seedConnections(25);
      await reconcileConnectorSummaryEvidence(null);
      const { calls: calls25, result: steadyState25 } = await countPoolQueries(() =>
        reconcileConnectorSummaryEvidence(null),
      );

      assert.equal(steadyState25.repaired, 0, 'fixture premise: N=25 steady state has zero candidates');
      assert.equal(steadyState25.discovered, 25);
      // Batched discovery issues one query PER TABLE regardless of N, so the
      // pool.query call count for N=25 should be within a small additive
      // constant of N=1 — nowhere near 25x. A per-connection N+1 regression
      // would blow this bound open (25x more queries).
      assert.ok(
        calls25 <= calls1 + 5,
        `N=25 discovery issued ${calls25} pool.query calls vs N=1's ${calls1} — batched discovery must not scale with N`,
      );
    } finally {
      await cleanupConnections();
      await closePostgresStorage();
    }
  },
);

test(
  'real PostgreSQL: repair work is proportional to K candidates, not N total connections',
  { skip: !POSTGRES_URL },
  async () => {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await cleanupConnections();
      const n = 10;
      await seedConnections(n);
      const warm = await reconcileConnectorSummaryEvidence(null);
      assert.equal(warm.repaired, n, 'first pass repairs every connection (all missing)');

      const k = 3;
      for (let i = 0; i < k; i += 1) {
        await postgresQuery('UPDATE connector_summary_evidence SET dirty = 1 WHERE connector_instance_id = $1', [
          `cin_nslope_pg_${i}`,
        ]);
      }

      const result = await reconcileConnectorSummaryEvidence(null);
      assert.equal(result.discovered, n, 'discovery still reads the complete N-connection set');
      assert.equal(result.repaired, k, 'repair touches exactly the K dirty candidates, not all N');
    } finally {
      await cleanupConnections();
      await closePostgresStorage();
    }
  },
);
