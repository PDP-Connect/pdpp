import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCollectionReport } from '../server/ref-control.ts';

// Pure unit tests for the Tranche C control-plane projection
// (`define-connector-progress-evidence-contract`, task 2.2b / 2.4 / 2.6).
//
// `buildCollectionReport` reads the runtime `collection_facts` block (objective
// per-stream facts: collected, considered-or-`unknown`, checkpoint, skip,
// pending-detail-gap count) and DERIVES, on read, each stream's coverage
// condition + forward disposition from those facts plus the connection-level
// freshness / attention / refresh evidence. The runtime stamped neither derived
// axis; this layer owns them.
//
// The single most important guarantee (2.4): a stream that collected records,
// recorded no gaps, and declared NO considered denominator reads `unknown` —
// NEVER `complete`. The exhaustive five-branch disposition logic is covered in
// `forward-disposition.test.js`; here we prove the per-stream coverage gate and
// the absence tolerances the projection must enforce before calling the helper.

/** A manual / paused / not-background-safe connection that cannot self-refresh. */
const MANUAL_REFRESH = Object.freeze({ backgroundSafe: false, recommendedMode: 'manual' });
/** A schedulable, background-safe connection the scheduler refreshes on its own. */
const SCHEDULABLE_REFRESH = Object.freeze({ backgroundSafe: true, recommendedMode: 'automatic' });

/** A runtime fact-block entry with honest defaults (no considered, no gaps, no skip). */
function fact(overrides = {}) {
  return {
    stream: 'transactions',
    collected: 0,
    considered: null,
    checkpoint: 'committed',
    pending_detail_gaps: 0,
    skipped: null,
    ...overrides,
  };
}

/** Default projection inputs: fresh, no attention, schedulable. */
function report(facts, overrides = {}) {
  return buildCollectionReport({
    collectionFacts: facts === null ? null : { streams: facts },
    manifestStreams: [],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
    ...overrides,
  });
}

/** Find the single entry for `stream` in a report (asserts presence). */
function entryFor(entries, stream) {
  const entry = entries.find((e) => e.stream === stream);
  assert.ok(entry, `expected a Collection Report entry for stream "${stream}"`);
  return entry;
}

// ─── 2.4 the honesty gate (the single most important assertion) ───────────────

test('collected records, no gaps, NO considered -> unknown coverage + resumable (never complete)', () => {
  const entries = report([fact({ stream: 'messages', collected: 1145, considered: null })]);
  const entry = entryFor(entries, 'messages');
  assert.equal(entry.considered, 'unknown');
  assert.equal(entry.collected, 1145);
  // The core dishonesty the contract removes: a clean succeeded run with no
  // considered denominator MUST NOT read `complete`.
  assert.equal(entry.coverage_condition, 'unknown');
  assert.equal(entry.forward_disposition, 'resumable');
});

// ─── considered known: satisfied -> complete, short -> partial ────────────────

test('considered satisfied (collected === considered), fresh -> complete / complete', () => {
  const entries = report([fact({ collected: 1145, considered: 1145 })]);
  const entry = entryFor(entries, 'transactions');
  assert.equal(entry.considered, 1145);
  assert.equal(entry.coverage_condition, 'complete');
  assert.equal(entry.forward_disposition, 'complete');
});

test('considered exceeds collected -> partial / resumable, considered recorded', () => {
  const entries = report([fact({ collected: 900, considered: 1145 })]);
  const entry = entryFor(entries, 'transactions');
  assert.equal(entry.considered, 1145);
  assert.equal(entry.coverage_condition, 'partial');
  assert.equal(entry.forward_disposition, 'resumable');
});

// ─── skip facts: never complete ───────────────────────────────────────────────

test('skip with retry_by_runtime recovery -> retryable_gap / resumable', () => {
  const entries = report([
    fact({ stream: 'dms', collected: 0, skipped: { reason: 'http_429', recovery_action: 'retry_by_runtime' } }),
  ]);
  const entry = entryFor(entries, 'dms');
  assert.notEqual(entry.coverage_condition, 'complete');
  assert.equal(entry.coverage_condition, 'retryable_gap');
  assert.equal(entry.forward_disposition, 'resumable');
  assert.deepEqual(entry.skipped, { reason: 'http_429', recovery_action: 'retry_by_runtime' });
});

test('skip out_of_scope -> deferred / complete (owes no further data)', () => {
  const entries = report([fact({ stream: 'drafts', collected: 0, skipped: { reason: 'out_of_scope' } })]);
  const entry = entryFor(entries, 'drafts');
  assert.equal(entry.coverage_condition, 'deferred');
  // `deferred` carries no outstanding gap -> complete disposition (fresh).
  assert.equal(entry.forward_disposition, 'complete');
});

