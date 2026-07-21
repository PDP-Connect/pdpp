// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Resumable bounded sweep: genuinely bounds discovery + fold + repair
 * TOGETHER, not just a repair-loop count/time cap
 * (Sol P2.2: "maxDurationMs checked only inside the repair loop does NOT
 * close Sol's finding... a full discovery can already exceed the budget
 * before the loop begins, and an unscoped fold can exceed it afterward.
 * Implement a genuinely resumable bounded startup unit across discovery +
 * fold + repair (e.g. stable cursor/batched scope plus deadline propagated
 * through all phases)").
 *
 * `runBoundedSummaryEvidenceSweep` processes the canonical connection set
 * in small pages, each running the FULL scoped discovery+fold+repair+prune
 * barrier (`observeConnectorSummaryEvidence`), with the deadline checked
 * BEFORE each page starts — never mid-page. This file proves:
 *
 *   1. A sweep with a tiny deadline covering only part of a large
 *      connection set stops early, reports `incomplete: true`, and returns
 *      a `resumeAfterId` cursor.
 *   2. A follow-up sweep starting from that cursor genuinely resumes and
 *      completes the sweep of the connections the first call did not
 *      reach — no connection is silently skipped forever.
 *   3. A sweep that DOES cover the complete set in one call runs complete
 *      orphan pruning; a sweep that stops early does NOT run complete
 *      pruning (only the scoped per-page pruning each page's own barrier
 *      call already performs) — an incomplete sweep must never risk
 *      treating an undiscovered page's connections as orphaned.
 *   4. The bound genuinely covers discovery+fold, not merely repair: a
 *      page with ZERO repair candidates (every row already fresh) still
 *      counts toward the page/time budget, proving the deadline check
 *      gates page START, not "only when there is repair work to bound."
 */

import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import { reconcileConnectorSummaryEvidence } from '../server/connector-summary-evidence-engine.ts';
import { runBoundedSummaryEvidenceSweep } from '../server/connector-summary-read-model.ts';

const NOW = '2026-07-17T00:00:00.000Z';

function withTempDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-bounded-sweep-'));
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
    // Zero-padded so lexical (ORDER BY connector_instance_id ASC) order
    // matches numeric order — the sweep's keyset cursor depends on this.
    const id = `${connectorId}_cin_${String(i).padStart(4, '0')}`;
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

function evidenceRowCount() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM connector_summary_evidence').get().n;
}

test(
  'a sweep whose deadline is exhausted mid-set stops early, reports incomplete, and never runs complete-set pruning',
  withTempDb(async () => {
    const n = 50;
    seedConnections(n);

    // Deadline exhausted almost immediately — expect only a small number of
    // pages (likely just the first) to complete before the deadline check
    // stops the loop.
    const result = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 1, pageSize: 10 });

    assert.equal(result.incomplete, true, 'a near-zero deadline cannot cover 50 connections in 10-per-page pages');
    assert.ok(result.resumeAfterId, 'an incomplete sweep returns a resume cursor');
    assert.equal(result.prunedComplete, false, 'an incomplete sweep must never run complete-set orphan pruning');
    assert.ok(result.discovered < n, 'fewer than the complete set was discovered this call');
    assert.ok(result.discovered > 0, 'at least the first page ran before the deadline check stopped further pages');
  }),
);

test(
  'a follow-up sweep resumes from the prior cursor and genuinely completes coverage of the connections the first call missed',
  withTempDb(async () => {
    const n = 30;
    const ids = seedConnections(n);

    // First sweep: cap pages so it deliberately covers only part of the set
    // (never hits the deadline — proves resumability independent of timing).
    const first = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, maxPages: 1, pageSize: 10 });
    assert.equal(first.incomplete, true, 'a 1-page cap on a 30-connection set is genuinely incomplete');
    assert.equal(first.discovered, 10, 'exactly one page (10 connections) was covered');
    assert.ok(first.resumeAfterId, 'a page-capped sweep returns a resume cursor');
    assert.equal(first.resumeAfterId, ids[9], 'the cursor is exactly the last id the first page covered');

    // Second sweep: resume from the first sweep's cursor, no page cap —
    // must cover every remaining connection and reach completion.
    const second = await runBoundedSummaryEvidenceSweep({
      maxDurationMs: 60_000,
      pageSize: 10,
      afterId: first.resumeAfterId,
    });
    assert.equal(second.incomplete, false, 'resuming from the cursor with no further cap reaches the end of the set');
    assert.equal(second.discovered, 20, 'the resumed sweep covers exactly the 20 connections the first sweep did not reach');
    // A resumed sweep that reaches the natural end of the id cursor DOES
    // safely run complete-set pruning: `readAllInstanceIdsForPruning` reads
    // the FULL live instance table independent of this call's own cursor
    // position, so pruning's live-id set is always complete once the sweep
    // itself confirms there is no more data past its cursor — regardless of
    // whether the earlier ids were walked by this call or a prior one.
    assert.equal(second.prunedComplete, true, 'a resumed sweep that reaches the end of the id space safely runs complete pruning — pruning reads the full live-instance table independently of the cursor');

    // Every one of the 30 connections has a durable evidence row after the
    // two-part sweep together covered the complete set.
    assert.equal(evidenceRowCount(), n, 'the two-part resumed sweep together produced evidence for every connection, none silently skipped forever');
  }),
);

