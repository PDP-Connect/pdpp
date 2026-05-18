import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import {
  ConnectorInstanceResolutionError,
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
  makeLegacyConnectorInstanceId,
  resolveOwnerConnectorInstanceNamespace,
} from '../server/stores/connector-instance-store.js';
import { closePostgresStorage, initPostgresStorage, postgresQuery } from '../server/postgres-storage.js';

const NOW = '2026-05-15T12:00:00.000Z';
const LATER = '2026-05-15T12:01:00.000Z';

function makeDriver(store) {
  return {
    async call(method, ...args) {
      return await store[method](...args);
    },
  };
}

async function seedSqliteConnector(connectorId) {
  getDb()
    .prepare(`INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)`)
    .run(connectorId, JSON.stringify({ connector_id: connectorId }), NOW);
}

async function seedPostgresConnector(connectorId) {
  await postgresQuery(
    `INSERT INTO connectors(connector_id, manifest, created_at)
     VALUES($1, $2::jsonb, $3)
     ON CONFLICT(connector_id) DO NOTHING`,
    [connectorId, JSON.stringify({ connector_id: connectorId }), NOW],
  );
}

async function runConformance({ makeStore, seedConnector }) {
  const store = await makeStore();
  const driver = makeDriver(store);

  await seedConnector('gmail');
  await seedConnector('claude-code');
  await seedConnector('reddit');

  const legacy = await driver.call('ensureLegacyDefault', {
    ownerSubjectId: 'owner_1',
    connectorId: 'gmail',
    displayName: 'Gmail',
    now: NOW,
  });
  assert.equal(legacy.connectorInstanceId, makeLegacyConnectorInstanceId('owner_1', 'gmail'));
  assert.equal(legacy.sourceKind, 'legacy');
  assert.deepEqual(legacy.sourceBinding, { kind: 'legacy_default' });
  assert.equal((await driver.call('resolveActiveByConnector', 'owner_1', 'gmail')).connectorInstanceId, legacy.connectorInstanceId);
  assert.deepEqual(
    await resolveOwnerConnectorInstanceNamespace({
      ownerSubjectId: 'owner_1',
      connectorId: 'gmail',
      connectorInstanceStore: store,
    }),
    {
      ownerSubjectId: 'owner_1',
      connectorId: 'gmail',
      connectorInstanceId: legacy.connectorInstanceId,
      displayName: 'Gmail',
      status: 'active',
      sourceKind: 'legacy',
      sourceBindingKey: 'default',
      sourceBinding: { kind: 'legacy_default' },
      selector: 'connector_id',
      createdLegacyDefault: false,
    },
  );

  const work = await driver.call('upsert', {
    connectorInstanceId: 'cin_gmail_work',
    ownerSubjectId: 'owner_2',
    connectorId: 'gmail',
    displayName: 'Gmail - work',
    sourceKind: 'account',
    sourceBindingKey: 'acct_work',
    sourceBinding: { account_hint: 'work@example.test' },
    createdAt: NOW,
    updatedAt: NOW,
  });
  const personal = await driver.call('upsert', {
    connectorInstanceId: 'cin_gmail_personal',
    ownerSubjectId: 'owner_2',
    connectorId: 'gmail',
    displayName: 'Gmail - personal',
    sourceKind: 'account',
    sourceBindingKey: 'acct_personal',
    sourceBinding: { account_hint: 'personal@example.test' },
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal(work.connectorId, personal.connectorId);
  assert.notEqual(work.connectorInstanceId, personal.connectorInstanceId);

  const ownerInstances = await driver.call('listByOwner', 'owner_2');
  assert.deepEqual(ownerInstances.map((row) => row.connectorInstanceId), ['cin_gmail_personal', 'cin_gmail_work']);
  assert.equal(
    (await driver.call('getByBinding', {
      ownerSubjectId: 'owner_2',
      connectorId: 'gmail',
      sourceKind: 'account',
      sourceBindingKey: 'acct_work',
    })).connectorInstanceId,
    'cin_gmail_work',
  );
  assert.equal(
    (await resolveOwnerConnectorInstanceNamespace({
      ownerSubjectId: 'owner_2',
      connectorInstanceId: 'cin_gmail_work',
      connectorInstanceStore: store,
    })).connectorInstanceId,
    'cin_gmail_work',
  );
  assert.equal(
    (await resolveOwnerConnectorInstanceNamespace({
      ownerSubjectId: 'owner_2',
      connectorId: 'gmail',
      connectorInstanceId: 'cin_gmail_work',
      connectorInstanceStore: store,
    })).connectorId,
    'gmail',
  );

  await assert.rejects(
    () => driver.call('resolveActiveByConnector', 'owner_2', 'gmail'),
    (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'ambiguous_connector_instance',
  );
  await assert.rejects(
    () => resolveOwnerConnectorInstanceNamespace({
      ownerSubjectId: 'owner_2',
      connectorId: 'gmail',
      connectorInstanceStore: store,
    }),
    (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'ambiguous_connector_instance',
  );
  await assert.rejects(
    () => resolveOwnerConnectorInstanceNamespace({
      ownerSubjectId: 'owner_1',
      connectorInstanceId: 'cin_gmail_work',
      connectorInstanceStore: store,
    }),
    (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'connector_instance_owner_mismatch',
  );
  await assert.rejects(
    () => resolveOwnerConnectorInstanceNamespace({
      ownerSubjectId: 'owner_2',
      connectorId: 'claude-code',
      connectorInstanceId: 'cin_gmail_work',
      connectorInstanceStore: store,
    }),
    (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'connector_instance_connector_mismatch',
  );

  await driver.call('updateStatus', 'cin_gmail_personal', {
    status: 'paused',
    updatedAt: LATER,
  });
  assert.equal((await driver.call('resolveActiveByConnector', 'owner_2', 'gmail')).connectorInstanceId, 'cin_gmail_work');
  await assert.rejects(
    () => resolveOwnerConnectorInstanceNamespace({
      ownerSubjectId: 'owner_2',
      connectorInstanceId: 'cin_gmail_personal',
      connectorInstanceStore: store,
    }),
    (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'connector_instance_inactive',
  );

  await driver.call('upsert', {
    connectorInstanceId: 'cin_claude_laptop',
    ownerSubjectId: 'owner_2',
    connectorId: 'claude-code',
    displayName: 'Claude Code - laptop',
    sourceKind: 'local_device',
    sourceBindingKey: 'dev_laptop:default',
    sourceBinding: { device_id: 'dev_laptop', local_binding_id: 'default' },
    createdAt: NOW,
    updatedAt: NOW,
  });
  await driver.call('upsert', {
    connectorInstanceId: 'cin_claude_desktop',
    ownerSubjectId: 'owner_2',
    connectorId: 'claude-code',
    displayName: 'Claude Code - desktop',
    sourceKind: 'local_device',
    sourceBindingKey: 'dev_desktop:default',
    sourceBinding: { device_id: 'dev_desktop', local_binding_id: 'default' },
    createdAt: NOW,
    updatedAt: NOW,
  });
  await assert.rejects(
    () => driver.call('resolveActiveByConnector', 'owner_2', 'claude-code'),
    (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'ambiguous_connector_instance',
  );

  await assert.rejects(
    () => driver.call('resolveActiveByConnector', 'owner_2', 'missing'),
    (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'connector_instance_not_found',
  );
  await assert.rejects(
    () => resolveOwnerConnectorInstanceNamespace({
      ownerSubjectId: 'owner_3',
      connectorId: 'reddit',
      connectorInstanceStore: store,
    }),
    (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'connector_instance_not_found',
  );
  const created = await resolveOwnerConnectorInstanceNamespace({
    ownerSubjectId: 'owner_3',
    connectorId: 'reddit',
    displayName: 'Reddit',
    connectorInstanceStore: store,
    allowLegacyDefault: true,
    now: NOW,
  });
  assert.equal(created.connectorInstanceId, makeLegacyConnectorInstanceId('owner_3', 'reddit'));
  assert.equal(created.createdLegacyDefault, true);
  assert.equal(created.selector, 'connector_id');
  await assert.rejects(
    () => resolveOwnerConnectorInstanceNamespace({
      ownerSubjectId: 'owner_3',
      connectorInstanceStore: store,
    }),
    (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'connector_instance_selector_required',
  );
}

test('SQLite ConnectorInstanceStore supports legacy defaults and ambiguous connector-only resolution', async () => {
  initDb();
  try {
    await runConformance({
      makeStore: () => createSqliteConnectorInstanceStore(),
      seedConnector: seedSqliteConnector,
    });
  } finally {
    closeDb();
  }
});

test('Postgres ConnectorInstanceStore conforms when PDPP_TEST_POSTGRES_URL is set', { skip: !process.env.PDPP_TEST_POSTGRES_URL }, async () => {
  await initPostgresStorage({ backend: 'postgres', databaseUrl: process.env.PDPP_TEST_POSTGRES_URL });
  try {
    await postgresQuery(`DELETE FROM connector_instances WHERE owner_subject_id IN ('owner_1', 'owner_2', 'owner_3')`);
    await runConformance({
      makeStore: () => createPostgresConnectorInstanceStore(),
      seedConnector: seedPostgresConnector,
    });
  } finally {
    await postgresQuery(`DELETE FROM connector_instances WHERE owner_subject_id IN ('owner_1', 'owner_2', 'owner_3')`);
    await postgresQuery(`DELETE FROM connectors WHERE connector_id IN ('gmail', 'claude-code', 'reddit')`);
    await closePostgresStorage();
  }
});
