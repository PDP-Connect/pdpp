import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import {
  DeviceBatchConflictError,
  createPostgresDeviceExporterStore,
  createSqliteDeviceExporterStore,
} from '../server/stores/device-exporter-store.js';
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

  await driver.call('upsertSourceInstance', {
    sourceInstanceId: 'src_1',
    deviceId: 'dev_1',
    connectorId: 'local.files',
    localBindingId: 'photos',
    displayName: 'Photos Folder',
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal((await driver.call('getSourceInstance', 'dev_1', 'src_1')).connectorId, 'local.files');
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
