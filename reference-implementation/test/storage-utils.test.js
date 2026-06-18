// Pins the shared storage helpers (storage-utils.js) that replace the previously
// duplicated copies in records.js (SQLite) and postgres-records.js (Postgres).
// The unified resolvers are a superset of both old copies: they accept string,
// snake_case, AND camelCase shapes, and have the audited empty-input behavior.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getChangeHistoryLimit,
  nowIso,
  resolveStorageConnectorId,
  resolveStorageConnectorInstanceId,
} from '../server/storage-utils.js';

test('nowIso returns an ISO-8601 timestamp', () => {
  const iso = nowIso();
  assert.equal(typeof iso, 'string');
  assert.ok(!Number.isNaN(Date.parse(iso)), 'must parse as a date');
  assert.match(iso, /T.*Z$/);
});

test('resolveStorageConnectorId accepts a bare string', () => {
  assert.equal(resolveStorageConnectorId('chase'), 'chase');
  assert.equal(resolveStorageConnectorId('  chase  '), 'chase');
});

test('resolveStorageConnectorId accepts snake_case objects (SQLite shape)', () => {
  assert.equal(resolveStorageConnectorId({ connector_id: 'chase' }), 'chase');
});

test('resolveStorageConnectorId accepts camelCase objects (Postgres shape, load-bearing)', () => {
  // connection-identity.js emits camelCase records; the Postgres copy accepted
  // these, the SQLite copy did not. The unified version accepts both.
  assert.equal(resolveStorageConnectorId({ connectorId: 'chase' }), 'chase');
});

test('resolveStorageConnectorId returns null on empty input (non-throwing superset)', () => {
  assert.equal(resolveStorageConnectorId(null), null);
  assert.equal(resolveStorageConnectorId(undefined), null);
  assert.equal(resolveStorageConnectorId({}), null);
  assert.equal(resolveStorageConnectorId(''), null);
});

test('resolveStorageConnectorInstanceId prefers an explicit instance id (both shapes)', () => {
  assert.equal(
    resolveStorageConnectorInstanceId({ connector_instance_id: 'cin_abc' }, 'chase'),
    'cin_abc',
  );
  assert.equal(
    resolveStorageConnectorInstanceId({ connectorInstanceId: 'cin_xyz' }, 'chase'),
    'cin_xyz',
  );
});

test('resolveStorageConnectorInstanceId derives a default from connectorId when no explicit id', () => {
  const derived = resolveStorageConnectorInstanceId({}, 'chase');
  assert.equal(typeof derived, 'string');
  assert.ok(derived.length > 0, 'must derive a non-empty default instance id');
});

test('resolveStorageConnectorInstanceId throws invalid_connector_id when neither is present (stricter SQLite guard preserved)', () => {
  let err = null;
  try {
    resolveStorageConnectorInstanceId({}, '');
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'must throw');
  assert.equal(err.code, 'invalid_connector_id');
});

test('getChangeHistoryLimit reads the env var, clamped to >= 0', () => {
  const original = process.env.PDPP_CHANGE_HISTORY_LIMIT;
  try {
    process.env.PDPP_CHANGE_HISTORY_LIMIT = '5';
    assert.equal(getChangeHistoryLimit(), 5);
    process.env.PDPP_CHANGE_HISTORY_LIMIT = '-3';
    assert.equal(getChangeHistoryLimit(), 0);
    delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
    assert.equal(getChangeHistoryLimit(), 0);
  } finally {
    if (original === undefined) delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
    else process.env.PDPP_CHANGE_HISTORY_LIMIT = original;
  }
});
