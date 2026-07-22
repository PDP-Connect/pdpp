// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Scoped-consumer query bounds
 * (openspec/changes/reconcile-active-summary-evidence/design.md "Central
 * consumer and cache boundary" / the reconcile-summary-evidence follow-up
 * closing the "scoped consumers always run a complete census" defect).
 *
 * `connector-summary-evidence-engine-n-slope.test.js` already proves the
 * engine's own COMPLETE (`null`) census is a fixed small query count
 * regardless of N. This file proves the DIFFERENT, previously-unproven
 * property: a CONSUMER that already knows exactly which one connection it
 * needs —
 *
 *   1. `reconcileConnectorSummaryEvidence([oneId])` (the read model's now-
 *      threaded scope, and `ref-control.ts`'s `getConnectorSummaryForRoute`
 *      path that calls it under the hood) issues a query count that does
 *      NOT grow with N, the total number of OTHER unrelated connections in
 *      the database — only with the size of the requested scope itself.
 *   2. The scoped discovery phase issues a FIXED, small number of queries
 *      for K requested ids — proving Part 2's batching (one `IN (...)`
 *      query per table, not one query PER requested id) — by comparing
 *      K=5 against K=15 and asserting the count does not scale with K.
 *   3. A scoped call for connection A never reads (and never repairs) a
 *      sibling connection B's evidence row, even when B also has a pending
 *      repair candidate — proving the scoping is genuinely narrow, not
 *      merely "narrow at the instance-row level but still touches every
 *      other table completely."
 *
 * Query-counting methodology (DELIBERATELY DIFFERENT from the n-slope
 * file's `db.prepare = wrapperFn` reassignment): `server/db.js` wraps the
 * real `better-sqlite3` `Database` in a `Proxy` whose `get` trap
 * UNCONDITIONALLY intercepts `prop === 'prepare'` and returns a fresh
 * cache-lookup closure on every read, regardless of any property actually
 * assigned on the proxy/target. Verified directly (see this change's PR
 * report): reassigning `db.prepare = fn` on that proxy silently writes an
 * own property nothing ever reads back (`db.prepare` after assignment
 * still resolves through the trap, not the assignment), so the existing
 * n-slope file's counters are always 0 and its query-count assertions pass
 * vacuously (`0 <= 0 + 5`) regardless of real query behavior — confirmed by
 * temporarily instrumenting the wrapper closure itself, which never fires.
 * This file instead patches `Database.prototype.prepare` (the RAW
 * better-sqlite3 method the cache proxy's `get` trap calls on a cache
 * MISS) directly, which genuinely intercepts every real prepare call and
 * correctly does NOT double-count a cache hit (same SQL text reused).
 */

import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import { reconcileConnectorSummaryEvidence } from '../server/connector-summary-evidence-engine.ts';
import { getConnectorSummaryEvidence } from '../server/connector-summary-read-model.ts';
import { getConnectorSummaryForRoute } from '../server/ref-control.ts';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';

const NOW = '2026-07-17T00:00:00.000Z';

function withTempDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-scoped-consumer-'));
    try {
      initDb(join(dir, 'pdpp.sqlite'));
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function seedConnections(n, { connectorId = 'c1' } = {}) {
  const existing = getDb().prepare('SELECT 1 FROM connectors WHERE connector_id = ?').get(connectorId);
  if (!existing) {
    getDb().prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, '{}', ?)").run(connectorId, NOW);
  }
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const id = `${connectorId}_cin_${i}`;
    getDb()
      .prepare(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         ) VALUES (?, 'owner_local', ?, 'x', 'active', 'account', ?, '{}', ?, ?, NULL)`,
      )
      .run(id, connectorId, id, NOW, NOW);
    ids.push(id);
  }
  return ids;
}

/**
 * Count REAL `Database.prototype.prepare` invocations (the raw
 * better-sqlite3 method) during `fn`. `server/db.js`'s cached-prepare Proxy
 * calls this exactly once per DISTINCT sql text per db instance — a cache
 * hit for already-prepared text does not re-invoke it — so this is the
 * genuine "how many prepared statements did this pass issue" signal. See
 * this file's header comment for why the n-slope file's `db.prepare =
 * wrapperFn` reassignment approach does not actually intercept anything on
 * this proxy shape.
 */
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

test(
  'scoped reconcile for one connection issues a query count independent of N other unrelated connections',
  withTempDb(async () => {
    // N=1: one unrelated connection plus the one connection under test.
    seedConnections(1, { connectorId: 'unrelated' });
    const [targetIn1] = seedConnections(1, { connectorId: 'target' });
    await reconcileConnectorSummaryEvidence(null); // warm: create both rows
    const { calls: calls1 } = await countRawPrepareCalls(() => reconcileConnectorSummaryEvidence([targetIn1]));
    assert.ok(calls1 > 0, 'sanity: the interception itself must observe real prepare calls');

    closeDb();
    const dir25 = mkdtempSync(join(tmpdir(), 'pdpp-scoped-consumer-25-'));
    initDb(join(dir25, 'pdpp.sqlite'));
    // N=25: twenty-five unrelated connections plus the SAME one connection under test.
    seedConnections(25, { connectorId: 'unrelated' });
    const [targetIn25] = seedConnections(1, { connectorId: 'target' });
    await reconcileConnectorSummaryEvidence(null); // warm: create all 26 rows
    const { result: steadyState25, calls: calls25 } = await countRawPrepareCalls(() =>
      reconcileConnectorSummaryEvidence([targetIn25]),
    );
    rmSync(dir25, { recursive: true, force: true });

    assert.equal(steadyState25.repaired, 0, 'fixture premise: the one scoped connection is already current');
    assert.equal(steadyState25.discovered, 1, 'scoped discovery reads exactly the one requested connection');
    // A regression that scopes only the instance-row query but leaves
    // evidence/retained-bytes/version-counter/canonical-count reads as
    // complete table scans would still show as a FIXED query count here
    // (each complete scan is one query, just with a bigger result set) —
    // the property this asserts is that the scoped call's QUERY COUNT does
    // not grow with N, which is what "each of the six discovery tables is
    // read with one batched/complete query, never N point queries" buys.
    assert.equal(
      calls25,
      calls1,
      `scoped reconcile against N=25 unrelated connections issued ${calls25} prepare calls vs N=1's ${calls1} — scoped consumer cost must not grow with N`,
    );
  }),
);

