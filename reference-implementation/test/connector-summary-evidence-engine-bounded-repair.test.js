/**
 * Bounded startup repair work (openspec/changes/reconcile-active-summary-evidence
 * design.md "Startup is acceleration, not authority"; the reconcile-
 * summary-evidence follow-up closing "startup work is best-effort but not
 * bounded").
 *
 * `reconcileConnectorSummaryEvidence`'s `options.maxCandidates`, used only
 * by the one-shot startup acceleration call (`server/index.js`), caps the
 * number of candidates ONE call repairs — proven here directly on the
 * engine — while discovery itself still reads the complete set (so
 * `discovered` is accurate) and the skipped candidates are genuinely
 * deferred, not lost: a second, unbounded pass (the correctness-gate
 * barrier every real read runs) picks up exactly what the bounded pass
 * left behind.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import { reconcileConnectorSummaryEvidence } from '../server/connector-summary-evidence-engine.ts';

const NOW = '2026-07-17T00:00:00.000Z';

async function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-bounded-repair-'));
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

test('a bounded pass repairs at most maxCandidates, discovers the complete set, and reports the exact skip count', () =>
  withTempDb(async () => {
    const n = 10;
    seedConnections(n);

    const bounded = await reconcileConnectorSummaryEvidence(null, { maxCandidates: 4 });
    assert.equal(bounded.discovered, n, 'discovery still reads the complete canonical set regardless of the bound');
    assert.equal(bounded.repaired, 4, 'exactly maxCandidates repairs happen, not all N');
    assert.equal(bounded.skipped, n - 4, 'the remaining candidates are reported as skipped, not silently dropped');
    assert.equal(bounded.failed, 0);
  }));

test('a candidate a bounded pass skips is genuinely deferred, not lost — the next unbounded pass repairs it', () =>
  withTempDb(async () => {
    const n = 10;
    seedConnections(n);

    const bounded = await reconcileConnectorSummaryEvidence(null, { maxCandidates: 4 });
    assert.equal(bounded.repaired, 4);
    assert.equal(bounded.skipped, 6);

    // Exactly 4 rows exist (the ones the bounded pass actually repaired);
    // the other 6 connections have no evidence row yet.
    const rowCount = getDb().prepare('SELECT COUNT(*) AS n FROM connector_summary_evidence').get();
    assert.equal(rowCount.n, 4, 'only the repaired candidates have a durable row after the bounded pass');

    // The correctness-gate barrier (an unbounded pass, exactly what every
    // real read runs) picks up every candidate the bounded pass deferred —
    // nothing was silently dropped.
    const unbounded = await reconcileConnectorSummaryEvidence(null);
    assert.equal(unbounded.discovered, n);
    assert.equal(unbounded.repaired, 6, 'the second, unbounded pass repairs exactly the 6 previously-skipped candidates');
    assert.equal(unbounded.skipped, 0, 'an unbounded pass never reports a skip');

    const finalRowCount = getDb().prepare('SELECT COUNT(*) AS n FROM connector_summary_evidence').get();
    assert.equal(finalRowCount.n, n, 'every connection has a durable evidence row after the follow-up unbounded pass');
  }));

test('an unbounded call (no options, the default) never skips — every existing consumer is unaffected', () =>
  withTempDb(async () => {
    seedConnections(5);
    const result = await reconcileConnectorSummaryEvidence(null);
    assert.equal(result.repaired, 5);
    assert.equal(result.skipped, 0, 'the default (unbounded) behavior is preserved for every caller that does not opt into a bound');
  }));
