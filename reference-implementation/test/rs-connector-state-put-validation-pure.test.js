// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the connector-state PUT validation in
// operations/rs-connector-state-put/index.ts. No test imports it by name. It
// validates each stream in the submitted state map against the connector manifest
// AND the grant scope before persisting — the write-gate that keeps a client from
// writing sync state for streams it can't see or wasn't granted.
//
// The store/manifest/grant dependencies are stubbed so we exercise the validation
// gates and their typed error codes without a DB.
//
// Mutation surface:
//   - a stream not in the manifest -> RsConnectorStatePutValidationError('not_found').
//   - a stream not in the grant scope (when grant-scoped) ->
//     RsConnectorStatePutValidationError('invalid_request').
//   - a valid state map is persisted via putSyncState with the allowed-streams set.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RsConnectorStatePutValidationError,
  executeRsConnectorStatePut,
} from '../operations/rs-connector-state-put/index.ts';

function makeDeps({ grantScope = null, onPut } = {}) {
  return {
    resolveRegisteredConnectorManifest: async () => ({ streams: [{ name: 'orders' }, { name: 'items' }] }),
    resolveGrantScope: async () => grantScope,
    onGrantResolved: async () => {},
    putSyncState: async (connectorId, stateMap, opts) => {
      if (onPut) onPut({ connectorId, stateMap, opts });
      return { persisted: stateMap };
    },
  };
}

function expectValidation(promise, code) {
  return assert.rejects(promise, (err) => {
    assert.ok(err instanceof RsConnectorStatePutValidationError, 'typed validation error');
    assert.equal(err.code, code, `expected ${code}, got ${err.code}`);
    return true;
  });
}

test('executeRsConnectorStatePut: a valid state map (no grant) persists', async () => {
  let put = null;
  const out = await executeRsConnectorStatePut(
    { connectorId: 'c', stateMap: { orders: { cursor: 'x' } } },
    makeDeps({ onPut: (p) => { put = p; } }),
  );
  assert.deepEqual(out.state, { persisted: { orders: { cursor: 'x' } } });
  assert.equal(put.connectorId, 'c');
  assert.equal(put.opts.allowedStreams, null, 'no grant -> null allowed-streams');
});

test('executeRsConnectorStatePut: a stream absent from the manifest is not_found', async () => {
  await expectValidation(
    executeRsConnectorStatePut({ connectorId: 'c', stateMap: { ghost_stream: {} } }, makeDeps()),
    'not_found',
  );
});

test('executeRsConnectorStatePut: a stream outside the grant scope is invalid_request', async () => {
  await expectValidation(
    executeRsConnectorStatePut(
      { connectorId: 'c', grantId: 'g', stateMap: { orders: {} } },
      makeDeps({ grantScope: { grantedStreams: new Set(['items']) } }),
    ),
    'invalid_request',
  );
});

test('executeRsConnectorStatePut: a grant-scoped stream that IS granted persists with the allowed set', async () => {
  let put = null;
  const out = await executeRsConnectorStatePut(
    { connectorId: 'c', grantId: 'g', stateMap: { items: { cursor: 'y' } } },
    makeDeps({ grantScope: { grantedStreams: new Set(['items']) }, onPut: (p) => { put = p; } }),
  );
  assert.deepEqual(out.state, { persisted: { items: { cursor: 'y' } } });
  assert.ok(put.opts.allowedStreams instanceof Set, 'allowed-streams set threaded to the store');
  assert.ok(put.opts.allowedStreams.has('items'));
});

test('executeRsConnectorStatePut: the manifest check runs BEFORE the grant check (unknown stream is not_found even if grant-scoped)', async () => {
  // 'ghost' is not in the manifest AND not in the grant; the manifest gate must fire first.
  await expectValidation(
    executeRsConnectorStatePut(
      { connectorId: 'c', grantId: 'g', stateMap: { ghost: {} } },
      makeDeps({ grantScope: { grantedStreams: new Set(['items']) } }),
    ),
    'not_found',
  );
});
