// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  streamPriority,
  buildStreamRollups,
  buildProgressEvidence,
} from '../runtime/connector-verdict-input.ts';

// Mutation-killing tests for the PURE per-stream rollup projection helpers in
// `connector-verdict-input.ts`. These map the Collection Report + manifest
// streams + connection health axes onto the synthesizer's per-stream rollups —
// the "worst-wins by priority" input to the connector verdict. The verdict-level
// tests exercise synthesizeConnectorVerdict/progressMode, but streamPriority,
// buildStreamRollups, and buildProgressEvidence have NO direct coverage, so
// their branch logic (priority weighting, unknown→null coercion, retryable
// derivation, the complete-connection gap demotion, attention attribution) is
// otherwise unguarded. checkJs is off, so minimal duck-typed fixtures suffice —
// the helpers read only the fields asserted here. Pure — no DB.

/** A minimal health snapshot: the rollup reads only `axes.attention`/`axes.coverage`. */
function snap(axes = {}) {
  return { axes: { attention: 'none', coverage: 'complete', ...axes } };
}

/** A collection-report entry with honest defaults. */
function entry(over = {}) {
  return {
    stream: 's1',
    collected: 10,
    considered: 10,
    coverage_condition: 'complete',
    pending_detail_gaps: 0,
    ...over,
  };
}

// --------------------------------------------------------------------------
// streamPriority — the manifest-weight branch table
// --------------------------------------------------------------------------

test('streamPriority: undefined stream is treated as required', () => {
  assert.equal(streamPriority(undefined), 'required');
});

test('streamPriority: required defaults to true when absent; only required===false opts out', () => {
  assert.equal(streamPriority({ name: 's' }), 'required', 'absent required → required');
  assert.equal(streamPriority({ name: 's', required: true }), 'required');
  // required:false with no accepted policy → optional.
  assert.equal(streamPriority({ name: 's', required: false }), 'optional');
});

test('streamPriority: non-required stream with an accepted (non-collect) policy is accepted_absence', () => {
  assert.equal(
    streamPriority({ name: 's', required: false, coverage_policy: 'inventory_only' }),
    'accepted_absence'
  );
  assert.equal(
    streamPriority({ name: 's', required: false, coverage_policy: 'unsupported' }),
    'accepted_absence'
  );
  // A "collect" policy is NOT accepted-absence — it is a real collection stream.
  assert.equal(
    streamPriority({ name: 's', required: false, coverage_policy: 'collect' }),
    'optional'
  );
});

test('streamPriority: a required stream that ALSO declares an accepted policy stays required (contradiction resolves to required)', () => {
  // required wins so the stream cannot annotate away its own gap.
  assert.equal(
    streamPriority({ name: 's', required: true, coverage_policy: 'unavailable' }),
    'required'
  );
});

// --------------------------------------------------------------------------
// buildStreamRollups — considered coercion, retryable, attention, gap demotion
// --------------------------------------------------------------------------

test('buildStreamRollups: considered "unknown" becomes null; a number passes through', () => {
  const rows = buildStreamRollups(
    [entry({ considered: 'unknown' }), entry({ stream: 's2', considered: 42 })],
    [],
    snap()
  );
  assert.equal(rows[0].considered, null, 'unknown → null');
  assert.equal(rows[1].considered, 42, 'a real denominator is preserved');
});

test('buildStreamRollups: gap_retryable is true for a retryable axis OR any pending detail gaps', () => {
  // retryable coverage axis.
  const retryAxis = buildStreamRollups([entry({ coverage_condition: 'retryable_gap' })], [], snap());
  assert.equal(retryAxis[0].gap_retryable, true);
  // pending detail gaps alone, on an otherwise non-retryable axis.
  const pending = buildStreamRollups(
    [entry({ coverage_condition: 'terminal_gap', pending_detail_gaps: 2 })],
    [],
    snap({ coverage: 'gaps' })
  );
  assert.equal(pending[0].gap_retryable, true, 'pending detail gaps make it retryable');
  // neither: complete axis, no pending → not retryable.
  const clean = buildStreamRollups([entry()], [], snap());
  assert.equal(clean[0].gap_retryable, false);
});

