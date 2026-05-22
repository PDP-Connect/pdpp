import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import { listConnectorSummaries } from '../server/ref-control.ts';
import { rebuildRetainedSize } from '../server/retained-size-read-model.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';

const CONNECTOR_ID = 'https://test.pdpp.dev/connectors/connection-first-records';
const WORK_INSTANCE_ID = 'cin_test_connection_first_work';
const PERSONAL_INSTANCE_ID = 'cin_test_connection_first_personal';
const NOW = '2026-05-20T12:00:00.000Z';

function withTmpDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-ref-connectors-connection-'));
    initDb(join(dir, 'pdpp.sqlite'));
    try {
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function seedConnector() {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: CONNECTOR_ID,
    version: '1.0.0',
    display_name: 'Connection First Records',
    streams: [
      { name: 'messages', primary_key: ['id'] },
      { name: 'files', primary_key: ['id'] },
    ],
  };
  getDb()
    .prepare('INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
    .run(CONNECTOR_ID, JSON.stringify(manifest), NOW);
}

async function seedInstances({ sourceKind = 'local_device' } = {}) {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorInstanceId: WORK_INSTANCE_ID,
    ownerSubjectId: 'owner_local',
    connectorId: CONNECTOR_ID,
    displayName: 'Work laptop',
    status: 'active',
    sourceKind,
    sourceBindingKey: 'work',
    sourceBinding: { kind: sourceKind, device: 'work' },
    createdAt: NOW,
    updatedAt: NOW,
  });
  await store.upsert({
    connectorInstanceId: PERSONAL_INSTANCE_ID,
    ownerSubjectId: 'owner_local',
    connectorId: CONNECTOR_ID,
    displayName: 'Personal laptop',
    status: 'active',
    sourceKind,
    sourceBindingKey: 'personal',
    sourceBinding: { kind: sourceKind, device: 'personal' },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function seedRecord({ connectorId = CONNECTOR_ID, connectorInstanceId, stream, key, data, emittedAt, version }) {
  getDb()
    .prepare(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(connectorId, connectorInstanceId, stream, key, JSON.stringify(data), emittedAt, version);
  getDb()
    .prepare(
      `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(connectorId, connectorInstanceId, stream, key, version, JSON.stringify(data), emittedAt);
}

test('reference connector summaries project concrete connection rows with instance-scoped records', withTmpDb(async () => {
  seedConnector();
  await seedInstances({ sourceKind: 'manual' });

  seedRecord({
    connectorInstanceId: WORK_INSTANCE_ID,
    stream: 'messages',
    key: 'msg_1',
    data: { id: 'msg_1', text: 'work message' },
    emittedAt: '2026-05-20T12:01:00.000Z',
    version: 1,
  });
  seedRecord({
    connectorInstanceId: WORK_INSTANCE_ID,
    stream: 'files',
    key: 'file_1',
    data: { id: 'file_1', name: 'brief.pdf' },
    emittedAt: '2026-05-20T12:02:00.000Z',
    version: 1,
  });
  seedRecord({
    connectorInstanceId: PERSONAL_INSTANCE_ID,
    stream: 'messages',
    key: 'msg_2',
    data: { id: 'msg_2', text: 'personal message' },
    emittedAt: '2026-05-20T12:03:00.000Z',
    version: 1,
  });
  getDb()
    .prepare(
      `INSERT INTO blobs(blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run('blob_work_1', CONNECTOR_ID, WORK_INSTANCE_ID, 'files', 'file_1', 'application/pdf', 4096, 'abc123');
  getDb()
    .prepare(
      `INSERT INTO blob_bindings(blob_id, connector_id, connector_instance_id, stream, record_key, json_path)
       VALUES (?, ?, ?, ?, ?, '@record')`,
    )
    .run('blob_work_1', CONNECTOR_ID, WORK_INSTANCE_ID, 'files', 'file_1');
  await rebuildRetainedSize();

  const summaries = await listConnectorSummaries();
  const rows = summaries.filter((row) => row.connector_id === CONNECTOR_ID);
  assert.equal(rows.length, 2);

  const work = rows.find((row) => row.connector_instance_id === WORK_INSTANCE_ID);
  const personal = rows.find((row) => row.connector_instance_id === PERSONAL_INSTANCE_ID);
  assert.ok(work);
  assert.ok(personal);

  assert.equal(work.connection_id, WORK_INSTANCE_ID);
  assert.equal(work.connector_id, CONNECTOR_ID);
  assert.equal(work.display_name, 'Work laptop');
  assert.equal(work.connector_display_name, 'Connection First Records');
  assert.equal(work.total_records, 2);
  assert.equal(work.stream_count, 2);
  assert.ok(work.total_retained_bytes >= 4096);

  assert.equal(personal.connection_id, PERSONAL_INSTANCE_ID);
  assert.equal(personal.total_records, 1);
  assert.equal(personal.stream_count, 1);
  assert.ok(personal.total_retained_bytes > 0);
  assert.ok(personal.total_retained_bytes < work.total_retained_bytes);
}));

test('reference connector summaries project local-device storage records under public connection rows', withTmpDb(async () => {
  seedConnector();
  await seedInstances();

  const storageConnectorId = `local-device:${encodeURIComponent(CONNECTOR_ID)}`;
  seedRecord({
    connectorId: storageConnectorId,
    connectorInstanceId: WORK_INSTANCE_ID,
    stream: 'messages',
    key: 'local_msg_1',
    data: { id: 'local_msg_1', text: 'stored through local-device namespace' },
    emittedAt: '2026-05-20T12:04:00.000Z',
    version: 1,
  });
  getDb()
    .prepare(
      `INSERT INTO blobs(blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run('blob_local_device_1', storageConnectorId, WORK_INSTANCE_ID, 'messages', 'local_msg_1', 'text/plain', 2048, 'def456');
  getDb()
    .prepare(
      `INSERT INTO blob_bindings(blob_id, connector_id, connector_instance_id, stream, record_key, json_path)
       VALUES (?, ?, ?, ?, ?, '@record')`,
    )
    .run('blob_local_device_1', storageConnectorId, WORK_INSTANCE_ID, 'messages', 'local_msg_1');
  await rebuildRetainedSize();

  const summaries = await listConnectorSummaries();
  const work = summaries.find(
    (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === WORK_INSTANCE_ID,
  );
  const personal = summaries.find(
    (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === PERSONAL_INSTANCE_ID,
  );
  assert.ok(work);
  assert.ok(personal);

  assert.equal(work.connector_id, CONNECTOR_ID);
  assert.equal(work.connector_instance_id, WORK_INSTANCE_ID);
  assert.equal(work.total_records, 1);
  assert.equal(work.stream_count, 1);
  assert.ok(work.total_retained_bytes >= 2048);

  assert.equal(personal.total_records, 0);
  assert.equal(personal.stream_count, 0);
}));