test('skip unsupported -> unsupported / terminal', () => {
  const entries = report([fact({ stream: 'reactions', collected: 0, skipped: { reason: 'unsupported_in_mode' } })]);
  const entry = entryFor(entries, 'reactions');
  assert.equal(entry.coverage_condition, 'unsupported');
  assert.equal(entry.forward_disposition, 'terminal');
});

test('skip unavailable -> unavailable / terminal', () => {
  const entries = report([fact({ stream: 'archive', collected: 0, skipped: { reason: 'source_unavailable' } })]);
  const entry = entryFor(entries, 'archive');
  assert.equal(entry.coverage_condition, 'unavailable');
  assert.equal(entry.forward_disposition, 'terminal');
});

test('skip with no recovery path -> terminal_gap / terminal', () => {
  const entries = report([fact({ stream: 'weird', collected: 0, skipped: { reason: 'connector_panicked' } })]);
  const entry = entryFor(entries, 'weird');
  assert.equal(entry.coverage_condition, 'terminal_gap');
  assert.equal(entry.forward_disposition, 'terminal');
});

// ─── detail gap ────────────────────────────────────────────────────────────────

test('pending detail gap -> retryable_gap / resumable, count preserved', () => {
  const entries = report([fact({ collected: 1000, considered: 1145, pending_detail_gaps: 3 })]);
  const entry = entryFor(entries, 'transactions');
  assert.equal(entry.coverage_condition, 'retryable_gap');
  assert.equal(entry.pending_detail_gaps, 3);
  assert.equal(entry.forward_disposition, 'resumable');
});

test('detail gap takes precedence over a satisfied considered denominator', () => {
  // Even with collected >= considered, a pending recoverable gap means the
  // stream is not yet fully covered.
  const entries = report([fact({ collected: 1145, considered: 1145, pending_detail_gaps: 1 })]);
  const entry = entryFor(entries, 'transactions');
  assert.equal(entry.coverage_condition, 'retryable_gap');
});

// ─── the manual-refresh freshness seam, re-proven at stream scope ─────────────

test('complete + stale + manual-refresh -> owner_refresh_due (coverage stays complete)', () => {
  const entries = report([fact({ collected: 1145, considered: 1145 })], {
    freshness: 'stale',
    refresh: MANUAL_REFRESH,
  });
  const entry = entryFor(entries, 'transactions');
  // Coverage stays complete; only the disposition carries the freshness fact.
  assert.equal(entry.coverage_condition, 'complete');
  assert.equal(entry.forward_disposition, 'owner_refresh_due');
});

test('complete + stale + schedulable -> complete (scheduler owns it, not owner)', () => {
  const entries = report([fact({ collected: 1145, considered: 1145 })], {
    freshness: 'stale',
    refresh: SCHEDULABLE_REFRESH,
  });
  const entry = entryFor(entries, 'transactions');
  assert.equal(entry.coverage_condition, 'complete');
  assert.notEqual(entry.forward_disposition, 'owner_refresh_due');
  assert.equal(entry.forward_disposition, 'complete');
});

test('retryable_gap + stale + manual-refresh -> resumable (gap not masked by staleness)', () => {
  const entries = report([fact({ collected: 1000, considered: 1145, pending_detail_gaps: 2 })], {
    freshness: 'stale',
    refresh: MANUAL_REFRESH,
  });
  const entry = entryFor(entries, 'transactions');
  assert.equal(entry.coverage_condition, 'retryable_gap');
  assert.equal(entry.pending_detail_gaps, 2);
  // Gaps are evaluated before freshness, so the resumable path stays visible.
  assert.equal(entry.forward_disposition, 'resumable');
});

// ─── attention ─────────────────────────────────────────────────────────────────

test('outstanding gap + open attention -> awaiting_owner', () => {
  const entries = report([fact({ collected: 900, considered: 1145 })], { attentionOpen: true });
  const entry = entryFor(entries, 'transactions');
  assert.equal(entry.coverage_condition, 'partial');
  assert.equal(entry.forward_disposition, 'awaiting_owner');
});

test('open attention does NOT taint a stream with no gap (complete stays complete)', () => {
  const entries = report([fact({ collected: 1145, considered: 1145 })], { attentionOpen: true });
  const entry = entryFor(entries, 'transactions');
  assert.equal(entry.forward_disposition, 'complete');
});

// ─── 2.6 portable RECORD/STATE/DONE-only connector ────────────────────────────

