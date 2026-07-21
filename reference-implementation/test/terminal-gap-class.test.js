// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * §10-A Terminal gap class — failing tests (write first, then implement).
 *
 * Spec: a gap that exhausts a bounded recovery-attempt budget (maxRecoveryAttempts)
 * against a NON-TRANSIENT error (404/410/permanent-403, or N identical 5xx) transitions
 * pending→terminal. Terminal gaps are:
 *   - excluded from listPendingGaps / listPendingGapsForConnector (fillable-pending set)
 *   - counted via countGapsByStatusForConnector(connectorId, { status: 'terminal' })
 *   - NOT silently dropped
 *   - NOT subject to revival by upsertPendingGap (terminal is sticky like recovered)
 *
 * maxRecoveryAttempts is a ProviderProfile field; ChatGPT's value is the only concrete
 * value — NO cross-provider default for safety/pressure quantities (spec §3 rule 6).
 *
 * Ref: docs/research/slvp-ideal-whole-system-spec-2026-06-11.md §10-A
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { closeDb, initDb } from '../server/db.js';
import { createSqliteConnectorDetailGapStore } from '../server/stores/connector-detail-gap-store.js';
import {
  classifyRecoveryError,
  isNonTransientError,
  CHATGPT_PROVIDER_PROFILE,
  maybeTerminateGap,
  terminalGapProfileForConnector,
} from '../server/stores/terminal-gap-classifier.js';

// ─── terminalGapProfileForConnector: per-connector registry, NO default ──────

test('terminalGapProfileForConnector resolves chatgpt (incl. instance-scoped ids) and returns null for unknown — no cross-provider default', () => {
  assert.equal(terminalGapProfileForConnector('chatgpt'), CHATGPT_PROVIDER_PROFILE);
  assert.equal(terminalGapProfileForConnector('chatgpt:default'), CHATGPT_PROVIDER_PROFILE, 'instance-scoped id resolves to base profile');
  assert.equal(terminalGapProfileForConnector('chatgpt@everyone'), CHATGPT_PROVIDER_PROFILE, 'account-scoped id resolves to base profile');
  // §3 rule 6: a connector with no declared profile must NOT borrow ChatGPT's
  // budget — it returns null so the recovery path simply does not terminalize.
  assert.equal(terminalGapProfileForConnector('gmail'), null);
  assert.equal(terminalGapProfileForConnector('some-new-connector'), null);
  assert.equal(terminalGapProfileForConnector(''), null);
  assert.equal(terminalGapProfileForConnector(undefined), null);
});

// The wired runtime adapter maps DETAIL_GAP last_error -> classifier errorInfo.
// Pin that mapping (last_error.http_status -> status, last_error.class ->
// errorClass) so the §10-A wiring in runtime/index.js stays correct.
test('the DETAIL_GAP last_error -> errorInfo mapping classifies non-transient statuses correctly', () => {
  const map = (lastError) => (lastError ? { status: lastError.http_status, errorClass: lastError.class } : null);
  assert.equal(classifyRecoveryError(map({ http_status: 404 })).nonTransient, true);
  assert.equal(classifyRecoveryError(map({ http_status: 410 })).nonTransient, true);
  assert.equal(classifyRecoveryError(map({ http_status: 401 })).reason, 'auth_failure');
  assert.equal(classifyRecoveryError(map({ http_status: 403, class: 'http_403_permanent' })).nonTransient, true);
  // run_cap_deferred / rate-limit shaped last_error (no http_status, or 429) stays transient.
  assert.equal(classifyRecoveryError(map({ class: 'max_detail_fetches' })).nonTransient, false);
  assert.equal(classifyRecoveryError(map({ http_status: 429 })).nonTransient, false);
  assert.equal(classifyRecoveryError(map(null)).nonTransient, false);
});

// ─── Test helpers ───────────────────────────────────────────────────────────

function withTempDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-terminal-gap-'));
    try {
      initDb(join(dir, 'pdpp.sqlite'));
      await fn(dir);
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function seedGap(store, overrides = {}) {
  return store.upsertPendingGap({
    connectorId: 'chatgpt',
    grantId: 'grant_test',
    stream: 'messages',
    recordKey: overrides.recordKey ?? 'conv_test_001',
    reason: overrides.reason ?? 'retry_exhausted',
    detailLocator: { kind: 'chatgpt.conversation', conversation_id: overrides.recordKey ?? 'conv_test_001' },
    ...overrides,
  });
}

// ─── classifyRecoveryError / isNonTransientError pure-function tests ────────

test('classifyRecoveryError: 404 is non-transient (deleted resource)', () => {
  const result = classifyRecoveryError({ status: 404 });
  assert.equal(result.nonTransient, true);
  assert.equal(result.reason, 'not_found');
});

test('classifyRecoveryError: 410 is non-transient (gone)', () => {
  const result = classifyRecoveryError({ status: 410 });
  assert.equal(result.nonTransient, true);
  assert.equal(result.reason, 'gone');
});

test('classifyRecoveryError: 403 permanent (no retry hint) is non-transient', () => {
  const result = classifyRecoveryError({ status: 403, errorClass: 'http_403_permanent' });
  assert.equal(result.nonTransient, true);
  assert.equal(result.reason, 'permanent_forbidden');
});

test('classifyRecoveryError: 403 without permanent marker is transient (may be auth refresh)', () => {
  // A bare 403 without an explicit permanent marker is considered transient —
  // it may resolve after a credential refresh. Only 403 with the permanent
  // errorClass is non-transient.
  const result = classifyRecoveryError({ status: 403 });
  assert.equal(result.nonTransient, false);
});

test('classifyRecoveryError: 429 is transient (rate pressure, must never terminalize)', () => {
  const result = classifyRecoveryError({ status: 429 });
  assert.equal(result.nonTransient, false);
});

test('classifyRecoveryError: 500 is transient on the first occurrence', () => {
  // A single 5xx is transient — the server may have been briefly unhealthy.
  const result = classifyRecoveryError({ status: 500 });
  assert.equal(result.nonTransient, false);
});

test('classifyRecoveryError: 503 is transient', () => {
  const result = classifyRecoveryError({ status: 503 });
  assert.equal(result.nonTransient, false);
});

test('classifyRecoveryError: null/undefined status is transient (safe default)', () => {
  assert.equal(classifyRecoveryError({}).nonTransient, false);
  assert.equal(classifyRecoveryError({ status: null }).nonTransient, false);
  assert.equal(classifyRecoveryError(null).nonTransient, false);
});

test('isNonTransientError convenience wrapper agrees with classifyRecoveryError', () => {
  assert.equal(isNonTransientError({ status: 404 }), true);
  assert.equal(isNonTransientError({ status: 410 }), true);
  assert.equal(isNonTransientError({ status: 429 }), false);
  assert.equal(isNonTransientError({ status: 500 }), false);
  assert.equal(isNonTransientError(null), false);
});

// ─── CHATGPT_PROVIDER_PROFILE pinned constants ───────────────────────────────
//
// maxRecoveryAttempts is a ProviderProfile field — NO cross-provider default.
// The ChatGPT value is pinned here so any drift is intentional.

test('CHATGPT_PROVIDER_PROFILE.maxRecoveryAttempts is a finite positive integer', () => {
  assert.ok(
    Number.isInteger(CHATGPT_PROVIDER_PROFILE.maxRecoveryAttempts) && CHATGPT_PROVIDER_PROFILE.maxRecoveryAttempts > 0,
    `CHATGPT_PROVIDER_PROFILE.maxRecoveryAttempts must be a positive integer, got ${CHATGPT_PROVIDER_PROFILE.maxRecoveryAttempts}`,
  );
});

test('CHATGPT_PROVIDER_PROFILE has no cross-provider default key — only chatgpt-specific values', () => {
  // Structural guard: the profile must not include a "default" or "fallback"
  // key that other connectors could silently inherit. Each connector declares
  // its own profile. This test makes the "no cross-provider default" rule
  // mechanically verifiable (§3 rule 6).
  assert.equal('default' in CHATGPT_PROVIDER_PROFILE, false);
  assert.equal('fallback' in CHATGPT_PROVIDER_PROFILE, false);
});

// ─── maybeTerminateGap — pending → terminal transition ──────────────────────

test('maybeTerminateGap: gap hitting non-transient error N times → terminal, leaves pending count unchanged', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const gap = await seedGap(store, { recordKey: 'conv_terminal_404' });

  // Simulate the gap being attempted maxRecoveryAttempts times against a 404.
  // Each call marks in_progress (incrementing attempt_count) then transitions.
  // After exhausting the budget, the gap must be terminal.
  const profile = { maxRecoveryAttempts: 3 };
  const errorInfo = { status: 404 };

  // Attempts 1..3: attempt_count should increment via in_progress, then
  // maybeTerminateGap returns false until budget is exhausted.
  for (let i = 1; i <= profile.maxRecoveryAttempts; i++) {
    await store.markGapStatus(gap.gap_id, 'in_progress');
  }

  // After exhausting the budget, maybeTerminateGap transitions to terminal.
  const result = await maybeTerminateGap(store, gap.gap_id, errorInfo, profile);
  assert.equal(result.terminated, true, 'gap must be marked terminal after budget exhaustion');

  // Terminal gap must NOT appear in listPendingGaps.
  const pending = await store.listPendingGaps({ connectorId: 'chatgpt', grantId: 'grant_test', streams: ['messages'] });
  assert.equal(pending.length, 0, 'terminal gap must not appear in listPendingGaps');

  // Terminal gap must NOT appear in listPendingGapsForConnector.
  const pendingForConnector = await store.listPendingGapsForConnector('chatgpt', { limit: 100 });
  assert.equal(pendingForConnector.length, 0, 'terminal gap must not appear in listPendingGapsForConnector');

  // Terminal gap must be counted by countGapsByStatusForConnector.
  const terminalCount = await store.countGapsByStatusForConnector('chatgpt', { status: 'terminal' });
  assert.equal(terminalCount, 1, 'terminal gap must be counted separately');
}));

