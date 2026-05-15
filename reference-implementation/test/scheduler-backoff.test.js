import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BACKOFF_THRESHOLD,
  computeNextRunWithBackoff,
  reasonClassOf,
} from '../runtime/scheduler-backoff.ts';

// ─── Test helpers ──────────────────────────────────────────────────────────

const BASE_INTERVAL_MS = 60_000; // 1 minute
const CONNECTOR_ID = 'https://registry.pdpp.org/connectors/example';
const T0 = 1_700_000_000_000; // arbitrary fixed epoch

function record(overrides = {}) {
  const {
    status = 'failed',
    terminalReason = null,
    failureReason = null,
    connectorError = null,
    attempt = 1,
    startedAt = '2026-05-15T00:00:00.000Z',
    completedAt = '2026-05-15T00:00:01.000Z',
    recordsEmitted = 0,
  } = overrides;
  return {
    connectorId: CONNECTOR_ID,
    source: { kind: 'connector', id: CONNECTOR_ID },
    status,
    recordsEmitted,
    reportedRecordsEmitted: null,
    checkpointSummary: null,
    knownGaps: [],
    runId: null,
    traceId: null,
    failureReason,
    terminalReason,
    connectorError,
    startedAt,
    completedAt,
    attempt,
  };
}

function failedRun(reasonOverrides) {
  return record({ status: 'failed', ...reasonOverrides });
}

function successRun() {
  return record({ status: 'succeeded', recordsEmitted: 1 });
}

function skippedRun() {
  return record({ status: 'skipped' });
}

// ─── reasonClassOf ─────────────────────────────────────────────────────────

test('reasonClassOf prefers terminalReason for failed records', () => {
  const r = failedRun({ terminalReason: 'authentication_error' });
  assert.equal(reasonClassOf(r), 'terminal:authentication_error');
});

test('reasonClassOf falls back to failureReason when no terminalReason', () => {
  const r = failedRun({ failureReason: 'connector_protocol_violation' });
  assert.equal(reasonClassOf(r), 'failure:connector_protocol_violation');
});

test('reasonClassOf reads connectorError.reason when neither terminal nor failure reason exist', () => {
  const r = failedRun({ connectorError: { reason: 'reddit_login_unexpected_ui' } });
  assert.equal(reasonClassOf(r), 'connector:reddit_login_unexpected_ui');
});

test('reasonClassOf returns failure:unknown for a failed record with no reason fields', () => {
  const r = failedRun({});
  assert.equal(reasonClassOf(r), 'failure:unknown');
});

test('reasonClassOf returns null for non-failed records', () => {
  assert.equal(reasonClassOf(successRun()), null);
  assert.equal(reasonClassOf(skippedRun()), null);
});

// ─── computeNextRunWithBackoff: threshold behavior ────────────────────────

test('no history yields no back-off and a nextRunAt of lastRun + base interval', () => {
  const decision = computeNextRunWithBackoff([], BASE_INTERVAL_MS, T0);
  assert.equal(decision.backoffApplied, false);
  assert.equal(decision.consecutiveFailures, 0);
  assert.equal(decision.reasonClass, null);
  assert.equal(decision.effectiveIntervalMs, BASE_INTERVAL_MS);
  assert.equal(decision.nextRunAt, new Date(T0 + BASE_INTERVAL_MS).toISOString());
});

test('2 consecutive same-class failures (under threshold of 3) do not engage back-off', () => {
  const history = [
    failedRun({ connectorError: { reason: 'reddit_login_unexpected_ui' } }),
    failedRun({ connectorError: { reason: 'reddit_login_unexpected_ui' } }),
  ];
  const decision = computeNextRunWithBackoff(history, BASE_INTERVAL_MS, T0);
  assert.equal(decision.backoffApplied, false);
  assert.equal(decision.consecutiveFailures, 2);
  assert.equal(decision.reasonClass, 'connector:reddit_login_unexpected_ui');
  assert.equal(decision.effectiveIntervalMs, BASE_INTERVAL_MS);
});

test('3 consecutive same-class failures engage first back-off at 1x base interval', () => {
  const history = Array.from({ length: 3 }, () =>
    failedRun({ connectorError: { reason: 'reddit_login_unexpected_ui' } })
  );
  const decision = computeNextRunWithBackoff(history, BASE_INTERVAL_MS, T0);
  assert.equal(decision.backoffApplied, true);
  assert.equal(decision.consecutiveFailures, 3);
  assert.equal(decision.reasonClass, 'connector:reddit_login_unexpected_ui');
  // At the threshold the exponent is 0, so effective == base.
  assert.equal(decision.effectiveIntervalMs, BASE_INTERVAL_MS);
  assert.equal(decision.nextRunAt, new Date(T0 + BASE_INTERVAL_MS).toISOString());
});

