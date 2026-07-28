// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * connector_instances.status `draft` CHECK-widening migration — SQLite.
 *
 * Verifies the migration that widens the status CHECK to admit `draft`:
 *   - fresh DB created with the new schema accepts a `draft` row directly;
 *   - a legacy DB with the narrow CHECK is rebuilt on initDb(), existing rows
 *     preserved, and a `draft` insert then succeeds;
 *   - the migration is idempotent (a second initDb is a no-op).
 *
 * See add-static-secret-owner-session-connect-path design Decision 1.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: Biome resolver lacks this runtime-supported dependency export shape.
import Database from "better-sqlite3";
// biome-ignore lint/correctness/noUnresolvedImports: Biome resolver lacks this runtime-supported dependency export shape.
import pg from "pg";

// biome-ignore lint/performance/noNamespaceImport: Namespace import is required for controlled module seam replacement.
import * as dbModule from "../server/db.ts";
// biome-ignore lint/performance/noNamespaceImport: Namespace import is required for controlled module seam replacement.
import * as postgresStorageModule from "../server/postgres-storage.ts";

const REGEXP_1 = /(?:^|[_-])test(?:[_-]|$)/i;
const REGEXP_2 = /CHECK constraint failed/;
const REGEXP_3 = /^\//;
const REGEXP_4 = /CHECK constraint failed/;

const { Pool } = pg;
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

// `server/db.js` and `server/postgres-storage.js` are still plain JS with no
// `.d.ts` — declare the honest local shapes for the entrypoints this test
// actually calls and cast the namespace imports through them, per the
// established `.js`-import boundary pattern.
type InitDb = (path?: string, opts?: { busyTimeoutMs?: number }) => unknown;
type CloseDb = () => void;
const initDb = dbModule.initDb as InitDb;
const closeDb = dbModule.closeDb as CloseDb;

interface PostgresStorageConfig {
  backend: "postgres";
  databaseUrl: string;
}
type InitPostgresStorage = (config: PostgresStorageConfig) => Promise<unknown>;
type ClosePostgresStorage = () => Promise<void>;
type PostgresQuery = <Row extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params?: unknown[]
) => Promise<pg.QueryResult<Row>>;
const initPostgresStorage = postgresStorageModule.initPostgresStorage as InitPostgresStorage;
const closePostgresStorage = postgresStorageModule.closePostgresStorage as ClosePostgresStorage;
const postgresQuery = postgresStorageModule.postgresQuery as PostgresQuery;

function isClearlyTestPostgresUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return REGEXP_1.test(parsed.pathname.replace(REGEXP_3, ""));
  } catch {
    return false;
  }
}

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdpp-status-draft-"));
  return path.join(dir, "pdpp.sqlite");
}

