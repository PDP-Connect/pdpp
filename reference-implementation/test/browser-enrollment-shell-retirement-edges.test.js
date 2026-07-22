// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Supplementary mutation-killing coverage for the edge branches of
 * `expiredEnrollmentShellIds` in
 * `server/browser-enrollment-shell-retirement.ts`. The existing route test
 * covers the status/kind filters, the missing-TTL case, and the empty list,
 * but leaves these unpinned:
 *
 *   - the `<=` expiry boundary: a shell whose TTL is exactly `now` IS retired
 *     (a `<=`→`<` mutant would survive), while one a second in the future is
 *     not.
 *   - a malformed (unparseable) enrollment_expires_at -> Number.isNaN guard ->
 *     treated conservatively as not-yet-expired.
 *   - a non-string enrollment_expires_at (number) -> typeof guard -> skipped.
 *   - a null / absent sourceBinding -> optional-chain kind guard -> skipped.
 *
 * Pure TTL sweep; no auth/grant logic; no source change.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { expiredEnrollmentShellIds } from '../server/browser-enrollment-shell-retirement.ts';

const NOW = '2026-06-10T12:00:00.000Z';

function shell(connectorInstanceId, bindingOverrides, status = 'draft') {
  return {
    connectorInstanceId,
    status,
    sourceBinding:
      bindingOverrides === null
        ? null
        : { kind: 'browser_enrollment_shell', ...bindingOverrides },
  };
}

test('expiredEnrollmentShellIds retires a shell whose TTL is exactly now (inclusive boundary)', () => {
  assert.deepEqual(
    expiredEnrollmentShellIds([shell('cin_at', { enrollment_expires_at: NOW })], NOW),
    ['cin_at'],
  );
});

test('expiredEnrollmentShellIds does not retire a shell one second in the future', () => {
  assert.deepEqual(
    expiredEnrollmentShellIds([shell('cin_future', { enrollment_expires_at: '2026-06-10T12:00:01.000Z' })], NOW),
    [],
  );
});

test('expiredEnrollmentShellIds treats an unparseable TTL as not-yet-expired', () => {
  assert.deepEqual(
    expiredEnrollmentShellIds([shell('cin_bad', { enrollment_expires_at: 'not-a-date' })], NOW),
    [],
  );
});

test('expiredEnrollmentShellIds ignores a non-string TTL', () => {
  assert.deepEqual(
    expiredEnrollmentShellIds([shell('cin_num', { enrollment_expires_at: 1234567890 })], NOW),
    [],
  );
});

test('expiredEnrollmentShellIds skips a shell with a null or absent sourceBinding', () => {
  assert.deepEqual(expiredEnrollmentShellIds([shell('cin_null', null)], NOW), []);
  assert.deepEqual(
    expiredEnrollmentShellIds([{ connectorInstanceId: 'cin_absent', status: 'draft' }], NOW),
    [],
  );
});

test('expiredEnrollmentShellIds retires an expired active shell alongside a draft', () => {
  const ids = expiredEnrollmentShellIds(
    [
      shell('cin_draft', { enrollment_expires_at: '2026-06-10T10:00:00.000Z' }, 'draft'),
      shell('cin_active', { enrollment_expires_at: '2026-06-10T10:00:00.000Z' }, 'active'),
    ],
    NOW,
  );
  assert.deepEqual(ids, ['cin_draft', 'cin_active']);
});