test('4 consecutive same-class failures yield 2x base interval (2^1)', () => {
  const history = Array.from({ length: 4 }, () =>
    failedRun({ terminalReason: 'authentication_error' })
  );
  const decision = computeNextRunWithBackoff(history, BASE_INTERVAL_MS, T0);
  assert.equal(decision.backoffApplied, true);
  assert.equal(decision.consecutiveFailures, 4);
  assert.equal(decision.effectiveIntervalMs, BASE_INTERVAL_MS * 2);
});

test('5 consecutive same-class failures yield 4x base interval (2^2)', () => {
  const history = Array.from({ length: 5 }, () =>
    failedRun({ terminalReason: 'authentication_error' })
  );
  const decision = computeNextRunWithBackoff(history, BASE_INTERVAL_MS, T0);
  assert.equal(decision.backoffApplied, true);
  assert.equal(decision.effectiveIntervalMs, BASE_INTERVAL_MS * 4);
});

// ─── Mixed reasons must break the streak ──────────────────────────────────

test('mixed reason classes do not engage back-off — must be the same class', () => {
  // Three failures total but two distinct classes: scheduler should only
  // count the trailing run of identical-class failures (here: 1).
  const history = [
    failedRun({ connectorError: { reason: 'reddit_login_unexpected_ui' } }),
    failedRun({ connectorError: { reason: 'reddit_login_unexpected_ui' } }),
    failedRun({ terminalReason: 'authentication_error' }),
  ];
  const decision = computeNextRunWithBackoff(history, BASE_INTERVAL_MS, T0);
  assert.equal(decision.backoffApplied, false);
  assert.equal(decision.consecutiveFailures, 1);
  assert.equal(decision.reasonClass, 'terminal:authentication_error');
});

test('mixed reason failures still engage back-off when the latest streak alone is over threshold', () => {
  // Three trailing authentication errors after one earlier different
  // failure — still over threshold for the trailing class.
  const history = [
    failedRun({ connectorError: { reason: 'reddit_login_unexpected_ui' } }),
    failedRun({ terminalReason: 'authentication_error' }),
    failedRun({ terminalReason: 'authentication_error' }),
    failedRun({ terminalReason: 'authentication_error' }),
  ];
  const decision = computeNextRunWithBackoff(history, BASE_INTERVAL_MS, T0);
  assert.equal(decision.backoffApplied, true);
  assert.equal(decision.consecutiveFailures, 3);
  assert.equal(decision.reasonClass, 'terminal:authentication_error');
  assert.equal(decision.effectiveIntervalMs, BASE_INTERVAL_MS);
});

// ─── Success resets ───────────────────────────────────────────────────────

test('a success after failures resets the consecutive-failure counter', () => {
  // 5 failures, then a success, then 1 failure: count = 1.
  const history = [
    ...Array.from({ length: 5 }, () => failedRun({ terminalReason: 'authentication_error' })),
    successRun(),
    failedRun({ terminalReason: 'authentication_error' }),
  ];
  const decision = computeNextRunWithBackoff(history, BASE_INTERVAL_MS, T0);
  assert.equal(decision.backoffApplied, false);
  assert.equal(decision.consecutiveFailures, 1);
  assert.equal(decision.effectiveIntervalMs, BASE_INTERVAL_MS);
});

test('a success at the tail of history resets to no failures', () => {
  const history = [
    ...Array.from({ length: 12 }, () => failedRun({ connectorError: { reason: 'reddit_login_unexpected_ui' } })),
    successRun(),
  ];
  const decision = computeNextRunWithBackoff(history, BASE_INTERVAL_MS, T0);
  assert.equal(decision.backoffApplied, false);
  assert.equal(decision.consecutiveFailures, 0);
  assert.equal(decision.reasonClass, null);
});

// ─── Manual override ─────────────────────────────────────────────────────

test('manual: true bypasses back-off even with a deep failure streak', () => {
  const history = Array.from({ length: 12 }, () =>
    failedRun({ connectorError: { reason: 'reddit_login_unexpected_ui' } })
  );
  const decision = computeNextRunWithBackoff(history, BASE_INTERVAL_MS, T0, { manual: true });
  assert.equal(decision.backoffApplied, false);
  assert.equal(decision.consecutiveFailures, 0);
  assert.equal(decision.reasonClass, null);
  assert.equal(decision.effectiveIntervalMs, 0);
});