test(
  'scoped discovery issues a fixed query count for K requested ids, not one query per id (Part 2 batching)',
  withTempDb(async () => {
    const idsK5 = seedConnections(5, { connectorId: 'batch' });
    await reconcileConnectorSummaryEvidence(null); // warm
    const { calls: callsK5 } = await countRawPrepareCalls(() => reconcileConnectorSummaryEvidence(idsK5));
    assert.ok(callsK5 > 0, 'sanity: the interception itself must observe real prepare calls');

    closeDb();
    const dir15 = mkdtempSync(join(tmpdir(), 'pdpp-scoped-consumer-k15-'));
    initDb(join(dir15, 'pdpp.sqlite'));
    const idsK15 = seedConnections(15, { connectorId: 'batch' });
    await reconcileConnectorSummaryEvidence(null); // warm
    const { result: steadyStateK15, calls: callsK15 } = await countRawPrepareCalls(() =>
      reconcileConnectorSummaryEvidence(idsK15),
    );
    rmSync(dir15, { recursive: true, force: true });

    assert.equal(steadyStateK15.repaired, 0, 'fixture premise: all K=15 requested connections are already current');
    assert.equal(steadyStateK15.discovered, 15);
    // The exact regression this proves closed: `readSqliteDiscoveryContext`'s
    // scoped branch used to do `connectorInstanceIds.map((id) => db.prepare(...).get(id))`
    // — one query PER requested id — for the instance-row lookup (and every
    // other scoped table was an unscoped complete-table read regardless of
    // K). A batched `IN (...)` query per table means the same FIXED number
    // of distinct SQL texts are prepared whether K=5 or K=15: the
    // placeholder COUNT changes (making each K's SQL text a distinct cache
    // key), but the number of PREPARE CALLS per table stays at exactly one,
    // so the total prepare-call count for K=15 must equal K=5's, not scale
    // with K.
    assert.equal(
      callsK15,
      callsK5,
      `K=15 scoped discovery issued ${callsK15} prepare calls vs K=5's ${callsK5} — batched IN(...) discovery must not scale with K`,
    );
  }),
);

