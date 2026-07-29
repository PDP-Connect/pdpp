// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { closePostgresStorage, getPostgresPool, initPostgresStorage } from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

let tempCounter = 0;
function tempDbName(): string {
  tempCounter += 1;
  return `pdpp_record_index_idem_${process.pid}_${tempCounter}`;
}

async function withTempDb(baseUrl: string, fn: (url: string) => Promise<void>): Promise<void> {
  await withTemporaryPostgresDatabase(
    { closeConnections: closePostgresStorage, connectionString: baseUrl, databaseName: tempDbName() },
    fn
  );
}

async function readIndex(
  pool: ReturnType<typeof getPostgresPool>,
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
