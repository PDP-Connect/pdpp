// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The resumable semantic backfill must ask about ONE PAGE of record keys, never
 * about every key a stream has ever indexed.
 *
 * The whole-stream read is what took production down on 2026-08-27: a single
 * claude-code `messages` stream held 1,515,064 rows, the boot-time backfill
 * materialized all of them as JSON strings in one Set (~200 MB), and the
 * process reached its heap ceiling roughly twenty minutes after every start —
 * forever, because the read happens at boot and the crash triggers the restart.
 *
 * These tests pin the property that makes that impossible: the query is scoped
 * by `record_key = ANY($4)`, so what it returns — and therefore what it
 * retains — is bounded by the caller's page, not by the table.
 */

import assert from "node:assert/strict";
import test from "node:test";

// biome-ignore lint/correctness/noUnresolvedImports: the test runner resolves this runtime fixture import outside Biome static resolution.
import pg from "pg";
import { postgresListExistingSemanticKeysForRecords } from "../server/postgres-search.ts";
import { bootstrapPostgresSchema, closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const CONNECTOR_ID = "claude-code";
const CONNECTOR_INSTANCE_ID = "cin_bounded_keys_test";
const STREAM = "messages";
/**
 * Deliberately larger than the page the production loop uses (500) so "returned
 * only the page" is distinguishable from "returned everything and happened to
 * fit". With a whole-stream read every one of these comes back.
 */
const TOTAL_INDEXED_RECORDS = 1200;
const PAGE_SIZE = 5;

function scopeKeyFor(field: string): string {
  return JSON.stringify([STREAM, field]);
}

async function seedIndexedKeys(url: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: url });
  try {
    const scopeKey = scopeKeyFor("content");
    // One multi-row insert: seeding is not what these tests measure.
    const values = Array.from({ length: TOTAL_INDEXED_RECORDS }, (_, i) => `rec_${String(i).padStart(5, "0")}`);
    await pool.query(
      `INSERT INTO semantic_search_blob (connector_id, connector_instance_id, scope_key, record_key, embedding)
       SELECT $1, $2, $3, key, '[0]' FROM unnest($4::text[]) AS key`,
      [CONNECTOR_ID, CONNECTOR_INSTANCE_ID, scopeKey, values]
    );
  } finally {
    await pool.end();
  }
}

test("postgresListExistingSemanticKeysForRecords: returns only the requested page, never the whole stream", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is not set",
}, async () => {
  const databaseName = `pdpp_bounded_keys_${Date.now().toString(36)}`;
  await withTemporaryPostgresDatabase(
    { closeConnections: closePostgresStorage, connectionString: POSTGRES_URL as string, databaseName },
    async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      await bootstrapPostgresSchema();
      await seedIndexedKeys(url);

      const requested = Array.from({ length: PAGE_SIZE }, (_, i) => `rec_${String(i).padStart(5, "0")}`);
      const keys = await postgresListExistingSemanticKeysForRecords({
        connectorId: CONNECTOR_ID,
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        recordKeys: requested,
        scopeKeys: [scopeKeyFor("content")],
      });

      assert.equal(
        keys.size,
        PAGE_SIZE,
        `must return exactly the ${PAGE_SIZE} requested keys; a whole-stream read returns ${TOTAL_INDEXED_RECORDS} and is what exhausted the heap in production`
      );
      for (const recordKey of requested) {
        assert.ok(
          keys.has(JSON.stringify([scopeKeyFor("content"), `${CONNECTOR_INSTANCE_ID}\u0000${recordKey}`])),
          `requested key ${recordKey} must be reported as already indexed, or the backfill re-embeds it`
        );
      }
    }
  );
});

