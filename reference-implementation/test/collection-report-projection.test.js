import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCollectionReport, projectCollectionReport } from '../server/ref-control.ts';

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
    covered: null,
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

test('collected records, no gaps, NO considered -> unknown coverage + unmeasured (never complete)', () => {
  const entries = report([fact({ stream: 'messages', collected: 1145, considered: null })]);
  const entry = entryFor(entries, 'messages');
  assert.equal(entry.considered, 'unknown');
  assert.equal(entry.collected, 1145);
  // The core dishonesty the contract removes: a clean succeeded run with no
  // considered denominator MUST NOT read `complete`.
  assert.equal(entry.coverage_condition, 'unknown');
  assert.equal(entry.forward_disposition, 'unmeasured');
});

test('declared checkpoint-window strategy with committed checkpoint proves coverage without numeric denominator', () => {
  const entries = buildCollectionReport({
    collectionFacts: { streams: [fact({ stream: 'messages', collected: 1145, considered: null, checkpoint: 'committed' })] },
    manifestStreams: [{ name: 'messages', coverage_strategy: 'checkpoint_window', freshness_strategy: 'scheduled_window' }],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const entry = entryFor(entries, 'messages');
  assert.equal(entry.considered, 'unknown');
  assert.equal(entry.coverage_strategy, 'checkpoint_window');
  assert.equal(entry.freshness_strategy, 'scheduled_window');
  assert.equal(entry.coverage_condition, 'complete');
  assert.equal(entry.forward_disposition, 'complete');
});

test('declared coverage strategy without committed boundary does not fabricate completeness', () => {
  const entries = buildCollectionReport({
    collectionFacts: { streams: [fact({ stream: 'messages', collected: 1145, considered: null, checkpoint: 'not_staged' })] },
    manifestStreams: [{ name: 'messages', coverage_strategy: 'checkpoint_window', freshness_strategy: 'scheduled_window' }],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const entry = entryFor(entries, 'messages');
  assert.equal(entry.coverage_strategy, 'checkpoint_window');
  assert.equal(entry.coverage_condition, 'unknown');
  assert.equal(entry.forward_disposition, 'unmeasured');
});

test('owner-cancelled latest run reuses prior successful facts for stream coverage', () => {
  const cancelledRun = {
    event_count: 2,
    failure_reason: null,
    finished_at: '2026-05-19T12:10:00.000Z',
    first_at: '2026-05-19T12:09:00.000Z',
    known_gaps: [],
    last_at: '2026-05-19T12:10:00.000Z',
    run_id: 'run_owner_cancelled',
    started_at: '2026-05-19T12:09:00.000Z',
    status: 'cancelled',
    terminal_reason: 'owner_cancelled',
  };
  const successfulRun = {
    event_count: 3,
    failure_reason: null,
    finished_at: '2026-05-19T12:00:00.000Z',
    first_at: '2026-05-19T11:59:00.000Z',
    known_gaps: [],
    last_at: '2026-05-19T12:00:00.000Z',
    run_id: 'run_success',
    started_at: '2026-05-19T11:59:00.000Z',
    status: 'succeeded',
    collection_facts: {
      streams: [fact({ stream: 'messages', collected: 0, considered: 1125, covered: 1125 })],
    },
  };
  const entries = projectCollectionReport({
    lastRun: cancelledRun,
    lastSuccessfulRun: successfulRun,
    connectionHealth: { axes: { attention: 'none', freshness: 'fresh' } },
    manifestStreams: [{ name: 'messages', coverage_strategy: 'checkpoint_window', freshness_strategy: 'scheduled_window' }],
    refreshPolicy: null,
  });
  const entry = entryFor(entries, 'messages');

  assert.equal(entry.coverage_condition, 'complete');
  assert.equal(entry.considered, 1125);
  assert.equal(entry.covered, 1125);
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

// ─── 4.4 the covered numerator: steady-state full-sync reads complete ─────────
//
// A fingerprint-suppressed full-sync stream enumerates its whole boundary and
// suppresses unchanged records, so `collected` is a churn-reduced subset. When it
// declares a `covered` count (emitted + suppressed-unchanged), the gate compares
// `considered` against `covered`, NOT `collected`. This is the steady-state fix:
// a run that emitted 0 but accounted for the whole inventory reads `complete`,
// not a false `partial`. A real drop (covered < considered) still reads `partial`.

test('4.4 steady-state: collected 0 but covered === considered -> complete (NOT a false partial)', () => {
  // The exact shape a steady-state fingerprint full-sync run produces: it
  // re-enumerated all 1145 rows, emitted none (all unchanged), and accounted for
  // every one as suppressed-unchanged.
  const entries = report([fact({ collected: 0, considered: 1145, covered: 1145 })]);
  const entry = entryFor(entries, 'transactions');
  assert.equal(entry.considered, 1145);
  assert.equal(entry.covered, 1145);
  assert.equal(entry.collected, 0);
  // Without the covered numerator the gate would compare considered(1145) against
  // collected(0) and read a false `partial`. With it, the run is `complete`.
  assert.equal(entry.coverage_condition, 'complete');
  assert.equal(entry.forward_disposition, 'complete');
});

test('4.4 one-changed: collected 1, covered === considered -> complete', () => {
  const entries = report([fact({ collected: 1, considered: 1145, covered: 1145 })]);
  const entry = entryFor(entries, 'transactions');
  assert.equal(entry.covered, 1145);
  assert.equal(entry.coverage_condition, 'complete');
});

test('4.4 dropped row: covered < considered -> partial (a weighed-but-dropped item still shows the shortfall)', () => {
  // The guardrail: a covered count never masks a dropped record. Here the run
  // enumerated 1145 but accounted for only 1144 (one weighed row dropped before
  // it could be emitted or suppressed). collected(0) is irrelevant — the gate
  // reads covered(1144) < considered(1145) and refuses `complete`.
  const entries = report([fact({ collected: 0, considered: 1145, covered: 1144 })]);
  const entry = entryFor(entries, 'transactions');
  assert.equal(entry.considered, 1145);
  assert.equal(entry.covered, 1144);
  assert.equal(entry.coverage_condition, 'partial');
  assert.equal(entry.forward_disposition, 'resumable');
});

test('4.4 covered absent -> gate falls back to collected (prior behavior byte-unchanged)', () => {
  // A declarer that emits NO covered count (every shipped 4.1/4.2 declarer) must
  // behave exactly as before: considered vs collected. covered: null means the
  // gate ignores it entirely.
  const satisfied = report([fact({ collected: 1145, considered: 1145, covered: null })]);
  assert.equal(entryFor(satisfied, 'transactions').coverage_condition, 'complete');
  assert.equal(entryFor(satisfied, 'transactions').covered, 'unknown');

  const short = report([fact({ collected: 900, considered: 1145, covered: null })]);
  assert.equal(entryFor(short, 'transactions').coverage_condition, 'partial');
});

test('4.4 covered satisfies considered while collected is below it -> complete (covered, not collected, is the numerator)', () => {
  // Explicitly pin that the gate prefers covered over collected when both are
  // present and they disagree: collected(500) < considered(1000) would be
  // `partial` on the old path, but covered(1000) === considered → complete.
  const entries = report([fact({ collected: 500, considered: 1000, covered: 1000 })]);
  const entry = entryFor(entries, 'transactions');
  assert.equal(entry.coverage_condition, 'complete');
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

test('pending detail gap overrides same-stream terminal-looking skip diagnostic', () => {
  const entries = report([
    fact({
      stream: 'transactions',
      collected: 100,
      considered: 101,
      pending_detail_gaps: 1,
      skipped: { reason: 'qfx_download_failed' },
    }),
  ]);
  const entry = entryFor(entries, 'transactions');
  assert.equal(entry.coverage_condition, 'retryable_gap');
  assert.equal(entry.forward_disposition, 'resumable');
  assert.equal(entry.pending_detail_gaps, 1);
});

// ─── detail gap ────────────────────────────────────────────────────────────────

test('pending detail gap -> retryable_gap / resumable, count preserved', () => {
  const entries = report([fact({ collected: 1000, considered: 1145, pending_detail_gaps: 3 })]);
  const entry = entryFor(entries, 'transactions');
  assert.equal(entry.coverage_condition, 'retryable_gap');
  assert.equal(entry.pending_detail_gaps, 3);
  assert.equal(entry.forward_disposition, 'resumable');
});

test('current pending detail gap without a terminal fact block is visible on its stream', () => {
  const entries = report(null, {
    manifestStreams: [{ name: 'accounts' }, { name: 'transactions' }],
    pendingDetailGaps: [{ reason: 'temporary_unavailable', status: 'pending', stream: 'transactions' }],
    freshness: 'unknown',
  });
  const accounts = entryFor(entries, 'accounts');
  const transactions = entryFor(entries, 'transactions');

  assert.equal(accounts.coverage_condition, 'unknown');
  assert.equal(accounts.forward_disposition, 'unmeasured');
  assert.equal(transactions.coverage_condition, 'retryable_gap');
  assert.equal(transactions.pending_detail_gaps, 1);
  assert.equal(transactions.forward_disposition, 'resumable');
});

test('terminal detail gap without a denominator is visible on its stream', () => {
  const entries = report([fact({ stream: 'order_items', collected: 272, considered: null, checkpoint: 'not_staged' })], {
    manifestStreams: [{ name: 'orders' }, { name: 'order_items' }],
    terminalDetailGapsByStream: new Map([['order_items', 33]]),
  });
  const orders = entryFor(entries, 'orders');
  const orderItems = entryFor(entries, 'order_items');

  assert.equal(orders.coverage_condition, 'unknown');
  assert.equal(orderItems.collected, 272);
  assert.equal(orderItems.considered, 'unknown');
  assert.equal(orderItems.coverage_condition, 'terminal_gap');
  assert.equal(orderItems.forward_disposition, 'terminal');
});

test('current pending detail gap raises an old zero-gap fact', () => {
  const entries = report([fact({ pending_detail_gaps: 0 })], {
    pendingDetailGaps: [{ reason: 'temporary_unavailable', status: 'pending', stream: 'transactions' }],
  });
  const entry = entryFor(entries, 'transactions');

  assert.equal(entry.coverage_condition, 'retryable_gap');
  assert.equal(entry.pending_detail_gaps, 1);
  assert.equal(entry.pending_detail_gaps_is_floor, false);
});

test('bounded pending detail-gap reads mark stream counts as floors when the limit is hit', () => {
  const entries = report(null, {
    manifestStreams: [{ name: 'transactions' }],
    pendingDetailGaps: [
      { reason: 'temporary_unavailable', status: 'pending', stream: 'transactions' },
      { reason: 'temporary_unavailable', status: 'pending', stream: 'transactions' },
    ],
    pendingDetailGapsReadLimit: 2,
    freshness: 'unknown',
  });
  const entry = entryFor(entries, 'transactions');

  assert.equal(entry.coverage_condition, 'retryable_gap');
  assert.equal(entry.pending_detail_gaps, 2);
  assert.equal(entry.pending_detail_gaps_is_floor, true);
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

test('portable RECORD/STATE/DONE-only stream (no considered, no gaps, no skip) -> unknown / unmeasured', () => {
  // The portability floor: a connector that emits only RECORD/STATE/DONE
  // declares no DETAIL_COVERAGE, no considered, and no SKIP_RESULT. Its entry
  // must be a VALID report with `unknown` axes — not an error, not `complete`.
  const entries = report([fact({ stream: 'posts', collected: 500, considered: null, checkpoint: 'committed' })]);
  const entry = entryFor(entries, 'posts');
  assert.equal(entry.considered, 'unknown');
  assert.equal(entry.coverage_condition, 'unknown');
  assert.equal(entry.forward_disposition, 'unmeasured');
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

// ─── succeeded-run coverage: staged checkpoint proves full_inventory /
//     singleton_presence streams (YNAB category_groups, Chase balances) ─────────
//
// These pin the fix for the live coverage omission: a succeeded run that emits
// records for a `full_inventory` or `singleton_presence` stream but leaves its
// checkpoint `not_staged` projects `unmeasured`; once the connector stages the
// checkpoint (committed), the declared strategy proves coverage without a
// numeric denominator and the stream reads `complete`. The strategy alone is not
// enough — the committed boundary is the load-bearing evidence.

test('YNAB category_groups (full_inventory): not_staged checkpoint -> unknown / unmeasured (the pre-fix bug)', () => {
  const entries = buildCollectionReport({
    collectionFacts: {
      streams: [fact({ stream: 'category_groups', collected: 12, considered: null, checkpoint: 'not_staged' })],
    },
    manifestStreams: [{ name: 'category_groups', coverage_strategy: 'full_inventory', freshness_strategy: 'scheduled_window' }],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const entry = entryFor(entries, 'category_groups');
  assert.equal(entry.coverage_strategy, 'full_inventory');
  assert.equal(entry.coverage_condition, 'unknown');
  assert.equal(entry.forward_disposition, 'unmeasured');
});

test('YNAB category_groups (full_inventory): committed checkpoint -> complete after a succeeded run', () => {
  const entries = buildCollectionReport({
    collectionFacts: {
      streams: [fact({ stream: 'category_groups', collected: 12, considered: null, checkpoint: 'committed' })],
    },
    manifestStreams: [{ name: 'category_groups', coverage_strategy: 'full_inventory', freshness_strategy: 'scheduled_window' }],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const entry = entryFor(entries, 'category_groups');
  assert.equal(entry.considered, 'unknown');
  assert.equal(entry.coverage_strategy, 'full_inventory');
  assert.equal(entry.coverage_condition, 'complete');
  assert.equal(entry.forward_disposition, 'complete');
});

test('Chase balances (singleton_presence): not_staged checkpoint -> unknown / unmeasured (the pre-fix bug)', () => {
  const entries = buildCollectionReport({
    collectionFacts: {
      streams: [fact({ stream: 'balances', collected: 3, considered: null, checkpoint: 'not_staged' })],
    },
    manifestStreams: [{ name: 'balances', coverage_strategy: 'singleton_presence', freshness_strategy: 'manual_as_of' }],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const entry = entryFor(entries, 'balances');
  assert.equal(entry.coverage_strategy, 'singleton_presence');
  assert.equal(entry.coverage_condition, 'unknown');
  assert.equal(entry.forward_disposition, 'unmeasured');
});

test('Chase balances (singleton_presence): committed checkpoint -> complete after a succeeded run', () => {
  const entries = buildCollectionReport({
    collectionFacts: {
      streams: [fact({ stream: 'balances', collected: 3, considered: null, checkpoint: 'committed' })],
    },
    manifestStreams: [{ name: 'balances', coverage_strategy: 'singleton_presence', freshness_strategy: 'manual_as_of' }],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const entry = entryFor(entries, 'balances');
  assert.equal(entry.considered, 'unknown');
  assert.equal(entry.coverage_strategy, 'singleton_presence');
  assert.equal(entry.coverage_condition, 'complete');
  assert.equal(entry.forward_disposition, 'complete');
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
