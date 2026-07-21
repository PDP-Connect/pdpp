import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCollectionReport,
  projectCollectionReport,
  rollupCollectionReportCoverageOverride,
} from '../server/ref-control.ts';

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

// Wave 10a live-evidence regression (2026-07-09): while a scheduled run is
// queued/starting/in_progress, it carries no `collection_facts` yet. Before
// `coverageClassifyingRun`'s fix, this nonterminal `lastRun` won outright
// (it is not owner-cancelled), so every previously-complete stream read
// unknown/unmeasured for the duration of the run. An active run must instead
// fall back to the prior successful run's proven coverage, exactly like the
// owner-cancel case above — active progress is a SEPARATE signal
// (`connectionHealth.badges.syncing` / `OwnerStateEvidence.progress.active`),
// not this function's concern.
test('active in-progress latest run preserves prior successful coverage (does not read unknown)', () => {
  const inProgressRun = {
    event_count: 0,
    failure_reason: null,
    finished_at: null,
    first_at: '2026-05-19T12:09:00.000Z',
    known_gaps: [],
    last_at: '2026-05-19T12:09:00.000Z',
    run_id: 'run_in_progress',
    started_at: '2026-05-19T12:09:00.000Z',
    status: 'in_progress',
    terminal_reason: null,
    collection_facts: null,
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
    lastRun: inProgressRun,
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

test('active in-progress latest run with NO prior success stays unknown (never false-green)', () => {
  const inProgressRun = {
    event_count: 0,
    failure_reason: null,
    finished_at: null,
    first_at: '2026-05-19T12:09:00.000Z',
    known_gaps: [],
    last_at: '2026-05-19T12:09:00.000Z',
    run_id: 'run_in_progress_first_ever',
    started_at: '2026-05-19T12:09:00.000Z',
    status: 'in_progress',
    terminal_reason: null,
    collection_facts: null,
  };
  const entries = projectCollectionReport({
    lastRun: inProgressRun,
    lastSuccessfulRun: null,
    connectionHealth: { axes: { attention: 'none', freshness: 'unknown' } },
    manifestStreams: [{ name: 'messages', coverage_strategy: 'checkpoint_window', freshness_strategy: 'scheduled_window' }],
    refreshPolicy: null,
  });
  const entry = entryFor(entries, 'messages');

  assert.equal(entry.coverage_condition, 'unknown');
  assert.equal(entry.forward_disposition, 'unmeasured');
});

test('terminal failed latest run is NEVER substituted by a prior success (failure stays a failure)', () => {
  const failedRun = {
    event_count: 0,
    failure_reason: 'credential_rejected',
    finished_at: '2026-05-19T12:10:00.000Z',
    first_at: '2026-05-19T12:09:00.000Z',
    known_gaps: [],
    last_at: '2026-05-19T12:10:00.000Z',
    run_id: 'run_failed',
    started_at: '2026-05-19T12:09:00.000Z',
    status: 'failed',
    terminal_reason: 'credential_rejected',
    collection_facts: null,
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
    lastRun: failedRun,
    lastSuccessfulRun: successfulRun,
    connectionHealth: { axes: { attention: 'none', freshness: 'stale' } },
    manifestStreams: [{ name: 'messages', coverage_strategy: 'checkpoint_window', freshness_strategy: 'scheduled_window' }],
    refreshPolicy: null,
  });
  const entry = entryFor(entries, 'messages');

  // The failed run carries no collection_facts of its own and is NOT
  // owner-cancelled, so it is NOT substituted — it reads unknown, never the
  // prior success's `complete`. Terminal failures must never appear green.
  assert.equal(entry.coverage_condition, 'unknown');
  assert.notEqual(entry.coverage_condition, 'complete');
});

// Live defect fix (2026-07-17): a connector with a durable non-pressure
// recovery backlog (e.g. a large Gmail attachment-hydration queue) is
// dispatched `recovery_only` on every scheduled/unscoped-manual run for as
// long as that backlog persists (`resolveEffectiveRecoveryOnly`,
// `runtime/controller.ts`). A recovery-only run's own `collection_facts` is
// ALWAYS `null` by design (`buildCollectionFacts`'s `recoveryOnly` branch) —
// not because measurement failed, but because none was attempted for any
// stream, list-pass or detail-recovered. Before this fix,
// `coverageClassifyingRun` used a terminal `recovery_only` success AS-IS
// (it is neither active nor owner-cancelled), which read every
// checkpoint_window/full_inventory stream the recovery-only run did not
// touch as `unknown`/`unmeasured` — masking a genuinely-measured PRIOR
// forward pass indefinitely while the backlog persisted.
test('succeeded recovery-only latest run defers to prior successful coverage (does not starve untouched streams)', () => {
  const recoveryOnlyRun = {
    event_count: 4,
    failure_reason: null,
    finished_at: '2026-07-17T10:00:00.000Z',
    first_at: '2026-07-17T09:59:00.000Z',
    known_gaps: [],
    last_at: '2026-07-17T10:00:00.000Z',
    run_id: 'run_recovery_only',
    started_at: '2026-07-17T09:59:00.000Z',
    status: 'succeeded',
    terminal_reason: null,
    recovery_only: true,
    collection_facts: null,
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
    lastRun: recoveryOnlyRun,
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

// Honesty proof (non-vacuous, negative case): a FAILED recovery-only run
// still carries a genuine failure signal for the connection and must NEVER
// be substituted by a prior success — exactly like an ordinary terminal
// failure. Only a SUCCEEDED recovery-only run gets the fallback.
test('FAILED recovery-only latest run is NEVER substituted by a prior success (failure stays a failure)', () => {
  const failedRecoveryOnlyRun = {
    event_count: 1,
    failure_reason: 'connector_exception',
    finished_at: '2026-07-17T10:10:00.000Z',
    first_at: '2026-07-17T10:09:00.000Z',
    known_gaps: [],
    last_at: '2026-07-17T10:10:00.000Z',
    run_id: 'run_recovery_only_failed',
    started_at: '2026-07-17T10:09:00.000Z',
    status: 'failed',
    terminal_reason: 'connector_exception',
    recovery_only: true,
    collection_facts: null,
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
    lastRun: failedRecoveryOnlyRun,
    lastSuccessfulRun: successfulRun,
    connectionHealth: { axes: { attention: 'none', freshness: 'stale' } },
    manifestStreams: [{ name: 'messages', coverage_strategy: 'checkpoint_window', freshness_strategy: 'scheduled_window' }],
    refreshPolicy: null,
  });
  const entry = entryFor(entries, 'messages');

  assert.equal(entry.coverage_condition, 'unknown');
  assert.notEqual(entry.coverage_condition, 'complete');
});

// Honesty proof (non-vacuous, negative case): a succeeded recovery-only run
// with NO prior successful run at all (e.g. a connection whose very first
// run was recovery-gated) must still rest unknown — the fallback only
// SURFACES a prior genuine measurement, it never fabricates one.
test('succeeded recovery-only latest run with NO prior success stays unknown (never false-green)', () => {
  const recoveryOnlyRun = {
    event_count: 4,
    failure_reason: null,
    finished_at: '2026-07-17T10:00:00.000Z',
    first_at: '2026-07-17T09:59:00.000Z',
    known_gaps: [],
    last_at: '2026-07-17T10:00:00.000Z',
    run_id: 'run_recovery_only_first_ever',
    started_at: '2026-07-17T09:59:00.000Z',
    status: 'succeeded',
    terminal_reason: null,
    recovery_only: true,
    collection_facts: null,
  };
  const entries = projectCollectionReport({
    lastRun: recoveryOnlyRun,
    lastSuccessfulRun: null,
    connectionHealth: { axes: { attention: 'none', freshness: 'unknown' } },
    manifestStreams: [{ name: 'messages', coverage_strategy: 'checkpoint_window', freshness_strategy: 'scheduled_window' }],
    refreshPolicy: null,
  });
  const entry = entryFor(entries, 'messages');

  assert.equal(entry.coverage_condition, 'unknown');
  assert.equal(entry.forward_disposition, 'unmeasured');
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
//     singleton_presence streams (YNAB category_groups) ───────────────────────
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

// ─── Chase balances (parent_detail_accounting) ─────────────────────────────
//
// `balances` was originally a bare `singleton_presence` stream whose only
// proof was a self-staged STATE checkpoint gated on "at least one balance
// record emitted this run". That left the stream permanently unmeasured on
// any run where every considered account was source-limited `no_activity`
// (Chase's no-activity confirmation page never serves a QFX response, so
// there is no LEDGERBAL/AVAILBAL block to read) — a real, common case, not a
// connector bug (live run_1783705924457: accounts/transactions/statements all
// committed while balances rested `not_staged` with considered/covered null).
// `balances` now adopts the same `parent_detail_accounting` evidence as
// `transactions`: a per-run DETAIL_COVERAGE over the `accounts` denominator,
// where a `no_activity` account is honest hydrated coverage of the balances
// pass (reached, nothing to report), never a gap. These pin the projection
// consequence of that fix.

test('Chase balances (parent_detail_accounting): zero balance records but considered==covered (all no_activity) -> complete, not unmeasured (the live regression)', () => {
  const entries = buildCollectionReport({
    collectionFacts: {
      streams: [fact({ stream: 'balances', collected: 0, considered: 2, covered: 2, checkpoint: 'committed' })],
    },
    manifestStreams: [{ name: 'balances', coverage_strategy: 'parent_detail_accounting', freshness_strategy: 'manual_as_of' }],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const entry = entryFor(entries, 'balances');
  assert.equal(entry.collected, 0, 'no balance records were emitted this run');
  assert.equal(entry.considered, 2);
  assert.equal(entry.coverage_strategy, 'parent_detail_accounting');
  assert.equal(entry.coverage_condition, 'complete');
  assert.equal(entry.forward_disposition, 'complete');
});

test('Chase balances (parent_detail_accounting): zero eligible accounts after a completed enumeration (considered 0 / covered 0) -> complete, not unmeasured', () => {
  // A real resource-filtered scoped run whose account enumeration succeeded
  // but matched zero eligible accounts still owes an explicit 0/0 report
  // (emitBalancesDetailCoverage no longer suppresses on outcomes.length ===
  // 0). This must resolve complete exactly like the USAA/Chase-statements
  // zero-candidate steady-state case, not rest unknown for lack of a
  // numeric denominator > 0.
  const entries = buildCollectionReport({
    collectionFacts: {
      streams: [fact({ stream: 'balances', collected: 0, considered: 0, covered: 0, checkpoint: 'committed' })],
    },
    manifestStreams: [{ name: 'balances', coverage_strategy: 'parent_detail_accounting', freshness_strategy: 'manual_as_of' }],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const entry = entryFor(entries, 'balances');
  assert.equal(entry.considered, 0);
  assert.equal(entry.coverage_condition, 'complete');
  assert.equal(entry.forward_disposition, 'complete');
});

test('Chase balances (parent_detail_accounting): no DETAIL_COVERAGE emitted (no considered denominator) -> unknown / unmeasured', () => {
  const entries = buildCollectionReport({
    collectionFacts: {
      streams: [fact({ stream: 'balances', collected: 0, considered: null, covered: null, checkpoint: 'not_staged' })],
    },
    manifestStreams: [{ name: 'balances', coverage_strategy: 'parent_detail_accounting', freshness_strategy: 'manual_as_of' }],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const entry = entryFor(entries, 'balances');
  assert.equal(entry.coverage_strategy, 'parent_detail_accounting');
  assert.equal(entry.coverage_condition, 'unknown');
  assert.equal(entry.forward_disposition, 'unmeasured');
});

test('Chase balances (parent_detail_accounting): a QFX gap on one account -> partial, not complete', () => {
  const entries = buildCollectionReport({
    collectionFacts: {
      streams: [fact({ stream: 'balances', collected: 1, considered: 2, covered: 1, checkpoint: 'committed' })],
    },
    manifestStreams: [{ name: 'balances', coverage_strategy: 'parent_detail_accounting', freshness_strategy: 'manual_as_of' }],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const entry = entryFor(entries, 'balances');
  assert.equal(entry.coverage_condition, 'partial');
});

test('Chase balances (parent_detail_accounting): all accounts hydrated with a balance -> complete', () => {
  const entries = buildCollectionReport({
    collectionFacts: {
      streams: [fact({ stream: 'balances', collected: 2, considered: 2, covered: 2, checkpoint: 'committed' })],
    },
    manifestStreams: [{ name: 'balances', coverage_strategy: 'parent_detail_accounting', freshness_strategy: 'manual_as_of' }],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const entry = entryFor(entries, 'balances');
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

// ─── `required` flag on the report entry ──────────────────────────────────────

test('required flag: manifest-declared stream defaults required=true; a fact-only undeclared stream is required=false', () => {
  const entries = buildCollectionReport({
    collectionFacts: {
      streams: [
        fact({ stream: 'transactions', collected: 5, considered: 5 }),
        fact({ stream: 'extra', collected: 1, considered: null }),
      ],
    },
    manifestStreams: [{ name: 'transactions' }],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  assert.equal(entryFor(entries, 'transactions').required, true);
  assert.equal(entryFor(entries, 'extra').required, false, 'undeclared fact-only stream must not be load-bearing');
});

test('required flag: an explicit required:false manifest stream is not required', () => {
  const entries = buildCollectionReport({
    collectionFacts: { streams: [fact({ stream: 'reactions', collected: 0, considered: null })] },
    manifestStreams: [{ name: 'reactions', required: false }],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  assert.equal(entryFor(entries, 'reactions').required, false);
});

// ─── Durable latest-attempt evidence (design.md "Per-Stream Evidence
//     Carry-Forward" / requirement "Per-stream coverage SHALL derive from
//     durable latest-attempt evidence") ──────────────────────────────────────
//
// `buildCollectionReport`'s `collectionFacts` is the CLASSIFYING run's own
// fact block; `latestStreamFacts` is the durable per-stream latest-attempt
// map from the connector-summary read model (raw fact + proof time + run id,
// connection-scoped). A run that did not attempt a stream must not erase
// that stream's prior evidence, and must not fabricate evidence for it
// either; the classifying run's own facts always overlay the store.

/** A manifest declaring `messages` as a checkpoint_window-proven stream. */
const CHECKPOINT_MESSAGES_MANIFEST = [
  { name: 'messages', coverage_strategy: 'checkpoint_window', freshness_strategy: 'scheduled_window' },
];

/** Stored latest-attempt facts: `buildCollectionReport`'s `latestStreamFacts` shape. */
function storedFacts(streams, { asOf = '2026-05-01T00:00:00.000Z', runId = 'run_old' } = {}) {
  return new Map(streams.map((f) => [f.stream, { fact: f, evidenceAsOf: asOf, runId }]));
}

test('carry-forward: scoped run preserves prior proof for an omitted required stream', () => {
  // Classifying run's scope did not attempt `messages` at all (no fact for it).
  // An older terminal block proved it complete via a committed checkpoint.
  const entries = buildCollectionReport({
    collectionFacts: { streams: [] },
    collectionFactsAsOf: '2026-06-01T00:00:00.000Z',
    latestStreamFacts: storedFacts(
      [fact({ stream: 'messages', collected: 500, considered: null, checkpoint: 'committed' })],
      { asOf: '2026-05-01T00:00:00.000Z' }
    ),
    manifestStreams: CHECKPOINT_MESSAGES_MANIFEST,
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const entry = entryFor(entries, 'messages');
  assert.equal(entry.coverage_condition, 'complete', 'carried resolved evidence proves the stream complete');
  assert.equal(entry.required, true);
  assert.equal(entry.evidence_as_of, '2026-05-01T00:00:00.000Z', 'proof age is the SOURCE block\'s own timestamp');
  assert.equal(rollupCollectionReportCoverageOverride('complete', entries), null);
});

test('carry-forward: never-measured omitted required stream still blocks Healthy', () => {
  // No carry block has ANY resolved evidence for `messages` — it stays unknown.
  const entries = buildCollectionReport({
    collectionFacts: { streams: [] },
    collectionFactsAsOf: '2026-06-01T00:00:00.000Z',
    latestStreamFacts: storedFacts([fact({ stream: 'other', collected: 1, considered: 1 })]),
    manifestStreams: CHECKPOINT_MESSAGES_MANIFEST,
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const entry = entryFor(entries, 'messages');
  assert.equal(entry.coverage_condition, 'unknown');
  assert.equal(entry.required, true);
  assert.equal(entry.evidence_as_of, null, 'no resolved evidence anywhere -> no proof age either');
  assert.equal(
    rollupCollectionReportCoverageOverride('complete', entries),
    'unknown',
    'a required stream resting unknown refuses the clean-success promotion'
  );
});

test('carry-forward: an attempted-but-unresolved classifying fact blocks carry (conservative — stays unknown)', () => {
  // The classifying block DID attempt `messages` but left it unresolved
  // (not_staged, no skip, no denominator). An older block proved it
  // complete, but the classifying run's own unresolved attempt must win —
  // carrying stale proof over an honest "we tried and can't yet prove it"
  // would be dishonest.
  const entries = buildCollectionReport({
    collectionFacts: {
      streams: [fact({ stream: 'messages', collected: 10, considered: null, checkpoint: 'not_staged' })],
    },
    collectionFactsAsOf: '2026-06-01T00:00:00.000Z',
    latestStreamFacts: storedFacts([
      fact({ stream: 'messages', collected: 500, considered: null, checkpoint: 'committed' }),
    ]),
    manifestStreams: CHECKPOINT_MESSAGES_MANIFEST,
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const entry = entryFor(entries, 'messages');
  assert.equal(entry.coverage_condition, 'unknown', 'the classifying run own unresolved attempt is not overridden');
  assert.equal(entry.checkpoint, 'not_staged');
  assert.equal(entry.evidence_as_of, '2026-06-01T00:00:00.000Z', 'proof age is the CLASSIFYING run\'s own time, not the older block');
});

test('carry-forward: manifest-deferred stream stays accepted policy regardless of carry evidence', () => {
  const entries = buildCollectionReport({
    collectionFacts: { streams: [] },
    manifestStreams: [{ name: 'drafts', coverage_policy: 'deferred', required: false }],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const entry = entryFor(entries, 'drafts');
  assert.equal(entry.coverage_condition, 'deferred');
  assert.equal(entry.required, false);
  assert.equal(rollupCollectionReportCoverageOverride('complete', entries), null);
});

test("stored evidence: a stored state_stream child inherits from its own run's stored parent, not the classifying block", () => {
  // `messages` (parent, checkpoint_window) is committed in an OLDER block; the
  // child `message_reactions` in that SAME older block is not_staged with no
  // skip/gap — the read-side state_stream inheritance should pick up the
  // parent's committed checkpoint from THAT block. The classifying block has
  // neither stream (both carried).
  const CHILD_MANIFEST = [
    { name: 'messages', coverage_strategy: 'checkpoint_window', freshness_strategy: 'scheduled_window' },
    {
      name: 'message_reactions',
      coverage_strategy: 'checkpoint_window',
      freshness_strategy: 'scheduled_window',
      state_stream: 'messages',
    },
  ];
  const entries = buildCollectionReport({
    collectionFacts: { streams: [] },
    latestStreamFacts: storedFacts([
      fact({ stream: 'messages', collected: 500, considered: null, checkpoint: 'committed' }),
      fact({ stream: 'message_reactions', collected: 0, considered: null, checkpoint: 'not_staged' }),
    ]),
    manifestStreams: CHILD_MANIFEST,
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const child = entryFor(entries, 'message_reactions');
  assert.equal(child.coverage_condition, 'complete', 'child inherits the parent checkpoint from its OWN carried block');
  assert.equal(child.checkpoint, 'committed');
});

test('carry-forward: a carried fact zeroes its stale run-local pending_detail_gaps; only the durable store count is authoritative', () => {
  // The older block's fact reports pending_detail_gaps: 3 — a stale run-local
  // number from that old run. The durable gap store (pendingDetailGaps input)
  // reports zero pending rows for this stream today. The carried entry must
  // read the DURABLE zero, not the stale 3 (which would fabricate a
  // retryable_gap that no longer exists).
  const entries = buildCollectionReport({
    collectionFacts: { streams: [] },
    latestStreamFacts: storedFacts([
      fact({
        stream: 'messages',
        collected: 500,
        considered: null,
        checkpoint: 'committed',
        pending_detail_gaps: 3,
      }),
    ]),
    manifestStreams: CHECKPOINT_MESSAGES_MANIFEST,
    pendingDetailGaps: [],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const entry = entryFor(entries, 'messages');
  assert.equal(entry.pending_detail_gaps, 0, 'stale carried pending_detail_gaps must be zeroed');
  assert.equal(entry.coverage_condition, 'complete', 'no retryable_gap fabricated from stale carried count');
});

test('carry-forward: worst-wins is preserved — a terminal_gap entry alongside a required-unknown entry keeps terminal_gap', () => {
  const entries = buildCollectionReport({
    collectionFacts: {
      streams: [fact({ stream: 'lost', collected: 0, skipped: { reason: 'connector_panicked' } })],
    },
    manifestStreams: [{ name: 'lost' }, { name: 'messages', coverage_strategy: 'checkpoint_window' }],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  assert.equal(entryFor(entries, 'lost').coverage_condition, 'terminal_gap');
  assert.equal(entryFor(entries, 'messages').coverage_condition, 'unknown');
  assert.equal(entryFor(entries, 'messages').required, true);
  assert.equal(
    rollupCollectionReportCoverageOverride('complete', entries),
    'terminal_gap',
    'the degrading terminal_gap axis wins over the required-unknown refusal — never upgraded'
  );
});

// A required-unknown entry must NEVER upgrade an axis pass 1 already ranks as
// a real degrading condition — `unknown` is not "worse" than
// terminal_gap/retryable_gap/gaps/partial on any ranking, so replacing one of
// those with `unknown` would be a false upgrade, not a worst-wins refusal.
// Parameterized over every degrading axis so this cannot regress silently.
for (const currentAxis of ['terminal_gap', 'retryable_gap', 'gaps', 'partial']) {
  test(`carry-forward: required-unknown entry must NOT upgrade a degrading currentAxis (${currentAxis})`, () => {
    const report = [
      { stream: 'other', collected: 0, considered: 'unknown', covered: 'unknown', checkpoint: 'unknown', pending_detail_gaps: 0, pending_detail_gaps_is_floor: false, required: true, skipped: null, coverage_condition: 'unknown', coverage_strategy: null, forward_disposition: 'unmeasured', freshness_strategy: null },
    ];
    assert.equal(
      rollupCollectionReportCoverageOverride(currentAxis, report),
      null,
      `a required-unknown entry must leave a degrading currentAxis (${currentAxis}) untouched, never upgrade it to unknown`
    );
  });
}

test('carry-forward: an undeclared fact-only stream resting unknown does NOT trigger the required-unknown override', () => {
  const entries = buildCollectionReport({
    collectionFacts: { streams: [fact({ stream: 'extra', collected: 3, considered: null })] },
    manifestStreams: [],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const entry = entryFor(entries, 'extra');
  assert.equal(entry.coverage_condition, 'unknown');
  assert.equal(entry.required, false, 'no manifest entry -> not required -> cannot block Healthy');
  assert.equal(
    rollupCollectionReportCoverageOverride('complete', entries),
    null,
    'an undeclared unknown stream must not override a clean connection axis'
  );
});

// openspec/changes/fix-recovery-run-lifecycle: a recovery-only run performs
// no forward/list inventory pass by definition, so `buildCollectionFacts`
// (connector-gap-bounding.ts) returns null for it unconditionally — a
// recovery-only classifying run's `collection_facts` is therefore always
// null/absent here, not a thin fact to overlay. `resolveEffectiveStreamFacts`
// needs no recovery-only-specific code: with collectionFacts empty, every
// stream falls through to the stored fact, with that fact's own provenance
// (evidence_as_of/run_id) completely untouched. Current gap-drain state is a
// SEPARATE channel: `pendingDetailGaps`/`terminalDetailGapsByStream` are live
// reads from the durable gap store, folded independently of collectionFacts.

test('recovery-only classifying run (collection_facts null) falls through to stored inventory evidence with its ORIGINAL provenance', () => {
  const entries = buildCollectionReport({
    collectionFacts: null,
    collectionFactsAsOf: '2026-07-15T22:45:32.686Z',
    collectionFactsRunId: 'run_1784155457650',
    latestStreamFacts: storedFacts(
      [fact({ stream: 'order_items', collected: 212, considered: 212, checkpoint: 'committed' })],
      { asOf: '2026-07-10T00:00:00.000Z', runId: 'run_old' }
    ),
    manifestStreams: [{ name: 'order_items', coverage_strategy: 'checkpoint_window', freshness_strategy: 'scheduled_window' }],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const entry = entryFor(entries, 'order_items');
  assert.equal(entry.coverage_condition, 'complete', 'stored inventory evidence is untouched by the recovery-only run');
  assert.equal(entry.considered, 212);
  assert.equal(
    entry.evidence_as_of,
    '2026-07-10T00:00:00.000Z',
    "proof age is the STORED fact's own timestamp, never the recovery-only run's"
  );
});

test('current gap-drain progress reads live from pendingDetailGaps, independent of the (null) collection_facts', () => {
  // A recovery-only run recovered the one pending gap for order_items down
  // to zero. Its own collection_facts is null (no inventory pass), but the
  // live gap-store input still reflects the drain — the two channels stay
  // separate: inventory evidence/provenance untouched, current gap count live.
  const entriesBeforeDrain = buildCollectionReport({
    collectionFacts: null,
    latestStreamFacts: storedFacts([fact({ stream: 'order_items', collected: 212, considered: 212, checkpoint: 'committed' })]),
    manifestStreams: [{ name: 'order_items', coverage_strategy: 'checkpoint_window', freshness_strategy: 'scheduled_window' }],
    pendingDetailGaps: [{ reason: 'temporary_unavailable', status: 'pending', stream: 'order_items' }],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const beforeEntry = entryFor(entriesBeforeDrain, 'order_items');
  assert.equal(beforeEntry.pending_detail_gaps, 1);

  const entriesAfterDrain = buildCollectionReport({
    collectionFacts: null,
    latestStreamFacts: storedFacts([fact({ stream: 'order_items', collected: 212, considered: 212, checkpoint: 'committed' })]),
    manifestStreams: [{ name: 'order_items', coverage_strategy: 'checkpoint_window', freshness_strategy: 'scheduled_window' }],
    pendingDetailGaps: [],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const afterEntry = entryFor(entriesAfterDrain, 'order_items');
  assert.equal(afterEntry.pending_detail_gaps, 0, 'current gap count reflects the drain');
  assert.equal(afterEntry.coverage_condition, 'complete', 'inventory evidence itself is unaffected by the drain');
  assert.equal(afterEntry.considered, 212, 'considered denominator is unchanged — it never came from the recovery-only run');
});

test('a non-recovery-only classifying run still fully replaces the stored fact (existing behavior unchanged)', () => {
  const entries = buildCollectionReport({
    collectionFacts: {
      streams: [fact({ stream: 'order_items', collected: 0, considered: null, checkpoint: 'not_staged' })],
    },
    collectionFactsAsOf: '2026-07-15T22:45:32.686Z',
    collectionFactsRunId: 'run_full_scope_failed',
    latestStreamFacts: storedFacts(
      [fact({ stream: 'order_items', collected: 212, considered: 212, checkpoint: 'committed' })],
      { asOf: '2026-07-10T00:00:00.000Z', runId: 'run_old' }
    ),
    manifestStreams: [{ name: 'order_items', coverage_strategy: 'checkpoint_window', freshness_strategy: 'scheduled_window' }],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const entry = entryFor(entries, 'order_items');
  assert.equal(
    entry.coverage_condition,
    'unknown',
    'a genuinely failed/unresolved full-scope attempt must still replace stale proof (unchanged prior behavior)'
  );
});

// Amazon-shaped acceptance test reproducing run_1784155457650: a recovery-only
// run recovers 15 pending detail gaps and drains the backlog to zero. Its
// collection_facts is null, so BOTH orders and order_items keep their prior
// evidence and provenance completely untouched; only the live pending-gap
// count (read separately) reflects the drain.
test('acceptance: Amazon-shaped recovery-only run (15 gaps recovered, pending drained to zero) leaves both streams evidence+provenance untouched', () => {
  const priorEvidenceAsOf = '2026-07-10T00:00:00.000Z';
  const entries = buildCollectionReport({
    collectionFacts: null,
    collectionFactsAsOf: '2026-07-15T22:45:32.686Z',
    collectionFactsRunId: 'run_1784155457650',
    latestStreamFacts: storedFacts(
      [
        fact({ stream: 'orders', collected: 40, considered: 40, checkpoint: 'committed' }),
        fact({ stream: 'order_items', collected: 212, considered: 212, checkpoint: 'committed' }),
      ],
      { asOf: priorEvidenceAsOf, runId: 'run_1784100000000' }
    ),
    manifestStreams: [
      { name: 'orders', coverage_strategy: 'checkpoint_window', freshness_strategy: 'scheduled_window' },
      { name: 'order_items', coverage_strategy: 'checkpoint_window', freshness_strategy: 'scheduled_window' },
    ],
    pendingDetailGaps: [], // drained to zero by the recovery-only run
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  const orders = entryFor(entries, 'orders');
  const orderItems = entryFor(entries, 'order_items');
  assert.equal(orders.coverage_condition, 'complete', 'orders keeps prior evidence');
  assert.equal(orders.considered, 40);
  assert.equal(orders.evidence_as_of, priorEvidenceAsOf, 'orders provenance is the prior run\'s, not the recovery run\'s');
  assert.equal(orderItems.coverage_condition, 'complete', 'order_items (touched/recovered) also keeps prior evidence');
  assert.equal(orderItems.considered, 212);
  assert.equal(orderItems.evidence_as_of, priorEvidenceAsOf, 'order_items provenance is also not restamped');
  assert.equal(orderItems.pending_detail_gaps, 0, 'the drain to zero is still reflected via the live gap-store input');
});
