// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the two connection-id-request.js exports that had
// ZERO by-name coverage: enforceConnectionNarrowing (connection_not_found gate)
// and buildLimitClampedWarning (structured limit_clamped warning).
//
// (clampRecordsPageLimit, validateConnectionAlias, resolveRequestConnectionId,
// projectStorageDisplayName are already unit-pinned by records-limit-clamp.test.js,
// public-read-connection-alias.test.js, and public-read-deprecated-alias-warning.test.js;
// this file deliberately does not re-cover those.)
//
// enforceConnectionNarrowing is a READ-gate: these tests only OBSERVE that a
// requested connection_id must equal the bound storage identity (or the request
// is rejected connection_not_found). No grant/consent source is modified.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RECORDS_MAX_PAGE_LIMIT,
  buildLimitClampedWarning,
  enforceConnectionNarrowing,
} from '../server/connection-id-request.js';

// ---------------------------------------------------------------------------
// enforceConnectionNarrowing
// ---------------------------------------------------------------------------

function expectConnectionNotFound(fn) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, 'connection_not_found', `expected connection_not_found, got ${err.code}`);
    assert.equal(err.param, 'connection_id');
    return true;
  });
}

test('enforceConnectionNarrowing: no connection identity in the request is a no-op', () => {
  assert.doesNotThrow(() => enforceConnectionNarrowing({}, 'ci-bound'));
  assert.doesNotThrow(() => enforceConnectionNarrowing({ connection_id: '' }, 'ci-bound'));
  assert.doesNotThrow(() => enforceConnectionNarrowing(null, 'ci-bound'));
});

test('enforceConnectionNarrowing: canonical connection_id equal to the bound id passes', () => {
  assert.doesNotThrow(() => enforceConnectionNarrowing({ connection_id: 'ci-bound' }, 'ci-bound'));
});

test('enforceConnectionNarrowing: deprecated connector_instance_id alias equal to bound id passes', () => {
  assert.doesNotThrow(() => enforceConnectionNarrowing({ connector_instance_id: 'ci-bound' }, 'ci-bound'));
});

test('enforceConnectionNarrowing: connection_id that does NOT match the bound id is connection_not_found', () => {
  expectConnectionNotFound(() => enforceConnectionNarrowing({ connection_id: 'ci-other' }, 'ci-bound'));
});

test('enforceConnectionNarrowing: a requested connection with NO bound storage is connection_not_found', () => {
  expectConnectionNotFound(() => enforceConnectionNarrowing({ connection_id: 'ci-x' }, null));
  expectConnectionNotFound(() => enforceConnectionNarrowing({ connection_id: 'ci-x' }, ''));
});

test('enforceConnectionNarrowing: conflicting connection_id/alias is rejected before narrowing (invalid_argument)', () => {
  // resolveRequestConnectionId (called first) throws invalid_argument on a
  // conflicting pair — so narrowing never even compares against the binding.
  assert.throws(
    () => enforceConnectionNarrowing({ connection_id: 'a', connector_instance_id: 'b' }, 'a'),
    (err) => { assert.equal(err.code, 'invalid_argument'); return true; },
  );
});

// ---------------------------------------------------------------------------
// buildLimitClampedWarning
// ---------------------------------------------------------------------------

test('buildLimitClampedWarning: structured detail carries requested + max limit', () => {
  const w = buildLimitClampedWarning(500);
  assert.equal(w.code, 'limit_clamped');
  assert.equal(w.param, 'limit');
  assert.equal(w.detail.requested_limit, 500, 'echoes the requested limit');
  assert.equal(w.detail.max_limit, RECORDS_MAX_PAGE_LIMIT, 'reports the contract max');
  assert.equal(w.detail.max_limit, 100, 'contract max is 100');
  assert.ok(typeof w.message === 'string' && w.message.includes('500'), 'human message mentions requested value');
});

test('buildLimitClampedWarning: preserves the exact requested value it is given', () => {
  const w = buildLimitClampedWarning(101);
  assert.equal(w.detail.requested_limit, 101);
  assert.notEqual(w.detail.requested_limit, w.detail.max_limit, 'requested is distinct from max');
});