test('buildStreamRollups: attention is attributed only to non-complete streams, and only when the axis is open', () => {
  // Attention open at the connection level; a complete stream must NOT inherit it.
  const withAttention = buildStreamRollups(
    [entry({ coverage_condition: 'complete' }), entry({ stream: 's2', coverage_condition: 'gaps' })],
    [],
    snap({ attention: 'action_required', coverage: 'gaps' })
  );
  assert.equal(withAttention[0].attention_open, false, 'complete stream never inherits attention');
  assert.equal(withAttention[1].attention_open, true, 'incomplete stream inherits the open attention');
  // Attention closed: even an incomplete stream is not flagged.
  const noAttention = buildStreamRollups(
    [entry({ coverage_condition: 'gaps' })],
    [],
    snap({ attention: 'none', coverage: 'gaps' })
  );
  assert.equal(noAttention[0].attention_open, false);
});

test('buildStreamRollups: a fresh complete connection demotes a required stream with a non-terminal report gap to optional', () => {
  // Connection coverage is complete, no pending gaps, but the stream's own
  // latest-run coverage is a benign non-terminal gap (`partial`) → demote to
  // optional so the complete/fresh connector is not turned amber by a per-run
  // denominator gap.
  const demoted = buildStreamRollups(
    [entry({ coverage_condition: 'partial', pending_detail_gaps: 0 })],
    [{ name: 's1', required: true }], // manifest says required...
    snap({ coverage: 'complete' })
  );
  assert.equal(demoted[0].priority, 'optional', '...but the complete-connection gap override demotes it');

  // A TERMINAL stream gap is load-bearing — the override must NOT demote it.
  const kept = buildStreamRollups(
    [entry({ coverage_condition: 'terminal_gap', pending_detail_gaps: 0 })],
    [{ name: 's1', required: true }],
    snap({ coverage: 'complete' })
  );
  assert.equal(kept[0].priority, 'required', 'terminal gap keeps its required weight');

  // If the CONNECTION coverage is not complete, the override does not fire even
  // for a non-terminal stream gap → required weight is preserved.
  const notComplete = buildStreamRollups(
    [entry({ coverage_condition: 'partial', pending_detail_gaps: 0 })],
    [{ name: 's1', required: true }],
    snap({ coverage: 'gaps' })
  );
  assert.equal(notComplete[0].priority, 'required');
});

test('buildStreamRollups: pending detail gaps block the complete-connection demotion', () => {
  // Same non-terminal stream gap, but pending_detail_gaps > 0 → the override's
  // `pending_detail_gaps === 0` clause fails, so the stream stays required.
  const rows = buildStreamRollups(
    [entry({ coverage_condition: 'partial', pending_detail_gaps: 1 })],
    [{ name: 's1', required: true }],
    snap({ coverage: 'complete' })
  );
  assert.equal(rows[0].priority, 'required');
  assert.equal(rows[0].gap_retryable, true, 'pending gaps also make it retryable');
});

test('buildStreamRollups: stream_id, collected, and coverage echo the report entry', () => {
  const rows = buildStreamRollups([entry({ stream: 'orders', collected: 7, coverage_condition: 'gaps' })], [], snap({ coverage: 'gaps' }));
  assert.equal(rows[0].stream_id, 'orders');
  assert.equal(rows[0].collected, 7);
  assert.equal(rows[0].coverage, 'gaps');
});

// --------------------------------------------------------------------------
// buildProgressEvidence — nullable pass-through + observed_at default
// --------------------------------------------------------------------------

test('buildProgressEvidence: passes every field through and defaults observed_at to null', () => {
  const ev = buildProgressEvidence({
    mode: 'scheduled',
    retainedRecords: 100,
    recordsCommittedLastRun: 5,
    gapsDrainedLastRun: 2,
    lastRefreshedAt: '2026-06-29T12:00:00.000Z',
  });
  assert.deepEqual(ev, {
    mode: 'scheduled',
    retained_records: 100,
    records_committed_last_run: 5,
    gaps_drained_last_run: 2,
    last_refreshed_at: '2026-06-29T12:00:00.000Z',
    observed_at: null,
  });
});

test('buildProgressEvidence: preserves an explicit observed_at and null facts (no fabrication)', () => {
  const ev = buildProgressEvidence({
    mode: 'deferred',
    retainedRecords: null,
    recordsCommittedLastRun: null,
    gapsDrainedLastRun: null,
    lastRefreshedAt: null,
    observedAt: '2026-07-01T00:00:00.000Z',
  });
  assert.equal(ev.observed_at, '2026-07-01T00:00:00.000Z');
  assert.equal(ev.retained_records, null);
  assert.equal(ev.records_committed_last_run, null);
  assert.equal(ev.mode, 'deferred');
});
