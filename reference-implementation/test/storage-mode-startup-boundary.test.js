// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Storage-mode startup boundary smoke — both backends.
 *
 * Proves the exclusive storage-mode boundary at the one contract the default
 * test run otherwise only exercises in SQLite mode: `startServer()` startup.
 *
 *   - SQLite mode: `startServer()` opens and migrates the configured persistent
 *     SQLite file (the file appears on disk) and seeds the pre-registered client
 *     into it.
 *   - Postgres mode: `startServer()` reaches readiness WITHOUT opening the
 *     configured persistent SQLite file (the file path stays absent on disk),
 *     and seeds the pre-registered client into Postgres. The persistent SQLite
 *     path is deliberately pointed at a file that does not exist and must never
 *     be created — a Postgres boot that touched it would create it.
 *
 * The Postgres half is gated on `PDPP_TEST_POSTGRES_URL`. When set, the test
 * creates and drops its own temporary database; when unset it registers a
 * single skipped test so the contract is acknowledged but the suite stays green
 * without Postgres.
 *
 * Spec: openspec/changes/exclude-persistent-sqlite-from-postgres-boot/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';

import { getRegisteredClient } from '../server/auth.js';
import { closeDb } from '../server/db.js';
import {
  closePostgresStorage,
  getStorageBackendKind,
} from '../server/postgres-storage.js';
import { startServer } from '../server/index.js';

const SEED_CLIENT = {
  client_id: 'storage-boundary-smoke-client',
  registration_mode: 'pre_registered_public',
  client_name: 'Storage Boundary Smoke',
  token_endpoint_auth_method: 'none',
};

const { Pool } = pg;
let tempPostgresCounter = 0;

function tempPostgresDbName() {
  tempPostgresCounter += 1;
  return `pdpp_storage_boundary_${process.pid}_${tempPostgresCounter}`;
}

function adminUrl(url) {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}

function dbUrl(url, dbName) {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function withTempPostgresDb(fn) {
  const admin = new Pool({ connectionString: adminUrl(POSTGRES_URL) });
  const name = tempPostgresDbName();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`CREATE DATABASE "${name}"`);
    await fn(dbUrl(POSTGRES_URL, name));
  } finally {
    try {
      await closePostgresStorage();
    } catch {}
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name],
      );
    } catch {}
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    } catch {}
    await admin.end();
  }
}

async function closeStartedServer(server) {
  if (!server) return;
  const closeOne = (httpServer) =>
    new Promise((resolve) => {
      if (!httpServer) {
        resolve();
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 2000);
      httpServer.closeAllConnections?.();
      httpServer.close(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
    });

  await Promise.allSettled([
    closeOne(server.asServer),
    closeOne(server.rsServer),
  ]);
}

test('SQLite-mode startup opens the persistent file and seeds clients into it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-storage-boundary-sqlite-'));
  const dbPath = join(dir, 'pdpp.sqlite');
  let server = null;
  try {
    assert.equal(existsSync(dbPath), false, 'precondition: db file absent before boot');
    server = await startServer({
      quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath,
      preRegisteredPublicClients: [SEED_CLIENT],
    });
    assert.equal(getStorageBackendKind(), 'sqlite', 'SQLite mode is the default backend');
    assert.equal(
      existsSync(dbPath),
      true,
      'SQLite mode SHALL open/migrate the configured persistent file',
    );
    const seeded = await getRegisteredClient(SEED_CLIENT.client_id);
    assert.ok(seeded, 'pre-registered client SHALL be readable from the SQLite backend after boot');
    assert.equal(seeded.client_id, SEED_CLIENT.client_id);
  } finally {
    await closeStartedServer(server);
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (!POSTGRES_URL) {
  test('Postgres-mode startup boundary (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  test('Postgres-mode startup reaches readiness without opening the persistent SQLite file', async () => {
    await withTempPostgresDb(async (databaseUrl) => {
      const dir = mkdtempSync(join(tmpdir(), 'pdpp-storage-boundary-postgres-'));
      // A persistent path the boot MUST NOT touch. If startServer opened/migrated
      // SQLite in Postgres mode, better-sqlite3 would create this file.
      const forbiddenSqlitePath = join(dir, 'must-not-be-created.sqlite');
      let server = null;
      try {
        assert.equal(
          existsSync(forbiddenSqlitePath),
          false,
          'precondition: forbidden SQLite file absent before boot',
        );
        server = await startServer({
          quiet: true,
          asPort: 0,
          rsPort: 0,
          dbPath: forbiddenSqlitePath,
          storageBackend: 'postgres',
          databaseUrl,
          reconcilePolyfillManifests: false,
          preRegisteredPublicClients: [SEED_CLIENT],
        });
        assert.equal(getStorageBackendKind(), 'postgres', 'Postgres mode is active');
        assert.equal(
          existsSync(forbiddenSqlitePath),
          false,
          'Postgres-mode startup SHALL NOT open/create the configured persistent SQLite file',
        );
        const seeded = await getRegisteredClient(SEED_CLIENT.client_id);
        assert.ok(seeded, 'pre-registered client SHALL be readable from the Postgres backend after boot');
        assert.equal(seeded.client_id, SEED_CLIENT.client_id);
      } finally {
        await closeStartedServer(server);
        closeDb();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
