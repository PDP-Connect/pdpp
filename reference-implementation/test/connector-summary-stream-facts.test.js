import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  foldConnectorSummaryStreamFacts,
  getConnectorSummaryEvidence,
  rebuildConnectorSummaryEvidence,
  reconcileDirtyConnectorSummaryEvidence,
} from '../server/connector-summary-read-model.ts';
import { closeDb, getDb, initDb } from '../server/db.js';

// Per-stream latest-attempt evidence fold
// (openspec/changes/define-stream-coverage-freshness-evidence, requirement
// "Per-stream coverage SHALL derive from durable latest-attempt evidence").
// SQLite-host tests: the fold SQL is dialect-split but the orchestration is
// shared, so the semantics proven here (newest attempt wins, connection
// isolation, refusal of unattributable events, checkpointed delta folding,
// failure leaves rows visibly non-fresh) hold for both backends.

const OWNER = 'owner_local';
const NOW = '2026-06-17T12:00:00.000Z';

async function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-stream-facts-'));
  try {
    initDb(join(dir, 'pdpp.sqlite'));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedInstance(connectorInstanceId, connectorId) {
  getDb()
    .prepare('INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
    .run(connectorId, JSON.stringify({ connector_id: connectorId }), NOW);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       )
       VALUES(?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`,
    )
    .run(connectorInstanceId, OWNER, connectorId, connectorId, connectorInstanceId, NOW, NOW);
}

let seededEventSeq = 0;

/** Append a terminal spine event carrying a collection_facts block. */
function seedTerminalEvent({
  runId,
  occurredAt,
  connectorInstanceId = null,
  streams,
  eventType = 'run.completed',
}) {
  seededEventSeq += 1;
  const data = {
    ...(connectorInstanceId
      ? { connector_instance_id: connectorInstanceId, connection_id: connectorInstanceId }
      : {}),
    collection_facts: { reference_only: true, schema_version: 1, streams },
  };
  getDb()
    .prepare(
      `INSERT INTO spine_events(
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, data_json, version
       )
       VALUES(?, ?, ?, ?, ?, 'test', ?, 'runtime', 'test-connector', 'run', ?, 'succeeded', ?, ?, '1')`,
    )
    .run(
      `evt_${seededEventSeq}`,
      seededEventSeq,
      eventType,
      occurredAt,
      occurredAt,
      `trace_${seededEventSeq}`,
      runId,
      runId,
      JSON.stringify(data),
    );
  return seededEventSeq;
}

function factsFor(evidence) {
  return evidence?.stream_latest_facts ?? null;
}

test('fold: newest attempt per stream wins, omitted streams retain prior evidence', async () => {
  await withTempDb(async () => {
    seedInstance('cin_a', 'gmail');
    await rebuildConnectorSummaryEvidence();
    // Run 1 (full scope): messages committed, labels committed.
    seedTerminalEvent({
      runId: 'run_1',
      occurredAt: '2026-06-17T10:00:00.000Z',
      connectorInstanceId: 'cin_a',
      streams: [
        { stream: 'messages', collected: 10, checkpoint: 'committed' },
        { stream: 'labels', collected: 3, checkpoint: 'committed' },
      ],
    });
    // Run 2 (scoped): only messages attempted, unresolved this time.
    seedTerminalEvent({
      runId: 'run_2',
      occurredAt: '2026-06-17T11:00:00.000Z',
      connectorInstanceId: 'cin_a',
      streams: [{ stream: 'messages', collected: 0, checkpoint: 'not_staged' }],
    });
    await reconcileDirtyConnectorSummaryEvidence();
    const evidence = await getConnectorSummaryEvidence('cin_a');
    const facts = factsFor(evidence);
    assert.ok(facts, 'fold stores a per-stream fact map');
    assert.equal(facts.messages.fact.checkpoint, 'not_staged', 'newest attempt replaces older proof (failure not masked)');
    assert.equal(facts.messages.run_id, 'run_2');
    assert.equal(facts.messages.evidence_as_of, '2026-06-17T11:00:00.000Z');
    assert.equal(facts.labels.fact.checkpoint, 'committed', 'omitted stream retains prior evidence');
    assert.equal(facts.labels.run_id, 'run_1');
    assert.equal(facts.labels.evidence_as_of, '2026-06-17T10:00:00.000Z', 'proof keeps its own age');
  });
});

test('fold: evidence never crosses connections; unattributable legacy events are refused', async () => {
  await withTempDb(async () => {
    seedInstance('cin_one', 'amazon');
    seedInstance('cin_two', 'amazon');
    await rebuildConnectorSummaryEvidence();
    seedTerminalEvent({
      runId: 'run_a',
      occurredAt: '2026-06-17T10:00:00.000Z',
      connectorInstanceId: 'cin_one',
      streams: [{ stream: 'orders', collected: 5, checkpoint: 'committed' }],
    });
    // Legacy connector-wide event: no connection identity -> refused.
    seedTerminalEvent({
      runId: 'run_legacy',
      occurredAt: '2026-06-17T10:30:00.000Z',
      connectorInstanceId: null,
      streams: [{ stream: 'orders', collected: 99, checkpoint: 'committed' }],
    });
    const summary = await foldConnectorSummaryStreamFacts();
    assert.equal(summary.refused, 1, 'the unattributable event is counted as refused');
    const one = factsFor(await getConnectorSummaryEvidence('cin_one'));
    const two = factsFor(await getConnectorSummaryEvidence('cin_two'));
    assert.equal(one.orders.fact.collected, 5, 'attributed evidence folds into its own connection');
    assert.equal(one.orders.run_id, 'run_a', 'the refused legacy event never overwrote the attributed fact');
    assert.equal(two, null, 'a sibling connection of the same connector inherits nothing');
  });
});

test('fold: checkpointed delta — a terminal event landing after a clean reconcile still folds without a dirty flag', async () => {
  await withTempDb(async () => {
    seedInstance('cin_a', 'gmail');
    await rebuildConnectorSummaryEvidence();
    await reconcileDirtyConnectorSummaryEvidence();
    const before = await getConnectorSummaryEvidence('cin_a');
    assert.equal(before.dirty, false, 'premise: row is clean before the late terminal event');
    // Terminal event lands with NO dirty marking (the race the sequence
    // checkpoint exists for: a read during the active run cleaned the flag
    // before the terminal event landed).
    seedTerminalEvent({
      runId: 'run_late',
      occurredAt: '2026-06-17T11:59:00.000Z',
      connectorInstanceId: 'cin_a',
      streams: [{ stream: 'messages', collected: 2, checkpoint: 'committed' }],
    });
    await reconcileDirtyConnectorSummaryEvidence();
    const after = await getConnectorSummaryEvidence('cin_a');
    const facts = factsFor(after);
    assert.equal(facts.messages.run_id, 'run_late', 'the max-seq comparison folds the late event');
    assert.ok(
      after.stream_facts_event_seq >= 1,
      'the fold checkpoint advanced past the late event',
    );
  });
});

test('fold: pre-change rows (NULL checkpoint) self-heal by folding full history on the next pass', async () => {
  await withTempDb(async () => {
    seedInstance('cin_a', 'gmail');
    seedTerminalEvent({
      runId: 'run_old',
      occurredAt: '2026-06-01T00:00:00.000Z',
      connectorInstanceId: 'cin_a',
      streams: [{ stream: 'messages', collected: 100, checkpoint: 'committed' }],
    });
    // Rebuild inserts the evidence row and immediately folds history.
    await rebuildConnectorSummaryEvidence();
    const evidence = await getConnectorSummaryEvidence('cin_a');
    const facts = factsFor(evidence);
    assert.equal(facts.messages.fact.collected, 100, 'historical terminal events backfill without any operator command');
    assert.notEqual(evidence.stream_facts_event_seq, null, 'the checkpoint is stamped after backfill');
  });
});

test('fold failure: rows stay visibly non-fresh and the failed pass reconciles nothing', async () => {
  await withTempDb(async () => {
    seedInstance('cin_a', 'gmail');
    await rebuildConnectorSummaryEvidence();
    await reconcileDirtyConnectorSummaryEvidence();
    // Inject a fold read failure: the fold's terminal-event reads hit
    // spine_events; renaming it makes readMaxTerminalEventSeq throw.
    getDb().exec('ALTER TABLE spine_events RENAME TO spine_events_hidden');
    try {
      const result = await reconcileDirtyConnectorSummaryEvidence();
      assert.equal(result.reconciled, 0, 'a failed fold must not run the normal dirty-row refresh');
      const evidence = await getConnectorSummaryEvidence('cin_a');
      assert.equal(evidence.dirty, true, 'the failure marks the row dirty');
      assert.equal(evidence.state, 'stale', 'the failure is visible as a non-fresh state');
      assert.ok(evidence.last_error, 'the sanitized fold error is recorded');
    } finally {
      getDb().exec('ALTER TABLE spine_events_hidden RENAME TO spine_events');
    }
    // Once the fold can read again, the next pass repairs the rows.
    const repaired = await reconcileDirtyConnectorSummaryEvidence();
    assert.ok(repaired.reconciled >= 1, 'the next pass repairs the previously failed rows');
    const evidence = await getConnectorSummaryEvidence('cin_a');
    assert.equal(evidence.state, 'fresh');
    assert.equal(evidence.last_error, null);
  });
});
