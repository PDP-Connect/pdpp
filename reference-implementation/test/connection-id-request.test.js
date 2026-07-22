// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the canonical/deprecated-alias connection-id contract
// (server/connection-id-request.js).
//
// These are pure functions governing public read-path connection identity:
// page-limit clamping, alias resolution + structured warnings, storage
// display-name projection, and connection narrowing. Each assertion pins a
// boundary or error code so a flipped comparator or dropped guard fails.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  RECORDS_DEFAULT_PAGE_LIMIT,
  RECORDS_MAX_PAGE_LIMIT,
  buildLimitClampedWarning,
  clampRecordsPageLimit,
  enforceConnectionNarrowing,
  projectStorageDisplayName,
  resolveRequestConnectionId,
  validateConnectionAlias,
} from '../server/connection-id-request.js';

test('clampRecordsPageLimit falls back to default for absent / unparseable / non-positive', () => {
  for (const raw of [undefined, null, 'abc', 0, -5, '0', '-1']) {
    const result = clampRecordsPageLimit(raw);
    assert.deepEqual(result, { limit: RECORDS_DEFAULT_PAGE_LIMIT, requested: null, clamped: false });
  }
});

test('clampRecordsPageLimit passes through an in-range limit unclamped', () => {
  assert.deepEqual(clampRecordsPageLimit(10), { limit: 10, requested: 10, clamped: false });
  // Boundary: exactly the max is NOT clamped (guard is `> RECORDS_MAX_PAGE_LIMIT`).
  assert.deepEqual(clampRecordsPageLimit(RECORDS_MAX_PAGE_LIMIT), {
    limit: RECORDS_MAX_PAGE_LIMIT,
    requested: RECORDS_MAX_PAGE_LIMIT,
    clamped: false,
  });
});

test('clampRecordsPageLimit clamps an over-max limit and flags it', () => {
  // Boundary: max+1 IS clamped.
  const result = clampRecordsPageLimit(RECORDS_MAX_PAGE_LIMIT + 1);
  assert.deepEqual(result, { limit: RECORDS_MAX_PAGE_LIMIT, requested: RECORDS_MAX_PAGE_LIMIT + 1, clamped: true });
  assert.deepEqual(clampRecordsPageLimit(500), { limit: 100, requested: 500, clamped: true });
});

test('clampRecordsPageLimit parses numeric strings', () => {
  assert.deepEqual(clampRecordsPageLimit('30'), { limit: 30, requested: 30, clamped: false });
});

test('buildLimitClampedWarning carries stable code, param, and detail', () => {
  const warning = buildLimitClampedWarning(500);
  assert.equal(warning.code, 'limit_clamped');
  assert.equal(warning.param, 'limit');
  assert.deepEqual(warning.detail, { requested_limit: 500, max_limit: RECORDS_MAX_PAGE_LIMIT });
  assert.ok(warning.message.includes('500'));
});

test('validateConnectionAlias throws only on conflicting canonical vs alias', () => {
  assert.throws(
    () => validateConnectionAlias({ connection_id: 'conn-a', connector_instance_id: 'conn-b' }),
    (err) => err.code === 'invalid_argument' && err.param === 'connector_instance_id'
  );
});

test('validateConnectionAlias is a no-op when they match or only one is set', () => {
  assert.doesNotThrow(() => validateConnectionAlias({ connection_id: 'x', connector_instance_id: 'x' }));
  assert.doesNotThrow(() => validateConnectionAlias({ connection_id: 'x' }));
  assert.doesNotThrow(() => validateConnectionAlias({ connector_instance_id: 'y' }));
  assert.doesNotThrow(() => validateConnectionAlias({}));
  assert.doesNotThrow(() => validateConnectionAlias(null));
  // Empty strings are treated as absent — no conflict even though they differ.
  assert.doesNotThrow(() => validateConnectionAlias({ connection_id: '', connector_instance_id: 'y' }));
});

