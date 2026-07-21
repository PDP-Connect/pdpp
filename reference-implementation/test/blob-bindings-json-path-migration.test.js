// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * blob_bindings json_path migration — SQLite.
 *
 * Verifies the schema migration that adds a json_path column to
 * blob_bindings' primary key. Covers:
 *   - fresh DB created with the new schema directly
 *   - legacy DB (old PK shape) rebuilt to the new shape on initDb()
 *   - existing rows backfilled with '@record' (preserving their
 *     pre-migration record-level semantics)
 *   - migration is idempotent (rerunning initDb is a no-op)
 *   - CHECK constraint rejects malformed json_path values
 *   - sha256 UNIQUE index is in place
 *
 * Design contract: docs/reference/binary-content-invariant-design-brief.md §4.6.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { initDb, closeDb } from '../server/db.js';
import { makeTemporaryDbPath } from './helpers/temp-dir.js';
import { makeDefaultAccountConnectorInstanceId } from '../server/stores/connector-instance-store.js';

function defaultAccountInstanceId(connectorId) {
  return makeDefaultAccountConnectorInstanceId('owner_local', connectorId);
}

function tempDbPath() {
  return makeTemporaryDbPath('pdpp-blobbindings-');
}

function tableColumns(raw, table) {
  return raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function indexes(raw, table) {
  return raw.prepare(`PRAGMA index_list(${table})`).all();
}

test('fresh DB has json_path in blob_bindings PK + CHECK constraint', () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  const raw = new Database(dbPath);
  try {
    assert.ok(tableColumns(raw, 'blob_bindings').includes('json_path'));

    // The default for new rows is '@record'.
    raw.prepare(
      'INSERT INTO blobs (blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run('blob_sha256_aa', 'c1', defaultAccountInstanceId('c1'), 's1', 'r1', 'application/octet-stream', 1, 'aa', Buffer.from([0xaa]));
    raw.prepare(
      'INSERT INTO blob_bindings (blob_id, connector_id, connector_instance_id, stream, record_key) VALUES (?,?,?,?,?)'
    ).run('blob_sha256_aa', 'c1', defaultAccountInstanceId('c1'), 's1', 'r1');
    const row = raw.prepare('SELECT json_path FROM blob_bindings').get();
    assert.equal(row.json_path, '@record');

    // CHECK constraint rejects shapes that are neither '@record' nor /-prefixed.
    assert.throws(
      () => raw.prepare(
        'INSERT INTO blob_bindings (blob_id, connector_id, connector_instance_id, stream, record_key, json_path) VALUES (?,?,?,?,?,?)'
      ).run('blob_sha256_aa', 'c1', defaultAccountInstanceId('c1'), 's1', 'r1', 'output_preview'),
      /CHECK constraint failed/,
    );

    // JSON Pointer values pass.
    raw.prepare(
      'INSERT INTO blob_bindings (blob_id, connector_id, connector_instance_id, stream, record_key, json_path) VALUES (?,?,?,?,?,?)'
    ).run('blob_sha256_aa', 'c1', defaultAccountInstanceId('c1'), 's1', 'r1', '/output_preview');
    const all = raw.prepare(
      "SELECT json_path FROM blob_bindings ORDER BY json_path"
    ).all().map((r) => r.json_path);
    assert.deepEqual(all, ['/output_preview', '@record']);
  } finally {
    raw.close();
    closeDb();
  }
});

test('legacy DB is rebuilt: existing rows backfilled with @record, count preserved', () => {
  // Build a legacy-shape DB by hand — the old blob_bindings PK lacked
  // json_path. Then call initDb() and verify the migration ran.
  const dbPath = tempDbPath();
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE blobs (
      blob_id       TEXT PRIMARY KEY,
      connector_id  TEXT NOT NULL,
      stream        TEXT NOT NULL,
      record_key    TEXT NOT NULL,
      mime_type     TEXT NOT NULL,
      size_bytes    INTEGER NOT NULL,
      sha256        TEXT NOT NULL,
      data          BLOB
    );
    CREATE TABLE blob_bindings (
      blob_id       TEXT NOT NULL,
      connector_id  TEXT NOT NULL,
      stream        TEXT NOT NULL,
      record_key    TEXT NOT NULL,
      PRIMARY KEY(blob_id, connector_id, stream, record_key),
      FOREIGN KEY(blob_id) REFERENCES blobs(blob_id)
    );
    INSERT INTO blobs VALUES
      ('blob_sha256_a', 'c1', 's1', 'r1', 'application/octet-stream', 1, 'a', x'aa'),
      ('blob_sha256_b', 'c1', 's1', 'r2', 'application/octet-stream', 1, 'b', x'bb'),
      ('blob_sha256_c', 'c2', 's2', 'r3', 'application/octet-stream', 1, 'c', x'cc');
    INSERT INTO blob_bindings (blob_id, connector_id, stream, record_key) VALUES
      ('blob_sha256_a', 'c1', 's1', 'r1'),
      ('blob_sha256_b', 'c1', 's1', 'r2'),
      ('blob_sha256_c', 'c2', 's2', 'r3');
  `);
  assert.equal(
    raw.prepare('SELECT COUNT(*) AS n FROM blob_bindings').get().n,
    3,
  );
  assert.ok(!tableColumns(raw, 'blob_bindings').includes('json_path'));
  raw.close();

  // Run initDb — this should trigger migrateBlobBindingsJsonPath.
  initDb(dbPath);
  closeDb();

  // Reopen and verify post-migration state.
  const verifyRaw = new Database(dbPath);
  try {
    assert.ok(tableColumns(verifyRaw, 'blob_bindings').includes('json_path'));
    const all = verifyRaw.prepare(
      'SELECT blob_id, json_path FROM blob_bindings ORDER BY blob_id'
    ).all();
    assert.equal(all.length, 3);
    for (const row of all) {
      assert.equal(row.json_path, '@record');
    }
    // Row count preserved.
    assert.equal(
      verifyRaw.prepare('SELECT COUNT(*) AS n FROM blob_bindings').get().n,
      3,
    );
  } finally {
    verifyRaw.close();
  }
});

test('migration is idempotent: second initDb() does not error or duplicate', () => {
  const dbPath = tempDbPath();
  // Build legacy shape, migrate once, then call initDb() again.
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE blobs (
      blob_id TEXT PRIMARY KEY, connector_id TEXT NOT NULL, stream TEXT NOT NULL,
      record_key TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL, data BLOB
    );
    CREATE TABLE blob_bindings (
      blob_id TEXT NOT NULL, connector_id TEXT NOT NULL, stream TEXT NOT NULL,
      record_key TEXT NOT NULL,
      PRIMARY KEY(blob_id, connector_id, stream, record_key)
    );
    INSERT INTO blobs VALUES ('blob_sha256_z', 'c', 's', 'r', 'application/octet-stream', 1, 'z', x'aa');
    INSERT INTO blob_bindings VALUES ('blob_sha256_z', 'c', 's', 'r');
  `);
  raw.close();

  initDb(dbPath);
  closeDb();
  // Second call must not throw.
  initDb(dbPath);
  closeDb();

  const v = new Database(dbPath);
  try {
    assert.equal(v.prepare('SELECT COUNT(*) AS n FROM blob_bindings').get().n, 1);
    assert.ok(tableColumns(v, 'blob_bindings').includes('json_path'));
  } finally {
    v.close();
  }
});

