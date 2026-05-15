import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCKED_PROMOTION_THRESHOLD,
  computeConnectorHealth,
} from '../runtime/connector-health.ts';
import { DISPLAY_MESSAGES } from '../runtime/display-messages.ts';

// ─── Test helpers ──────────────────────────────────────────────────────────

const CONNECTOR_ID = 'https://registry.pdpp.org/connectors/example';

function run(overrides = {}) {
  const {
    status = 'succeeded',
    knownGaps = [],
    terminalReason = null,
    failureReason = null,
    connectorError = null,
    completedAt = '2026-05-15T00:00:00.000Z',
    startedAt = '2026-05-15T00:00:00.000Z',
    recordsEmitted = 1,
  } = overrides;
  return {
    connectorId: CONNECTOR_ID,
    source: { kind: 'connector', id: CONNECTOR_ID },
    status,
    recordsEmitted,
    reportedRecordsEmitted: null,
    checkpointSummary: null,
    knownGaps,
    runId: null,
    traceId: null,
    failureReason,
    terminalReason,
    connectorError,
    startedAt,
    completedAt,
    attempt: 1,
  };
}

function input(overrides = {}) {
  return {
    recentRuns: [],
    schedule: { enabled: true },
    activeAssistance: null,
    backoffState: null,
    ...overrides,
  };
}

function backoff(overrides = {}) {
  return {
    backoffApplied: true,
    consecutiveFailures: 3,
    reasonClass: 'connector:reddit_login_unexpected_ui',
    nextRunAt: '2026-05-15T01:00:00.000Z',
    ...overrides,
  };
}

// ─── BLOCKED_PROMOTION_THRESHOLD constant ─────────────────────────────────

test('BLOCKED_PROMOTION_THRESHOLD is 7 (matches design brief §1.3)', () => {
  assert.equal(BLOCKED_PROMOTION_THRESHOLD, 7);
});

// ─── All six states reachable ──────────────────────────────────────────────

test('idle: no recent runs and enabled schedule yields idle with manual_paused=false', () => {
  const snap = computeConnectorHealth(input());
  assert.equal(snap.state, 'idle');
  assert.equal(snap.manual_paused, false);
  assert.equal(snap.consecutive_failures, 0);
  assert.equal(snap.last_success_at, null);
});

test('idle (manual_paused): disabled schedule yields idle with manual_paused=true', () => {
  const snap = computeConnectorHealth(
    input({
      recentRuns: [run({ status: 'succeeded' })],
      schedule: { enabled: false },
    })
  );
  assert.equal(snap.state, 'idle');
  assert.equal(snap.manual_paused, true);
});

test('healthy: last run succeeded with no gaps', () => {
  const snap = computeConnectorHealth(
    input({ recentRuns: [run({ status: 'succeeded' })] })
  );
  assert.equal(snap.state, 'healthy');
  assert.equal(snap.reason_code, null);
  assert.equal(snap.display_message, null);
  assert.equal(snap.last_success_at, '2026-05-15T00:00:00.000Z');
});

test('degraded: last run succeeded_with_gaps (succeeded + knownGaps non-empty)', () => {
  const snap = computeConnectorHealth(
    input({
      recentRuns: [run({ status: 'succeeded', knownGaps: [{ reason: 'not_available' }] })],
    })
  );
  assert.equal(snap.state, 'degraded');
  assert.equal(snap.reason_code, 'not_available');
  assert.equal(snap.display_message, DISPLAY_MESSAGES.not_available);
});

test('needs_attention: active assistance event takes priority over outcome', () => {
  const snap = computeConnectorHealth(
    input({
      recentRuns: [run({ status: 'succeeded' })],
      activeAssistance: { reason_code: 'cloudflare_challenge' },
    })
  );
  assert.equal(snap.state, 'needs_attention');
  assert.equal(snap.reason_code, 'cloudflare_challenge');
  assert.equal(snap.display_message, DISPLAY_MESSAGES.cloudflare_challenge);
});

test('cooling_off: backoffApplied with consecutiveFailures < 7', () => {
  const snap = computeConnectorHealth(
    input({
      recentRuns: [run({ status: 'failed' })],
      backoffState: backoff({ consecutiveFailures: 5 }),
    })
  );
  assert.equal(snap.state, 'cooling_off');
  assert.equal(snap.consecutive_failures, 5);
  assert.equal(snap.reason_code, 'reddit_login_unexpected_ui');
  assert.equal(snap.display_message, DISPLAY_MESSAGES.reddit_login_unexpected_ui);
  assert.equal(snap.next_attempt_at, '2026-05-15T01:00:00.000Z');
});

test('blocked: backoff with consecutiveFailures >= 7', () => {
  const snap = computeConnectorHealth(
    input({
      recentRuns: [run({ status: 'failed' })],
      backoffState: backoff({ consecutiveFailures: 7 }),
    })
  );
  assert.equal(snap.state, 'blocked');
  assert.equal(snap.consecutive_failures, 7);
  assert.equal(snap.reason_code, 'reddit_login_unexpected_ui');
});

// ─── Decision-order precedence ─────────────────────────────────────────────