function statusCheckSql(raw: Database.Database): string {
  const row = raw
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'connector_instances'`)
    .get() as { sql: string } | undefined;
  assert.ok(row, "expected a connector_instances row in sqlite_master");
  return row.sql;
}

function insertInstance(
  raw: Database.Database,
  { id, status, bindingKey }: { id: string; status: string; bindingKey: string }
): void {
  raw
    .prepare(
      `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name,
       status, source_kind, source_binding_key, source_binding_json,
       created_at, updated_at, revoked_at)
     VALUES (?, 'owner_1', 'gmail', 'Gmail', ?, 'account', ?, '{}', '2026-06-02', '2026-06-02', NULL)`
    )
    .run(id, status, bindingKey);
}

test("fresh DB admits a draft connector instance", () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  closeDb();
  const raw = new Database(dbPath);
  try {
    assert.ok(statusCheckSql(raw).includes("'draft'"), "fresh CHECK names draft");
    // FK requires a connectors row.
    raw
      .prepare(`INSERT INTO connectors(connector_id, manifest, created_at) VALUES ('gmail', '{}', '2026-06-02')`)
      .run();
    insertInstance(raw, { bindingKey: "b1", id: "cin_draft_1", status: "draft" });
    const draftRow = raw
      .prepare(`SELECT status FROM connector_instances WHERE connector_instance_id = 'cin_draft_1'`)
      .get() as { status: string } | undefined;
    assert.ok(draftRow, "expected cin_draft_1 row");
    assert.equal(draftRow.status, "draft");
    // An unknown status is still rejected.
    assert.throws(() => insertInstance(raw, { bindingKey: "b2", id: "cin_bad", status: "bogus" }), REGEXP_4);
  } finally {
    raw.close();
  }
});

test("legacy narrow-CHECK DB is rebuilt and then admits a draft", () => {
  const dbPath = tempDbPath();
  const raw = new Database(dbPath);
  // Hand-build the legacy connectors + connector_instances tables with the
  // pre-draft narrow status CHECK and one active row.
  raw.exec(`
    CREATE TABLE connectors (
      connector_id TEXT PRIMARY KEY, manifest TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE connector_instances (
      connector_instance_id TEXT PRIMARY KEY,
      owner_subject_id      TEXT NOT NULL,
      connector_id          TEXT NOT NULL,
      display_name          TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
      source_kind           TEXT NOT NULL CHECK (source_kind IN ('account', 'local_device', 'browser_collector', 'manual')),
      source_binding_key    TEXT NOT NULL,
      source_binding_json   TEXT NOT NULL DEFAULT '{}',
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL,
      revoked_at            TEXT,
      UNIQUE(owner_subject_id, connector_id, source_kind, source_binding_key),
      FOREIGN KEY(connector_id) REFERENCES connectors(connector_id) ON DELETE RESTRICT
    );
    INSERT INTO connectors VALUES ('gmail', '{}', '2026-06-02');
  `);
  insertInstance(raw, { bindingKey: "legacy", id: "cin_active_legacy", status: "active" });
  assert.ok(!statusCheckSql(raw).includes("'draft'"), "legacy CHECK is narrow");
  // The narrow CHECK rejects draft before the migration.
  assert.throws(() => insertInstance(raw, { bindingKey: "pre", id: "cin_draft_pre", status: "draft" }), REGEXP_2);
  raw.close();

  // initDb runs the migration.
  initDb(dbPath);
  closeDb();

  const v = new Database(dbPath);
  try {
    assert.ok(statusCheckSql(v).includes("'draft'"), "CHECK widened to draft");
    // Existing row preserved.
    const legacyRow = v
      .prepare(`SELECT status FROM connector_instances WHERE connector_instance_id = 'cin_active_legacy'`)
      .get() as { status: string } | undefined;
    assert.ok(legacyRow, "expected cin_active_legacy row");
    assert.equal(legacyRow.status, "active");
    // Draft now admissible.
    insertInstance(v, { bindingKey: "post", id: "cin_draft_post", status: "draft" });
    const draftPostRow = v
      .prepare(`SELECT status FROM connector_instances WHERE connector_instance_id = 'cin_draft_post'`)
      .get() as { status: string } | undefined;
    assert.ok(draftPostRow, "expected cin_draft_post row");
    assert.equal(draftPostRow.status, "draft");
  } finally {
    v.close();
  }
});

test("status-draft migration is idempotent", () => {
  const dbPath = tempDbPath();
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE connectors (
      connector_id TEXT PRIMARY KEY, manifest TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE connector_instances (
      connector_instance_id TEXT PRIMARY KEY,
      owner_subject_id      TEXT NOT NULL,
      connector_id          TEXT NOT NULL,
      display_name          TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
      source_kind           TEXT NOT NULL CHECK (source_kind IN ('account', 'local_device', 'browser_collector', 'manual')),
      source_binding_key    TEXT NOT NULL,
      source_binding_json   TEXT NOT NULL DEFAULT '{}',
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL,
      revoked_at            TEXT,
      UNIQUE(owner_subject_id, connector_id, source_kind, source_binding_key),
      FOREIGN KEY(connector_id) REFERENCES connectors(connector_id) ON DELETE RESTRICT
    );
    INSERT INTO connectors VALUES ('gmail', '{}', '2026-06-02');
  `);
  insertInstance(raw, { bindingKey: "keep", id: "cin_keep", status: "active" });
  raw.close();

  initDb(dbPath);
  closeDb();
  // Second init must not throw or duplicate.
  initDb(dbPath);
  closeDb();

  const v = new Database(dbPath);
  try {
    const countRow = v.prepare("SELECT COUNT(*) AS n FROM connector_instances").get() as { n: number } | undefined;
    assert.ok(countRow, "expected a COUNT(*) row");
    assert.equal(countRow.n, 1);
    assert.ok(statusCheckSql(v).includes("'draft'"));
  } finally {
    v.close();
  }
});

