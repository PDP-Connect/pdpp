/**
 * connector_instances.status `draft` CHECK-widening migration — SQLite.
 *
 * Verifies the migration that widens the status CHECK to admit `draft`:
 *   - fresh DB created with the new schema accepts a `draft` row directly;
 *   - a legacy DB with the narrow CHECK is rebuilt on initDb(), existing rows
 *     preserved, and a `draft` insert then succeeds;
 *   - the migration is idempotent (a second initDb is a no-op).
 *
 * See add-static-secret-owner-session-connect-path design Decision 1.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import { initDb, closeDb } from '../server/db.js';

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdpp-status-draft-'));
  return path.join(dir, 'pdpp.sqlite');
}

function statusCheckSql(raw) {
  return raw
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'connector_instances'`)
    .get().sql;
}

function insertInstance(raw, { id, status, bindingKey }) {
  raw.prepare(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name,
       status, source_kind, source_binding_key, source_binding_json,
       created_at, updated_at, revoked_at)
     VALUES (?, 'owner_1', 'gmail', 'Gmail', ?, 'account', ?, '{}', '2026-06-02', '2026-06-02', NULL)`,
  ).run(id, status, bindingKey);
}

test('fresh DB admits a draft connector instance', () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  closeDb();
  const raw = new Database(dbPath);
  try {
    assert.ok(statusCheckSql(raw).includes("'draft'"), 'fresh CHECK names draft');
    // FK requires a connectors row.
    raw.prepare(`INSERT INTO connectors(connector_id, manifest, created_at) VALUES ('gmail', '{}', '2026-06-02')`).run();
    insertInstance(raw, { id: 'cin_draft_1', status: 'draft', bindingKey: 'b1' });
    assert.equal(
      raw.prepare(`SELECT status FROM connector_instances WHERE connector_instance_id = 'cin_draft_1'`).get().status,
      'draft',
    );
    // An unknown status is still rejected.
    assert.throws(
      () => insertInstance(raw, { id: 'cin_bad', status: 'bogus', bindingKey: 'b2' }),
      /CHECK constraint failed/,
    );
  } finally {
    raw.close();
  }
});

test('legacy narrow-CHECK DB is rebuilt and then admits a draft', () => {
  const dbPath = tempDbPath();
  const raw = new Database(dbPath);
  // Hand-build the legacy connectors + connector_instances tables with the
  // pre-draft narrow status CHECK and one active row.
  raw.exec(`
    CREATE TABLE connectors (
      connector_id TEXT PRIMARY KEY, manifest TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE connector_instances (
      connector_instance_id TEXT PRIMARY KEY,
      owner_subject_id      TEXT NOT NULL,
      connector_id          TEXT NOT NULL,
      display_name          TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
      source_kind           TEXT NOT NULL CHECK (source_kind IN ('account', 'local_device', 'browser_collector', 'manual')),
      source_binding_key    TEXT NOT NULL,
      source_binding_json   TEXT NOT NULL DEFAULT '{}',
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL,
      revoked_at            TEXT,
      UNIQUE(owner_subject_id, connector_id, source_kind, source_binding_key),
      FOREIGN KEY(connector_id) REFERENCES connectors(connector_id) ON DELETE RESTRICT
    );
    INSERT INTO connectors VALUES ('gmail', '{}', '2026-06-02');
  `);
  insertInstance(raw, { id: 'cin_active_legacy', status: 'active', bindingKey: 'legacy' });
  assert.ok(!statusCheckSql(raw).includes("'draft'"), 'legacy CHECK is narrow');
  // The narrow CHECK rejects draft before the migration.
  assert.throws(
    () => insertInstance(raw, { id: 'cin_draft_pre', status: 'draft', bindingKey: 'pre' }),
    /CHECK constraint failed/,
  );
  raw.close();

  // initDb runs the migration.
  initDb(dbPath);
  closeDb();

  const v = new Database(dbPath);
  try {
    assert.ok(statusCheckSql(v).includes("'draft'"), 'CHECK widened to draft');
    // Existing row preserved.
    assert.equal(
      v.prepare(`SELECT status FROM connector_instances WHERE connector_instance_id = 'cin_active_legacy'`).get().status,
      'active',
    );
    // Draft now admissible.
    insertInstance(v, { id: 'cin_draft_post', status: 'draft', bindingKey: 'post' });
    assert.equal(
      v.prepare(`SELECT status FROM connector_instances WHERE connector_instance_id = 'cin_draft_post'`).get().status,
      'draft',
    );
  } finally {
    v.close();
  }
});

test('status-draft migration is idempotent', () => {
  const dbPath = tempDbPath();
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE connectors (
      connector_id TEXT PRIMARY KEY, manifest TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE connector_instances (
      connector_instance_id TEXT PRIMARY KEY,
      owner_subject_id      TEXT NOT NULL,
      connector_id          TEXT NOT NULL,
      display_name          TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
      source_kind           TEXT NOT NULL CHECK (source_kind IN ('account', 'local_device', 'browser_collector', 'manual')),
      source_binding_key    TEXT NOT NULL,
      source_binding_json   TEXT NOT NULL DEFAULT '{}',
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL,
      revoked_at            TEXT,
      UNIQUE(owner_subject_id, connector_id, source_kind, source_binding_key),
      FOREIGN KEY(connector_id) REFERENCES connectors(connector_id) ON DELETE RESTRICT
    );
    INSERT INTO connectors VALUES ('gmail', '{}', '2026-06-02');
  `);
  insertInstance(raw, { id: 'cin_keep', status: 'active', bindingKey: 'keep' });
  raw.close();

  initDb(dbPath);
  closeDb();
  // Second init must not throw or duplicate.
  initDb(dbPath);
  closeDb();

  const v = new Database(dbPath);
  try {
    assert.equal(v.prepare('SELECT COUNT(*) AS n FROM connector_instances').get().n, 1);
    assert.ok(statusCheckSql(v).includes("'draft'"));
  } finally {
    v.close();
  }
});
