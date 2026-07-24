// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  closePostgresStorage,
  getPostgresPool,
  initPostgresStorage,
} from '../server/postgres-storage.js';
import { withTemporaryPostgresDatabase } from './helpers/postgres-temp-database.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

let tempCounter = 0;
function tempDbName() {
  tempCounter += 1;
  return `pdpp_record_index_boot_${process.pid}_${tempCounter}`;
}

async function withTempDb(fn) {
  return withTemporaryPostgresDatabase(
    { connectionString: POSTGRES_URL, databaseName: tempDbName(), closeConnections: closePostgresStorage },
    fn,
  );
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
  test('Postgres record index bootstrap tests (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  test('record index bootstrap keeps matching indexes across restart', async () => {
    await withTempDb(async (url) => {
      await initPostgresStorage({ backend: 'postgres', databaseUrl: url });
      let pool = getPostgresPool();
      const before = await readIndex(pool, 'idx_pg_records_stream_version');
      assert.ok(before?.oid, 'records stream/version index exists after first boot');

      await initPostgresStorage({ backend: 'postgres', databaseUrl: url });
      pool = getPostgresPool();
      const after = await readIndex(pool, 'idx_pg_records_stream_version');
      assert.equal(after?.oid, before.oid, 'boot must not drop/recreate a matching index');
    });
  });

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
