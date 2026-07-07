import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveForwardDisposition } from '../runtime/connection-health.ts';

// ─── Refresh-policy fixtures ─────────────────────────────────────────────────

/** A manual / paused / not-background-safe connection that cannot self-refresh. */
const MANUAL_REFRESH = Object.freeze({ backgroundSafe: false, recommendedMode: 'manual' });
const PAUSED_REFRESH = Object.freeze({ backgroundSafe: true, recommendedMode: 'paused' });
/** A schedulable, background-safe connection the scheduler refreshes on its own. */
const SCHEDULABLE_REFRESH = Object.freeze({ backgroundSafe: true, recommendedMode: 'automatic' });

/** Build a disposition input with safe defaults: no gap, no attention, fresh. */
function input(overrides = {}) {
  return {
    coverage: 'complete',
    gapRetryable: false,
    attentionOpen: false,
    freshness: 'fresh',
    refresh: null,
    ...overrides,
  };
}

// ─── complete ────────────────────────────────────────────────────────────────

test('complete: no gap, fresh freshness -> complete', () => {
  assert.equal(deriveForwardDisposition(input({ coverage: 'complete', freshness: 'fresh' })), 'complete');
});

test('complete: no gap, unknown freshness -> complete (freshness unknown is not a gap)', () => {
  assert.equal(deriveForwardDisposition(input({ coverage: 'complete', freshness: 'unknown' })), 'complete');
});

test('complete: deferred coverage owes no data -> complete, not terminal', () => {
  assert.equal(deriveForwardDisposition(input({ coverage: 'deferred' })), 'complete');
});

test('complete: inventory_only coverage owes no per-record detail -> complete', () => {
  assert.equal(deriveForwardDisposition(input({ coverage: 'inventory_only' })), 'complete');
});

// ─── owner_refresh_due (the manual-refresh seam) ─────────────────────────────

test('owner_refresh_due: complete coverage, manual-refresh stale -> owner_refresh_due', () => {
  assert.equal(
    deriveForwardDisposition(input({ coverage: 'complete', freshness: 'stale', refresh: MANUAL_REFRESH })),
    'owner_refresh_due',
  );
});

test('owner_refresh_due: complete coverage, paused-refresh stale -> owner_refresh_due', () => {
  assert.equal(
    deriveForwardDisposition(input({ coverage: 'complete', freshness: 'stale', refresh: PAUSED_REFRESH })),
    'owner_refresh_due',
  );
});

test('owner_refresh_due: it is NOT awaiting_owner, resumable, or complete', () => {
  const disposition = deriveForwardDisposition(
    input({ coverage: 'complete', freshness: 'stale', refresh: MANUAL_REFRESH }),
  );
  assert.notEqual(disposition, 'awaiting_owner');
  assert.notEqual(disposition, 'resumable');
  assert.notEqual(disposition, 'complete');
});

// ─── schedulable-stale negative case (NOT owner_refresh_due) ──────────────────

test('schedulable-stale: background-safe connection going stale stays complete, not owner_refresh_due', () => {
  const disposition = deriveForwardDisposition(
    input({ coverage: 'complete', freshness: 'stale', refresh: SCHEDULABLE_REFRESH }),
  );
  assert.equal(disposition, 'complete');
  assert.notEqual(disposition, 'owner_refresh_due');
});

test('schedulable-stale: absent refresh evidence is treated as schedulable -> stays complete', () => {
  // isManualRefreshOnly(null) === false, so staleness alone does not make it owner_refresh_due.
  assert.equal(
    deriveForwardDisposition(input({ coverage: 'complete', freshness: 'stale', refresh: null })),
    'complete',
  );
});

// ─── resumable ───────────────────────────────────────────────────────────────

test('resumable: retryable detail gap, no attention -> resumable', () => {
  assert.equal(
    deriveForwardDisposition(input({ coverage: 'retryable_gap', gapRetryable: true })),
    'resumable',
  );
});

test('resumable: ordinary partial boundary -> resumable even without an explicit retry flag', () => {
  assert.equal(
    deriveForwardDisposition(input({ coverage: 'partial', gapRetryable: false })),
    'resumable',
  );
});

test('resumable: generic gaps boundary -> resumable', () => {
  assert.equal(deriveForwardDisposition(input({ coverage: 'gaps', gapRetryable: false })), 'resumable');
});

// ─── gaps are evaluated before freshness (staleness never masks a gap) ────────