test(
  'a scoped reconcile for connection A does not read or repair sibling connection B, even when B also needs repair',
  withTempDb(async () => {
    const manifest = {
      protocol_version: '0.1.0',
      connector_id: 'c1',
      version: '1.0.0',
      display_name: 'Sibling Isolation Test Connector',
      capabilities: { public_listing: { listed: true, status: 'test' } },
      streams: [{ name: 'messages', primary_key: ['id'] }],
    };
    getDb()
      .prepare('INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
      .run('c1', JSON.stringify(manifest), NOW);
    const store = createSqliteConnectorInstanceStore();
    await store.upsert({
      connectorInstanceId: 'cin_a',
      ownerSubjectId: 'owner_local',
      connectorId: 'c1',
      displayName: 'A',
      status: 'active',
      sourceKind: 'account',
      sourceBindingKey: 'a',
      sourceBinding: {},
      createdAt: NOW,
      updatedAt: NOW,
    });
    await store.upsert({
      connectorInstanceId: 'cin_b',
      ownerSubjectId: 'owner_local',
      connectorId: 'c1',
      displayName: 'B',
      status: 'active',
      sourceKind: 'account',
      sourceBindingKey: 'b',
      sourceBinding: {},
      createdAt: NOW,
      updatedAt: NOW,
    });
    // Warm: create both evidence rows.
    await reconcileConnectorSummaryEvidence(null);
    const bBeforeScopedCall = await getConnectorSummaryEvidence('cin_b');
    assert.ok(bBeforeScopedCall, 'fixture premise: B has an evidence row before the scoped call');
    const bComputedAtBefore = bBeforeScopedCall.computed_at;

    // Dirty BOTH A and B so both are genuine repair candidates.
    getDb().prepare("UPDATE connector_summary_evidence SET dirty = 1 WHERE connector_instance_id IN ('cin_a', 'cin_b')").run();

    // Scoped reconcile for A ONLY.
    const result = await reconcileConnectorSummaryEvidence(['cin_a']);
    assert.equal(result.discovered, 1, 'scoped discovery reads exactly the requested connection, not B');
    assert.equal(result.repaired, 1, 'scoped repair touches exactly the requested connection');

    const bAfterScopedCall = await getConnectorSummaryEvidence('cin_b');
    assert.equal(
      bAfterScopedCall.dirty,
      true,
      "B's dirty flag must remain set — a scoped call for A must not silently repair or clean B",
    );
    assert.equal(
      bAfterScopedCall.computed_at,
      bComputedAtBefore,
      "B's evidence row must be byte-identical after a scoped call for A — the scoped call never touched B",
    );

    // Prove the SAME non-intersection through the real HTTP-facing consumer
    // path (getConnectorSummaryForRoute -> loadConnectorSummaryProjectionDeps
    // scoped -> reconcileDirtyConnectorSummaryEvidence scoped), not just the
    // engine primitive directly.
    const summaryA = await getConnectorSummaryForRoute('cin_a');
    assert.ok(summaryA, 'getConnectorSummaryForRoute resolves the requested connection');
    const bAfterRouteCall = await getConnectorSummaryEvidence('cin_b');
    assert.equal(
      bAfterRouteCall.dirty,
      true,
      "B must still read dirty after getConnectorSummaryForRoute('cin_a') — the consumer-facing scoped route must not touch B",
    );
  }),
);
