import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { iterateDynamicSqlAcknowledged } from '../lib/db.ts';
import { closeDb, getDb, initDb } from '../server/db.js';
import { sqliteCountIndexableTextValues } from '../server/search-index-counts.ts';

afterEach(() => {
  closeDb();
});

test('sqlite grouped indexable field count preserves per-field loop semantics', () => {
  initDb(':memory:');
  const db = getDb();
  const connectorId = 'sqlite_index_counts';
  const connectorInstanceId = 'cin_sqlite_index_counts';
  const stream = 'messages';
  const insertRecord = db.prepare(
    `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted)
     VALUES(?, ?, ?, ?, ?, ?, 1, ?)`,
  );
  const now = new Date().toISOString();
  insertRecord.run(connectorId, connectorInstanceId, stream, 'a', JSON.stringify({ title: 'Alpha', body: '  ' }), now, 0);
  insertRecord.run(connectorId, connectorInstanceId, stream, 'b', JSON.stringify({ title: '', body: 'Beta' }), now, 0);
  insertRecord.run(connectorId, connectorInstanceId, stream, 'c', JSON.stringify({ title: 'Gamma', body: 'Delta' }), now, 0);
  insertRecord.run(connectorId, connectorInstanceId, stream, 'deleted', JSON.stringify({ title: 'Hidden', body: 'Hidden' }), now, 1);

  assert.equal(
    sqliteCountIndexableTextValues({
      connectorInstanceId,
      stream,
      declaredFields: ['title', 'body', 'missing', 'title'],
      jsonPathForField: (field) => `$."${field}"`,
      iterateDynamicSql: iterateDynamicSqlAcknowledged,
    }),
    7,
  );
});
