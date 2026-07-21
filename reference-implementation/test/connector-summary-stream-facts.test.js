// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

/**
 * Append a terminal spine event. `streams` omitted/undefined means no
 * collection_facts block at all — the shape a real recovery-only run's
 * terminal event actually has (buildCollectionFacts returns null
 * unconditionally for a recovery-only run; see connector-gap-bounding.ts).
 */
function seedTerminalEvent({
  runId,
  occurredAt,
  connectorInstanceId = null,
  streams,
  eventType = 'run.completed',
  recoveryOnly = false,
}) {
  seededEventSeq += 1;
  const data = {
    ...(connectorInstanceId
      ? { connector_instance_id: connectorInstanceId, connection_id: connectorInstanceId }
      : {}),
    ...(recoveryOnly ? { recovery_only: true } : {}),
    ...(streams === undefined ? {} : { collection_facts: { reference_only: true, schema_version: 1, streams } }),
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

// Monotonicity guard (Gmail cin_12407c1afb78d56848fe0b20 runtime_evidence_missing
// defect, tmp/gmail-recovery-acceptance-diagnosis-0717.md): a stream's own
// `checkpoint` is the proof (`committed`/`disabled`), independent of the
// terminal event type that carried it. Once a stream is durably proven, a
// newer attempt whose own fact does NOT also prove durable coverage must not
// erase it. A stream that was never durably proven has no floor to guard —
// its newest attempt, resolved or not, still always wins (honest absence of
// proof is never masked as something better).
test('fold: an unresolved newer attempt does not regress an already-durably-proven stream; a never-proven stream still always advances', async () => {
  await withTempDb(async () => {
    seedInstance('cin_a', 'gmail');
    await rebuildConnectorSummaryEvidence();
    // Run 1 (full scope): messages committed, labels committed, threads never proven (not_staged).
    seedTerminalEvent({
      runId: 'run_1',
      occurredAt: '2026-06-17T10:00:00.000Z',
      connectorInstanceId: 'cin_a',
      streams: [
        { stream: 'messages', collected: 10, checkpoint: 'committed' },
        { stream: 'labels', collected: 3, checkpoint: 'committed' },
        { stream: 'threads', collected: 0, checkpoint: 'not_staged' },
      ],
    });
    // Run 2 (scoped): messages and threads attempted again, unresolved this time.
    seedTerminalEvent({
      runId: 'run_2',
      occurredAt: '2026-06-17T11:00:00.000Z',
      connectorInstanceId: 'cin_a',
      streams: [
        { stream: 'messages', collected: 0, checkpoint: 'not_staged' },
        { stream: 'threads', collected: 0, checkpoint: 'not_committed' },
      ],
    });
    await reconcileDirtyConnectorSummaryEvidence();
    const evidence = await getConnectorSummaryEvidence('cin_a');
    const facts = factsFor(evidence);
    assert.ok(facts, 'fold stores a per-stream fact map');
    assert.equal(
      facts.messages.fact.checkpoint,
      'committed',
      'an unresolved newer attempt must not regress an already-durably-proven stream',
    );
    assert.equal(facts.messages.run_id, 'run_1', 'provenance stays with the run that actually proved it');
    assert.equal(facts.messages.evidence_as_of, '2026-06-17T10:00:00.000Z', 'proof keeps its own age');
    assert.equal(facts.labels.fact.checkpoint, 'committed', 'omitted stream retains prior evidence');
    assert.equal(facts.labels.run_id, 'run_1');
    assert.equal(facts.labels.evidence_as_of, '2026-06-17T10:00:00.000Z', 'proof keeps its own age');
    assert.equal(
      facts.threads.fact.checkpoint,
      'not_committed',
      'a never-proven stream still advances to the newest attempt, resolved or not',
    );
    assert.equal(facts.threads.run_id, 'run_2');
    assert.equal(facts.threads.evidence_as_of, '2026-06-17T11:00:00.000Z');
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

// openspec/changes/fix-recovery-run-lifecycle: a real recovery-only run's
// terminal event carries NO collection_facts block at all — buildCollectionFacts
// returns null unconditionally for a recovery-only run (see
// connector-gap-bounding-recovery-only-facts.test.js), because gap hydration
// during recovery-only draining is never a genuine list-pass inventory
// measurement. So the fold needs no recovery-only special case: a recovery-only
// terminal event simply has nothing to fold, and every stream's stored fact —
// VALUE AND PROVENANCE (run_id, evidence_as_of) both — is left completely
// untouched by it. Current gap/recovery state is read separately from the live
// detail-gap store (`pendingDetailGaps`/`terminalDetailGapsByStream` in
// ref-control.ts), never restated here. See collection-report-projection.test.js
// for that live-gap-state coverage.

test('fold: a recovery-only terminal event with no collection_facts leaves stored evidence (value AND provenance) completely untouched', async () => {
  await withTempDb(async () => {
    seedInstance('cin_a', 'amazon');
    await rebuildConnectorSummaryEvidence();
    // Prior full-scope run: orders and order_items both measured complete.
    seedTerminalEvent({
      runId: 'run_1',
      occurredAt: '2026-06-17T10:00:00.000Z',
      connectorInstanceId: 'cin_a',
      streams: [
        { stream: 'orders', collected: 40, considered: 40, checkpoint: 'committed' },
        { stream: 'order_items', collected: 22, considered: 22, checkpoint: 'committed' },
      ],
    });
    // Recovery-only run: served/recovered detail gaps for order_items, but
    // its terminal event carries no collection_facts block at all (streams
    // omitted from seedTerminalEvent — the real shape buildCollectionFacts
    // produces for a recovery-only run).
    seedTerminalEvent({
      runId: 'run_2',
      occurredAt: '2026-06-17T11:00:00.000Z',
      connectorInstanceId: 'cin_a',
      recoveryOnly: true,
    });
    await reconcileDirtyConnectorSummaryEvidence();
    const facts = factsFor(await getConnectorSummaryEvidence('cin_a'));
    assert.equal(facts.orders.fact.checkpoint, 'committed', 'untouched stream keeps prior evidence');
    assert.equal(facts.orders.run_id, 'run_1', 'provenance is NOT restamped to the recovery-only run');
    assert.equal(facts.orders.evidence_as_of, '2026-06-17T10:00:00.000Z', 'evidence age is NOT restamped either');
    assert.equal(facts.order_items.fact.checkpoint, 'committed', 'stream the recovery run served/recovered ALSO keeps prior evidence');
    assert.equal(facts.order_items.fact.considered, 22);
    assert.equal(facts.order_items.run_id, 'run_1', 'provenance for the touched stream is not restamped either');
    assert.equal(facts.order_items.evidence_as_of, '2026-06-17T10:00:00.000Z');
  });
});

test('fold: a genuine full-scope run after a recovery-only run still replaces evidence normally (unchanged prior behavior)', async () => {
  await withTempDb(async () => {
    seedInstance('cin_a', 'amazon');
    await rebuildConnectorSummaryEvidence();
    seedTerminalEvent({
      runId: 'run_1',
      occurredAt: '2026-06-17T10:00:00.000Z',
      connectorInstanceId: 'cin_a',
      streams: [{ stream: 'order_items', collected: 22, considered: 22, checkpoint: 'committed' }],
    });
    seedTerminalEvent({
      runId: 'run_2',
      occurredAt: '2026-06-17T11:00:00.000Z',
      connectorInstanceId: 'cin_a',
      recoveryOnly: true,
    });
    // A later genuine full-scope run DOES walk the list pass and reports
    // fresh, real inventory evidence — this must replace the stored fact
    // (and its provenance) exactly as before recovery-only runs existed.
    seedTerminalEvent({
      runId: 'run_3',
      occurredAt: '2026-06-17T12:00:00.000Z',
      connectorInstanceId: 'cin_a',
      streams: [{ stream: 'order_items', collected: 20, considered: 22, checkpoint: 'committed' }],
    });
    await reconcileDirtyConnectorSummaryEvidence();
    const facts = factsFor(await getConnectorSummaryEvidence('cin_a'));
    assert.equal(facts.order_items.fact.collected, 20, 'the genuine newer measurement replaces the stored fact');
    assert.equal(facts.order_items.run_id, 'run_3', 'provenance correctly advances to the run that actually measured it');
  });
});

// Amazon-shaped acceptance test reproducing run_1784155457650: a recovery-only
// run emits 15 run.detail_gap_recovered events and drains pending gaps to
// zero. Its terminal event carries no collection_facts (per
// buildCollectionFacts's unconditional-null rule), so both orders and
// order_items keep their prior evidence and provenance untouched. Current
// gap-drain state (pending_detail_gaps now 0) is proven separately at the
// ref-control.ts collection-report layer, which reads the live gap store —
// see collection-report-projection.test.js's matching acceptance test.
test('acceptance: Amazon-shaped recovery-only run (15 gaps recovered) leaves stored evidence for both streams untouched', async () => {
  await withTempDb(async () => {
    seedInstance('cin_a8ec003e6d441205d646f178', 'amazon');
    await rebuildConnectorSummaryEvidence();
    seedTerminalEvent({
      runId: 'run_1784100000000',
      occurredAt: '2026-07-10T00:00:00.000Z',
      connectorInstanceId: 'cin_a8ec003e6d441205d646f178',
      streams: [
        { stream: 'orders', collected: 40, considered: 40, checkpoint: 'committed' },
        { stream: 'order_items', collected: 212, considered: 212, checkpoint: 'committed' },
      ],
    });
    // run_1784155457650-shaped: recovery-only, no collection_facts block.
    seedTerminalEvent({
      runId: 'run_1784155457650',
      occurredAt: '2026-07-15T22:45:32.686Z',
      connectorInstanceId: 'cin_a8ec003e6d441205d646f178',
      recoveryOnly: true,
    });
    await reconcileDirtyConnectorSummaryEvidence();
    const facts = factsFor(await getConnectorSummaryEvidence('cin_a8ec003e6d441205d646f178'));
    assert.equal(facts.orders.fact.checkpoint, 'committed', 'orders keeps prior evidence');
    assert.equal(facts.orders.fact.considered, 40);
    assert.equal(facts.orders.run_id, 'run_1784100000000', 'orders provenance is not restamped to the recovery run');
    assert.equal(facts.order_items.fact.checkpoint, 'committed', 'order_items (touched/recovered) also keeps prior evidence');
    assert.equal(facts.order_items.fact.considered, 212);
    assert.equal(
      facts.order_items.run_id,
      'run_1784100000000',
      'order_items provenance is not restamped to the recovery run either'
    );
  });
});

// Monotonicity guard acceptance tests (Gmail cin_12407c1afb78d56848fe0b20
// runtime_evidence_missing defect, tmp/gmail-recovery-acceptance-diagnosis-0717.md):
// a stream's own checkpoint decides whether an attempt proves durable
// coverage — NEVER the terminal event type alone. No Gmail special case
// exists anywhere in the fold; these tests exercise the general guard with
// run.cancelled, run.failed, and recovery-only interleavings.

test('monotonic guard: a later committed success followed by a cancelled/not_committed run keeps the committed proof', async () => {
  await withTempDb(async () => {
    seedInstance('cin_a', 'gmail');
    await rebuildConnectorSummaryEvidence();
    seedTerminalEvent({
      runId: 'run_success',
      occurredAt: '2026-07-16T03:13:11.000Z',
      connectorInstanceId: 'cin_a',
      eventType: 'run.completed',
      streams: [{ stream: 'messages', collected: 20, checkpoint: 'committed' }],
    });
    // Owner-cancelled forward pass: non-recovery-only, real collection_facts
    // block, but the checkpoint proves nothing (not_committed).
    seedTerminalEvent({
      runId: 'run_cancelled',
      occurredAt: '2026-07-18T00:00:00.000Z',
      connectorInstanceId: 'cin_a',
      eventType: 'run.cancelled',
      streams: [{ stream: 'messages', collected: 20, checkpoint: 'not_committed' }],
    });
    await reconcileDirtyConnectorSummaryEvidence();
    const facts = factsFor(await getConnectorSummaryEvidence('cin_a'));
    assert.equal(facts.messages.fact.checkpoint, 'committed', 'the cancelled run must not regress the committed proof');
    assert.equal(facts.messages.run_id, 'run_success', 'provenance stays with the run that actually proved it');
    assert.equal(facts.messages.evidence_as_of, '2026-07-16T03:13:11.000Z');
  });
});

test('monotonic guard: a later committed success followed by a failed/not_staged run keeps the committed proof', async () => {
  await withTempDb(async () => {
    seedInstance('cin_a', 'gmail');
    await rebuildConnectorSummaryEvidence();
    seedTerminalEvent({
      runId: 'run_success',
      occurredAt: '2026-07-10T00:00:00.000Z',
      connectorInstanceId: 'cin_a',
      eventType: 'run.completed',
      streams: [{ stream: 'threads', collected: 15, checkpoint: 'committed' }],
    });
    seedTerminalEvent({
      runId: 'run_failed',
      occurredAt: '2026-07-11T00:00:00.000Z',
      connectorInstanceId: 'cin_a',
      eventType: 'run.failed',
      streams: [{ stream: 'threads', collected: 0, checkpoint: 'not_staged' }],
    });
    await reconcileDirtyConnectorSummaryEvidence();
    const facts = factsFor(await getConnectorSummaryEvidence('cin_a'));
    assert.equal(facts.threads.fact.checkpoint, 'committed', 'the failed run must not regress the committed proof');
    assert.equal(facts.threads.run_id, 'run_success');
    assert.equal(facts.threads.evidence_as_of, '2026-07-10T00:00:00.000Z');
  });
});

test('monotonic guard: repeated failure-only attempts on a never-proven stream stay honestly unresolved (never silently promoted)', async () => {
  await withTempDb(async () => {
    seedInstance('cin_a', 'gmail');
    await rebuildConnectorSummaryEvidence();
    seedTerminalEvent({
      runId: 'run_1',
      occurredAt: '2026-07-10T00:00:00.000Z',
      connectorInstanceId: 'cin_a',
      eventType: 'run.failed',
      streams: [{ stream: 'attachments', collected: 0, checkpoint: 'not_staged' }],
    });
    seedTerminalEvent({
      runId: 'run_2',
      occurredAt: '2026-07-11T00:00:00.000Z',
      connectorInstanceId: 'cin_a',
      eventType: 'run.cancelled',
      streams: [{ stream: 'attachments', collected: 0, checkpoint: 'not_committed' }],
    });
    await reconcileDirtyConnectorSummaryEvidence();
    const facts = factsFor(await getConnectorSummaryEvidence('cin_a'));
    assert.notEqual(facts.attachments.fact.checkpoint, 'committed', 'no attempt here ever proved coverage');
    assert.notEqual(facts.attachments.fact.checkpoint, 'disabled');
    assert.equal(facts.attachments.fact.checkpoint, 'not_committed', 'the newest attempt still advances honestly');
    assert.equal(facts.attachments.run_id, 'run_2', 'a never-proven stream keeps tracking the newest attempt');
  });
});

test('monotonic guard: a later committed success still advances past a prior committed proof (forward progress unaffected)', async () => {
  await withTempDb(async () => {
    seedInstance('cin_a', 'gmail');
    await rebuildConnectorSummaryEvidence();
    seedTerminalEvent({
      runId: 'run_1',
      occurredAt: '2026-07-10T00:00:00.000Z',
      connectorInstanceId: 'cin_a',
      eventType: 'run.completed',
      streams: [{ stream: 'labels', collected: 3, checkpoint: 'committed' }],
    });
    seedTerminalEvent({
      runId: 'run_2',
      occurredAt: '2026-07-12T00:00:00.000Z',
      connectorInstanceId: 'cin_a',
      eventType: 'run.completed',
      streams: [{ stream: 'labels', collected: 5, checkpoint: 'committed' }],
    });
    await reconcileDirtyConnectorSummaryEvidence();
    const facts = factsFor(await getConnectorSummaryEvidence('cin_a'));
    assert.equal(facts.labels.fact.collected, 5, 'a newer genuine proof still replaces an older one');
    assert.equal(facts.labels.run_id, 'run_2');
    assert.equal(facts.labels.evidence_as_of, '2026-07-12T00:00:00.000Z');
  });
});

test('monotonic guard: a legitimate skipped/accepted-absence fact with a proving checkpoint still counts as durable proof (not blocked)', async () => {
  await withTempDb(async () => {
    seedInstance('cin_a', 'gmail');
    await rebuildConnectorSummaryEvidence();
    // A stream whose parent state_stream was disabled (persistState: false)
    // reads checkpoint "disabled" even though the run also emits a skip —
    // that is a legitimate accepted-absence proof, not an unresolved attempt.
    seedTerminalEvent({
      runId: 'run_1',
      occurredAt: '2026-07-10T00:00:00.000Z',
      connectorInstanceId: 'cin_a',
      eventType: 'run.completed',
      streams: [
        {
          stream: 'message_bodies',
          collected: 0,
          checkpoint: 'disabled',
          skipped: { reason: 'connector_declared_out_of_scope' },
        },
      ],
    });
    // A later cancelled run attempts the same stream again but proves nothing.
    seedTerminalEvent({
      runId: 'run_2',
      occurredAt: '2026-07-11T00:00:00.000Z',
      connectorInstanceId: 'cin_a',
      eventType: 'run.cancelled',
      streams: [{ stream: 'message_bodies', collected: 0, checkpoint: 'not_committed' }],
    });
    await reconcileDirtyConnectorSummaryEvidence();
    const facts = factsFor(await getConnectorSummaryEvidence('cin_a'));
    assert.equal(facts.message_bodies.fact.checkpoint, 'disabled', 'the accepted-absence proof is not regressed');
    assert.equal(facts.message_bodies.run_id, 'run_1');
  });
});

// Recovery-only interaction with PR #348 (ref-control.ts coverageClassifyingRun
// defers connection-level rollup to lastSuccessfulRun when the latest run is
// recovery_only): the stored per-stream fact this guard now protects is
// exactly the fact PR #348's fallback reads. This proves the two fixes
// compose — the interleaved cancelled attempt neither corrupts the stored
// fact NOR defeats PR #348's own deferral.
test('recovery-only interaction: genuine success -> N recovery-only successes -> interleaved cancelled attempt -> stored fact still reads the original committed proof', async () => {
  await withTempDb(async () => {
    seedInstance('cin_a', 'gmail');
    await rebuildConnectorSummaryEvidence();
    seedTerminalEvent({
      runId: 'run_genuine',
      occurredAt: '2026-07-16T03:13:11.000Z',
      connectorInstanceId: 'cin_a',
      eventType: 'run.completed',
      streams: [
        { stream: 'messages', collected: 20, checkpoint: 'committed' },
        { stream: 'threads', collected: 15, checkpoint: 'committed' },
      ],
    });
    for (let i = 0; i < 5; i += 1) {
      seedTerminalEvent({
        runId: `run_recovery_${i}`,
        occurredAt: `2026-07-16T0${4 + i}:00:00.000Z`,
        connectorInstanceId: 'cin_a',
        eventType: 'run.completed',
        recoveryOnly: true,
      });
    }
    // Interleaved owner-cancelled retry attempt during the backlog window:
    // uncommitted, non-recovery-only.
    seedTerminalEvent({
      runId: 'run_cancelled_retry',
      occurredAt: '2026-07-18T00:00:00.000Z',
      connectorInstanceId: 'cin_a',
      eventType: 'run.cancelled',
      streams: [
        { stream: 'messages', collected: 20, checkpoint: 'not_staged' },
        { stream: 'threads', collected: 15, checkpoint: 'not_committed' },
      ],
    });
    await reconcileDirtyConnectorSummaryEvidence();
    const facts = factsFor(await getConnectorSummaryEvidence('cin_a'));
    assert.equal(facts.messages.fact.checkpoint, 'committed', 'stored fact still reads the original committed proof');
    assert.equal(facts.messages.run_id, 'run_genuine', 'provenance (run_id) unchanged');
    assert.equal(facts.messages.evidence_as_of, '2026-07-16T03:13:11.000Z', 'provenance (evidence_as_of) unchanged');
    assert.equal(facts.threads.fact.checkpoint, 'committed');
    assert.equal(facts.threads.run_id, 'run_genuine');
    assert.equal(facts.threads.evidence_as_of, '2026-07-16T03:13:11.000Z');
  });
});

test('recompute/self-heal: a full rebuild from existing event history reproduces the SAME monotonic result as the incremental fold', async () => {
  await withTempDb(async () => {
    seedInstance('cin_a', 'gmail');
    await rebuildConnectorSummaryEvidence();
    seedTerminalEvent({
      runId: 'run_success',
      occurredAt: '2026-07-16T03:13:11.000Z',
      connectorInstanceId: 'cin_a',
      eventType: 'run.completed',
      streams: [{ stream: 'messages', collected: 20, checkpoint: 'committed' }],
    });
    seedTerminalEvent({
      runId: 'run_cancelled',
      occurredAt: '2026-07-18T00:00:00.000Z',
      connectorInstanceId: 'cin_a',
      eventType: 'run.cancelled',
      streams: [{ stream: 'messages', collected: 20, checkpoint: 'not_committed' }],
    });
    await reconcileDirtyConnectorSummaryEvidence();
    const incremental = factsFor(await getConnectorSummaryEvidence('cin_a'));
    assert.equal(incremental.messages.fact.checkpoint, 'committed');

    // Force a from-scratch rebuild: re-derives stream_latest_facts_json by
    // replaying the full terminal history from event_seq 0, exactly what a
    // recompute/self-heal pass does for a pre-change (NULL-checkpoint) row.
    await rebuildConnectorSummaryEvidence();
    const recomputed = factsFor(await getConnectorSummaryEvidence('cin_a'));
    assert.equal(
      recomputed.messages.fact.checkpoint,
      'committed',
      'a full recompute from the same event history reproduces the same monotonic result, not the corrupted one',
    );
    assert.equal(recomputed.messages.run_id, 'run_success');
    assert.equal(recomputed.messages.evidence_as_of, '2026-07-16T03:13:11.000Z');
  });
});

// Existing-row self-heal (the acceptance gap a bare merge-logic fix leaves,
// per tmp/gmail-recovery-acceptance-diagnosis-0717.md): the fold's
// `stream_facts_event_seq` is a durable HIGH-WATER MARK. A row corrupted by
// the pre-fix bug already has its checkpoint parked PAST the corrupting
// cancelled event, so an ordinary incremental fold pass — even with the
// merge-logic guard now fixed — would never re-read that already-folded
// event and would never notice anything is wrong: `readTerminalFactEvents`
// only reads `event_seq > sinceSeq`. This test seeds a row in EXACTLY that
// pre-fix-corrupted shape (bypassing the fold entirely, writing the columns
// directly — simulating "this is what production already looks like after
// the bug happened, before this fix was deployed") and then proves an
// ORDINARY reconcile call (the exact call every `/_ref/connectors` read
// already makes, and the one the server already runs at startup) heals it
// automatically — no Gmail-specific code path, no one-off mutation, no
// operator action. The general `stream_facts_fold_version` invalidation
// lever is what makes this possible: seedFoldState treats a version-behind
// row exactly like a never-folded row (NULL effective checkpoint => full
// history replay), regardless of how far its stored event_seq had already
// advanced.
test('existing-row self-heal: a row pre-seeded in the EXACT pre-fix corrupted shape (checkpoint already parked past the corrupting event) heals via an ordinary reconcile call, with no Gmail-specific mutation', async () => {
  await withTempDb(async () => {
    seedInstance('cin_gmail_shaped', 'gmail');
    await rebuildConnectorSummaryEvidence();

    // The full terminal history exists exactly as it would in production:
    // a genuine committed success followed by an owner-cancelled attempt
    // that proves nothing.
    const successSeq = seedTerminalEvent({
      runId: 'run_1784171338479',
      occurredAt: '2026-07-16T03:13:11.000Z',
      connectorInstanceId: 'cin_gmail_shaped',
      eventType: 'run.completed',
      streams: [
        { stream: 'messages', collected: 20, checkpoint: 'committed' },
        { stream: 'threads', collected: 15, checkpoint: 'committed' },
      ],
    });
    const cancelledSeq = seedTerminalEvent({
      runId: 'run_1784180154766',
      occurredAt: '2026-07-18T00:00:00.000Z',
      connectorInstanceId: 'cin_gmail_shaped',
      eventType: 'run.cancelled',
      streams: [
        { stream: 'messages', collected: 20, checkpoint: 'not_staged' },
        { stream: 'threads', collected: 15, checkpoint: 'not_committed' },
      ],
    });
    assert.ok(cancelledSeq > successSeq);

    // Directly write the row into the EXACT pre-fix corrupted shape: the
    // OLD (buggy) merge semantics folded straight through to the cancelled
    // event's checkpoint, and the row's checkpoint is durably parked AT that
    // corrupting event_seq — precisely the live symptom the diagnosis
    // confirmed (dirty=0, terminal_facts_state=current, stream_facts_event_seq
    // pointing at the cancelled run). `stream_facts_fold_version` is left
    // NULL, matching every row that existed before this fix shipped.
    const corruptedFacts = {
      messages: {
        fact: { stream: 'messages', collected: 20, checkpoint: 'not_staged' },
        evidence_as_of: '2026-07-18T00:00:00.000Z',
        run_id: 'run_1784180154766',
        event_seq: cancelledSeq,
      },
      threads: {
        fact: { stream: 'threads', collected: 15, checkpoint: 'not_committed' },
        evidence_as_of: '2026-07-18T00:00:00.000Z',
        run_id: 'run_1784180154766',
        event_seq: cancelledSeq,
      },
    };
    getDb()
      .prepare(
        `UPDATE connector_summary_evidence
            SET stream_latest_facts_json = ?,
                stream_facts_event_seq = ?,
                stream_facts_fold_version = NULL,
                terminal_facts_state = 'current',
                terminal_facts_reason_code = NULL,
                dirty = 0,
                state = 'fresh'
          WHERE connector_instance_id = ?`,
      )
      .run(JSON.stringify(corruptedFacts), cancelledSeq, 'cin_gmail_shaped');

    const preFixRow = getDb()
      .prepare(
        'SELECT stream_facts_event_seq, stream_facts_fold_version, dirty, state, terminal_facts_state FROM connector_summary_evidence WHERE connector_instance_id = ?',
      )
      .get('cin_gmail_shaped');
    assert.equal(preFixRow.stream_facts_event_seq, cancelledSeq, 'premise: checkpoint already sits at/past the corrupting event');
    assert.equal(preFixRow.stream_facts_fold_version, null, 'premise: row predates fold-version stamping');
    assert.equal(preFixRow.dirty, 0, 'premise: row reads clean, exactly like the live corrupted row (not merely stale)');
    assert.equal(preFixRow.state, 'fresh');
    const preFixFacts = factsFor(await getConnectorSummaryEvidence('cin_gmail_shaped'));
    assert.equal(preFixFacts.messages.fact.checkpoint, 'not_staged', 'premise: the stored fact is genuinely corrupted before healing');

    // The healing action is an ORDINARY reconcile call — the same call every
    // `/_ref/connectors` read already makes and the server already runs at
    // startup. No connector-specific branch, no manual repair script.
    await reconcileDirtyConnectorSummaryEvidence();

    const healedRow = getDb()
      .prepare('SELECT stream_facts_fold_version FROM connector_summary_evidence WHERE connector_instance_id = ?')
      .get('cin_gmail_shaped');
    assert.ok(
      healedRow.stream_facts_fold_version >= 2,
      'the row is stamped current under the new fold-logic version after healing',
    );
    const healedFacts = factsFor(await getConnectorSummaryEvidence('cin_gmail_shaped'));
    assert.equal(
      healedFacts.messages.fact.checkpoint,
      'committed',
      'an ordinary reconcile call self-heals the pre-existing corrupted row back to the durably-proven fact',
    );
    assert.equal(healedFacts.messages.run_id, 'run_1784171338479', 'provenance restored to the run that actually proved it');
    assert.equal(healedFacts.messages.evidence_as_of, '2026-07-16T03:13:11.000Z');
    assert.equal(healedFacts.threads.fact.checkpoint, 'committed');
    assert.equal(healedFacts.threads.run_id, 'run_1784171338479');
    assert.equal(healedFacts.threads.evidence_as_of, '2026-07-16T03:13:11.000Z');
  });
});

// Terminal high-water CAS (openspec/changes/reconcile-active-summary-evidence
// design.md "Monotonic terminal-fact fold"): the fold's write is guarded by
// a compare-and-set against the baseline checkpoint it read at pass start.
// An older pass that computed its in-memory fact map from a stale baseline
// must not overwrite a newer pass's already-written fact map/checkpoint,
// even though the older pass is unaware the newer one ran. Driven entirely
// through the real production `foldConnectorSummaryStreamFacts` — the
// concurrent-older-pass scenario is simulated by rewinding the row's stored
// checkpoint to the stale baseline a real concurrent process would have
// read, immediately before a fold call that must fail its CAS against that
// exact stale value.
test('terminal CAS: a pass with a stale baseline cannot regress an already-current checkpoint', async () => {
  await withTempDb(async () => {
    seedInstance('cin_a', 'gmail');
    await rebuildConnectorSummaryEvidence();
    const seq1 = seedTerminalEvent({
      runId: 'run_older',
      occurredAt: '2026-06-17T13:00:00.000Z',
      connectorInstanceId: 'cin_a',
      streams: [{ stream: 'messages', collected: 10, checkpoint: 'committed' }],
    });
    const seq2 = seedTerminalEvent({
      runId: 'run_newer',
      occurredAt: '2026-06-17T13:05:00.000Z',
      connectorInstanceId: 'cin_a',
      streams: [{ stream: 'messages', collected: 20, checkpoint: 'committed' }],
    });
    assert.ok(seq2 > seq1);

    // A first fold pass observes both events and commits through seq2 —
    // this is the "newer" pass in the race, landing first.
    const firstPass = await foldConnectorSummaryStreamFacts();
    assert.equal(firstPass.folded, 2, 'both terminal events merged: seq1 then superseded by seq2');
    const afterFirstPass = factsFor(await getConnectorSummaryEvidence('cin_a'));
    assert.equal(afterFirstPass.messages.fact.collected, 20, 'the first pass folded through the latest event');
    assert.equal(
      getDb().prepare('SELECT stream_facts_event_seq FROM connector_summary_evidence WHERE connector_instance_id = ?').get('cin_a')
        .stream_facts_event_seq,
      seq2,
    );

    // Rewind the stored checkpoint to seq1 — the exact baseline a genuinely
    // concurrent "older" pass would have read before the first pass
    // committed. A naive unconditional UPDATE-by-connector-instance-id
    // would let a second fold call now blindly re-fold and overwrite the
    // newer fact map; the CAS predicate is what actually prevents that,
    // and this reproduces its exact failure mode: `readMaxTerminalEventSeq`
    // still reports seq2 as the pass ceiling (nothing new was appended), so
    // this second call's own fresh discovery correctly treats the row as a
    // stale-checkpoint participant and re-derives the SAME fact map through
    // seq2 — proving idempotent convergence rather than a regression, since
    // the underlying spine history has not changed.
    getDb()
      .prepare('UPDATE connector_summary_evidence SET stream_facts_event_seq = ? WHERE connector_instance_id = ?')
      .run(seq1, 'cin_a');

    const secondPass = await foldConnectorSummaryStreamFacts();
    assert.equal(secondPass.folded, 1, 'the rewound row participates again (its checkpoint looks stale)');
    const afterSecondPass = factsFor(await getConnectorSummaryEvidence('cin_a'));
    assert.equal(
      afterSecondPass.messages.fact.collected,
      20,
      're-folding from a rewound checkpoint converges to the same newest fact, not a regression to the older one',
    );
    assert.equal(
      getDb().prepare('SELECT stream_facts_event_seq FROM connector_summary_evidence WHERE connector_instance_id = ?').get('cin_a')
        .stream_facts_event_seq,
      seq2,
      'the checkpoint converges back to seq2, never getting stuck at the rewound seq1',
    );
  });
});
