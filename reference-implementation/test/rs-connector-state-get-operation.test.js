/**
 * Operation-level behavior tests for `rs.connector-state.get`.
 *
 * Pins the validation order, the storage call shape, and the
 * `onGrantResolved` notification ordering.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeRsConnectorStateGet } from '../operations/rs-connector-state-get/index.ts';

function deps(overrides = {}) {
  return {
    resolveRegisteredConnectorManifest: async () => ({}),
    resolveGrantScope: async () => {
      throw new Error('grant scope resolver should not be called without grantId');
    },
    onGrantResolved: () => {},
    getSyncState: async () => ({ state: {}, updated_at: null }),
    ...overrides,
  };
}

test('reads sync state with null grant context when no grantId is supplied', async () => {
  let capturedArgs = null;
  const result = await executeRsConnectorStateGet(
    { connectorId: 'gh', grantId: null },
    deps({
      getSyncState: async (id, args) => {
        capturedArgs = { id, ...args };
        return { state: { messages: { cursor: 'abc' } }, updated_at: 't1' };
      },
    }),
  );
  assert.deepEqual(capturedArgs, {
    id: 'gh',
    grantId: null,
    allowedStreams: null,
  });
  assert.equal(result.grantScope, null);
  assert.equal(result.state.updated_at, 't1');
});

test('passes grant-scope allowedStreams to getSyncState', async () => {
  const grantScope = {
    grantId: 'g1',
    grantedStreams: new Set(['messages', 'events']),
  };
  let capturedArgs = null;
  const result = await executeRsConnectorStateGet(
    { connectorId: 'gh', grantId: 'g1' },
    deps({
      resolveGrantScope: async () => grantScope,
      getSyncState: async (id, args) => {
        capturedArgs = args;
        return { state: {}, updated_at: null };
      },
    }),
  );
  assert.equal(capturedArgs.grantId, 'g1');
  assert.equal(capturedArgs.allowedStreams, grantScope.grantedStreams);
  assert.equal(result.grantScope, grantScope);
});

test('invokes onGrantResolved between grant scope resolution and storage read', async () => {
  const order = [];
  const grantScope = {
    grantId: 'g1',
    grantedStreams: new Set(['messages']),
  };
  await executeRsConnectorStateGet(
    { connectorId: 'gh', grantId: 'g1' },
    deps({
      resolveRegisteredConnectorManifest: async () => {
        order.push('manifest');
        return {};
      },
      resolveGrantScope: async () => {
        order.push('grant');
        return grantScope;
      },
      onGrantResolved: (scope) => {
        order.push(['notify', scope === grantScope]);
      },
      getSyncState: async () => {
        order.push('state');
        return { state: {}, updated_at: null };
      },
    }),
  );
  assert.deepEqual(order, ['manifest', 'grant', ['notify', true], 'state']);
});

test('invokes onGrantResolved with null when no grantId is supplied', async () => {
  let capturedScope = 'unset';
  await executeRsConnectorStateGet(
    { connectorId: 'gh', grantId: null },
    deps({
      onGrantResolved: (scope) => {
        capturedScope = scope;
      },
    }),
  );
  assert.equal(capturedScope, null);
});

test('manifest resolver error short-circuits before grant resolution', async () => {
  let grantCalled = false;
  await assert.rejects(
    executeRsConnectorStateGet(
      { connectorId: 'gh', grantId: 'g1' },
      deps({
        resolveRegisteredConnectorManifest: async () => {
          const err = new Error('unknown');
          err.code = 'not_found';
          throw err;
        },
        resolveGrantScope: async () => {
          grantCalled = true;
          return {
            grantId: 'g1',
            grantedStreams: new Set(),
          };
        },
      }),
    ),
    { code: 'not_found' },
  );
  assert.equal(grantCalled, false);
});
