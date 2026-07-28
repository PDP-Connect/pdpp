// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

// biome-ignore lint/correctness/noUnresolvedImports: the test runner resolves this runtime fixture import outside Biome static resolution.
import pg from "pg";

import { closePostgresStorage, getPostgresPool, initPostgresStorage } from "../server/postgres-storage.ts";

const { Pool } = pg;
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

let tempCounter = 0;
function tempDbName(): string {
  tempCounter += 1;
  return `pdpp_record_index_idem_${process.pid}_${tempCounter}`;
}

function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = "/postgres";
  return u.toString();
}

function dbUrl(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function withTempDb(baseUrl: string, fn: (url: string) => Promise<void>): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl(baseUrl) });
  const name = tempDbName();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } catch (err) {
    await admin.end();
    throw err;
  }
  const url = dbUrl(baseUrl, name);
  try {
    await fn(url);
  } finally {
    try {
      await closePostgresStorage();
    } catch {
      /* intentional: cleanup is best-effort */
    }
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name]
      );
    } catch {
      /* intentional: cleanup is best-effort */
    }
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    } catch {
      /* intentional: cleanup is best-effort */
    }
    await admin.end();
  }
}

async function readIndex(
  pool: pg.Pool,
  indexName: string
): Promise<{ oid: string; definition: string; valid: boolean } | null> {
  const result = await pool.query<{ oid: string; definition: string; valid: boolean }>(
    `SELECT idx.oid::text AS oid, pg_get_indexdef(idx.oid) AS definition, ix.indisvalid AS valid
       FROM pg_class idx
       JOIN pg_namespace ns ON ns.oid = idx.relnamespace
       JOIN pg_index ix ON ix.indexrelid = idx.oid
      WHERE ns.nspname = current_schema()
        AND idx.relname = $1`,
    [indexName]
  );
  return result.rows[0] ?? null;
}

if (POSTGRES_URL) {
  test("record index bootstrap keeps matching stream/version index oid across restart", async () => {
    await withTempDb(POSTGRES_URL, async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      let pool = getPostgresPool();
      const before = await readIndex(pool, "idx_pg_records_stream_version");
      assert.ok(before?.oid, "records stream/version index exists after first boot");
      assert.equal(before?.valid, true, "records stream/version index is valid after first boot");

      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      pool = getPostgresPool();
      const after = await readIndex(pool, "idx_pg_records_stream_version");
      assert.equal(after?.oid, before.oid, "boot must not drop/recreate a matching index");
    });
  });
} else {
  test("Postgres record index idempotency-oracle tests (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
  }, () => {
    // skip
  });
}
