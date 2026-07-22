// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fold-write reliability invariants (owner review, 2026-07-18 revision of
 * the monotonic-coverage-guard candidate):
 *
 *   1. A bounded fold pass that exhausts its budget before genuinely
 *      reaching the pass's high-water mark (`maxSeq`) must NEVER mark a
 *      row's terminal facts `current` — it writes `stream_latest_facts_json`/
 *      `stream_facts_event_seq` as real, resumable partial progress, but
 *      `terminal_facts_state = 'stale'` with a precise, stable reason
 *      (`terminal_fold_incomplete`) so `evidenceUnreliableSources` (see
 *      ref-control.ts) surfaces it as unreliable through the EXISTING
 *      failure boundary. Only a pass whose drain genuinely converges
 *      (`cursor === maxSeq`) may write `current`.
 *   2. `stream_latest_facts_json` is replaced EXACTLY on every fold write —
 *      never COALESCEd with a prior value — so an empty/early replay never
 *      silently retains old-logic facts under a claimed-current version.
 *   3. `stream_facts_fold_version` is ALWAYS stamped to the binary's own
 *      `STREAM_FACTS_FOLD_LOGIC_VERSION` on every write this fold makes,
 *      converged or not: the merge semantics that produced the write's
 *      output ARE the current version from the first partial batch, so
 *      holding the version field back would make an incomplete row look
 *      version-behind again next pass and restart its replay from scratch
 *      instead of resuming. Reliability is carried by `terminal_facts_state`
 *      alone, never by the version field.
 *   4. A row whose stored `stream_facts_fold_version` is AHEAD of this
 *      binary's own version (a newer deploy already folded it) is NEVER
 *      folded, replayed, or durably mutated by this binary — not even to
 *      mark it unreliable. This binary fails it closed purely at READ time
 *      (`shapeEvidenceRow`), in memory, so a rollback or a still-in-flight
 *      older instance can never poison the durable row a newer binary owns,
 *      and a newer-compatible reader still sees the row exactly as stored.
 *   5. `maxEvents` is an ACTUAL per-call ceiling, not merely an early-exit
 *      hint checked between oversized batches: each internal batch read's
 *      own `limit` is capped at the REMAINING budget
 *      (`min(STREAM_FACTS_FOLD_BATCH, maxEvents - eventsProcessed)`), so
 *      `maxEvents: 1` processes AT MOST one event even when the scope has
 *      far more attributable history than one internal batch could ever
 *      hold.
 *
 * `drainTerminalEventBatches`'s exact-boundary case (a batch whose last
 * event lands exactly on `maxSeq`, including when that batch's size equals
 * the caller's own remaining `maxEvents` budget rather than the internal
 * `STREAM_FACTS_FOLD_BATCH` constant) is covered directly here too:
 * convergence must be derived from `cursor === maxSeq`, never from which
 * internal branch of the drain loop happened to return, and the "was this
 * batch short" check must compare against the batch's own requested
 * `limit`, never the raw `STREAM_FACTS_FOLD_BATCH` constant.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  foldConnectorSummaryStreamFacts,
  getConnectorSummaryEvidence,
  rebuildConnectorSummaryEvidence,
} from '../server/connector-summary-read-model.ts';
import { closeDb, getDb, initDb } from '../server/db.js';

const OWNER = 'owner_local';
const NOW = '2026-07-18T00:00:00.000Z';