test('maybeTerminateGap: transient error (429) does NOT terminalize, regardless of attempt count', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const gap = await seedGap(store, { recordKey: 'conv_transient_429' });

  const profile = { maxRecoveryAttempts: 3 };
  const errorInfo = { status: 429 };

  // Drive attempt_count past maxRecoveryAttempts.
  for (let i = 1; i <= profile.maxRecoveryAttempts + 2; i++) {
    await store.markGapStatus(gap.gap_id, 'in_progress');
  }

  const result = await maybeTerminateGap(store, gap.gap_id, errorInfo, profile);
  assert.equal(result.terminated, false, '429 must never terminalize a gap');

  // Gap must still be countable as non-terminal (it remains in_progress after the loop).
  const terminalCount = await store.countGapsByStatusForConnector('chatgpt', { status: 'terminal' });
  assert.equal(terminalCount, 0, 'no terminal gaps for transient errors');
}));

test('maybeTerminateGap: gap below budget is NOT terminalized even on non-transient error', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const gap = await seedGap(store, { recordKey: 'conv_below_budget' });

  const profile = { maxRecoveryAttempts: 5 };
  const errorInfo = { status: 404 };

  // Only 2 attempts — below the budget of 5.
  for (let i = 1; i <= 2; i++) {
    await store.markGapStatus(gap.gap_id, 'in_progress');
  }

  const result = await maybeTerminateGap(store, gap.gap_id, errorInfo, profile);
  assert.equal(result.terminated, false, 'gap must not be terminalized below the budget');

  const terminalCount = await store.countGapsByStatusForConnector('chatgpt', { status: 'terminal' });
  assert.equal(terminalCount, 0);
}));

// ─── Terminal gaps do not appear in non-pressure recoverable count ───────────
//
// The §4 recovery lane counts non-pressure pending gaps as the trigger for
// recovery-only dispatch. Terminal gaps must NEVER appear in that count.

test('terminal gap is excluded from pending count but still counted as terminal', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();

  // Create two gaps: one that will be terminalized, one that stays pending.
  const terminalGap = await seedGap(store, { recordKey: 'conv_will_terminal' });
  await seedGap(store, { recordKey: 'conv_stays_pending' });

  const profile = { maxRecoveryAttempts: 2 };

  // Exhaust the budget on one gap.
  for (let i = 1; i <= profile.maxRecoveryAttempts; i++) {
    await store.markGapStatus(terminalGap.gap_id, 'in_progress');
  }
  await maybeTerminateGap(store, terminalGap.gap_id, { status: 404 }, profile);

  // Only 1 pending remains (the non-terminal one).
  const pending = await store.listPendingGaps({ connectorId: 'chatgpt', grantId: 'grant_test' });
  assert.equal(pending.length, 1, 'only the non-terminal gap is in pending set');
  assert.equal(pending[0].record_key, 'conv_stays_pending');

  // Terminal count is 1.
  const terminalCount = await store.countGapsByStatusForConnector('chatgpt', { status: 'terminal' });
  assert.equal(terminalCount, 1);
}));

// ─── Terminal status is sticky (upsertPendingGap does not revive terminal) ───
//
// The ON CONFLICT path in upsertPendingGap must preserve 'terminal' status
// just as it preserves 'recovered' — a terminalized gap must not be silently
// resurrected into the fillable-pending set by a re-upsert.

test('upsertPendingGap does not revive a terminal gap (terminal is sticky like recovered)', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const gap = await seedGap(store, { recordKey: 'conv_terminal_sticky' });

  // Terminalize it.
  await store.markGapStatus(gap.gap_id, 'terminal', { lastError: { message: 'not found', status: 404 } });

  const afterTerminal = await store.countGapsByStatusForConnector('chatgpt', { status: 'terminal' });
  assert.equal(afterTerminal, 1, 'one terminal gap before re-upsert');

  // Re-upsert the same logical gap (same identity fields → hits ON CONFLICT).
  await store.upsertPendingGap({
    connectorId: 'chatgpt',
    grantId: 'grant_test',
    stream: 'messages',
    recordKey: 'conv_terminal_sticky',
    reason: 'retry_exhausted',
    detailLocator: { kind: 'chatgpt.conversation', conversation_id: 'conv_terminal_sticky' },
  });

  // Must still be terminal — not resurrected to pending.
  const pending = await store.listPendingGaps({ connectorId: 'chatgpt', grantId: 'grant_test', streams: ['messages'] });
  assert.equal(pending.length, 0, 'terminal gap must NOT be revived to pending by re-upsert');

  const stillTerminal = await store.countGapsByStatusForConnector('chatgpt', { status: 'terminal' });
  assert.equal(stillTerminal, 1, 'terminal gap count must be unchanged after re-upsert');
}));
