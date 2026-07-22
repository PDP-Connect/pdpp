// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import {
  DeviceBatchConflictError,
  createPostgresDeviceExporterStore,
  createSqliteDeviceExporterStore,
} from '../server/stores/device-exporter-store.ts';
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from '../server/stores/connector-instance-store.js';
import { closePostgresStorage, initPostgresStorage, postgresQuery } from '../server/postgres-storage.js';

const NOW = '2026-04-30T12:00:00.000Z';
const LATER = '2026-04-30T12:01:00.000Z';

function makeDriver(store) {
  return {
    async call(method, ...args) {
      return await store[method](...args);
    },
  };
}

async function runConformance(makeStore) {
  const driver = makeDriver(await makeStore());

  await driver.call('createEnrollmentCode', {
    enrollmentCodeId: 'enroll_1',
    codeHash: 'sha256:enrollment-code',
    ownerSubjectId: 'owner_1',
    createdAt: NOW,
    expiresAt: '2026-05-01T12:00:00.000Z',
  });

  assert.equal(await driver.call('findEnrollmentByCodeHash', 'plaintext-enrollment-code'), null);
  assert.equal((await driver.call('findEnrollmentByCodeHash', 'sha256:enrollment-code')).status, 'pending');

  await driver.call('createDevice', {
    deviceId: 'dev_1',
    ownerSubjectId: 'owner_1',
    displayName: 'the owner MacBook',
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal(await driver.call('consumeEnrollmentCode', 'enroll_1', 'dev_1', LATER), true);
  assert.equal(await driver.call('consumeEnrollmentCode', 'enroll_1', 'dev_1', LATER), false);
  assert.equal((await driver.call('findEnrollmentByCodeHash', 'sha256:enrollment-code')).deviceId, 'dev_1');

  await driver.call('createCredential', {
    credentialId: 'cred_1',
    deviceId: 'dev_1',
    tokenHash: 'sha256:device-token',
    createdAt: NOW,
  });
  assert.equal(await driver.call('findCredentialByTokenHash', 'plaintext-device-token'), null);
  assert.equal((await driver.call('findCredentialByTokenHash', 'sha256:device-token')).deviceId, 'dev_1');

  await driver.call('markCredentialUsed', 'cred_1', LATER);
  assert.equal((await driver.call('findCredentialByTokenHash', 'sha256:device-token')).lastUsedAt, LATER);
  assert.equal(await driver.call('markDeviceHeartbeat', 'dev_1', { receivedAt: LATER, lastError: null }), 1);
  assert.equal((await driver.call('getDevice', 'dev_1')).lastHeartbeatAt, LATER);
  assert.equal((await driver.call('listDevices', 'owner_1'))[0].lastHeartbeatAt, LATER);

  await driver.call('upsertSourceInstance', {
    sourceInstanceId: 'src_1',
    deviceId: 'dev_1',
    connectorId: 'local.files',
    connectorInstanceId: 'cin_local_files_dev_1',
    localBindingId: 'photos',
    displayName: 'Photos Folder',
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal((await driver.call('getSourceInstance', 'dev_1', 'src_1')).connectorId, 'local.files');
  assert.equal((await driver.call('getSourceInstance', 'dev_1', 'src_1')).connectorInstanceId, 'cin_local_files_dev_1');
  assert.equal(
    (await driver.call('getSourceInstanceByBinding', 'dev_1', 'local.files', 'photos')).sourceInstanceId,
    'src_1',
  );
  assert.equal(await driver.call('getSourceInstance', 'dev_2', 'src_1'), null);

  const first = await driver.call('recordBatchOutcome', {
    deviceId: 'dev_1',
    batchId: 'batch_1',
    bodyHash: 'sha256:body-a',
    sourceInstanceId: 'src_1',
    status: 'accepted',
    httpStatus: 202,
    response: { recordsAccepted: 2 },
    createdAt: NOW,
  });
  assert.equal(first.kind, 'created');

  const replay = await driver.call('recordBatchOutcome', {
    deviceId: 'dev_1',
    batchId: 'batch_1',
    bodyHash: 'sha256:body-a',
    sourceInstanceId: 'src_1',
    status: 'accepted',
    httpStatus: 202,
    response: { ignored: true },
    createdAt: LATER,
  });
  assert.equal(replay.kind, 'replayed');
  assert.deepEqual(replay.outcome.response, { recordsAccepted: 2 });

  await assert.rejects(
    () => driver.call('recordBatchOutcome', {
      deviceId: 'dev_1',
      batchId: 'batch_1',
      bodyHash: 'sha256:body-b',
      sourceInstanceId: 'src_1',
      status: 'accepted',
      httpStatus: 202,
      response: {},
      createdAt: LATER,
    }),
    DeviceBatchConflictError,
  );

  // Heartbeat evidence persistence: the operator console's outbox axis
  // needs heartbeat status + records_pending on the source-instance row.
  // The mark call must accept (and round-trip) these fields without
  // leaking secrets or arbitrary payload.
  assert.equal(
    await driver.call('markSourceInstanceHeartbeat', 'dev_1', 'src_1', {
      receivedAt: LATER,
      lastError: null,
      status: 'healthy',
      recordsPending: 7,
    }),
    1,
  );
  const heartbeated = await driver.call('getSourceInstance', 'dev_1', 'src_1');
  assert.equal(heartbeated.lastHeartbeatAt, LATER);
  assert.equal(heartbeated.lastHeartbeatStatus, 'healthy');
  assert.equal(heartbeated.recordsPending, 7);

  // Unrecognized status values must NOT be persisted: only the enum we
  // accept on the heartbeat contract is stored.
  await driver.call('markSourceInstanceHeartbeat', 'dev_1', 'src_1', {
    receivedAt: LATER,
    lastError: null,
    status: 'totally_made_up',
    recordsPending: -3,
  });
  const sanitized = await driver.call('getSourceInstance', 'dev_1', 'src_1');
  assert.equal(sanitized.lastHeartbeatStatus, null);
  assert.equal(sanitized.recordsPending, null);

  const byConnector = await driver.call('listSourceInstanceHeartbeatsByConnector', 'local.files');
  assert.equal(byConnector.length, 1);
  assert.equal(byConnector[0].sourceInstanceId, 'src_1');
  assert.equal(byConnector[0].deviceStatus, 'active');
  assert.equal(byConnector[0].sourceStatus, 'active');
  assert.equal(byConnector[0].connectorInstanceId, 'cin_local_files_dev_1');
  assert.equal(byConnector[0].lastIngestAt, NOW);

  // Instance-scoped query must not leak rows from a different
  // connector_instance_id. This is the foundation of per-connection
  // dashboard health for connectors (e.g. two Claude Code laptops) that
  // share a `connector_id` but project independent rows.
  const byInstance = await driver.call(
    'listSourceInstanceHeartbeatsByConnector',
    'local.files',
    { connectorInstanceId: 'cin_local_files_dev_1' },
  );
  assert.equal(byInstance.length, 1);
  assert.equal(byInstance[0].connectorInstanceId, 'cin_local_files_dev_1');
  assert.equal(byInstance[0].lastIngestAt, NOW);
  const byOtherInstance = await driver.call(
    'listSourceInstanceHeartbeatsByConnector',
    'local.files',
    { connectorInstanceId: 'cin_local_files_nonexistent' },
  );
  assert.equal(byOtherInstance.length, 0);

  await driver.call('revokeDevice', 'dev_1', LATER);
  assert.equal((await driver.call('getDevice', 'dev_1')).status, 'revoked');
  assert.equal((await driver.call('findCredentialByTokenHash', 'sha256:device-token')).status, 'revoked');
}

test('SQLite DeviceExporterStore conforms to enrollment, credential, source, and batch semantics', async () => {
  initDb();
  try {
    await runConformance(() => createSqliteDeviceExporterStore());

    const db = getDb();
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM device_ingest_credentials WHERE token_hash = ?`).get('plaintext-device-token').count,
      0,
    );
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM device_enrollment_codes WHERE code_hash = ?`).get('plaintext-enrollment-code').count,
      0,
    );
  } finally {
    closeDb();
  }
});

// Revoking a device exporter must cascade revoke status to the
// device_source_instances bound to it AND to the connector_instances those
// source instances reference. Otherwise the operator surfaces
// (/_ref/connectors, device-exporter diagnostics) keep listing revoked local
// collectors as live records rows, including zero-record duplicates.
async function runRevokeCascade({ makeDeviceStore, makeConnectorInstanceStore, seedConnector, now }) {
  await seedConnector('local.files');

  const deviceStore = await makeDeviceStore();
  const instanceStore = await makeConnectorInstanceStore();

  await instanceStore.upsert({
    connectorInstanceId: 'cin_dev_revoked',
    ownerSubjectId: 'owner_1',
    connectorId: 'local.files',
    displayName: 'Revoked laptop binding',
    status: 'active',
    sourceKind: 'local_device',
    sourceBindingKey: 'revoked',
    sourceBinding: { kind: 'local_device', label: 'revoked' },
    createdAt: now,
    updatedAt: now,
  });
  await instanceStore.upsert({
    connectorInstanceId: 'cin_dev_kept',
    ownerSubjectId: 'owner_1',
    connectorId: 'local.files',
    displayName: 'Kept laptop binding',
    status: 'active',
    sourceKind: 'local_device',
    sourceBindingKey: 'kept',
    sourceBinding: { kind: 'local_device', label: 'kept' },
    createdAt: now,
    updatedAt: now,
  });

  await deviceStore.createDevice({
    deviceId: 'dev_revoke',
    ownerSubjectId: 'owner_1',
    displayName: 'Device to revoke',
    createdAt: now,
    updatedAt: now,
  });
  await deviceStore.createDevice({
    deviceId: 'dev_keep',
    ownerSubjectId: 'owner_1',
    displayName: 'Device to keep',
    createdAt: now,
    updatedAt: now,
  });

  await deviceStore.upsertSourceInstance({
    sourceInstanceId: 'src_revoke',
    deviceId: 'dev_revoke',
    connectorId: 'local.files',
    connectorInstanceId: 'cin_dev_revoked',
    localBindingId: 'photos',
    displayName: 'Photos on revoked device',
    createdAt: now,
    updatedAt: now,
  });
  await deviceStore.upsertSourceInstance({
    sourceInstanceId: 'src_keep',
    deviceId: 'dev_keep',
    connectorId: 'local.files',
    connectorInstanceId: 'cin_dev_kept',
    localBindingId: 'photos',
    displayName: 'Photos on kept device',
    createdAt: now,
    updatedAt: now,
  });

  await deviceStore.revokeDevice('dev_revoke', LATER);

  assert.equal((await deviceStore.getDevice('dev_revoke')).status, 'revoked');
  const revokedSource = await deviceStore.getSourceInstance('dev_revoke', 'src_revoke');
  assert.equal(revokedSource.status, 'revoked');
  assert.equal(revokedSource.revokedAt, LATER);
  const revokedInstance = await instanceStore.get('cin_dev_revoked');
  assert.equal(revokedInstance.status, 'revoked');
  assert.equal(revokedInstance.revokedAt, LATER);
  assert.equal(revokedInstance.updatedAt, LATER);

  // The other device, its source instance, and its connector_instance must
  // remain untouched. Revoke is per-device, not global.
  assert.equal((await deviceStore.getDevice('dev_keep')).status, 'active');
  const keptSource = await deviceStore.getSourceInstance('dev_keep', 'src_keep');
  assert.equal(keptSource.status, 'active');
  assert.equal(keptSource.revokedAt, null);
  const keptInstance = await instanceStore.get('cin_dev_kept');
  assert.equal(keptInstance.status, 'active');
  assert.equal(keptInstance.revokedAt, null);
}

// Shared connector_instance case: the stable-binding re-enrollment lane lets
// two devices (e.g. an old laptop re-enrolled as a new device) reference the
// same connector_instance via separate device_source_instances. Revoking one
// device must leave the connector_instance active while the other device's
// source instance still references it. Only after the last referencing source
// instance is revoked may the connector_instance flip to revoked.
async function runRevokeCascadeShared({ makeDeviceStore, makeConnectorInstanceStore, seedConnector, now }) {
  await seedConnector('local.files');

  const deviceStore = await makeDeviceStore();
  const instanceStore = await makeConnectorInstanceStore();

  await instanceStore.upsert({
    connectorInstanceId: 'cin_shared',
    ownerSubjectId: 'owner_1',
    connectorId: 'local.files',
    displayName: 'Shared stable binding',
    status: 'active',
    sourceKind: 'local_device',
    sourceBindingKey: 'shared',
    sourceBinding: { kind: 'local_device', label: 'shared' },
    createdAt: now,
    updatedAt: now,
  });

  await deviceStore.createDevice({
    deviceId: 'dev_old',
    ownerSubjectId: 'owner_1',
    displayName: 'Old laptop enrollment',
    createdAt: now,
    updatedAt: now,
  });
  await deviceStore.createDevice({
    deviceId: 'dev_new',
    ownerSubjectId: 'owner_1',
    displayName: 'Re-enrolled laptop',
    createdAt: now,
    updatedAt: now,
  });

  await deviceStore.upsertSourceInstance({
    sourceInstanceId: 'src_old',
    deviceId: 'dev_old',
    connectorId: 'local.files',
    connectorInstanceId: 'cin_shared',
    localBindingId: 'photos',
    displayName: 'Photos (old enrollment)',
    createdAt: now,
    updatedAt: now,
  });
  await deviceStore.upsertSourceInstance({
    sourceInstanceId: 'src_new',
    deviceId: 'dev_new',
    connectorId: 'local.files',
    connectorInstanceId: 'cin_shared',
    localBindingId: 'photos',
    displayName: 'Photos (new enrollment)',
    createdAt: now,
    updatedAt: now,
  });

  // Revoking the old device must revoke its own source instance but MUST NOT
  // revoke the shared connector_instance — the new device's source instance
  // is still active and references it.
  await deviceStore.revokeDevice('dev_old', LATER);

  const oldSource = await deviceStore.getSourceInstance('dev_old', 'src_old');
  assert.equal(oldSource.status, 'revoked');
  assert.equal(oldSource.revokedAt, LATER);

  const newSource = await deviceStore.getSourceInstance('dev_new', 'src_new');
  assert.equal(newSource.status, 'active');
  assert.equal(newSource.revokedAt, null);

  const sharedAfterFirst = await instanceStore.get('cin_shared');
  assert.equal(sharedAfterFirst.status, 'active', 'shared connector_instance must remain active while another device references it');
  assert.equal(sharedAfterFirst.revokedAt, null);

  // Now revoke the second device. With no remaining non-revoked source
  // instances referencing it, the shared connector_instance must flip to
  // revoked.
  const EVEN_LATER = '2026-04-30T12:02:00.000Z';
  await deviceStore.revokeDevice('dev_new', EVEN_LATER);

  const sharedAfterSecond = await instanceStore.get('cin_shared');
  assert.equal(sharedAfterSecond.status, 'revoked');
  assert.equal(sharedAfterSecond.revokedAt, EVEN_LATER);
}

test('SQLite revokeDevice cascades revoked status to device source instances and their connector_instances', async () => {
  initDb();
  try {
    await runRevokeCascade({
      makeDeviceStore: () => createSqliteDeviceExporterStore(),
      makeConnectorInstanceStore: () => createSqliteConnectorInstanceStore(),
      seedConnector: async (connectorId) => {
        getDb()
          .prepare('INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
          .run(connectorId, JSON.stringify({ connector_id: connectorId, version: '1.0.0', streams: [] }), NOW);
      },
      now: NOW,
    });
  } finally {
    closeDb();
  }
});

test('SQLite revokeDevice spares connector_instance shared with another active device source', async () => {
  initDb();
  try {
    await runRevokeCascadeShared({
      makeDeviceStore: () => createSqliteDeviceExporterStore(),
      makeConnectorInstanceStore: () => createSqliteConnectorInstanceStore(),
      seedConnector: async (connectorId) => {
        getDb()
          .prepare('INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
          .run(connectorId, JSON.stringify({ connector_id: connectorId, version: '1.0.0', streams: [] }), NOW);
      },
      now: NOW,
    });
  } finally {
    closeDb();
  }
});

test('Postgres revokeDevice cascades revoked status when PDPP_TEST_POSTGRES_URL is set', { skip: !process.env.PDPP_TEST_POSTGRES_URL }, async () => {
  await initPostgresStorage({ backend: 'postgres', databaseUrl: process.env.PDPP_TEST_POSTGRES_URL });
  const cleanup = async () => {
    await postgresQuery(`DELETE FROM device_source_instances WHERE device_id IN ('dev_revoke', 'dev_keep')`);
    await postgresQuery(`DELETE FROM device_exporters WHERE device_id IN ('dev_revoke', 'dev_keep')`);
    await postgresQuery(`DELETE FROM connector_instances WHERE connector_instance_id IN ('cin_dev_revoked', 'cin_dev_kept')`);
    await postgresQuery(`DELETE FROM connectors WHERE connector_id = 'local.files'`);
  };
  try {
    await cleanup();
    await runRevokeCascade({
      makeDeviceStore: () => createPostgresDeviceExporterStore(),
      makeConnectorInstanceStore: () => createPostgresConnectorInstanceStore(),
      seedConnector: async (connectorId) => {
        await postgresQuery(
          `INSERT INTO connectors(connector_id, manifest, created_at) VALUES ($1, $2::jsonb, $3)`,
          [connectorId, JSON.stringify({ connector_id: connectorId, version: '1.0.0', streams: [] }), NOW],
        );
      },
      now: NOW,
    });
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

test('Postgres revokeDevice spares shared connector_instance when PDPP_TEST_POSTGRES_URL is set', { skip: !process.env.PDPP_TEST_POSTGRES_URL }, async () => {
  await initPostgresStorage({ backend: 'postgres', databaseUrl: process.env.PDPP_TEST_POSTGRES_URL });
  const cleanup = async () => {
    await postgresQuery(`DELETE FROM device_source_instances WHERE device_id IN ('dev_old', 'dev_new')`);
    await postgresQuery(`DELETE FROM device_exporters WHERE device_id IN ('dev_old', 'dev_new')`);
    await postgresQuery(`DELETE FROM connector_instances WHERE connector_instance_id = 'cin_shared'`);
    await postgresQuery(`DELETE FROM connectors WHERE connector_id = 'local.files'`);
  };
  try {
    await cleanup();
    await runRevokeCascadeShared({
      makeDeviceStore: () => createPostgresDeviceExporterStore(),
      makeConnectorInstanceStore: () => createPostgresConnectorInstanceStore(),
      seedConnector: async (connectorId) => {
        await postgresQuery(
          `INSERT INTO connectors(connector_id, manifest, created_at) VALUES ($1, $2::jsonb, $3)`,
          [connectorId, JSON.stringify({ connector_id: connectorId, version: '1.0.0', streams: [] }), NOW],
        );
      },
      now: NOW,
    });
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

test('Postgres DeviceExporterStore conforms when PDPP_TEST_POSTGRES_URL is set', { skip: !process.env.PDPP_TEST_POSTGRES_URL }, async () => {
  await initPostgresStorage({ backend: 'postgres', databaseUrl: process.env.PDPP_TEST_POSTGRES_URL });
  try {
    await postgresQuery(`DELETE FROM device_ingest_batch_outcomes WHERE device_id = 'dev_1'`);
    await postgresQuery(`DELETE FROM device_source_instances WHERE device_id = 'dev_1'`);
    await postgresQuery(`DELETE FROM device_ingest_credentials WHERE device_id = 'dev_1'`);
    await postgresQuery(`DELETE FROM device_enrollment_codes WHERE enrollment_code_id = 'enroll_1'`);
    await postgresQuery(`DELETE FROM device_exporters WHERE device_id = 'dev_1'`);
    await runConformance(() => createPostgresDeviceExporterStore());
  } finally {
    await postgresQuery(`DELETE FROM device_ingest_batch_outcomes WHERE device_id = 'dev_1'`);
    await postgresQuery(`DELETE FROM device_source_instances WHERE device_id = 'dev_1'`);
    await postgresQuery(`DELETE FROM device_ingest_credentials WHERE device_id = 'dev_1'`);
    await postgresQuery(`DELETE FROM device_enrollment_codes WHERE enrollment_code_id = 'enroll_1'`);
    await postgresQuery(`DELETE FROM device_exporters WHERE device_id = 'dev_1'`);
    await closePostgresStorage();
  }
});
