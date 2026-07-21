/**
 * Mutation-killing coverage for the connection-id request helpers whose
 * branches the existing tests (`records-limit-clamp`,
 * `public-read-deprecated-alias-warning`) leave unpinned:
 *
 *   - buildLimitClampedWarning: zero prior tests — the structured warning
 *     shape (code/param/detail/message) is unasserted.
 *   - validateConnectionAlias: the non-object short-circuit, the matching /
 *     single-field no-throw paths, and the conflicting-values throw.
 *   - projectStorageDisplayName: non-string / whitespace input, each of the
 *     three placeholder labels, connectorId-equality, connectorInstanceId-
 *     equality, and a genuinely-meaningful label passing through.
 *   - enforceConnectionNarrowing: OBSERVED here (this is connection-scope
 *     enforcement — test-only, no source change). Pins the noop path, the
 *     canonical/alias match, and the three connection_not_found throws
 *     (value mismatch, empty bound, non-string bound).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLimitClampedWarning,
  CANONICAL_WARNING_CODES,
  enforceConnectionNarrowing,
  projectStorageDisplayName,
  RECORDS_MAX_PAGE_LIMIT,
  validateConnectionAlias,
} from '../server/connection-id-request.js';

// ─── buildLimitClampedWarning ────────────────────────────────────────────

test('buildLimitClampedWarning carries the canonical code, param, and machine detail', () => {
  const warning = buildLimitClampedWarning(500);
  assert.equal(warning.code, CANONICAL_WARNING_CODES.LIMIT_CLAMPED);
  assert.equal(warning.param, 'limit');
  assert.deepEqual(warning.detail, { requested_limit: 500, max_limit: RECORDS_MAX_PAGE_LIMIT });
  assert.match(warning.message, /500/);
  assert.match(warning.message, new RegExp(String(RECORDS_MAX_PAGE_LIMIT)));
});

// ─── validateConnectionAlias ─────────────────────────────────────────────

test('validateConnectionAlias is a no-op for non-object / nullish input', () => {
  assert.doesNotThrow(() => validateConnectionAlias(null));
  assert.doesNotThrow(() => validateConnectionAlias(undefined));
  assert.doesNotThrow(() => validateConnectionAlias('x'));
});

test('validateConnectionAlias accepts matching or single-field identifiers', () => {
  assert.doesNotThrow(() => validateConnectionAlias({ connection_id: 'a', connector_instance_id: 'a' }));
  assert.doesNotThrow(() => validateConnectionAlias({ connection_id: 'a' }));
  assert.doesNotThrow(() => validateConnectionAlias({ connector_instance_id: 'a' }));
  assert.doesNotThrow(() => validateConnectionAlias({}));
});

test('validateConnectionAlias throws invalid_argument on conflicting values', () => {
  assert.throws(
    () => validateConnectionAlias({ connection_id: 'a', connector_instance_id: 'b' }),
    (err) => {
      assert.equal(err.code, 'invalid_argument');
      assert.equal(err.param, 'connector_instance_id');
      return true;
    },
  );
});

// ─── projectStorageDisplayName ───────────────────────────────────────────

test('projectStorageDisplayName returns null for non-string or blank labels', () => {
  assert.equal(projectStorageDisplayName(123, {}), null);
  assert.equal(projectStorageDisplayName(null, {}), null);
  assert.equal(projectStorageDisplayName('   ', {}), null);
});

test('projectStorageDisplayName treats each documented placeholder as unlabeled', () => {
  assert.equal(projectStorageDisplayName('legacy', {}), null);
  assert.equal(projectStorageDisplayName('default_account', {}), null);
  assert.equal(projectStorageDisplayName('Default account', {}), null);
});

test('projectStorageDisplayName drops a label that equals the connectorId', () => {
  assert.equal(projectStorageDisplayName('my-conn', { connectorId: 'my-conn' }), null);
});

test('projectStorageDisplayName drops a label that equals the connectorInstanceId', () => {
  assert.equal(projectStorageDisplayName('cin_1', { connectorInstanceId: 'cin_1' }), null);
});

test('projectStorageDisplayName passes through a genuinely owner-meaningful label', () => {
  assert.equal(
    projectStorageDisplayName('My Gmail', { connectorId: 'gmail', connectorInstanceId: 'cin_1' }),
    'My Gmail',
  );
});

// ─── enforceConnectionNarrowing (observed connection-scope enforcement) ───

test('enforceConnectionNarrowing is a no-op when no connection_id is requested', () => {
  assert.doesNotThrow(() => enforceConnectionNarrowing({}, 'cin_abc'));
  assert.doesNotThrow(() => enforceConnectionNarrowing({ connection_id: '' }, 'cin_abc'));
});

test('enforceConnectionNarrowing accepts a canonical id that addresses the bound storage', () => {
  assert.doesNotThrow(() => enforceConnectionNarrowing({ connection_id: 'cin_abc' }, 'cin_abc'));
});

test('enforceConnectionNarrowing accepts the deprecated alias when it matches the bound storage', () => {
  assert.doesNotThrow(() => enforceConnectionNarrowing({ connector_instance_id: 'cin_abc' }, 'cin_abc'));
});

test('enforceConnectionNarrowing throws connection_not_found when the id does not match the binding', () => {
  assert.throws(
    () => enforceConnectionNarrowing({ connection_id: 'cin_xyz' }, 'cin_abc'),
    (err) => {
      assert.equal(err.code, 'connection_not_found');
      assert.equal(err.param, 'connection_id');
      return true;
    },
  );
});

test('enforceConnectionNarrowing throws connection_not_found when the grant has no bound storage', () => {
  for (const bound of ['', null, undefined]) {
    assert.throws(
      () => enforceConnectionNarrowing({ connection_id: 'cin_abc' }, bound),
      (err) => err.code === 'connection_not_found',
      `bound=${JSON.stringify(bound)} should fail closed`,
    );
  }
});
