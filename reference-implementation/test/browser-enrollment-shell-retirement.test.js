// Unit tests for the pure browser-enrollment-shell TTL classifier
// (server/browser-enrollment-shell-retirement.ts).
//
// `expiredEnrollmentShellIds` takes a shell list and an explicit `now`
// (no clock) and returns the ids to retire. Its four independent guards —
// status must be draft|active, binding kind must be browser_enrollment_shell,
// enrollment_expires_at must be a string, and expiresMs <= nowMs with NaN
// rejection — are each pinned below so a dropped guard turns the suite red.
//
// NOTE: `retireExpiredBrowserEnrollmentShells` (the store-writing variant) is
// out of scope; only the pure classifier is exercised.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { expiredEnrollmentShellIds } from '../server/browser-enrollment-shell-retirement.ts';

const NOW = '2026-07-02T00:00:00.000Z';

function shell(id, overrides = {}) {
  return {
    connectorInstanceId: id,
    status: 'draft',
    sourceBinding: {
      kind: 'browser_enrollment_shell',
      enrollment_expires_at: '2026-06-01T00:00:00.000Z', // well before NOW
    },
    ...overrides,
  };
}

test('retires an expired draft shell', () => {
  assert.deepEqual(expiredEnrollmentShellIds([shell('a')], NOW), ['a']);
});

test('retires an expired active shell (active != completed)', () => {
  assert.deepEqual(expiredEnrollmentShellIds([shell('a', { status: 'active' })], NOW), ['a']);
});

test('does not retire shells in other statuses', () => {
  assert.deepEqual(expiredEnrollmentShellIds([shell('a', { status: 'revoked' })], NOW), []);
  assert.deepEqual(expiredEnrollmentShellIds([shell('a', { status: 'completed' })], NOW), []);
});

test('does not retire when the binding kind is not a browser-enrollment shell', () => {
  const wrongKind = shell('a', {
    sourceBinding: { kind: 'something_else', enrollment_expires_at: '2026-06-01T00:00:00.000Z' },
  });
  assert.deepEqual(expiredEnrollmentShellIds([wrongKind], NOW), []);
});

test('does not retire when the binding is missing or null', () => {
  assert.deepEqual(expiredEnrollmentShellIds([shell('a', { sourceBinding: null })], NOW), []);
  assert.deepEqual(expiredEnrollmentShellIds([shell('a', { sourceBinding: undefined })], NOW), []);
});

test('treats a non-string enrollment_expires_at as not-yet-expired', () => {
  const noTtl = shell('a', {
    sourceBinding: { kind: 'browser_enrollment_shell', enrollment_expires_at: undefined },
  });
  assert.deepEqual(expiredEnrollmentShellIds([noTtl], NOW), []);
  const numericTtl = shell('a', {
    sourceBinding: { kind: 'browser_enrollment_shell', enrollment_expires_at: 12345 },
  });
  assert.deepEqual(expiredEnrollmentShellIds([numericTtl], NOW), []);
});

test('treats an unparseable enrollment_expires_at (NaN) as not-yet-expired', () => {
  const badDate = shell('a', {
    sourceBinding: { kind: 'browser_enrollment_shell', enrollment_expires_at: 'not-a-date' },
  });
  assert.deepEqual(expiredEnrollmentShellIds([badDate], NOW), []);
});

test('does NOT retire a shell whose TTL is in the future', () => {
  const future = shell('a', {
    sourceBinding: { kind: 'browser_enrollment_shell', enrollment_expires_at: '2026-08-01T00:00:00.000Z' },
  });
  assert.deepEqual(expiredEnrollmentShellIds([future], NOW), []);
});

test('retires a shell whose TTL is exactly now (inclusive boundary)', () => {
  // Guard is `expiresMs <= nowMs`, so expiry == now is retired.
  const atBoundary = shell('a', {
    sourceBinding: { kind: 'browser_enrollment_shell', enrollment_expires_at: NOW },
  });
  assert.deepEqual(expiredEnrollmentShellIds([atBoundary], NOW), ['a']);
});

test('filters a mixed list to only the expired, eligible shells', () => {
  const shells = [
    shell('expired-draft'),
    shell('expired-active', { status: 'active' }),
    shell('future', {
      sourceBinding: { kind: 'browser_enrollment_shell', enrollment_expires_at: '2027-01-01T00:00:00.000Z' },
    }),
    shell('wrong-status', { status: 'revoked' }),
  ];
  assert.deepEqual(expiredEnrollmentShellIds(shells, NOW), ['expired-draft', 'expired-active']);
});

test('returns an empty array for an empty input', () => {
  assert.deepEqual(expiredEnrollmentShellIds([], NOW), []);
});