test('precedence: manual_paused beats assistance, beats backoff, beats outcome', () => {
  // All four signals "active". Expect manual_paused to win.
  const snap = computeConnectorHealth(
    input({
      recentRuns: [run({ status: 'failed' })],
      schedule: { enabled: false },
      activeAssistance: { reason_code: 'cloudflare_challenge' },
      backoffState: backoff({ consecutiveFailures: 9 }),
    })
  );
  assert.equal(snap.state, 'idle');
  assert.equal(snap.manual_paused, true);
});

test('precedence: assistance beats backoff (blocked) when schedule enabled', () => {
  const snap = computeConnectorHealth(
    input({
      recentRuns: [run({ status: 'failed' })],
      activeAssistance: { reason_code: 'cloudflare_challenge' },
      backoffState: backoff({ consecutiveFailures: 9 }),
    })
  );
  assert.equal(snap.state, 'needs_attention');
});

test('precedence: backoff (blocked) beats last-run outcome', () => {
  const snap = computeConnectorHealth(
    input({
      recentRuns: [run({ status: 'succeeded' })], // claims success
      backoffState: backoff({ consecutiveFailures: 8 }), // but streak still active
    })
  );
  assert.equal(snap.state, 'blocked');
});

// ─── Boundary tests: 6 vs 7 ────────────────────────────────────────────────

test('boundary: consecutiveFailures === 6 → cooling_off (NOT blocked)', () => {
  const snap = computeConnectorHealth(
    input({
      recentRuns: [run({ status: 'failed' })],
      backoffState: backoff({ consecutiveFailures: 6 }),
    })
  );
  assert.equal(snap.state, 'cooling_off');
});

test('boundary: consecutiveFailures === 7 → blocked', () => {
  const snap = computeConnectorHealth(
    input({
      recentRuns: [run({ status: 'failed' })],
      backoffState: backoff({ consecutiveFailures: 7 }),
    })
  );
  assert.equal(snap.state, 'blocked');
});

test('boundary: consecutiveFailures === 8 → blocked (still)', () => {
  const snap = computeConnectorHealth(
    input({
      recentRuns: [run({ status: 'failed' })],
      backoffState: backoff({ consecutiveFailures: 8 }),
    })
  );
  assert.equal(snap.state, 'blocked');
});

// ─── Mixed-reason streak does NOT promote ──────────────────────────────────

test('mixed-reason streak: blocked promotion is driven by the helper, not by raw failure counts', () => {
  // Per Worker C semantics, `consecutiveFailures` in the BackoffState
  // is the count of *same-class* trailing failures. If a mixed-reason
  // history produced consecutiveFailures < 7, the classifier must not
  // promote to blocked even if many total failures exist in history.
  const recentRuns = [
    run({ status: 'failed', terminalReason: 'authentication_error' }),
    run({ status: 'failed', terminalReason: 'authentication_error' }),
    run({ status: 'failed', terminalReason: 'authentication_error' }),
    run({ status: 'failed', connectorError: { reason: 'reddit_login_unexpected_ui' } }),
  ];
  // Helper counted only the trailing run as one class:
  const state = computeConnectorHealth(
    input({
      recentRuns,
      backoffState: {
        backoffApplied: false,
        consecutiveFailures: 1,
        reasonClass: 'connector:reddit_login_unexpected_ui',
        nextRunAt: null,
      },
    })
  );
  // Last run failed, no back-off engaged → falls through to degraded
  // (the "one failure under cadence" shape), NOT to blocked.
  assert.notEqual(state.state, 'blocked');
  assert.equal(state.state, 'degraded');
});

// ─── display_message population ────────────────────────────────────────────

test('display_message is populated when reason_code is in the registry', () => {
  const snap = computeConnectorHealth(
    input({
      recentRuns: [run({ status: 'failed' })],
      backoffState: backoff({
        consecutiveFailures: 4,
        reasonClass: 'connector:reddit_login_unexpected_ui',
      }),
    })
  );
  assert.equal(snap.reason_code, 'reddit_login_unexpected_ui');
  assert.equal(snap.display_message, 'Reddit is asking for extra verification');
});

test('display_message is null when reason_code is null (healthy state)', () => {
  const snap = computeConnectorHealth(
    input({ recentRuns: [run({ status: 'succeeded' })] })
  );
  assert.equal(snap.reason_code, null);
  assert.equal(snap.display_message, null);
});

test('display_message is null for an unregistered reason_code (UI handles fallback)', () => {
  const snap = computeConnectorHealth(
    input({
      recentRuns: [run({ status: 'failed' })],
      backoffState: backoff({
        consecutiveFailures: 4,
        reasonClass: 'connector:some_brand_new_reason_we_have_not_vetted',
      }),
    })
  );
  assert.equal(snap.reason_code, 'some_brand_new_reason_we_have_not_vetted');
  assert.equal(snap.display_message, null);
});

// ─── Recovery: last_success_at exposed even when degraded/blocked ─────────

test('last_success_at is the most recent succeeded run completedAt', () => {
  const snap = computeConnectorHealth(
    input({
      recentRuns: [
        run({ status: 'failed', completedAt: '2026-05-15T03:00:00.000Z' }),
        run({ status: 'succeeded', completedAt: '2026-05-15T02:00:00.000Z' }),
        run({ status: 'failed', completedAt: '2026-05-15T01:00:00.000Z' }),
      ],
      backoffState: backoff({ consecutiveFailures: 9 }),
    })
  );
  assert.equal(snap.state, 'blocked');
  assert.equal(snap.last_success_at, '2026-05-15T02:00:00.000Z');
});
