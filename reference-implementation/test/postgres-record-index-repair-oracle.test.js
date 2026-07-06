import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import {
  closePostgresStorage,
  getPostgresPool,
  initPostgresStorage,
} from '../server/postgres-storage.js';

const { Pool } = pg;
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

let tempCounter = 0;
function tempDbName() {
  tempCounter += 1;
  return `pdpp_record_index_repair_${process.pid}_${tempCounter}`;
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

async function withTempDb(fn) {
  const admin = new Pool({ connectionString: adminUrl(POSTGRES_URL) });
  const name = tempDbName();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } catch (err) {
    await admin.end();
    throw err;
  }
  const url = dbUrl(POSTGRES_URL, name);
  try {
    await fn(url);
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

async function readIndex(pool, indexName) {
  const result = await pool.query(
    `SELECT idx.oid::text AS oid, pg_get_indexdef(idx.oid) AS definition
       FROM pg_class idx
       JOIN pg_namespace ns ON ns.oid = idx.relnamespace
      WHERE ns.nspname = current_schema()
        AND idx.relname = $1`,
    [indexName],
  );
  return result.rows[0] ?? null;
}

if (!POSTGRES_URL) {
  test('Postgres record index repair oracle tests (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  test('record index bootstrap repairs obsolete same-name index definitions', async () => {
    await withTempDb(async (url) => {
      await initPostgresStorage({ backend: 'postgres', databaseUrl: url });
      let pool = getPostgresPool();
      await pool.query('DROP INDEX idx_pg_records_stream_version');
      await pool.query('CREATE INDEX idx_pg_records_stream_version ON records(stream, version)');

      const obsolete = await readIndex(pool, 'idx_pg_records_stream_version');
      assert.match(obsolete?.definition ?? '', /USING btree \(stream, version\)/);

      await initPostgresStorage({ backend: 'postgres', databaseUrl: url });
      pool = getPostgresPool();
      const repaired = await readIndex(pool, 'idx_pg_records_stream_version');
      assert.match(
        repaired?.definition ?? '',
        /USING btree \(connector_instance_id, stream, version\)/,
      );
    });
  });
}