test("Postgres bootstrap widens a legacy connector_instances status CHECK to draft", {
  skip: !(POSTGRES_URL && isClearlyTestPostgresUrl(POSTGRES_URL)),
}, async () => {
  // The `skip` option above guarantees POSTGRES_URL is set whenever this
  // body actually runs; narrow it here so the rest of the test can use it
  // as a plain string.
  assert.ok(POSTGRES_URL, "expected PDPP_TEST_POSTGRES_URL to be set when this test is not skipped");
  const setup = new Pool({ connectionString: POSTGRES_URL });
  try {
    await setup.query(`
      DROP TABLE IF EXISTS connector_instances CASCADE;
      DROP TABLE IF EXISTS connectors CASCADE;
      CREATE TABLE connectors (
        connector_id TEXT PRIMARY KEY,
        manifest JSONB NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE connector_instances (
        connector_instance_id TEXT PRIMARY KEY,
        owner_subject_id TEXT NOT NULL,
        connector_id TEXT NOT NULL REFERENCES connectors(connector_id) ON DELETE RESTRICT,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('account', 'local_device', 'browser_collector', 'manual')),
        source_binding_key TEXT NOT NULL,
        source_binding_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE(owner_subject_id, connector_id, source_kind, source_binding_key)
      );
      INSERT INTO connectors(connector_id, manifest, created_at) VALUES ('gmail', '{}'::jsonb, '2026-06-02');
      INSERT INTO connector_instances(
        connector_instance_id, owner_subject_id, connector_id, display_name,
        status, source_kind, source_binding_key, source_binding_json,
        created_at, updated_at, revoked_at
      )
      VALUES ('cin_active_legacy', 'owner_1', 'gmail', 'Gmail', 'active', 'account', 'legacy', '{}'::jsonb, '2026-06-02', '2026-06-02', NULL);
    `);
  } finally {
    await setup.end();
  }

  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  try {
    const constraints = await postgresQuery(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'connector_instances'::regclass
          AND contype = 'c'
        ORDER BY conname`
    );
    assert.ok(
      constraints.rows.some((row) => String(row.def).includes("draft")),
      "Postgres status CHECK names draft after bootstrap"
    );
    // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
    const legacyRow = (
      await postgresQuery(`SELECT status FROM connector_instances WHERE connector_instance_id = 'cin_active_legacy'`)
    ).rows[0];
    assert.ok(legacyRow, "expected cin_active_legacy row in Postgres");
    assert.equal(legacyRow.status, "active", "legacy row preserved");
    await postgresQuery(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name,
         status, source_kind, source_binding_key, source_binding_json,
         created_at, updated_at, revoked_at
       )
       VALUES ('cin_draft_postgres', 'owner_1', 'gmail', 'Gmail Draft', 'draft', 'account', 'draft', '{}'::jsonb, '2026-06-02', '2026-06-02', NULL)`
    );
    // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
    const draftPostgresRow = (
      await postgresQuery(`SELECT status FROM connector_instances WHERE connector_instance_id = 'cin_draft_postgres'`)
    ).rows[0];
    assert.ok(draftPostgresRow, "expected cin_draft_postgres row in Postgres");
    assert.equal(draftPostgresRow.status, "draft");
  } finally {
    await closePostgresStorage();
  }
});