test('resolveRequestConnectionId prefers canonical and emits alias warning when alias present', () => {
  // Both present + equal: canonical value, but alias is on the wire → warning.
  const both = resolveRequestConnectionId({ connection_id: 'c', connector_instance_id: 'c' });
  assert.equal(both.connectionId, 'c');
  assert.equal(both.warnings.length, 1);
  assert.equal(both.warnings[0].code, 'deprecated_alias_used');
  assert.equal(both.warnings[0].param, 'connector_instance_id');
});

test('resolveRequestConnectionId returns canonical with no warning when alias absent', () => {
  const result = resolveRequestConnectionId({ connection_id: 'canon' });
  assert.equal(result.connectionId, 'canon');
  assert.deepEqual(result.warnings, []);
});

test('resolveRequestConnectionId returns alias value + warning when only alias set', () => {
  const result = resolveRequestConnectionId({ connector_instance_id: 'aliased' });
  assert.equal(result.connectionId, 'aliased');
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'deprecated_alias_used');
});

test('resolveRequestConnectionId returns null identity when neither set', () => {
  assert.deepEqual(resolveRequestConnectionId({}), { connectionId: null, warnings: [] });
  assert.deepEqual(resolveRequestConnectionId(null), { connectionId: null, warnings: [] });
});

test('resolveRequestConnectionId throws on conflicting values (delegates to validator)', () => {
  assert.throws(
    () => resolveRequestConnectionId({ connection_id: 'a', connector_instance_id: 'b' }),
    (err) => err.code === 'invalid_argument'
  );
});

test('projectStorageDisplayName drops non-strings, blanks, and placeholders', () => {
  assert.equal(projectStorageDisplayName(null), null);
  assert.equal(projectStorageDisplayName(undefined), null);
  assert.equal(projectStorageDisplayName(42), null);
  assert.equal(projectStorageDisplayName('   '), null);
  assert.equal(projectStorageDisplayName('legacy'), null);
  assert.equal(projectStorageDisplayName('default_account'), null);
  assert.equal(projectStorageDisplayName('Default account'), null);
});

test('projectStorageDisplayName drops names equal to the connector id or instance id', () => {
  assert.equal(projectStorageDisplayName('my-conn-instance', { connectorInstanceId: 'my-conn-instance' }), null);
  assert.equal(projectStorageDisplayName('some-connector-id', { connectorId: 'some-connector-id' }), null);
});

test('projectStorageDisplayName returns a trimmed owner-meaningful label', () => {
  assert.equal(projectStorageDisplayName('  My Gmail  ', { connectorId: 'gmail', connectorInstanceId: 'ci-1' }), 'My Gmail');
  assert.equal(projectStorageDisplayName('Work Account', {}), 'Work Account');
});

test('enforceConnectionNarrowing is a no-op when no connection identity supplied', () => {
  assert.doesNotThrow(() => enforceConnectionNarrowing({}, 'bound-id'));
  assert.doesNotThrow(() => enforceConnectionNarrowing(null, 'bound-id'));
});

test('enforceConnectionNarrowing throws connection_not_found on mismatch', () => {
  assert.throws(
    () => enforceConnectionNarrowing({ connection_id: 'other' }, 'bound-id'),
    (err) => err.code === 'connection_not_found' && err.param === 'connection_id'
  );
});

test('enforceConnectionNarrowing throws when the grant has no addressable binding', () => {
  assert.throws(
    () => enforceConnectionNarrowing({ connection_id: 'x' }, ''),
    (err) => err.code === 'connection_not_found'
  );
  assert.throws(
    () => enforceConnectionNarrowing({ connection_id: 'x' }, null),
    (err) => err.code === 'connection_not_found'
  );
});

test('enforceConnectionNarrowing passes when identity matches the binding', () => {
  assert.doesNotThrow(() => enforceConnectionNarrowing({ connection_id: 'bound-id' }, 'bound-id'));
  // Deprecated alias equal to the binding is honored.
  assert.doesNotThrow(() => enforceConnectionNarrowing({ connector_instance_id: 'bound-id' }, 'bound-id'));
});
