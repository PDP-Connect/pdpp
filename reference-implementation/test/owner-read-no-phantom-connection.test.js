// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner read routes SHALL NOT create phantom connector_instances rows.
 *
 * Regression for manual/artifact connectors like WhatsApp: an owner read that
 * addressed `/v1/streams?connector_id=whatsapp` resolved the manifest through a
 * path that still allowed default-account materialization. That persisted an
 * active `source_kind:'account'` row even though the owner never uploaded an
 * artifact and the connection had zero records/runs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { issueOwnerToken, registerConnector } from '../server/auth.js';
import { startServer } from '../server/index.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from '../server/owner-auth.ts';

const CONNECTOR_ID = 'test-manual-artifact';

const manualArtifactManifest = {
  protocol_version: '0.1.0',
  connector_id: CONNECTOR_ID,
  connector_key: 'test-manual-artifact',
  manifest_uri: 'https://registry.pdpp.org/connectors/test-manual-artifact',
  version: '1.0.0',
  display_name: 'Test Manual Artifact',
  setup: {
    modality: 'manual_or_upload',
    manual_or_upload: {
      label: 'Manual artifact',
      accepted_file_extensions: ['.txt'],
      validation: { kind: 'test_manual_artifact' },
    },
  },
  capabilities: {
    public_listing: { listed: true, status: 'test' },
    refresh_policy: {
      recommended_mode: 'manual',
      interaction_posture: 'manual_action_likely',
      background_safe: false,
      rationale: 'The test source is populated only when the owner uploads an artifact.',
    },
  },
  streams: [
    {
      name: 'messages',
      primary_key: ['id'],
      schema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  ],
};

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeOne = (srv) =>
    new Promise((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 2000);
      srv.close(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

test('owner /v1/streams read for an unconnected manual connector persists no connection row', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
  });
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    await registerConnector(manualArtifactManifest);
    const token = await issueOwnerToken(OWNER_AUTH_DEFAULT_SUBJECT_ID);
    const store = createSqliteConnectorInstanceStore();

    assert.equal(store.listByOwner(OWNER_AUTH_DEFAULT_SUBJECT_ID).length, 0);

    const resp = await fetch(`${rsUrl}/v1/streams?connector_id=${encodeURIComponent(CONNECTOR_ID)}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    const body = await resp.json();
    assert.equal(resp.status, 404, JSON.stringify(body));
    assert.equal(body.error?.code, 'connection_not_found');

    assert.equal(
      store.listByOwner(OWNER_AUTH_DEFAULT_SUBJECT_ID).length,
      0,
      'owner read must not persist a default-account connector_instances row'
    );
  } finally {
    await closeServer(server);
  }
});
