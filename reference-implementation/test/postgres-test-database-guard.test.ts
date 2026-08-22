// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proof for the fail-closed test-database admission guard
 * (`server/postgres-test-database-guard.ts`).
 *
 * The guard exists because a Postgres-backed test was pointed at the
 * PRODUCTION database and wrote 42 stray rows into real owner data. A guard
 * with only a passing case is theater, so this file proves BOTH directions
 * against a real Postgres server:
 *
 *   REFUSES  a production-shaped database (no sentinel; and, separately, a
 *            sentinel-stamped database that already holds `records` rows)
 *   ALLOWS   a properly-provisioned, empty, sentinel-stamped test database
 *
 * Each scenario builds its own throwaway database off the dedicated test
 * listener, so the proof never depends on ambient state and never touches a
 * database it did not create.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve this installed package export; Node and TypeScript resolve it.
import pg from "pg";
import {
  assertTestDatabase,
  ProductionDatabaseRefusedError,
  provisionTestDatabase,
  TEST_DATABASE_SENTINEL_TABLE,
  testDatabaseGuardActive,
} from "../server/postgres-test-database-guard.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const REFUSAL_HEADLINE_PATTERN = /REFUSING to run tests against/;
const SENTINEL_TABLE_PATTERN = new RegExp(TEST_DATABASE_SENTINEL_TABLE);
// A refusal names the target host/port/database but must never echo the
// password from the connection URL.
const CREDENTIAL_LEAK_PATTERN = /:[^/@]*@/;
const OWNER_ROW_COUNT_PATTERN = /already holds 1 row\(s\)/;

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const POSTGRES_SKIP = POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset or non-dedicated";

function adminUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