test('portable RECORD/STATE/DONE-only stream (no considered, no gaps, no skip) -> unknown / resumable', () => {
  // The portability floor: a connector that emits only RECORD/STATE/DONE
  // declares no DETAIL_COVERAGE, no considered, and no SKIP_RESULT. Its entry
  // must be a VALID report with `unknown` axes — not an error, not `complete`.
  const entries = report([fact({ stream: 'posts', collected: 500, considered: null, checkpoint: 'committed' })]);
  const entry = entryFor(entries, 'posts');
  assert.equal(entry.considered, 'unknown');
  assert.equal(entry.coverage_condition, 'unknown');
  assert.equal(entry.forward_disposition, 'resumable');
  assert.equal(entry.checkpoint, 'committed');
});

// ─── manifest accepted-coverage policy folds in ───────────────────────────────

test('manifest inventory_only stream with satisfied considered -> inventory_only, not complete', () => {
  const entries = buildCollectionReport({
    collectionFacts: { streams: [fact({ stream: 'catalog', collected: 10, considered: 10 })] },
    manifestStreams: [{ name: 'catalog', coverage_policy: 'inventory_only', required: false }],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const entry = entryFor(entries, 'catalog');
  assert.equal(entry.coverage_condition, 'inventory_only');
  // inventory_only owes no further data -> complete disposition.
  assert.equal(entry.forward_disposition, 'complete');
});

test('contradictory manifest (required + unsupported) -> unsupported / terminal, never green', () => {
  const entries = buildCollectionReport({
    collectionFacts: { streams: [fact({ stream: 'messages', collected: 5, considered: 5 })] },
    manifestStreams: [{ name: 'messages', coverage_policy: 'unsupported', required: true }],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const entry = entryFor(entries, 'messages');
  // A required stream that also declares accepted-absent must never paint green
  // even when collected satisfies a considered denominator.
  assert.equal(entry.coverage_condition, 'unsupported');
  assert.equal(entry.forward_disposition, 'terminal');
});

// ─── absence tolerances (§3.2) ────────────────────────────────────────────────

test('no fact block -> one unknown entry per manifest stream (never dropped, never complete)', () => {
  const entries = buildCollectionReport({
    collectionFacts: null,
    manifestStreams: [{ name: 'a' }, { name: 'b' }],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  assert.equal(entries.length, 2);
  for (const name of ['a', 'b']) {
    const entry = entryFor(entries, name);
    assert.equal(entry.considered, 'unknown');
    assert.equal(entry.coverage_condition, 'unknown');
    assert.equal(entry.collected, 0);
    assert.equal(entry.checkpoint, 'unknown');
    assert.notEqual(entry.coverage_condition, 'complete');
  }
});

test('manifest stream missing from fact block -> honest zero entry, in-scope universe is union', () => {
  const entries = buildCollectionReport({
    collectionFacts: { streams: [fact({ stream: 'reported', collected: 7, considered: 7 })] },
    manifestStreams: [{ name: 'reported' }, { name: 'unreported' }],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  assert.equal(entries.length, 2);
  const reported = entryFor(entries, 'reported');
  assert.equal(reported.coverage_condition, 'complete');
  const unreported = entryFor(entries, 'unreported');
  assert.equal(unreported.collected, 0);
  assert.equal(unreported.considered, 'unknown');
  assert.equal(unreported.coverage_condition, 'unknown');
});

test('fact-only stream not in manifest is still reported (union, not manifest-only)', () => {
  const entries = buildCollectionReport({
    collectionFacts: { streams: [fact({ stream: 'extra', collected: 3, considered: null })] },
    manifestStreams: [],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  assert.equal(entries.length, 1);
  assert.equal(entryFor(entries, 'extra').coverage_condition, 'unknown');
});

test('malformed considered (handled upstream as null) reads unknown, never fabricates complete', () => {
  // The reader normalizes a malformed `considered` to null before this layer; a
  // null considered must read `unknown` regardless of collected count.
  const entries = report([fact({ stream: 'x', collected: 99, considered: null })]);
  const entry = entryFor(entries, 'x');
  assert.equal(entry.considered, 'unknown');
  assert.equal(entry.coverage_condition, 'unknown');
});

test('empty in-scope universe -> empty report (no invented entries)', () => {
  const entries = buildCollectionReport({
    collectionFacts: null,
    manifestStreams: [],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  assert.deepEqual(entries, []);
});

// ─── entries are deterministically ordered ────────────────────────────────────

test('entries are sorted by stream name (stable owner-facing order)', () => {
  const entries = report([
    fact({ stream: 'zeta', collected: 1, considered: 1 }),
    fact({ stream: 'alpha', collected: 1, considered: 1 }),
    fact({ stream: 'mu', collected: 1, considered: 1 }),
  ]);
  assert.deepEqual(
    entries.map((e) => e.stream),
    ['alpha', 'mu', 'zeta']
  );
});