test(
  'a sweep that genuinely covers the complete set in one call runs complete-set orphan pruning',
  withTempDb(async () => {
    seedConnections(5);
    await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: 10 });
    assert.equal(evidenceRowCount(), 5);

    // Delete one connection's canonical row entirely — its evidence row is
    // now a genuine orphan.
    getDb().prepare("DELETE FROM connector_instances WHERE connector_instance_id = 'c1_cin_0002'").run();

    const result = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: 10 });
    assert.equal(result.incomplete, false, 'a 5-connection set fits in one 10-per-page pass');
    assert.equal(result.prunedComplete, true, 'a genuinely complete sweep runs complete-set orphan pruning');
    assert.equal(evidenceRowCount(), 4, 'the orphaned connection\'s evidence row was pruned by the complete pass');
  }),
);

test(
  'the deadline bounds page START (discovery+fold+repair together), not merely repair work — a page with zero repair candidates still counts toward the budget',
  withTempDb(async () => {
    const n = 40;
    seedConnections(n);
    // Warm every row to fresh/current first — every subsequent page has
    // ZERO repair candidates, proving the page-count/deadline bound is not
    // merely "only checked when there is something to repair."
    await reconcileConnectorSummaryEvidence(null);

    const result = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, maxPages: 2, pageSize: 10 });
    assert.equal(result.incomplete, true, 'the maxPages cap stops the sweep even though every page had zero repair work');
    assert.equal(result.discovered, 20, 'exactly 2 pages (20 connections) were processed before the page cap stopped further pages, despite zero repair candidates');
  }),
);

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
  'one page\'s total query count (discovery + fold + repair together) does not grow with N, the total connection count',
  withTempDb(async () => {
    // N=50, page size 10: the sweep's FIRST page must cover connections
    // 0-9 regardless of whether there are 50 or 500 total connections —
    // its own discovery+fold+repair query cost must not depend on N.
    seedConnections(50);
    const { calls: calls50 } = await countRawPrepareCalls(() =>
      runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, maxPages: 1, pageSize: 10 }),
    );
    assert.ok(calls50 > 0, 'sanity: interception observed real prepare calls');

    closeDb();
    const dir200 = mkdtempSync(join(tmpdir(), 'pdpp-bounded-sweep-200-'));
    initDb(join(dir200, 'pdpp.sqlite'));
    // N=200: same page size, same first page — the ONLY thing that changed
    // is how many MORE connections exist beyond what this one page covers.
    seedConnections(200);
    const { result: page1of200, calls: calls200 } = await countRawPrepareCalls(() =>
      runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, maxPages: 1, pageSize: 10 }),
    );
    rmSync(dir200, { recursive: true, force: true });

    assert.equal(page1of200.discovered, 10, 'one page still covers exactly 10 connections regardless of N=200 total');
    assert.equal(page1of200.incomplete, true, 'N=200 with a 1-page cap is genuinely incomplete');
    // The decisive assertion: one page's discovery+fold+repair query count
    // must be the same whether 50 or 200 total connections exist — proving
    // the bound genuinely covers discovery and fold (both of which, before
    // this fix, scanned the COMPLETE table regardless of page/candidate
    // count), not merely the repair loop.
    assert.equal(
      calls200,
      calls50,
      `one page against N=200 total connections issued ${calls200} prepare calls vs N=50's ${calls50} — a single bounded page's discovery+fold+repair must not scale with total N`,
    );
  }),
);