function urlForDb(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/** Create a throwaway database and hand its URL to `body`, dropping it after. */
async function withScratchDatabase(baseUrl: string, body: (url: string, dbName: string) => Promise<void>) {
  const dbName = `pdpp_guardproof_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl(baseUrl) });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();
  try {
    await body(urlForDb(baseUrl, dbName), dbName);
  } finally {
    const cleanup = new pg.Client({ connectionString: adminUrl(baseUrl) });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await cleanup.end();
  }
}

async function exec(url: string, sql: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

// --- Direction 1: REFUSE a production-shaped database -----------------------

test("guard REFUSES a production-shaped database that carries no test sentinel", { skip: POSTGRES_SKIP }, async () => {
  assert.ok(POSTGRES_URL);
  await withScratchDatabase(POSTGRES_URL, async (url) => {
    // Production shape: a real `records` table holding owner data, and no
    // sentinel -- exactly what the live database looks like.
    await exec(
      url,
      `CREATE TABLE records (
           id bigserial PRIMARY KEY,
           connector_id text NOT NULL,
           stream text NOT NULL,
           record_key text NOT NULL,
           record_json jsonb NOT NULL
         );
         INSERT INTO records (connector_id, stream, record_key, record_json)
         VALUES ('gmail', 'messages', 'real-owner-row', '{}'::jsonb);`
    );

    const error = await assertTestDatabase(url).then(
      () => null,
      (err: unknown) => err
    );

    assert.ok(
      error instanceof ProductionDatabaseRefusedError,
      `expected ProductionDatabaseRefusedError, got: ${String(error)}`
    );
    assert.equal((error as ProductionDatabaseRefusedError).code, "PDPP_PRODUCTION_DATABASE_REFUSED");
    assert.match(error.message, REFUSAL_HEADLINE_PATTERN);
    assert.match(error.message, SENTINEL_TABLE_PATTERN);
    // The refusal must never leak the password from the connection URL.
    assert.doesNotMatch(error.message, CREDENTIAL_LEAK_PATTERN);
  });
});

test("guard REFUSES an EMPTY database that carries no test sentinel (fail-closed default)", {
  skip: POSTGRES_SKIP,
}, async () => {
  assert.ok(POSTGRES_URL);
  await withScratchDatabase(POSTGRES_URL, async (url) => {
    // No tables at all. An unmarked database is refused even when it looks
    // harmless: absence of a sentinel is refusal, which is what makes the
    // guard fail CLOSED rather than open.
    await assert.rejects(assertTestDatabase(url), ProductionDatabaseRefusedError);
  });
});

test("guard REFUSES a sentinel-stamped database that already holds owner data", {
  skip: POSTGRES_SKIP,
}, async () => {
  assert.ok(POSTGRES_URL);
  await withScratchDatabase(POSTGRES_URL, async (url) => {
    // Defense in depth: someone stamped a sentinel onto a database that holds
    // real records (a restored production dump, or a hand-stamped real DB).
    // The marker alone must not buy admission.
    await provisionTestDatabase(url);
    await exec(
      url,
      `CREATE TABLE records (
         id bigserial PRIMARY KEY,
         connector_id text NOT NULL,
         stream text NOT NULL,
         record_key text NOT NULL,
         record_json jsonb NOT NULL
       );
       INSERT INTO records (connector_id, stream, record_key, record_json)
       VALUES ('gmail', 'messages', 'real-owner-row', '{}'::jsonb);`
    );

    const error = await assertTestDatabase(url).then(
      () => null,
      (err: unknown) => err
    );
    assert.ok(
      error instanceof ProductionDatabaseRefusedError,
      `expected refusal for sentinel-stamped DB holding owner data, got: ${String(error)}`
    );
    assert.match(error.message, OWNER_ROW_COUNT_PATTERN);
  });
});

test("provisionTestDatabase REFUSES to stamp a database that holds owner data", {
  skip: POSTGRES_SKIP,
}, async () => {
  assert.ok(POSTGRES_URL);
  await withScratchDatabase(POSTGRES_URL, async (url) => {
    // The sentinel cannot be minted onto production. This is what keeps the
    // positive marker honest -- otherwise the fix would be one command away
    // from being defeated.
    await exec(
      url,
      `CREATE TABLE records (
         id bigserial PRIMARY KEY,
         connector_id text NOT NULL,
         stream text NOT NULL,
         record_key text NOT NULL,
         record_json jsonb NOT NULL
       );
       INSERT INTO records (connector_id, stream, record_key, record_json)
       VALUES ('gmail', 'messages', 'real-owner-row', '{}'::jsonb);`
    );

    await assert.rejects(provisionTestDatabase(url), ProductionDatabaseRefusedError);
  });
});

// --- Direction 2: ALLOW a properly-provisioned test database ----------------

test("guard ALLOWS a properly-provisioned, empty test database", { skip: POSTGRES_SKIP }, async () => {
  assert.ok(POSTGRES_URL);
  await withScratchDatabase(POSTGRES_URL, async (url) => {
    await provisionTestDatabase(url);
    // Must not throw. If the guard ever refused a real provisioned database,
    // the whole Postgres suite would be dead, so this direction matters as
    // much as the refusal.
    await assertTestDatabase(url);
  });
});

test("guard ALLOWS a provisioned test database with an EMPTY records table", {
  skip: POSTGRES_SKIP,
}, async () => {
  assert.ok(POSTGRES_URL);
  await withScratchDatabase(POSTGRES_URL, async (url) => {
    await provisionTestDatabase(url);
    await exec(
      url,
      `CREATE TABLE records (
         id bigserial PRIMARY KEY,
         connector_id text NOT NULL,
         stream text NOT NULL,
         record_key text NOT NULL,
         record_json jsonb NOT NULL
       );`
    );
    // A bootstrapped-but-empty schema is the normal state of a test database
    // after initPostgresStorage runs; it must stay admissible.
    await assertTestDatabase(url);
  });
});

test("guard survives a suite that DROPs SCHEMA public (sentinel lives in its own schema)", {
  skip: POSTGRES_SKIP,
}, async () => {
  assert.ok(POSTGRES_URL);
  await withScratchDatabase(POSTGRES_URL, async (url) => {
    await provisionTestDatabase(url);
    // browser-surface-lease-store.test.ts legitimately does exactly this to
    // exercise the empty-database bootstrap path. A sentinel stored in
    // `public` would be destroyed here and every later initPostgresStorage in
    // that file would be refused -- the guard would break honest tests.
    await exec(url, "DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await assertTestDatabase(url);
  });
});

test("provisionTestDatabase is idempotent", { skip: POSTGRES_SKIP }, async () => {
  assert.ok(POSTGRES_URL);
  await withScratchDatabase(POSTGRES_URL, async (url) => {
    await provisionTestDatabase(url);
    await provisionTestDatabase(url);
    await assertTestDatabase(url);
  });
});

// --- Activation scope (pure; runs everywhere) ------------------------------

test("guard activates for test lanes and stays inert for product boots", () => {
  assert.equal(testDatabaseGuardActive({ PDPP_TEST_POSTGRES_URL: "postgresql://x/y" }), true);
  assert.equal(testDatabaseGuardActive({ PDPP_REQUIRE_TEST_DATABASE: "1" }), true);
  // A production boot sets neither, so it is never subject to the sentinel
  // requirement -- the guard must not be able to break the real server.
  assert.equal(testDatabaseGuardActive({ PDPP_DATABASE_URL: "postgresql://prod/pdpp" }), false);
  assert.equal(testDatabaseGuardActive({}), false);
});
