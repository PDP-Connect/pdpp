// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `run_history.owner_epoch` must exist on BOTH backends.
 *
 * This test exists because a single-backend schema change has already shipped
 * here: `run_generation` reached SQLite without PostgreSQL and was caught only
 * as a deploy blocker. The failure mode is silent — the SQLite suite stays
 * green while the deployed backend lacks the column, and the fence it exists
 * to provide simply is not there.
 *
 * The SQLite half runs everywhere. The PostgreSQL half runs when
 * PDPP_TEST_POSTGRES_URL is configured, matching this repo's existing
 * Postgres-profile convention.
 *
 * Mutation proof (both halves independently verified to fail):
 *   - Removing the `addColumnIfMissing(raw, "run_history", "owner_epoch", ...)`
 *     line from server/db.ts fails the SQLite case.
 *   - Removing the `ALTER TABLE run_history ADD COLUMN IF NOT EXISTS
 *     owner_epoch` from server/postgres-storage.ts fails the PostgreSQL case.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

test("SQLite run_history carries a NULL-tolerant owner_epoch column", async () => {
  initDb(":memory:");
  try {
    const raw = getDb() as unknown as {
      prepare: (sql: string) => { all: () => Array<{ name: string; notnull: number }> };
    };
    const columns = raw.prepare("PRAGMA table_info(run_history)").all();
    const ownerEpoch = columns.find((column) => column.name === "owner_epoch");

    assert.ok(
      ownerEpoch,
      `run_history.owner_epoch is missing on SQLite. Columns: ${columns.map((c) => c.name).join(", ")}`
    );
    // NULL-tolerant is load-bearing: rows written before the column existed
    // must migrate without a backfill, and a NULL epoch is what makes them
    // claimable by any adjudicator.
    assert.equal(ownerEpoch.notnull, 0, "owner_epoch must be nullable so legacy rows need no backfill");
  } finally {
    await closeDb();
  }
});

if (POSTGRES_URL) {
  test("PostgreSQL run_history carries a NULL-tolerant owner_epoch column", async () => {
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      const result = await postgresQuery<{ is_nullable: string }>(
        `SELECT is_nullable
           FROM information_schema.columns
          WHERE table_name = 'run_history' AND column_name = 'owner_epoch'`
      );

      assert.equal(result.rows.length, 1, "run_history.owner_epoch is missing on PostgreSQL");
      assert.equal(result.rows[0]?.is_nullable, "YES", "owner_epoch must be nullable on PostgreSQL too");
    } finally {
      await closePostgresStorage();
    }
  });
} else {
  test("PostgreSQL owner_epoch column check", { skip: "PDPP_TEST_POSTGRES_URL not configured" }, () => {
    // Reported as skipped rather than silently absent: a dual-backend
    // requirement that quietly runs on one backend is the failure mode this
    // file exists to prevent.
  });
}
