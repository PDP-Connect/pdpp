// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Production incident, 2026-08-21: the owner's source-detail page took 44.5s
 * while a Google Maps re-ingest of 299,248 records ran concurrently.
 *
 * Two independent causes. The dominant one -- a missing keyset index on
 * `records`, which made BOTH the page's query and the backfill's own
 * coverage scan multi-second -- is fixed separately
 * (`idx_pg_records_instance_stream_id`). This file covers the second: the RI
 * runs the HTTP server, the scheduler and the connector/embedding runtime in
 * ONE Node process sharing ONE node-postgres Pool that never set `max`, so
 * the library default of 10 connections was the whole budget for interactive
 * request handlers AND background bulk work together.
 *
 * That is a QUEUEING failure, not a duration failure: even with every bulk
 * statement fast, enough concurrent bulk work can leave an interactive
 * handler waiting on `pool.connect()` for a connection that does not exist.
 * Chunking cannot fix it (the chunks are what exhaust the pool) and neither
 * can the index (it makes each statement cheap, not the supply larger).
 *
 * Worth stating plainly, because the incident write-up assumed otherwise:
 * the bulk path was ALREADY chunked before this change. The semantic rebuild
 * pages `records` 500 rows at a time and issues each page's read and write as
 * its own autocommit statement, holding no transaction across pages. So the
 * remedy here is not "introduce chunking" -- it is to give that already-
 * chunked work a lane of its own and a hard ceiling.
 *
 * This file proves, against REAL PostgreSQL:
 *   - Bulk work draws from a DIFFERENT pool than interactive work, so
 *     saturating the bulk lane leaves interactive capacity intact.
 *   - The bulk lane is bounded: a statement that exceeds the bulk
 *     `statement_timeout` is cancelled by Postgres and surfaces as
 *     `PostgresStatementTimeoutError`, not as an unbounded hang.
 *   - That bound is `SET LOCAL` and therefore does NOT leak onto the next
 *     caller to reuse the same physical connection.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  closePostgresStorage,
  getPostgresBulkPool,
  getPostgresPool,
  initPostgresStorage,
  PostgresStatementTimeoutError,
  postgresBulkQuery,
  postgresQuery,
} from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

function withPostgres(fn: () => Promise<void>) {
  return async () => {
    if (!POSTGRES_URL) {
      return;
    }
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await fn();
    } finally {
      await closePostgresStorage();
    }
  };
}

test(
  "the bulk lane is a distinct pool, so saturating it cannot consume interactive connections",
  withPostgres(async () => {
    const interactive = getPostgresPool();
    const bulk = getPostgresBulkPool();

    assert.notEqual(interactive, bulk, "bulk work must not draw from the interactive pool");

    // Occupy EVERY bulk connection with an in-flight statement, which is
    // exactly the burst that starved interactive handlers before the split.
    const bulkMax = bulk.options.max as number;
    assert.ok(bulkMax > 0, "the bulk pool must declare a bound");
    const held = await Promise.all(Array.from({ length: bulkMax }, () => bulk.connect()));
    try {
      assert.equal(bulk.idleCount, 0, "precondition: the bulk lane is genuinely saturated, not merely nominally busy");

      // The load-bearing assertion: with the bulk lane fully occupied, an
      // interactive query still completes. Before the split this same
      // saturation consumed connections this query needed.
      const result = await postgresQuery<{ ok: number }>("SELECT 1 AS ok", []);
      assert.equal(result.rows[0]?.ok, 1, "interactive work proceeds while the bulk lane is saturated");
    } finally {
      for (const client of held) {
        client.release();
      }
    }
  })
);

test(
  "a bulk statement that exceeds the bulk statement_timeout is cancelled rather than running unbounded",
  withPostgres(async () => {
    // pg_sleep(60) stands in for a pathological chunk. The bulk bound is
    // 15s, so Postgres must cancel this well before the sleep elapses --
    // proving the ceiling is enforced by the DB, not merely intended. (A
    // client-side timer could not do this: Postgres cannot preempt an
    // admitted transaction from outside, which is the whole reason
    // statement_timeout is the mechanism.)
    const startedAt = Date.now();
    await assert.rejects(
      () => postgresBulkQuery("SELECT pg_sleep(60)", []),
      (err: unknown) => err instanceof PostgresStatementTimeoutError,
      "an over-long bulk statement surfaces as PostgresStatementTimeoutError"
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(
      elapsedMs < 40_000,
      `the bulk bound must fire well before the statement's natural end (elapsed ${elapsedMs}ms)`
    );
  })
);

test(
  "the bulk bound is SET LOCAL and does not leak onto the next user of the same connection",
  withPostgres(async () => {
    // Run a bulk statement that COMMITS (does not roll back). This is the
    // case that distinguishes SET LOCAL from a bare SET: a bare SET inside a
    // transaction that later ROLLBACKs is discarded by the rollback anyway,
    // so a failing statement cannot detect the difference -- an earlier
    // draft of this test used pg_sleep and consequently could not tell the
    // two apart (confirmed by mutation: swapping SET LOCAL for SET left it
    // green). A committed transaction makes a bare SET persist on the
    // connection, which is exactly the leak being guarded against.
    await postgresBulkQuery("SELECT 1", []);

    // Read the setting OUTSIDE any bulk transaction. Check EVERY connection
    // the bulk pool can hand out, not just one: the pool holds up to `max`
    // physical connections and only the one that actually ran the statement
    // above would carry a leaked setting, so sampling a single arbitrary
    // connection could miss it.
    const bulk = getPostgresBulkPool();
    const bulkMax = bulk.options.max as number;
    const clients = await Promise.all(Array.from({ length: bulkMax }, () => bulk.connect()));
    try {
      const settings = await Promise.all(
        clients.map(async (client) => {
          const result = await client.query<{ statement_timeout: string }>("SHOW statement_timeout");
          return result.rows[0]?.statement_timeout;
        })
      );
      assert.deepEqual(
        settings,
        Array.from({ length: bulkMax }, () => "0"),
        "statement_timeout must revert at transaction end on every bulk connection, leaving none bounded for its next user"
      );
    } finally {
      for (const client of clients) {
        client.release();
      }
    }
  })
);