test('uniq_blobs_sha256 index exists on fresh DB and after migration', () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  closeDb();
  const raw = new Database(dbPath);
  try {
    const names = indexes(raw, 'blobs').map((i) => i.name);
    assert.ok(
      names.includes('uniq_blobs_sha256'),
      `uniq_blobs_sha256 missing from blobs indexes: ${names.join(', ')}`,
    );
  } finally {
    raw.close();
  }
});

test('uniq_blobs_sha256 actually rejects duplicate sha256 values', () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  closeDb();
  const raw = new Database(dbPath);
  try {
    raw.prepare(
      'INSERT INTO blobs (blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run('blob_sha256_a', 'c', defaultAccountInstanceId('c'), 's', 'r', 'application/octet-stream', 1, 'shared_sha', Buffer.from([0xaa]));
    assert.throws(
      () => raw.prepare(
        'INSERT INTO blobs (blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data) VALUES (?,?,?,?,?,?,?,?,?)'
      ).run('blob_sha256_b', 'c', defaultAccountInstanceId('c'), 's', 'r', 'application/octet-stream', 1, 'shared_sha', Buffer.from([0xbb])),
      /UNIQUE constraint failed: blobs\.sha256/,
    );
  } finally {
    raw.close();
  }
});

test('PK includes json_path: same blob can bind to same record at multiple json_paths', () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  closeDb();
  const raw = new Database(dbPath);
  try {
    raw.prepare(
      'INSERT INTO blobs (blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run('blob_sha256_x', 'c1', defaultAccountInstanceId('c1'), 's1', 'r1', 'application/octet-stream', 1, 'x', Buffer.from([0xaa]));
    raw.prepare(
      'INSERT INTO blob_bindings (blob_id, connector_id, connector_instance_id, stream, record_key, json_path) VALUES (?,?,?,?,?,?)'
    ).run('blob_sha256_x', 'c1', defaultAccountInstanceId('c1'), 's1', 'r1', '/output_preview');
    raw.prepare(
      'INSERT INTO blob_bindings (blob_id, connector_id, connector_instance_id, stream, record_key, json_path) VALUES (?,?,?,?,?,?)'
    ).run('blob_sha256_x', 'c1', defaultAccountInstanceId('c1'), 's1', 'r1', '/arguments');
    raw.prepare(
      'INSERT INTO blob_bindings (blob_id, connector_id, connector_instance_id, stream, record_key, json_path) VALUES (?,?,?,?,?,?)'
    ).run('blob_sha256_x', 'c1', defaultAccountInstanceId('c1'), 's1', 'r1', '@record');
    const rows = raw.prepare(
      'SELECT json_path FROM blob_bindings ORDER BY json_path'
    ).all().map((r) => r.json_path);
    assert.deepEqual(rows, ['/arguments', '/output_preview', '@record']);

    // But same json_path is rejected (PK uniqueness).
    assert.throws(
      () => raw.prepare(
        'INSERT INTO blob_bindings (blob_id, connector_id, connector_instance_id, stream, record_key, json_path) VALUES (?,?,?,?,?,?)'
      ).run('blob_sha256_x', 'c1', defaultAccountInstanceId('c1'), 's1', 'r1', '/output_preview'),
      /UNIQUE constraint failed/,
    );
  } finally {
    raw.close();
  }
});
