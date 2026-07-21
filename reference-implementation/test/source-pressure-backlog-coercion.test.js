import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveSourcePressureBacklog } from '../runtime/connection-health.ts';

// Mutation-killing complement for the source-pressure backlog rollup's numeric
// COERCION and GUARD edges. The existing suite covers the pending/other split,
// floor flags, and next_attempt latest-pick. This file isolates the honesty
// guards that individual mutations slip through:
//
//   - recovered / terminal: a valid non-negative number is floored through;
//     a negative or non-finite value degrades to null (never a fabricated 0).
//   - max_attempt_count: negative / non-finite / fractional attemptCount inputs
//     are ignored or floored, so a malformed gap can't inflate the max.
//   - next_attempt_at: malformed timestamps (empty, non-string, unparseable) are
//     skipped while the latest VALID floor still wins.
//
// deriveSourcePressureBacklog is a pure projection — no DB.

/** A source-pressure pending gap. */
function gap(over = {}) {
  return { reason: 'upstream_pressure', attemptCount: 0, nextAttemptAfter: null, ...over };
}

function evidence(over = {}) {
  return { pendingGaps: [], unreadable: false, ...over };
}

// --------------------------------------------------------------------------
// recovered / terminal coercion
// --------------------------------------------------------------------------

test('recovered/terminal: valid non-negative numbers pass through, floored', () => {
  const r = deriveSourcePressureBacklog(evidence({ pendingGaps: [gap()], recovered: 5, terminal: 2.9 }));
  assert.equal(r.recovered, 5);
  assert.equal(r.terminal, 2, 'terminal is floored, not rounded');
});

test('recovered/terminal: negative or non-finite values degrade to null (no fabricated zero)', () => {
  const neg = deriveSourcePressureBacklog(evidence({ pendingGaps: [gap()], recovered: -1, terminal: -3 }));
  assert.equal(neg.recovered, null, 'a negative recovered is null, not clamped to 0');
  assert.equal(neg.terminal, null);

  const inf = deriveSourcePressureBacklog(
    evidence({ pendingGaps: [gap()], recovered: Number.POSITIVE_INFINITY, terminal: Number.NaN })
  );
  assert.equal(inf.recovered, null);
  assert.equal(inf.terminal, null);
});

test('recovered/terminal: a plain zero is a real 0 (distinct from absent → null)', () => {
  const zero = deriveSourcePressureBacklog(evidence({ pendingGaps: [gap()], recovered: 0, terminal: 0 }));
  assert.equal(zero.recovered, 0);
  assert.equal(zero.terminal, 0);
  const absent = deriveSourcePressureBacklog(evidence({ pendingGaps: [gap()] }));
  assert.equal(absent.recovered, null, 'absent recovered → null, not 0');
  assert.equal(absent.terminal, null);
});

// --------------------------------------------------------------------------
// max_attempt_count guards
// --------------------------------------------------------------------------

test('max_attempt_count: ignores negative and non-finite attempt counts, floors fractional', () => {
  const r = deriveSourcePressureBacklog(
    evidence({
      pendingGaps: [
        gap({ attemptCount: -5 }), // negative → ignored
        gap({ attemptCount: Number.POSITIVE_INFINITY }), // non-finite → ignored
        gap({ attemptCount: 3.9 }), // fractional → floored to 3
        gap({ attemptCount: 2 }),
      ],
    })
  );
  assert.equal(r.max_attempt_count, 3, 'floored fractional 3.9 wins; malformed gaps ignored');
});

test('max_attempt_count: all-malformed attempt counts yield 0, not a negative or NaN', () => {
  const r = deriveSourcePressureBacklog(
    evidence({ pendingGaps: [gap({ attemptCount: -1 }), gap({ attemptCount: Number.NaN })] })
  );
  assert.equal(r.max_attempt_count, 0);
  // These still count toward `pending` — the malformed attempt count does not
  // disqualify the gap itself, only its contribution to the max.
  assert.equal(r.pending, 2);
});

// --------------------------------------------------------------------------
// next_attempt_at malformed-timestamp skipping
// --------------------------------------------------------------------------

test('next_attempt_at: skips empty/non-string/unparseable timestamps, keeps the latest valid one', () => {
  const r = deriveSourcePressureBacklog(
    evidence({
      pendingGaps: [
        gap({ nextAttemptAfter: '' }), // empty → skipped
        gap({ nextAttemptAfter: 'not-a-date' }), // unparseable → skipped
        gap({ nextAttemptAfter: '2026-05-19T10:00:00.000Z' }),
        gap({ nextAttemptAfter: '2026-05-19T15:30:00.000Z' }), // latest valid → wins
        gap({ nextAttemptAfter: '2026-05-19T12:00:00.000Z' }),
      ],
    })
  );
  assert.equal(r.next_attempt_at, '2026-05-19T15:30:00.000Z');
});

test('next_attempt_at: only-malformed timestamps yield null (no fabricated floor)', () => {
  const r = deriveSourcePressureBacklog(
    evidence({ pendingGaps: [gap({ nextAttemptAfter: 'garbage' }), gap({ nextAttemptAfter: '' })] })
  );
  assert.equal(r.next_attempt_at, null);
});

test('next_attempt_at: a non-source-pressure gap does not contribute its floor', () => {
  // A non-pressure gap with a LATER timestamp must be reason-filtered out before
  // the next_attempt max, so the pressure gap's earlier floor wins.
  const r = deriveSourcePressureBacklog(
    evidence({
      pendingGaps: [
        gap({ reason: 'schema_validation_failed', nextAttemptAfter: '2026-05-19T23:00:00.000Z' }),
        gap({ reason: 'rate_limited', nextAttemptAfter: '2026-05-19T09:00:00.000Z' }),
      ],
    })
  );
  assert.equal(r.next_attempt_at, '2026-05-19T09:00:00.000Z', 'only source-pressure gaps drive next_attempt_at');
  assert.equal(r.pending, 1, 'only the rate_limited gap counts as pending pressure');
  assert.equal(r.pending_other, 1);
});
