/**
 * N-slope: fixed-query discovery, K-only repair
 * (openspec/changes/reconcile-active-summary-evidence/design.md
 * "An instrumented N-slope oracle proves discovery/evidence query count is
 * fixed for N=1 and N=25 current connections; repair adds work only for K
 * actual candidates").
 *
 * Proves two independent properties directly on the evidence engine:
 *
 *   1. Steady-state discovery (zero repair candidates) is a FIXED small set
 *      of batched queries regardless of N — proven by discovery query COUNT,
 *      not wall-clock timing (timing is a noisy, environment-dependent
 *      proxy; counting real `Database.prototype.prepare` calls is the
 *      deterministic signal).
 *   2. Repair work is proportional to K (candidates), not N (total
 *      connections): seeding exactly K dirty rows among N connections
 *      repairs exactly K, never N.
 *
 * Query-counting methodology: `server/db.js` wraps the real `better-sqlite3`
 * `Database` in a `Proxy` whose `get` trap unconditionally intercepts
 * `prop === 'prepare'` and returns a fresh cache-lookup closure on every
 * read, regardless of any property assigned on the proxy/target — so a
 * `db.prepare = wrapperFn` reassignment (as this file previously did) is
 * silently never read back by the engine's own internal `getDb().prepare(...)`
 * calls, and the counters stay 0 (the assertion below then passes vacuously,
 * `0 <= 0 + 5`, regardless of real query behavior). This patches
 * `Database.prototype.prepare` directly instead — the raw method the cache
 * proxy actually calls on a cache miss — which genuinely intercepts every
 * real prepare call and correctly does not double-count a cache hit for
 * already-prepared SQL text.
 */

import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import { reconcileConnectorSummaryEvidence } from '../server/connector-summary-evidence-engine.ts';

/** Count REAL `Database.prototype.prepare` invocations during `fn`. */
async function countRawPrepareCalls(fn) {
  let calls = 0;
  const original = Database.prototype.prepare;
  Database.prototype.prepare = function patchedPrepare(sql, ...rest) {
    calls += 1;
    return original.call(this, sql, ...rest);
  };
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    Database.prototype.prepare = original;
  }
}

const NOW = '2026-07-17T00:00:00.000Z';

async function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-nslope-'));
  try {
    initDb(join(dir, 'pdpp.sqlite'));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedConnections(n) {
  getDb().prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES ('c1', '{}', ?)").run(NOW);
  for (let i = 0; i < n; i += 1) {
    const id = `cin_${i}`;
    getDb()
      .prepare(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         ) VALUES (?, 'owner_local', 'c1', 'x', 'active', 'account', ?, '{}', ?, ?, NULL)`,
      )
      .run(id, id, NOW, NOW);
  }
}

/**
 * Measure a genuinely COLD (never-prepared) steady-state discovery pass for
 * N connections: seed + converge in one DB session (uncounted), then close
 * and reopen against the SAME file — `server/db.js`'s statement cache lives
 * on the JS-level wrapper `initDb` creates, so a fresh `initDb` call means
 * every SQL text the measured pass issues is a genuine cache miss (a real
 * `Database.prototype.prepare` call), not a hit against warm-up's already-
 * cached statements. Without this reopen, a same-session measured pass
 * would legitimately (and correctly!) issue ZERO new prepares — the cache
 * doing its job — which is a stronger result than "fixed small count" but
 * breaks a naive `calls > 0` sanity check and cannot be compared against
 * another N's cold count on equal terms.
 */
async function measureColdSteadyStatePrepareCalls(n) {
  const warmDir = mkdtempSync(join(tmpdir(), `pdpp-nslope-warm-${n}-`));
  initDb(join(warmDir, 'pdpp.sqlite'));
  seedConnections(n);
  await reconcileConnectorSummaryEvidence(null);
  closeDb();

  initDb(join(warmDir, 'pdpp.sqlite'));
  const { result, calls } = await countRawPrepareCalls(() => reconcileConnectorSummaryEvidence(null));
  closeDb();
  rmSync(warmDir, { recursive: true, force: true });
  return { result, calls };
}

test('discovery query count for N=25 is within a small constant factor of N=1, never N=25x', async () => {
  const { calls: calls1 } = await measureColdSteadyStatePrepareCalls(1);
  assert.ok(calls1 > 0, 'sanity: the interception itself must observe real prepare calls');

  const { result: steadyState25, calls: calls25 } = await measureColdSteadyStatePrepareCalls(25);

  assert.equal(steadyState25.repaired, 0, 'fixture premise: N=25 steady state has zero candidates');
  assert.equal(steadyState25.discovered, 25);
  // Batched discovery issues one query PER TABLE regardless of N (each
  // query reads/aggregates across all N rows in one statement), so the
  // prepare-call count for N=25 should be within a small additive
  // constant of N=1 — nowhere near 25x. A per-connection N+1 regression
  // would blow this bound open (25x more prepare calls).
  assert.ok(
    calls25 <= calls1 + 5,
    `N=25 discovery issued ${calls25} prepare calls vs N=1's ${calls1} — batched discovery must not scale with N`,
  );
});

test('repair work is proportional to K candidates, not N total connections', () =>
  withTempDb(async () => {
    const n = 10;
    seedConnections(n);
    const warm = await reconcileConnectorSummaryEvidence(null);
    assert.equal(warm.repaired, n, 'first pass repairs every connection (all missing)');

    // Dirty exactly K=3 of the 10 rows.
    const k = 3;
    for (let i = 0; i < k; i += 1) {
      getDb()
        .prepare('UPDATE connector_summary_evidence SET dirty = 1 WHERE connector_instance_id = ?')
        .run(`cin_${i}`);
    }

    const result = await reconcileConnectorSummaryEvidence(null);
    assert.equal(result.discovered, n, 'discovery still reads the complete N-connection set');
    assert.equal(result.repaired, k, 'repair touches exactly the K dirty candidates, not all N');
  }));