test('gap-before-freshness: retryable_gap that is ALSO stale stays resumable, not owner_refresh_due', () => {
  const disposition = deriveForwardDisposition(
    input({ coverage: 'retryable_gap', gapRetryable: true, freshness: 'stale', refresh: MANUAL_REFRESH }),
  );
  assert.equal(disposition, 'resumable');
  assert.notEqual(disposition, 'owner_refresh_due');
});

test('gap-before-freshness: partial that is ALSO stale on a manual connection stays resumable', () => {
  assert.equal(
    deriveForwardDisposition(
      input({ coverage: 'partial', freshness: 'stale', refresh: MANUAL_REFRESH }),
    ),
    'resumable',
  );
});

// ─── awaiting_owner ──────────────────────────────────────────────────────────

test('awaiting_owner: outstanding gap blocked on open attention -> awaiting_owner', () => {
  assert.equal(
    deriveForwardDisposition(input({ coverage: 'retryable_gap', gapRetryable: true, attentionOpen: true })),
    'awaiting_owner',
  );
});

test('awaiting_owner: a partial boundary blocked on attention awaits the owner, not resumable', () => {
  assert.equal(
    deriveForwardDisposition(input({ coverage: 'partial', attentionOpen: true })),
    'awaiting_owner',
  );
});

test('awaiting_owner: a complete-but-stale stream is NOT awaiting_owner (no outstanding gap)', () => {
  // The seam guard: missing data (awaiting_owner) must stay distinct from merely aged data.
  const disposition = deriveForwardDisposition(
    input({ coverage: 'complete', freshness: 'stale', refresh: MANUAL_REFRESH, attentionOpen: true }),
  );
  // Attention is open but there is no coverage gap, so this is not an awaiting_owner gap.
  assert.notEqual(disposition, 'awaiting_owner');
  assert.equal(disposition, 'owner_refresh_due');
});

// ─── terminal ────────────────────────────────────────────────────────────────

test('terminal: unsupported stream -> terminal', () => {
  assert.equal(deriveForwardDisposition(input({ coverage: 'unsupported' })), 'terminal');
});

test('terminal: terminal_gap with no attention -> terminal', () => {
  assert.equal(deriveForwardDisposition(input({ coverage: 'terminal_gap' })), 'terminal');
});

test('terminal: unavailable stream -> terminal', () => {
  assert.equal(deriveForwardDisposition(input({ coverage: 'unavailable' })), 'terminal');
});

test('terminal: unsupported is terminal whatever the retryability flag claims', () => {
  assert.equal(
    deriveForwardDisposition(input({ coverage: 'unsupported', gapRetryable: true })),
    'terminal',
  );
});

test('terminal: a terminal_gap blocked on attention awaits the owner (attention wins over terminal)', () => {
  // Design ordering: open attention is rule 1, surfaced ahead of a terminal verdict.
  assert.equal(
    deriveForwardDisposition(input({ coverage: 'terminal_gap', attentionOpen: true })),
    'awaiting_owner',
  );
});

// ─── unknown denominator is unmeasured, not complete or resumable ─────────────

test('unknown-denominator: unknown coverage is unmeasured, not complete or resumable (fresh)', () => {
  // A stream whose considered denominator is unknown carries `unknown` coverage,
  // which is absence of evidence — never proof of completeness. The function must
  // not upgrade it to `complete` or fabricate a recoverable `resumable` gap.
  const disposition = deriveForwardDisposition(input({ coverage: 'unknown', freshness: 'fresh' }));
  assert.notEqual(disposition, 'complete');
  assert.notEqual(disposition, 'resumable');
  assert.equal(disposition, 'unmeasured');
});

test('unknown-denominator: unknown coverage is unmeasured even with no gap and no attention', () => {
  assert.equal(deriveForwardDisposition(input({ coverage: 'unknown' })), 'unmeasured');
});

test('unknown-denominator: unknown coverage that is also manual-refresh stale stays unmeasured, not owner_refresh_due', () => {
  // owner_refresh_due is reserved for ESTABLISHED-complete coverage. An unknown
  // denominator has not established completeness, so staleness does not promote it
  // to a refresh-due signal or a retryable gap.
  const disposition = deriveForwardDisposition(
    input({ coverage: 'unknown', freshness: 'stale', refresh: MANUAL_REFRESH }),
  );
  assert.equal(disposition, 'unmeasured');
  assert.notEqual(disposition, 'owner_refresh_due');
  assert.notEqual(disposition, 'complete');
});
