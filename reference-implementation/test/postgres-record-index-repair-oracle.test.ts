// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { closePostgresStorage, getPostgresPool, initPostgresStorage } from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const RE_STREAM_VERSION_BTREE = /USING btree \(stream, version\)/;
const RE_CIN_STREAM_VERSION_BTREE = /USING btree \(connector_instance_id, stream, version\)/;

let tempCounter = 0;
function tempDbName(): string {
  tempCounter += 1;
  return `pdpp_record_index_repair_${process.pid}_${tempCounter}`;
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
): Promise<{ oid: string; definition: string } | null> {
  const result = await pool.query<{ oid: string; definition: string }>(
    `SELECT idx.oid::text AS oid, pg_get_indexdef(idx.oid) AS definition
       FROM pg_class idx
       JOIN pg_namespace ns ON ns.oid = idx.relnamespace
      WHERE ns.nspname = current_schema()
        AND idx.relname = $1`,
    [indexName]
  );
  return result.rows[0] ?? null;
}

if (POSTGRES_URL) {
  test("record index bootstrap repairs obsolete same-name index definitions", async () => {
    await withTempDb(POSTGRES_URL, async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      let pool = getPostgresPool();
      await pool.query("DROP INDEX idx_pg_records_stream_version");
      await pool.query("CREATE INDEX idx_pg_records_stream_version ON records(stream, version)");

      const obsolete = await readIndex(pool, "idx_pg_records_stream_version");
      assert.ok(obsolete !== null, "obsolete index must exist after DROP+CREATE");
      assert.match(obsolete.definition, RE_STREAM_VERSION_BTREE);

      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      pool = getPostgresPool();
      const repaired = await readIndex(pool, "idx_pg_records_stream_version");
      assert.ok(repaired !== null, "repaired index must exist after bootstrap");
      assert.match(repaired.definition, RE_CIN_STREAM_VERSION_BTREE);
    });
  });
} else {
  test("Postgres record index repair oracle tests (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {
    // skip
  });
}
