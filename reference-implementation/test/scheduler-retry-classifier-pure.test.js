// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the scheduler RETRY CLASSIFIER in
// runtime/scheduler-retry-classifier.ts. No test imports this module by name.
// This classifier decides whether a failed connector run is retried or left
// terminal — a wrong verdict either hammers a permanently-broken source or
// abandons a transient failure. It is exactly the kind of pure decision table
// that off-by-one / set-membership mutants silently corrupt.
//
// Mutation surface:
//   isRetryableHttpStatus -- 4xx (except 429) is NOT retryable; 429 (source
//     pressure) and 5xx and non-integer status ARE retryable. The `!== 429`
//     carve-out is the load-bearing bit: 429 must ALWAYS retry.
//   shouldRetryRunFailure -- composite AND-gate: retry only if the HTTP status is
//     retryable AND failure_reason is not in the non-retryable set AND
//     terminal_reason is not in the non-retryable set AND connector_error.retryable
//     is not explicitly false. Null err -> do not retry.
//   isTerminalGrantFailure -- membership in the grant-terminal reason set only
//     (auth/permission are non-retryable but are NOT grant failures).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NON_RETRYABLE_FAILURE_REASONS,
  TERMINAL_GRANT_FAILURE_REASONS,
  isRetryableHttpStatus,
  isTerminalGrantFailure,
  shouldRetryRunFailure,
} from '../runtime/scheduler-retry-classifier.ts';

// ---------------------------------------------------------------------------
// isRetryableHttpStatus
// ---------------------------------------------------------------------------

test('isRetryableHttpStatus: 4xx (except 429) is NOT retryable', () => {
  assert.equal(isRetryableHttpStatus(400), false);
  assert.equal(isRetryableHttpStatus(401), false);
  assert.equal(isRetryableHttpStatus(403), false);
  assert.equal(isRetryableHttpStatus(404), false);
  assert.equal(isRetryableHttpStatus(499), false);
});

test('isRetryableHttpStatus: 429 (source pressure) IS retryable — the load-bearing carve-out', () => {
  assert.equal(isRetryableHttpStatus(429), true, '429 must always be retryable');
});

test('isRetryableHttpStatus: 5xx and sub-400 statuses are retryable', () => {
  assert.equal(isRetryableHttpStatus(500), true);
  assert.equal(isRetryableHttpStatus(503), true);
  assert.equal(isRetryableHttpStatus(399), true, 'below the 4xx band -> retryable');
  assert.equal(isRetryableHttpStatus(200), true);
});

test('isRetryableHttpStatus: a non-integer / absent status is retryable (unknown -> retry)', () => {
  assert.equal(isRetryableHttpStatus(null), true);
  assert.equal(isRetryableHttpStatus(undefined), true);
  assert.equal(isRetryableHttpStatus('404'), true, 'non-integer string is not a real 4xx');
});

// ---------------------------------------------------------------------------
// shouldRetryRunFailure
// ---------------------------------------------------------------------------

test('shouldRetryRunFailure: a bare/empty error is retryable by default', () => {
  assert.equal(shouldRetryRunFailure({}), true);
});

test('shouldRetryRunFailure: a null/undefined error is NOT retryable', () => {
  assert.equal(shouldRetryRunFailure(null), false);
  assert.equal(shouldRetryRunFailure(undefined), false);
});

test('shouldRetryRunFailure: a non-retryable HTTP status blocks retry', () => {
  assert.equal(shouldRetryRunFailure({ response_status: 404 }), false);
  assert.equal(shouldRetryRunFailure({ response_status: 429 }), true, '429 still retries through the composite gate');
});

test('shouldRetryRunFailure: a non-retryable failure_reason blocks retry', () => {
  for (const reason of ['authentication_error', 'grant_revoked', 'permission_error', 'grant_invalid']) {
    assert.equal(shouldRetryRunFailure({ failure_reason: reason }), false, `${reason} must not retry`);
  }
  // A reason NOT in the set does not block.
  assert.equal(shouldRetryRunFailure({ failure_reason: 'transient_network_blip' }), true);
});

test('shouldRetryRunFailure: a non-retryable terminal_reason blocks retry', () => {
  assert.equal(shouldRetryRunFailure({ terminal_reason: 'connector_reported_cancelled' }), false);
  assert.equal(shouldRetryRunFailure({ terminal_reason: 'grant_expired' }), false);
});

test('shouldRetryRunFailure: connector_error.retryable === false blocks retry', () => {
  assert.equal(shouldRetryRunFailure({ connector_error: { retryable: false } }), false);
  // retryable true or absent does not block on its own.
  assert.equal(shouldRetryRunFailure({ connector_error: { retryable: true } }), true);
  assert.equal(shouldRetryRunFailure({ connector_error: {} }), true, 'absent retryable flag is not a block');
});

// ---------------------------------------------------------------------------
// isTerminalGrantFailure
// ---------------------------------------------------------------------------

test('isTerminalGrantFailure: true only for the grant-terminal reasons', () => {
  for (const reason of ['grant_consumed', 'grant_expired', 'grant_invalid', 'grant_revoked']) {
    assert.equal(isTerminalGrantFailure(reason), true, `${reason} is a terminal grant failure`);
  }
});

test('isTerminalGrantFailure: auth/permission are non-retryable but NOT grant failures', () => {
  assert.equal(isTerminalGrantFailure('authentication_error'), false);
  assert.equal(isTerminalGrantFailure('permission_error'), false);
  assert.equal(isTerminalGrantFailure(null), false);
  assert.equal(isTerminalGrantFailure(undefined), false);
  assert.equal(isTerminalGrantFailure('anything_else'), false);
});

test('exported reason sets: grant reasons are a strict subset of the non-retryable failure reasons', () => {
  for (const reason of TERMINAL_GRANT_FAILURE_REASONS) {
    assert.ok(NON_RETRYABLE_FAILURE_REASONS.has(reason), `${reason} should also be non-retryable`);
  }
  // auth is non-retryable but not a grant reason (proves the sets are distinct).
  assert.ok(NON_RETRYABLE_FAILURE_REASONS.has('authentication_error'));
  assert.ok(!TERMINAL_GRANT_FAILURE_REASONS.has('authentication_error'));
});
