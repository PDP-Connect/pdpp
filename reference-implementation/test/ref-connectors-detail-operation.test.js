// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level behavior tests for `ref.connectors.detail`.
 *
 * Pins the envelope discriminator, that the operation injects
 * `object: 'ref_connector_detail'` exactly once, and the
 * not-found-error mapping when the dependency returns null.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RefConnectorDetailNotFoundError,
  executeRefConnectorDetail,
} from '../operations/ref-connectors-detail/index.ts';

function makeDetailWithoutObject(connectorId) {
  return {
    connector_id: connectorId,
    connection_resolution: 'resolved',
    connection_health: null,
    display_name: connectorId,
    manifest_version: '1.0.0',
    total_records: 0,
    freshness: { status: 'unknown' },
    schedule: null,
    last_run: null,
    last_successful_run: null,
    recent_runs: [],
    manifest_excerpt: {
      connector_id: connectorId,
      display_name: connectorId,
      profile_ids: [],
      protocol_version: null,
      version: '1.0.0',
    },
    streams: [],
  };
}

test('ref.connectors.detail wraps dependency output with object: ref_connector_detail', async () => {
  const dep = makeDetailWithoutObject('acme');
  const envelope = await executeRefConnectorDetail(
    { connectorId: 'acme' },
    {
      getConnectorDetail: async () => dep,
    },
  );
  assert.equal(envelope.object, 'ref_connector_detail');
  assert.equal(envelope.connector_id, 'acme');
  assert.equal(envelope.display_name, 'acme');
});

test('ref.connectors.detail throws RefConnectorDetailNotFoundError when dependency returns null', async () => {
  await assert.rejects(
    executeRefConnectorDetail(
      { connectorId: 'missing' },
      {
        getConnectorDetail: async () => null,
      },
    ),
    (err) => {
      assert.ok(err instanceof RefConnectorDetailNotFoundError);
      assert.equal(err.code, 'not_found');
      assert.equal(err.connectorId, 'missing');
      return true;
    },
  );
});

test('ref.connectors.detail propagates dependency-thrown errors unchanged', async () => {
  class DependencyError extends Error {
    constructor() {
      super('manifest invalid');
      this.code = 'connector_invalid';
    }
  }
  await assert.rejects(
    executeRefConnectorDetail(
      { connectorId: 'broken' },
      {
        getConnectorDetail: async () => {
          throw new DependencyError();
        },
      },
    ),
    (err) => err instanceof DependencyError && err.code === 'connector_invalid',
  );
});

test('ref.connectors.detail awaits dependency promises', async () => {
  let resolved = false;
  const envelope = await executeRefConnectorDetail(
    { connectorId: 'async' },
    {
      getConnectorDetail: () =>
        new Promise((resolve) =>
          setImmediate(() => {
            resolved = true;
            resolve(makeDetailWithoutObject('async'));
          }),
        ),
    },
  );
  assert.equal(resolved, true);
  assert.equal(envelope.connector_id, 'async');
});
