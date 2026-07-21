import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';

import { closeDb, getDb, initDb } from '../server/db.js';
import { createSqliteConnectorStateStore } from '../server/stores/connector-state-store.ts';
import { makeDefaultAccountConnectorInstanceId } from '../server/stores/connector-instance-store.js';
import { getSyncState, putSyncState } from '../server/records.js';

test.afterEach(() => {
  closeDb();
});

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdpp-connector-state-'));
  return path.join(dir, 'pdpp.sqlite');
}

test('connector sync state is isolated by connector_instance_id', async () => {
  initDb();
  const store = createSqliteConnectorStateStore();
  const connectorId = 'gmail';
  const stream = 'messages';

  await store.putState(
    { connectorId, connectorInstanceId: 'cin_gmail_work' },
    { [stream]: { cursor: 'work' } },
  );
  await store.putState(
    { connectorId, connectorInstanceId: 'cin_gmail_personal' },
    { [stream]: { cursor: 'personal' } },
  );

  assert.deepEqual(
    (await store.getState({ connectorId, connectorInstanceId: 'cin_gmail_work' })).state[stream],
    { cursor: 'work' },
  );
  assert.deepEqual(
    (await store.getState({ connectorId, connectorInstanceId: 'cin_gmail_personal' })).state[stream],
    { cursor: 'personal' },
  );

  const rows = getDb()
    .prepare('SELECT connector_id, connector_instance_id, stream FROM connector_state ORDER BY connector_instance_id')
    .all();
  assert.deepEqual(rows, [
    { connector_id: connectorId, connector_instance_id: 'cin_gmail_personal', stream },
    { connector_id: connectorId, connector_instance_id: 'cin_gmail_work', stream },
  ]);
});

test('sqlite migration preserves existing instance ids when only one sync-state table needs rebuild', () => {
  const dbPath = tempDbPath();
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE connector_state (
      connector_id TEXT NOT NULL,
      connector_instance_id TEXT NOT NULL,
      stream TEXT NOT NULL,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(connector_instance_id, stream)
    );
    CREATE TABLE grant_connector_state (
      grant_id TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      stream TEXT NOT NULL,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(grant_id, connector_id, stream)
    );
    INSERT INTO connector_state VALUES
      ('gmail', 'cin_gmail_work', 'messages', '{"cursor":"work"}', '2026-05-18T12:00:00.000Z'),
      ('gmail', 'cin_gmail_personal', 'messages', '{"cursor":"personal"}', '2026-05-18T12:01:00.000Z');
    INSERT INTO grant_connector_state VALUES
      ('grant_1', 'gmail', 'messages', '{"cursor":"grant"}', '2026-05-18T12:02:00.000Z');
  `);
  raw.close();

  assert.doesNotThrow(() => initDb(dbPath));
  closeDb();

  const verify = new Database(dbPath);
  try {
    const ownerRows = verify.prepare(
      `SELECT connector_instance_id, stream, state_json
         FROM connector_state
        ORDER BY connector_instance_id`
    ).all();
    assert.deepEqual(ownerRows, [
      { connector_instance_id: 'cin_gmail_personal', stream: 'messages', state_json: '{"cursor":"personal"}' },
      { connector_instance_id: 'cin_gmail_work', stream: 'messages', state_json: '{"cursor":"work"}' },
    ]);
    const grantRow = verify.prepare(
      `SELECT connector_instance_id, state_json
         FROM grant_connector_state
        WHERE grant_id = 'grant_1' AND connector_id = 'gmail' AND stream = 'messages'`
    ).get();
    assert.equal(
      grantRow.connector_instance_id,
      makeDefaultAccountConnectorInstanceId('owner_local', 'gmail'),
    );
    assert.equal(grantRow.state_json, '{"cursor":"grant"}');
  } finally {
    verify.close();
  }
});

test('grant sync state is isolated by connector_instance_id for the same grant and stream', async () => {
  initDb();
  const store = createSqliteConnectorStateStore();
  const connectorId = 'gmail';
  const grantId = 'grant_same';
  const stream = 'messages';

  await store.putState(
    { connectorId, connectorInstanceId: 'cin_gmail_work', grantId },
    { [stream]: { cursor: 'work-grant' } },
  );
  await store.putState(
    { connectorId, connectorInstanceId: 'cin_gmail_personal', grantId },
    { [stream]: { cursor: 'personal-grant' } },
  );

  assert.deepEqual(
    (await store.getState({ connectorId, connectorInstanceId: 'cin_gmail_work', grantId })).state[stream],
    { cursor: 'work-grant' },
  );
  assert.deepEqual(
    (await store.getState({ connectorId, connectorInstanceId: 'cin_gmail_personal', grantId })).state[stream],
    { cursor: 'personal-grant' },
  );
});

test('default connector-only records state uses deterministic default account connector instance id', async () => {
  initDb();
  const connectorId = 'default_reddit';
  const stream = 'posts';
  const expectedInstanceId = makeDefaultAccountConnectorInstanceId('owner_local', connectorId);

  await putSyncState(connectorId, { [stream]: { cursor: 'default' } });
  const projection = await getSyncState(connectorId);

  assert.equal(projection.connector_instance_id, expectedInstanceId);
  assert.deepEqual(projection.state[stream], { cursor: 'default' });
  assert.equal(
    getDb()
      .prepare('SELECT connector_instance_id FROM connector_state WHERE connector_id = ? AND stream = ?')
      .get(connectorId, stream).connector_instance_id,
    expectedInstanceId,
  );
});
