/**
 * Mutation-killing unit tests for the connection-id-request helpers that
 * have no by-name unit coverage:
 *
 *   - buildLimitClampedWarning   (the canonical LIMIT_CLAMPED warning shape)
 *   - validateConnectionAlias    (canonical vs deprecated-alias disagreement
 *                                 throws invalid_argument on
 *                                 connector_instance_id; all other combos
 *                                 pass)
 *   - enforceConnectionNarrowing (a supplied connection_id / alias MUST
 *                                 address the grant's single storage
 *                                 binding, else typed connection_not_found)
 *
 * `clampRecordsPageLimit`, `resolveRequestConnectionId`, and
 * `projectStorageDisplayName` are already covered elsewhere
 * (records-limit-clamp / public-read-*), so this file deliberately does not
 * re-pin them.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANONICAL_WARNING_CODES,
  RECORDS_MAX_PAGE_LIMIT,
  buildLimitClampedWarning,
  enforceConnectionNarrowing,
  validateConnectionAlias,
} from '../server/connection-id-request.js';

function assertThrows(fn, { code, param, messageIncludes } = {}) {
  let thrown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'expected the call to throw, but it returned normally');
  if (code !== undefined) {
    assert.equal(thrown.code, code, `expected code=${code} got ${JSON.stringify(thrown.code)} (${thrown.message})`);
  }
  if (param !== undefined) {
    assert.equal(thrown.param, param, `expected param=${param} got ${JSON.stringify(thrown.param)}`);
  }
  if (messageIncludes !== undefined) {
    assert.ok(String(thrown.message).includes(messageIncludes), `message="${thrown.message}"`);
  }
  return thrown;
}

test('buildLimitClampedWarning: carries LIMIT_CLAMPED code, limit param, and the requested/max detail', () => {
  const w = buildLimitClampedWarning(500);
  assert.equal(w.code, CANONICAL_WARNING_CODES.LIMIT_CLAMPED);
  assert.equal(w.param, 'limit');
  assert.equal(w.detail.requested_limit, 500);
  assert.equal(w.detail.max_limit, RECORDS_MAX_PAGE_LIMIT);
  // The message must name the concrete requested value and the ceiling.
  assert.ok(w.message.includes('500'), w.message);
  assert.ok(w.message.includes(String(RECORDS_MAX_PAGE_LIMIT)), w.message);
});

test('validateConnectionAlias: no-op unless canonical and alias are BOTH set and DISAGREE', () => {
  // Non-object / empty inputs are no-ops.
  assert.equal(validateConnectionAlias(undefined), undefined);
  assert.equal(validateConnectionAlias(null), undefined);
  assert.equal(validateConnectionAlias({}), undefined);

  // Only canonical, only alias, or matching values -> pass.
  assert.equal(validateConnectionAlias({ connection_id: 'cin_1' }), undefined);
  assert.equal(validateConnectionAlias({ connector_instance_id: 'cin_1' }), undefined);
  assert.equal(validateConnectionAlias({ connection_id: 'cin_1', connector_instance_id: 'cin_1' }), undefined);
  // An empty-string alias does not count as "set", so no disagreement.
  assert.equal(validateConnectionAlias({ connection_id: 'cin_1', connector_instance_id: '' }), undefined);

  // Both set and different -> typed invalid_argument on the deprecated param.
  assertThrows(() => validateConnectionAlias({ connection_id: 'cin_1', connector_instance_id: 'cin_2' }), {
    code: 'invalid_argument',
    param: 'connector_instance_id',
    messageIncludes: 'same connection',
  });
});

test('enforceConnectionNarrowing: no connection_id -> no-op regardless of binding', () => {
  // Neither connection_id nor alias supplied: always allowed, even with no binding.
  assert.equal(enforceConnectionNarrowing({}, null), undefined);
  assert.equal(enforceConnectionNarrowing({}, 'cin_bound'), undefined);
  assert.equal(enforceConnectionNarrowing({ connection_id: '' }, 'cin_bound'), undefined);
});

test('enforceConnectionNarrowing: supplied connection_id must equal the bound instance', () => {
  // Matching canonical id -> allowed.
  assert.equal(enforceConnectionNarrowing({ connection_id: 'cin_bound' }, 'cin_bound'), undefined);
  // The deprecated alias is honored when it matches the binding.
  assert.equal(enforceConnectionNarrowing({ connector_instance_id: 'cin_bound' }, 'cin_bound'), undefined);

  // A connection_id present but NO binding on the grant -> connection_not_found.
  assertThrows(() => enforceConnectionNarrowing({ connection_id: 'cin_x' }, null), {
    code: 'connection_not_found',
    param: 'connection_id',
    messageIncludes: 'not addressable',
  });
  assertThrows(() => enforceConnectionNarrowing({ connection_id: 'cin_x' }, ''), {
    code: 'connection_not_found',
    param: 'connection_id',
  });

  // A connection_id that does not match the binding -> connection_not_found,
  // and the message names the offending id.
  assertThrows(() => enforceConnectionNarrowing({ connection_id: 'cin_other' }, 'cin_bound'), {
    code: 'connection_not_found',
    param: 'connection_id',
    messageIncludes: "cin_other",
  });
});
