// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Grant fan-in SHALL NOT bind to a phantom default-account connection.
 *
 * Regression for `openspec/changes/separate-connector-catalog-from-connections/`
 * (Requirement: "Grant resolution SHALL NOT bind to a non-existent connection").
 *
 * Before the fix, the dashboard / catalog read (`listConnectorSummaries`)
 * called `ensureDefaultAccountConnection` for every registered public
 * connector when the owner had zero connections. That `upsert` persisted a
 * `status:'active'` default-account `connector_instances` row, which then
 * leaked into grant fan-in resolution: a grant naming a `connector_id`
 * without pinning a `connector_instance_id` would resolve to that phantom
 * binding and read across a connection the owner never created.
 *
 * After the fix, a read persists nothing, so fan-in resolution for an
 * unconnected connector fails closed — it returns no binding (and reads zero
 * records) exactly as if the owner had never connected.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, initDb } from '../server/db.js';
import { registerConnector } from '../server/auth.js';
import { listConnectorSummaries } from '../server/ref-control.ts';
import { resolveFanInBindings, listActiveBindingsForGrant } from '../server/connection-identity.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from '../server/owner-auth.ts';

const CONNECTOR_ID = 'https://test.pdpp.dev/connectors/grant-fail-closed';
const STREAM = 'messages';

const listedManifest = {
  protocol_version: '0.1.0',
  connector_id: CONNECTOR_ID,
  version: '1.0.0',
  display_name: 'Grant Fail-Closed Connector',
  // listed:true so it would have been materialized by the old read-time
  // catalog fan-out — the exact shape that produced phantom bindings.
  capabilities: { public_listing: { listed: true, status: 'test' } },
  streams: [
    {
      name: STREAM,
      primary_key: ['id'],
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
    },
  ],
};

function withDb(fn) {
  return async () => {
    initDb();
    try {
      await fn();
    } finally {
      closeDb();
    }
  };
}

test(
  'a dashboard read of an unconnected listed connector persists no connection and grant fan-in fails closed',
  withDb(async () => {
    await registerConnector(listedManifest);

    const store = createSqliteConnectorInstanceStore();
    assert.equal(
      store.listByOwner(OWNER_AUTH_DEFAULT_SUBJECT_ID).length,
      0,
      'pre-condition: owner has zero connections for the registered connector',
    );

    // Simulate the owner viewing the dashboard / catalog. This is the read
    // that previously materialized a phantom default-account connection.
    const summaries = await listConnectorSummaries();
    assert.equal(
      summaries.length,
      0,
      'owner with zero connections sees zero connections after the read',
    );
    assert.equal(
      store.listByOwner(OWNER_AUTH_DEFAULT_SUBJECT_ID).length,
      0,
      'the read persisted no connector_instances row (no phantom connection)',
    );

    // Grant fan-in for a grant that names the connector but does NOT pin a
    // connector_instance_id must fail closed: no active binding, zero records.
    const active = await listActiveBindingsForGrant({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    assert.deepEqual(active, [], 'no active binding exists for an unconnected connector');

    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    assert.deepEqual(
      bindings,
      [],
      'fan-in resolution must NOT bind to a phantom default-account connection; it fails closed',
    );
  }),
);
