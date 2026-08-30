// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pins the write-elision guard in `postgresLexicalIndexPublishWithClient`
 * against a REAL Postgres, because the defect it fixes is a storage-engine
 * fact that no in-memory fake can express: re-publishing identical content
 * used to DELETE and re-INSERT every field row, leaving one dead tuple per
 * field per re-collect.
 *
 * Production, 2026-08-30: 195.8M inserts and 192.2M deletes to hold ~8M live
 * rows — roughly 9,195 index writes per record write, ~22.8M inserts/hour
 * against a ~7M-row corpus. The autovacuum load that generated starved the
 * connector-maintenance sweep, which sat at 47 consecutive no-progress passes
 * while a source's record count stayed visibly stale for hours.
 *
 * These tests assert the storage effect (dead tuples / row identity), not just
 * the query result, because a test that only checked search output would pass
 * against the old unconditional delete-and-reinsert and prove nothing.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { postgresLexicalIndexPublishWithClient, postgresLexicalSearch } from "../server/postgres-search.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
  withPostgresTransaction,
} from "../server/postgres-storage.ts";
import { provisionTestDatabase } from "../server/postgres-test-database-guard.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const CONNECTOR_ID = "lexical-churn-fixture";
const INSTANCE_ID = "cin_lexical_churn_fixture";
const STREAM = "messages";
const RECORD_KEY = "rec-1";

async function publish(fields: Record<string, unknown>): Promise<void> {
  await withPostgresTransaction((client) =>
    postgresLexicalIndexPublishWithClient(client, {
      connectorId: CONNECTOR_ID,
      connectorInstanceId: INSTANCE_ID,
      fields,
      recordKey: RECORD_KEY,
      stream: STREAM,
    })
  );
}

/** Rows for the fixture record, as `field -> value`, in a stable order. */
async function indexRows(): Promise<Array<{ field: string; value: string }>> {
  const result = await postgresQuery<{ field: string; value: string }>(
    "SELECT field, value FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3 ORDER BY field",
    [INSTANCE_ID, STREAM, RECORD_KEY]
  );
  return result.rows;
}

/**
 * Physical row identity. A DELETE + re-INSERT produces new tuples with new
 * ctids even when the visible values are identical, so this is what separates
 * "wrote nothing" from "rewrote the same thing".
 */
async function rowCtids(): Promise<string[]> {
  const result = await postgresQuery<{ ctid: string }>(
    "SELECT ctid::text AS ctid FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3 ORDER BY field",
    [INSTANCE_ID, STREAM, RECORD_KEY]
  );
  return result.rows.map((row) => row.ctid);
}

async function reset(): Promise<void> {
  await postgresQuery("DELETE FROM lexical_search_index WHERE connector_instance_id = $1", [INSTANCE_ID]);
  await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1", [INSTANCE_ID]);
}

if (POSTGRES_URL) {
  test("re-publishing identical fields writes nothing at all", async (t) => {
    await provisionTestDatabase(POSTGRES_URL);
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    t.after(async () => {
      await reset();
      await closePostgresStorage();
    });
    await reset();

    const fields = { body: "the quick brown fox", subject: "hello world" };
    await publish(fields);
    const before = await rowCtids();
    assert.equal(before.length, 2, "fixture must actually index two fields");

    // The whole point: a second publish of byte-identical content.
    await publish(fields);
    const after = await rowCtids();

    assert.deepEqual(
      after,
      before,
      "identical content must leave the physical rows untouched — differing ctids mean the row was deleted and re-inserted, which is the churn this guard removes"
    );
    assert.deepEqual(await indexRows(), [
      { field: "body", value: "the quick brown fox" },
      { field: "subject", value: "hello world" },
    ]);
  });

  test("a changed field value is still published", async (t) => {
    await provisionTestDatabase(POSTGRES_URL);
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    t.after(async () => {
      await reset();
      await closePostgresStorage();
    });
    await reset();

    await publish({ body: "original text", subject: "hello world" });
    await publish({ body: "replacement text", subject: "hello world" });

    assert.deepEqual(
      await indexRows(),
      [
        { field: "body", value: "replacement text" },
        { field: "subject", value: "hello world" },
      ],
      "a real edit must reach the index — skipping it would silently serve stale search results"
    );
  });

  test("a removed field is deleted from the index", async (t) => {
    await provisionTestDatabase(POSTGRES_URL);
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    t.after(async () => {
      await reset();
      await closePostgresStorage();
    });
    await reset();

    await publish({ body: "still here", subject: "goes away" });
    await publish({ body: "still here" });

    assert.deepEqual(
      await indexRows(),
      [{ field: "body", value: "still here" }],
      "a field that disappears from the record must disappear from the index, or search keeps matching text the record no longer has"
    );
  });

  test("an added field is inserted without disturbing the untouched ones", async (t) => {
    await provisionTestDatabase(POSTGRES_URL);
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    t.after(async () => {
      await reset();
      await closePostgresStorage();
    });
    await reset();

    await publish({ body: "unchanged body" });
    const bodyCtidBefore = await rowCtids();

    await publish({ body: "unchanged body", subject: "brand new" });

    assert.deepEqual(
      await indexRows(),
      [
        { field: "body", value: "unchanged body" },
        { field: "subject", value: "brand new" },
      ],
      "the new field must be indexed"
    );
    const after = await rowCtids();
    assert.equal(after[0], bodyCtidBefore[0], "adding one field must not rewrite the fields that did not change");
  });

  test("elision does not change what search returns", async (t) => {
    await provisionTestDatabase(POSTGRES_URL);
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    t.after(async () => {
      await reset();
      await closePostgresStorage();
    });
    await reset();

    const fields = { body: "salamander", subject: "amphibian notes" };
    await publish(fields);
    await publish(fields);
    await publish(fields);
    // The production search JOINs the visible `records` row, so the fixture
    // needs one or this would fail for a reason unrelated to elision.
    await postgresQuery(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, 1, FALSE, $4)
       ON CONFLICT (connector_instance_id, stream, record_key) DO UPDATE
         SET record_json = EXCLUDED.record_json, deleted = FALSE`,
      [
        CONNECTOR_ID,
        INSTANCE_ID,
        STREAM,
        RECORD_KEY,
        JSON.stringify({ id: RECORD_KEY, ...fields }),
        "2026-06-01T00:00:00.000Z",
      ]
    );

    const hits = await postgresLexicalSearch({
      connectorId: CONNECTOR_ID,
      connectorInstanceId: INSTANCE_ID,
      limit: 10,
      q: "salamander",
      stream: STREAM,
    });
    assert.ok(
      hits.some((hit: { record_key?: string; recordKey?: string }) => (hit.record_key ?? hit.recordKey) === RECORD_KEY),
      "the record must still be findable after repeated no-op publishes"
    );
  });
} else {
  test("lexical index write-elision (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {
    /* intentionally empty */
  });
}