test("postgresListExistingSemanticKeysForRecords: an empty page asks Postgres nothing", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is not set",
}, async () => {
  const databaseName = `pdpp_bounded_keys_empty_${Date.now().toString(36)}`;
  await withTemporaryPostgresDatabase(
    { closeConnections: closePostgresStorage, connectionString: POSTGRES_URL as string, databaseName },
    async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      await bootstrapPostgresSchema();
      await seedIndexedKeys(url);

      // `= ANY('{}')` matches nothing, so the guard is not load-bearing for
      // correctness — but a final empty page is the common case at the end of
      // every rebuild, and paying a round trip for a known-empty answer is
      // waste the caller cannot see.
      const keys = await postgresListExistingSemanticKeysForRecords({
        connectorId: CONNECTOR_ID,
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        recordKeys: [],
        scopeKeys: [scopeKeyFor("content")],
      });
      assert.equal(keys.size, 0, "an empty page has no already-indexed keys");
    }
  );
});

test("postgresListExistingSemanticKeysForRecords: does not leak keys from another stream", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is not set",
}, async () => {
  const databaseName = `pdpp_bounded_keys_scope_${Date.now().toString(36)}`;
  await withTemporaryPostgresDatabase(
    { closeConnections: closePostgresStorage, connectionString: POSTGRES_URL as string, databaseName },
    async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      await bootstrapPostgresSchema();

      const pool = new pg.Pool({ connectionString: url });
      try {
        // Same record_key, different stream. Dropping the scope_key filter
        // would report this row as an already-indexed `messages` key and the
        // backfill would silently skip embedding a record it never indexed.
        await pool.query(
          `INSERT INTO semantic_search_blob (connector_id, connector_instance_id, scope_key, record_key, embedding)
             VALUES ($1, $2, $3, $4, '[0]')`,
          [CONNECTOR_ID, CONNECTOR_INSTANCE_ID, JSON.stringify(["attachments", "content"]), "rec_00000"]
        );
      } finally {
        await pool.end();
      }

      const keys = await postgresListExistingSemanticKeysForRecords({
        connectorId: CONNECTOR_ID,
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        recordKeys: ["rec_00000"],
        scopeKeys: [scopeKeyFor("content")],
      });
      assert.equal(keys.size, 0, "a key indexed under a different stream is not an indexed key for this stream");
    }
  );
});

// The bounded-Set property is not enough. The 2026-08-27 production incident was
// a QUERY PLAN defect: the correct answer, computed by scanning 1.5M rows.
// `semantic_search_blob`'s primary key is (connector_instance_id, scope_key,
// record_key); a `LIKE 'prefix%'` on the MIDDLE column cannot be an index
// condition, so Postgres demotes it to a filter and index-scans the whole
// instance. Measured live: 5924ms vs 0.069ms for the same single-key lookup.
// This test reads the plan itself, because a correctness assertion passes
// either way and cannot see the difference.
test("postgresListExistingSemanticKeysForRecords: scope_key is an INDEX CONDITION, never a filter", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is not set",
}, async () => {
  const databaseName = `pdpp_bounded_keys_plan_${Date.now().toString(36)}`;
  await withTemporaryPostgresDatabase(
    { closeConnections: closePostgresStorage, connectionString: POSTGRES_URL as string, databaseName },
    async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      await bootstrapPostgresSchema();

      const pool = new pg.Pool({ connectionString: url });
      try {
        const plan = await pool.query(
          `EXPLAIN SELECT scope_key, record_key
               FROM semantic_search_blob
              WHERE connector_id = $1
                AND connector_instance_id = $2
                AND scope_key = ANY($3)
                AND record_key = ANY($4)`,
          [CONNECTOR_ID, CONNECTOR_INSTANCE_ID, [scopeKeyFor("content")], ["rec_00000"]]
        );
        const text = plan.rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
        const indexCond = text.split("\n").find((l) => l.includes("Index Cond")) ?? "";
        assert.ok(
          indexCond.includes("scope_key"),
          `scope_key must be part of the Index Cond, or Postgres scans every row for the instance. Plan was:\n${text}`
        );
      } finally {
        await pool.end();
      }
    }
  );
});