async function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-stream-facts-reliability-'));
  try {
    initDb(join(dir, 'pdpp.sqlite'));
    // Each temp DB starts its own spine_events.event_seq space at 1; reset
    // the seeding counter to match so per-test absolute event_seq
    // assertions stay meaningful across tests in this file.
    seededEventSeq = 0;
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

function seedTerminalEvent({ runId, connectorInstanceId, streams }) {
  seededEventSeq += 1;
  const data = {
    connector_instance_id: connectorInstanceId,
    connection_id: connectorInstanceId,
    collection_facts: { reference_only: true, schema_version: 1, streams },
  };
  getDb()
    .prepare(
      `INSERT INTO spine_events(
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
       )
       VALUES(?, ?, 'run.completed', ?, ?, 'test', ?, 'runtime', 'test-connector', 'run', ?, 'succeeded', ?, ?, ?, '1')`,
    )
    .run(
      `evt_${seededEventSeq}`,
      seededEventSeq,
      NOW,
      NOW,
      `trace_${seededEventSeq}`,
      runId,
      runId,
      connectorInstanceId,
      JSON.stringify(data),
    );
  return seededEventSeq;
}

function evidenceRow(connectorInstanceId) {
  return getDb()
    .prepare(
      'SELECT stream_facts_event_seq, stream_facts_fold_version, stream_latest_facts_json, terminal_facts_state, terminal_facts_reason_code FROM connector_summary_evidence WHERE connector_instance_id = ?',
    )
    .get(connectorInstanceId);
}

function factsFor(evidence) {
  return evidence?.stream_latest_facts ?? null;
}

// ─── 1 & 5. maxEvents is an ACTUAL ceiling: bounded pass processes AT MOST
//            the requested count, cannot be read as current ───────────────

test('bounded first pass: maxEvents:1 processes AT MOST one event (never the whole in-flight batch) and stays stale/incomplete', async () => {
  await withTempDb(async () => {
    seedInstance('cin_a', 'gmail');
    await rebuildConnectorSummaryEvidence();
    seedTerminalEvent({
      runId: 'run_1',
      connectorInstanceId: 'cin_a',
      streams: [{ stream: 'messages', collected: 1, checkpoint: 'committed' }],
    });
    seedTerminalEvent({
      runId: 'run_2',
      connectorInstanceId: 'cin_a',
      streams: [{ stream: 'threads', collected: 1, checkpoint: 'committed' }],
    });
    seedTerminalEvent({
      runId: 'run_3',
      connectorInstanceId: 'cin_a',
      streams: [{ stream: 'labels', collected: 1, checkpoint: 'committed' }],
    });

    const result = await foldConnectorSummaryStreamFacts(['cin_a'], { maxEvents: 1 });
    assert.equal(result.incomplete, true, 'the pass genuinely did not converge (3 events exist, budget is 1)');
    assert.equal(result.resumeAfterSeq, 1, 'the resume cursor is EXACTLY the one event actually processed, not the whole in-flight batch');

    const row = evidenceRow('cin_a');
    assert.equal(Number(row.stream_facts_event_seq), 1, 'the durable checkpoint reflects processing AT MOST one event');
    assert.equal(
      row.terminal_facts_state,
      'stale',
      'an incomplete pass must NEVER be readable as current, even though it made real progress',
    );
    assert.equal(row.terminal_facts_reason_code, 'terminal_fold_incomplete');
    assert.equal(Number(row.stream_facts_fold_version), 3, 'the version field already reflects the current fold logic from the FIRST partial write');

    const facts = JSON.parse(row.stream_latest_facts_json);
    assert.equal(Object.keys(facts).length, 1, 'exactly the ONE event actually processed is folded — maxEvents:1 is a real ceiling, not merely an early-exit hint');
    assert.ok(facts.messages, 'the one event folded is genuinely the first one (messages), not an arbitrary later one');

    const evidence = await getConnectorSummaryEvidence('cin_a');
    assert.equal(evidence.terminal_facts.state, 'stale', 'the public read model surfaces the same unreliable state');
    assert.equal(evidence.terminal_facts.reason_code, 'terminal_fold_incomplete');
  });
});

test('bounded upgrade replay from a pre-existing (pre-versioning) row: maxEvents:1 never mixes old-logic and new-logic facts', async () => {
  await withTempDb(async () => {
    seedInstance('cin_a', 'gmail');
    await rebuildConnectorSummaryEvidence();
    seedTerminalEvent({
      runId: 'run_1',
      connectorInstanceId: 'cin_a',
      streams: [{ stream: 'messages', collected: 1, checkpoint: 'committed' }],
    });
    seedTerminalEvent({
      runId: 'run_2',
      connectorInstanceId: 'cin_a',
      streams: [{ stream: 'threads', collected: 1, checkpoint: 'committed' }],
    });

    // Simulate a pre-existing row folded entirely under an OLD logic
    // version (NULL fold_version), carrying OLD-logic facts for BOTH
    // streams already, with its checkpoint already at the full history.
    const OLD_LOGIC_FACTS = {
      messages: { fact: { stream: 'messages', collected: 999, checkpoint: 'not_staged' }, run_id: 'old_run', event_seq: 2, evidence_as_of: null },
      threads: { fact: { stream: 'threads', collected: 999, checkpoint: 'not_staged' }, run_id: 'old_run', event_seq: 2, evidence_as_of: null },
    };
    getDb()
      .prepare(
        `UPDATE connector_summary_evidence
            SET stream_latest_facts_json = ?, stream_facts_event_seq = 2, stream_facts_fold_version = NULL,
                terminal_facts_state = 'current', terminal_facts_reason_code = NULL, dirty = 0, state = 'fresh'
          WHERE connector_instance_id = ?`,
      )
      .run(JSON.stringify(OLD_LOGIC_FACTS), 'cin_a');

    // Bounded to 1 event: the upgrade replay (which starts EMPTY, per
    // rowIsFoldLogicVersionBehind) can only fold ONE of the two events this
    // round.
    const result = await foldConnectorSummaryStreamFacts(['cin_a'], { maxEvents: 1 });
    assert.equal(result.incomplete, true);
    assert.equal(result.resumeAfterSeq, 1, 'the replay processed AT MOST one event this round');

    const row = evidenceRow('cin_a');
    assert.equal(row.terminal_facts_state, 'stale', 'the partial upgrade replay must not be trusted');
    assert.equal(row.terminal_facts_reason_code, 'terminal_fold_incomplete');
    assert.equal(Number(row.stream_facts_fold_version), 3, 'the version field already reflects the current fold logic from the FIRST partial write');

    const facts = JSON.parse(row.stream_latest_facts_json);
    assert.equal(Object.keys(facts).length, 1, 'only the ONE stream the replay actually re-derived this round is present');
    const [[, entry]] = Object.entries(facts);
    assert.equal(entry.fact.collected, 1, 'the surviving fact is the NEW-logic value, never the old collected:999 leftover');
    assert.notEqual(entry.run_id, 'old_run', 'provenance is the new replay, not the stale old-logic run');
  });
});

// ─── 2. Empty replacement clears stale JSON exactly (no COALESCE) ─────────

test('exact replacement: a converged pass with genuinely zero facts clears stream_latest_facts_json to NULL, not a COALESCE-preserved stale value', async () => {
  await withTempDb(async () => {
    seedInstance('cin_a', 'gmail');
    await rebuildConnectorSummaryEvidence();
    // Seed a row with OLD-logic leftover facts and an OLD version, but NO
    // terminal events exist for it at all.
    getDb()
      .prepare(
        `UPDATE connector_summary_evidence
            SET stream_latest_facts_json = ?, stream_facts_event_seq = NULL, stream_facts_fold_version = NULL
          WHERE connector_instance_id = ?`,
      )
      .run(JSON.stringify({ messages: { fact: { stream: 'messages', collected: 5, checkpoint: 'committed' }, run_id: 'r', event_seq: 1, evidence_as_of: null } }), 'cin_a');

    // No terminal events exist anywhere -> maxSeq === null -> the bootstrap
    // path (stampZeroCheckpointForBootstrap) fires, which must write a
    // genuinely fresh NULL, not silently keep the stale leftover.
    const result = await foldConnectorSummaryStreamFacts(['cin_a']);
    assert.equal(result.incomplete, false);

    const row = evidenceRow('cin_a');
    assert.equal(row.stream_latest_facts_json, null, 'the stale leftover fact map is genuinely cleared, not COALESCEd back in');
    assert.equal(row.terminal_facts_state, 'current');
    assert.equal(Number(row.stream_facts_fold_version), 3);
  });
});

// ─── 3. Multi-round resume: converges and only THEN reads current ────────

test('multi-round resume: bounded (maxEvents:2) rounds accumulate and only the genuinely converged final round reads current', async () => {
  await withTempDb(async () => {
    seedInstance('cin_a', 'gmail');
    await rebuildConnectorSummaryEvidence();
    for (let i = 0; i < 5; i += 1) {
      seedTerminalEvent({
        runId: `run_${i}`,
        connectorInstanceId: 'cin_a',
        streams: [{ stream: `stream_${i}`, collected: 1, checkpoint: 'committed' }],
      });
    }

    // Round 1: bounded to 2 events, genuinely incomplete (5 total exist).
    const round1 = await foldConnectorSummaryStreamFacts(['cin_a'], { maxEvents: 2 });
    assert.equal(round1.incomplete, true);
    assert.equal(round1.resumeAfterSeq, 2, 'round 1 processed AT MOST its own 2-event budget');
    const afterRound1 = evidenceRow('cin_a');
    assert.equal(afterRound1.terminal_facts_state, 'stale', 'round 1 must not read current');
    assert.equal(afterRound1.terminal_facts_reason_code, 'terminal_fold_incomplete');
    const factsAfterRound1 = JSON.parse(afterRound1.stream_latest_facts_json);
    assert.equal(Object.keys(factsAfterRound1).length, 2, 'round 1 folded exactly 2 events');

    // Round 2: another bounded call, same scope — RESUMES from round 1's
    // checkpoint (does not restart), accumulating rather than losing round
    // 1's progress. Bounded to 2 more events -> still incomplete (2+2=4 < 5).
    const round2 = await foldConnectorSummaryStreamFacts(['cin_a'], { maxEvents: 2 });
    assert.equal(round2.incomplete, true, 'still short of the full 5-event history');
    assert.equal(round2.resumeAfterSeq, 4, 'round 2 resumed from 2, not restarted from 0');
    const afterRound2 = evidenceRow('cin_a');
    assert.equal(afterRound2.terminal_facts_state, 'stale', 'round 2 (still incomplete) must also not read current');
    const factsAfterRound2 = JSON.parse(afterRound2.stream_latest_facts_json);
    assert.equal(Object.keys(factsAfterRound2).length, 4, 'round 2 ACCUMULATED on top of round 1 (2 + 2 = 4), not restarted from 0');
    assert.ok(
      Object.keys(factsAfterRound1).every((k) => Object.keys(factsAfterRound2).includes(k)),
      'every stream round 1 folded is still present after round 2 — genuine accumulation, not a restart',
    );

    // Round 3: unbounded — genuinely converges (reaches the full 5-event
    // history) and only THEN may read current.
    const round3 = await foldConnectorSummaryStreamFacts(['cin_a']);
    assert.equal(round3.incomplete, false, 'round 3 genuinely reaches the full history');
    const afterRound3 = evidenceRow('cin_a');
    assert.equal(afterRound3.terminal_facts_state, 'current', 'only the genuinely converged final round may read current');
    assert.equal(afterRound3.terminal_facts_reason_code, null);
    const factsAfterRound3 = JSON.parse(afterRound3.stream_latest_facts_json);
    assert.equal(Object.keys(factsAfterRound3).length, 5, 'all 5 streams present after full convergence');

    const evidence = await getConnectorSummaryEvidence('cin_a');
    assert.equal(evidence.terminal_facts.state, 'current');
    assert.equal(Object.keys(factsFor(evidence)).length, 5);
  });
});

// ─── 4. Exact-boundary convergence: budget exactly covers the last event ──

test('exact-boundary convergence: a maxEvents budget that exactly equals the remaining history still reads current, not falsely incomplete', async () => {
  await withTempDb(async () => {
    seedInstance('cin_a', 'gmail');
    await rebuildConnectorSummaryEvidence();
    for (let i = 0; i < 3; i += 1) {
      seedTerminalEvent({
        runId: `run_${i}`,
        connectorInstanceId: 'cin_a',
        streams: [{ stream: `stream_${i}`, collected: 1, checkpoint: 'committed' }],
      });
    }

    // maxEvents exactly equals the total event count (3): the capped batch
    // read requests exactly 3 (min(STREAM_FACTS_FOLD_BATCH, 3-0)), gets
    // back exactly 3, and `batch.length < limit` (3 < 3) is false so the
    // loop continues to a SECOND iteration — where `cursor >= maxSeq` must
    // fire FIRST, before the budget check, so this reads as genuinely
    // converged rather than budget-exhausted.
    const result = await foldConnectorSummaryStreamFacts(['cin_a'], { maxEvents: 3 });
    assert.equal(result.incomplete, false, 'a pass whose cursor lands exactly on maxSeq is genuinely converged, not budget-exhausted');
    assert.equal(result.resumeAfterSeq, null);

    const row = evidenceRow('cin_a');
    assert.equal(row.terminal_facts_state, 'current', 'exact-boundary convergence must read current, not falsely stale');
    assert.equal(row.terminal_facts_reason_code, null);
    assert.equal(Number(row.stream_facts_event_seq), 3);
    const facts = JSON.parse(row.stream_latest_facts_json);
    assert.equal(Object.keys(facts).length, 3, 'all 3 streams genuinely folded');
  });
});

// ─── 6. Future-version row: fail-closed at read time, durable row untouched ─

test('future-version row: this binary fails it closed at READ time only — the durable row is byte-for-byte unchanged, and a compatible reader still sees it current', async () => {
  await withTempDb(async () => {
    seedInstance('cin_a', 'gmail');
    await rebuildConnectorSummaryEvidence();
    seedTerminalEvent({
      runId: 'run_1',
      connectorInstanceId: 'cin_a',
      streams: [{ stream: 'messages', collected: 1, checkpoint: 'committed' }],
    });

    // Simulate a row already folded by a NEWER binary: version 99 (this
    // binary's own STREAM_FACTS_FOLD_LOGIC_VERSION is 3), genuinely
    // current, with real facts.
    const FUTURE_FACTS = {
      messages: { fact: { stream: 'messages', collected: 42, checkpoint: 'committed' }, run_id: 'future_run', event_seq: 1, evidence_as_of: null },
    };
    getDb()
      .prepare(
        `UPDATE connector_summary_evidence
            SET stream_latest_facts_json = ?, stream_facts_event_seq = 1, stream_facts_fold_version = 99,
                terminal_facts_state = 'current', terminal_facts_reason_code = NULL, dirty = 0, state = 'fresh'
          WHERE connector_instance_id = ?`,
      )
      .run(JSON.stringify(FUTURE_FACTS), 'cin_a');

    const beforeRow = evidenceRow('cin_a');
    assert.equal(Number(beforeRow.stream_facts_fold_version), 99, 'premise: the row is genuinely future-version');
    assert.equal(beforeRow.terminal_facts_state, 'current', 'premise: the newer binary left it genuinely current');

    // This (older, version-3) binary runs an ordinary fold pass over this
    // scope. It must NOT fold, replay, or durably mutate this row in any
    // way — not even to mark it unreliable.
    const result = await foldConnectorSummaryStreamFacts(['cin_a']);
    assert.equal(result.participants, 0, "the future-version row never participates in this binary's fold");

    const afterRow = evidenceRow('cin_a');
    assert.deepEqual(
      afterRow,
      beforeRow,
      "the durable row is BYTE-FOR-BYTE unchanged by this older binary's fold pass — no durable poisoning of newer-owned state",
    );

    // THIS binary's own read-time view (shapeEvidenceRow, via
    // getConnectorSummaryEvidence) fails the row closed in memory only —
    // it must present unreliable terminal facts to ITS OWN callers without
    // ever having touched the stored row.
    const evidence = await getConnectorSummaryEvidence('cin_a');
    assert.equal(evidence.terminal_facts.state, 'stale', 'this (older) binary reads the future-version row as unreliable for its OWN observation');
    assert.equal(evidence.terminal_facts.reason_code, 'fold_logic_version_incompatible_future');

    // The durable row is STILL genuinely current underneath — a
    // newer-compatible reader (the binary that wrote it, or any future
    // binary at version >= 99) reads it exactly as stored, completely
    // unaffected by this older binary's fail-closed observation.
    const rawRowAfterRead = evidenceRow('cin_a');
    assert.equal(rawRowAfterRead.terminal_facts_state, 'current', 'the STORED state is untouched — still current for a compatible reader');
    assert.equal(rawRowAfterRead.terminal_facts_reason_code, null);
    assert.deepEqual(rawRowAfterRead, beforeRow, 'reading through this older binary left literally zero durable trace');
  });
});

test("future-version row: a rollback-then-forward-return sequence never durably regresses the row, and the newer binary's later write still lands", async () => {
  await withTempDb(async () => {
    seedInstance('cin_a', 'gmail');
    await rebuildConnectorSummaryEvidence();
    seedTerminalEvent({
      runId: 'run_1',
      connectorInstanceId: 'cin_a',
      streams: [{ stream: 'messages', collected: 1, checkpoint: 'committed' }],
    });
    seedTerminalEvent({
      runId: 'run_2',
      connectorInstanceId: 'cin_a',
      streams: [{ stream: 'messages', collected: 2, checkpoint: 'committed' }],
    });

    // A newer binary (simulated: version 99) already folded this row
    // through its first event only (it hasn't seen the second event yet).
    const FUTURE_FACTS = {
      messages: { fact: { stream: 'messages', collected: 1, checkpoint: 'committed' }, run_id: 'run_1', event_seq: 1, evidence_as_of: null },
    };
    getDb()
      .prepare(
        `UPDATE connector_summary_evidence
            SET stream_latest_facts_json = ?, stream_facts_event_seq = 1, stream_facts_fold_version = 99,
                terminal_facts_state = 'current', terminal_facts_reason_code = NULL, dirty = 0, state = 'fresh'
          WHERE connector_instance_id = ?`,
      )
      .run(JSON.stringify(FUTURE_FACTS), 'cin_a');

    // ROLLBACK: an older (version-3) binary is now serving traffic and
    // runs several ordinary fold passes over this scope while "rolled
    // back" — none of them may touch the row.
    for (let i = 0; i < 3; i += 1) {
      const result = await foldConnectorSummaryStreamFacts(['cin_a']);
      assert.equal(result.participants, 0, `rollback pass ${i} must not participate`);
    }
    const afterRollback = evidenceRow('cin_a');
    assert.equal(Number(afterRollback.stream_facts_event_seq), 1, "still exactly the newer binary's own checkpoint");
    assert.equal(Number(afterRollback.stream_facts_fold_version), 99, "still exactly the newer binary's own version");
    assert.equal(afterRollback.terminal_facts_state, 'current', 'the durable row was never regressed to stale by the rolled-back older binary');

    // FORWARD RETURN: the durable state the rollback window left behind is
    // exactly the CAS baseline a real newer binary would resume from — its
    // own write for the second (still-unfolded) event would still land
    // cleanly against it.
    const rawRow = evidenceRow('cin_a');
    assert.equal(Number(rawRow.stream_facts_event_seq), 1, 'the rollback window left the CAS baseline a real newer-binary write would still match');
    assert.equal(Number(rawRow.stream_facts_fold_version), 99);
  });
});