// ─── Caps + skipped records ──────────────────────────────────────────────

test('effective interval is capped by maxBackoffMs', () => {
  // 12 failures with base=1m and default maxBackoffMs=24h:
  // exponent = 12 - 3 = 9 (capped to maxBackoffExp=8) -> 256m -> still < 24h
  const history = Array.from({ length: 12 }, () =>
    failedRun({ terminalReason: 'authentication_error' })
  );
  const decision = computeNextRunWithBackoff(history, BASE_INTERVAL_MS, T0);
  assert.equal(decision.backoffApplied, true);
  // 60_000 * 2^8 = 15_360_000ms = 256 minutes, under the 24h ceiling.
  assert.equal(decision.effectiveIntervalMs, BASE_INTERVAL_MS * 256);
});

test('explicit small maxBackoffMs caps the effective interval', () => {
  const history = Array.from({ length: 6 }, () =>
    failedRun({ terminalReason: 'authentication_error' })
  );
  const cap = BASE_INTERVAL_MS * 3; // smaller than the natural 2^3=8 multiplier
  const decision = computeNextRunWithBackoff(history, BASE_INTERVAL_MS, T0, { maxBackoffMs: cap });
  assert.equal(decision.backoffApplied, true);
  assert.equal(decision.effectiveIntervalMs, cap);
});

test('skipped records are ignored when counting the streak (neither reset nor extend)', () => {
  // Failures with a back-off skip record interleaved still count as a
  // single streak: the back-off skip itself shouldn't reset things.
  const history = [
    failedRun({ terminalReason: 'authentication_error' }),
    failedRun({ terminalReason: 'authentication_error' }),
    skippedRun(),
    failedRun({ terminalReason: 'authentication_error' }),
  ];
  const decision = computeNextRunWithBackoff(history, BASE_INTERVAL_MS, T0);
  assert.equal(decision.consecutiveFailures, 3);
  assert.equal(decision.backoffApplied, true);
});

// ─── Threshold tunable ────────────────────────────────────────────────────

test('DEFAULT_BACKOFF_THRESHOLD is 3', () => {
  // Pinning the constant so we notice if it ever drifts without intent.
  assert.equal(DEFAULT_BACKOFF_THRESHOLD, 3);
});

test('custom threshold of 2 engages back-off earlier', () => {
  const history = Array.from({ length: 2 }, () =>
    failedRun({ terminalReason: 'authentication_error' })
  );
  const decision = computeNextRunWithBackoff(history, BASE_INTERVAL_MS, T0, { backoffThreshold: 2 });
  assert.equal(decision.backoffApplied, true);
  assert.equal(decision.consecutiveFailures, 2);
});

test('malformed timing inputs do not throw or emit invalid timestamps', () => {
  const history = Array.from({ length: 3 }, () =>
    failedRun({ terminalReason: 'authentication_error' })
  );
  const cases = [
    { baseIntervalMs: Number.NaN, lastRunAtMs: T0 },
    { baseIntervalMs: Number.POSITIVE_INFINITY, lastRunAtMs: T0 },
    { baseIntervalMs: BASE_INTERVAL_MS, lastRunAtMs: Number.POSITIVE_INFINITY },
    { baseIntervalMs: -1, lastRunAtMs: -1 },
  ];

  for (const c of cases) {
    const decision = computeNextRunWithBackoff(history, c.baseIntervalMs, c.lastRunAtMs);
    assert.equal(Number.isFinite(decision.effectiveIntervalMs), true);
    assert.equal(Number.isNaN(Date.parse(decision.nextRunAt)), false);
  }
});

test('malformed tunables fall back to safe defaults', () => {
  const history = Array.from({ length: 3 }, () =>
    failedRun({ terminalReason: 'authentication_error' })
  );
  const decision = computeNextRunWithBackoff(history, BASE_INTERVAL_MS, T0, {
    backoffThreshold: Number.NaN,
    maxBackoffExp: Number.POSITIVE_INFINITY,
    maxBackoffMs: Number.NaN,
  });

  assert.equal(decision.backoffApplied, true);
  assert.equal(decision.effectiveIntervalMs, BASE_INTERVAL_MS);
  assert.equal(decision.nextRunAt, new Date(T0 + BASE_INTERVAL_MS).toISOString());
});
