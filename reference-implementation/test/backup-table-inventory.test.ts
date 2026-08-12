// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DERIVED_TABLES, SKIP_TABLES, TABLES } from "../scripts/migrate-storage/schema.ts";
import {
  BACKUP_TABLE_INVENTORY,
  isInternalBackupCatalogTable,
  POSTGRES_LAZY_STORAGE_TABLES,
  POSTGRES_SQLITE_ONLY_STORAGE_TABLES,
  POSTGRES_STORAGE_TABLES,
  SQLITE_LAZY_STORAGE_TABLES,
} from "../server/backup-table-policy.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  withPostgresReadOnlyTransaction,
} from "../server/postgres-storage.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const SERVER_SOURCE_FILE_RE = /\.(?:js|sql|ts)$/;
const CREATE_TABLE_NAME_RE = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z][a-z0-9_]*)\s*[(]/gi;
const BACKUP_POLICY_PATH_RE = /server\/backup-table-policy\.ts/;
const LOGICAL_MIGRATION_SUBSET_RE = /logical migration subset/i;
const POSTGRES_VERSION_RE = /PostgreSQL\)\s+(\d+)\./;

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function walkFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return walkFiles(path);
    }
    return SERVER_SOURCE_FILE_RE.test(entry.name) ? [path] : [];
  });
}

function bootstrappedSqliteTables(): string[] {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-backup-inventory-"));
  try {
    initDb(join(dir, "pdpp.sqlite"));
    const rows = getDb()
      .prepare(
        `SELECT name
           FROM sqlite_schema
          WHERE type IN ('table', 'virtual table')
            AND name NOT LIKE 'sqlite_%'
          ORDER BY name`
      )
      .all<{ name: string }>();
    return rows.map((row) => row.name).filter((name) => !isInternalBackupCatalogTable(name));
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

function sqliteQueryRows(path: string, sql: string): string[] {
  return execFileSync("sqlite3", ["-batch", "-noheader", path, sql], { encoding: "utf8" })
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean);
}

function sqliteCatalogTables(path: string): string[] {
  return sqliteQueryRows(
    path,
    `SELECT name
       FROM sqlite_schema
      WHERE type IN ('table', 'virtual table')
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name`
  ).filter((name) => !isInternalBackupCatalogTable(name));
}

function missingRequiredTables(restoredTables: Set<string>, lazyTables: ReadonlySet<string>): string[] {
  return Object.entries(BACKUP_TABLE_INVENTORY)
    .filter(([, entry]) => entry.classification === "backup_required")
    .map(([table]) => table)
    .filter((table) => !(restoredTables.has(table) || lazyTables.has(table)));
}

function postgresTool(tool: "pg_dump" | "psql", args: string[]): void {
  const image = process.env.PDPP_TEST_POSTGRES_CLIENT_IMAGE;
  if (image) {
    execFileSync("docker", ["run", "--rm", "--network", "host", image, tool, ...args], { stdio: "inherit" });
    return;
  }
  execFileSync(tool, args, { stdio: "inherit" });
}

function postgresToolOutput(tool: "pg_dump" | "psql", args: string[]): string {
  const image = process.env.PDPP_TEST_POSTGRES_CLIENT_IMAGE;
  if (image) {
    return execFileSync("docker", ["run", "--rm", "--network", "host", image, tool, ...args], { encoding: "utf8" });
  }
  return execFileSync(tool, args, { encoding: "utf8" });
}

function postgresToolWithInput(tool: "psql", args: string[], input: string): void {
  const image = process.env.PDPP_TEST_POSTGRES_CLIENT_IMAGE;
  if (image) {
    execFileSync("docker", ["run", "--rm", "--interactive", "--network", "host", image, tool, ...args], {
      input,
      stdio: ["pipe", "inherit", "inherit"],
    });
    return;
  }
  execFileSync(tool, args, { input, stdio: ["pipe", "inherit", "inherit"] });
}

function postgresClientMajor(tool: "pg_dump" | "psql"): number {
  const output = postgresToolOutput(tool, ["--version"]);
  const match = POSTGRES_VERSION_RE.exec(output);
  assert(match, `could not parse ${tool} version from ${output}`);
  return Number(match[1]);
}

function postgresServerMajor(url: string): number {
  const version = postgresToolOutput("psql", [url, "-At", "-c", "SHOW server_version_num;"]).trim();
  return Math.floor(Number(version) / 10_000);
}

function assertPostgresDumpClientCompatible(url: string): void {
  const serverMajor = postgresServerMajor(url);
  const dumpMajor = postgresClientMajor("pg_dump");
  const psqlMajor = postgresClientMajor("psql");

  assert.equal(
    dumpMajor,
    serverMajor,
    `pg_dump major ${dumpMajor} must match PostgreSQL server major ${serverMajor}; set PDPP_TEST_POSTGRES_CLIENT_IMAGE=postgres:${serverMajor}-alpine or equivalent`
  );
  assert.equal(
    psqlMajor,
    serverMajor,
    `psql major ${psqlMajor} must match PostgreSQL server major ${serverMajor}; set PDPP_TEST_POSTGRES_CLIENT_IMAGE=postgres:${serverMajor}-alpine or equivalent`
  );
}
test("backup inventory classifies every bootstrapped SQLite catalog table", () => {
  const liveTables = new Set(bootstrappedSqliteTables());
  const classifiedTables = new Set(Object.keys(BACKUP_TABLE_INVENTORY));

  assert.deepEqual(
    sorted([...liveTables].filter((table) => !classifiedTables.has(table))),
    [],
    "every live table must be classified as backup_required, derived_rebuildable, or ephemeral_crash_reconciled"
  );
});

test("backup inventory has deterministic SQLite/Postgres table parity", () => {
  const sqliteTables = new Set([...bootstrappedSqliteTables(), ...SQLITE_LAZY_STORAGE_TABLES]);
  const postgresTables = new Set(POSTGRES_STORAGE_TABLES);

  assert.deepEqual(
    sorted([...sqliteTables].filter((table) => !postgresTables.has(table))),
    ["semantic_search_rowid"],
    "SQLite-only semantic rowid state must be the only static storage parity exception"
  );
  assert.deepEqual(
    sorted([...postgresTables].filter((table) => !sqliteTables.has(table))),
    [],
    "Postgres storage table seam must not contain tables absent from bootstrapped SQLite"
  );
});

test("backup inventory accounts for store-created table DDL outside bootstrap", () => {
  const classifiedTables = new Set(Object.keys(BACKUP_TABLE_INVENTORY));
  const createdTables = new Set<string>();
  for (const path of walkFiles(join(repoRoot, "reference-implementation/server"))) {
    const source = readFileSync(path, "utf8");
    for (const [, tableName] of source.matchAll(CREATE_TABLE_NAME_RE)) {
      if (tableName && !tableName.endsWith("_new") && tableName !== "scheduler_run_history") {
        createdTables.add(tableName);
      }
    }
  }

  assert.deepEqual(
    sorted([...createdTables].filter((table) => !(isInternalBackupCatalogTable(table) || classifiedTables.has(table)))),
    [],
    "store-created application tables must also be classified"
  );
});

test("non-required backup classifications require executable proof", () => {
  const unprovedNonRequiredTables = Object.entries(BACKUP_TABLE_INVENTORY)
    .filter(([, entry]) => entry.classification !== "backup_required")
    .map(([table]) => table);

  assert.deepEqual(
    sorted(unprovedNonRequiredTables),
    [],
    "tables without a named executable rebuild/reconcile oracle must remain backup_required"
  );
});

test("SQLite stopped backup preserves every required durable table", () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-sqlite-backup-oracle-"));
  const sourcePath = join(dir, "source.sqlite");
  const backupPath = join(dir, "backup.sqlite");
  try {
    initDb(sourcePath);
    const source = getDb();
    source.prepare("INSERT INTO connectors(connector_id, manifest) VALUES (?, ?)").run("connector_backup", "{}");
    source
      .prepare(
        `INSERT INTO connector_instances(
          connector_instance_id, owner_subject_id, connector_id, display_name,
          source_kind, source_binding_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "cin_backup",
        "owner_backup",
        "connector_backup",
        "Backup",
        "account",
        "account_backup",
        "2026-08-12T00:00:00.000Z",
        "2026-08-12T00:00:00.000Z"
      );
    source
      .prepare(
        `INSERT INTO source_webhook_run_receipts(
          source_id, event_id, body_hash, connector_id, connector_instance_id,
          owner_subject_id, action, run_id, trace_id, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "source_backup",
        "evt_backup",
        "sha256:body",
        "connector_backup",
        "cin_backup",
        "owner_backup",
        "schedule_run",
        "run_backup",
        "trace_backup",
        "2026-08-12T00:00:00.000Z"
      );
    source
      .prepare(
        `INSERT INTO record_rejection_quota(owner_subject_id, pending_payload_bytes, pending_receipt_count)
         VALUES (?, ?, ?)`
      )
      .run("owner_backup", 7, 1);
    source
      .prepare(
        `INSERT INTO record_rejections(
          receipt_id, owner_subject_id, connector_instance_id, stream,
          connector_id, run_id, first_input_index, latest_input_index, reason_code,
          payload, payload_sha256, payload_bytes, replay_key, rejection_generation,
          created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "rr_backup",
        "owner_backup",
        "cin_backup",
        "messages",
        "connector_backup",
        "run_backup",
        0,
        0,
        "validation_error",
        Buffer.from("payload"),
        "sha256:fixture",
        7,
        "record-rejection-v2:fixture",
        "record-rejection-v2",
        "2026-08-12T00:00:00.000Z",
        "2026-08-12T00:00:00.000Z"
      );
    source.prepare("VACUUM INTO ?").run(backupPath);
    closeDb();

    const restoredTables = new Set(sqliteCatalogTables(backupPath));
    const missingTables = missingRequiredTables(restoredTables, new Set(SQLITE_LAZY_STORAGE_TABLES));

    assert.deepEqual(sorted(missingTables), [], "SQLite backup artifact must contain every non-lazy required table");
    assert.equal(sqliteQueryRows(backupPath, "SELECT COUNT(*) FROM source_webhook_run_receipts")[0], "1");
    assert.equal(sqliteQueryRows(backupPath, "SELECT COUNT(*) FROM record_rejections")[0], "1");
    assert.equal(sqliteQueryRows(backupPath, "SELECT pending_payload_bytes FROM record_rejection_quota")[0], "7");
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});
test("migration schema exports load and preserve the logical migration subset", () => {
  const tableNames = TABLES.map((table) => table.name);

  assert(tableNames.includes("records"), "migration schema should parse canonical tables");
  assert(DERIVED_TABLES.has("lexical_search_index"), "derived migration set should load");
  assert.equal(SKIP_TABLES, DERIVED_TABLES, "skip table export must alias the derived migration set");
  assert.deepEqual(
    TABLES.filter((table) => table.skipMigration).map((table) => table.name),
    tableNames.filter((table) => DERIVED_TABLES.has(table)),
    "derived migration tables must be the only skipped logical migration tables"
  );
});

test("backup inventory matches a bootstrapped Postgres catalog when configured", async (t) => {
  const url = process.env.PDPP_TEST_POSTGRES_URL;
  if (!url) {
    t.skip("PDPP_TEST_POSTGRES_URL is not set");
    return;
  }
  await initPostgresStorage({ backend: "postgres", databaseUrl: url });
  try {
    const actualTables = await withPostgresReadOnlyTransaction(async (client) => {
      const result = await client.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = current_schema()
            AND table_type = 'BASE TABLE'
          ORDER BY table_name`
      );
      return result.rows.map((row) => row.table_name);
    });
    const actualAndLazyTables = new Set([...actualTables, ...POSTGRES_LAZY_STORAGE_TABLES]);
    assert.deepEqual(sorted(actualAndLazyTables), sorted(POSTGRES_STORAGE_TABLES));
  } finally {
    await closePostgresStorage();
  }
});

test("Postgres dump/restore preserves every required durable table when configured", async (t) => {
  const sourceUrl = process.env.PDPP_TEST_POSTGRES_URL;
  const restoreUrl = process.env.PDPP_TEST_POSTGRES_RESTORE_URL;
  if (!(sourceUrl && restoreUrl)) {
    t.skip("PDPP_TEST_POSTGRES_URL and PDPP_TEST_POSTGRES_RESTORE_URL are not both set");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "pdpp-postgres-backup-oracle-"));
  const dumpPath = join(dir, "backup.sql");
  try {
    assertPostgresDumpClientCompatible(sourceUrl);
    assertPostgresDumpClientCompatible(restoreUrl);

    postgresTool("psql", [
      sourceUrl,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;",
    ]);
    await initPostgresStorage({ backend: "postgres", databaseUrl: sourceUrl });
    await closePostgresStorage();

    const dumpSql = postgresToolOutput("pg_dump", ["--no-owner", "--no-privileges", sourceUrl]);
    writeFileSync(dumpPath, dumpSql);
    postgresTool("psql", [
      restoreUrl,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;",
    ]);
    postgresToolWithInput("psql", [restoreUrl, "-v", "ON_ERROR_STOP=1"], dumpSql);

    await initPostgresStorage({ backend: "postgres", databaseUrl: restoreUrl });
    try {
      const restoredTables = await withPostgresReadOnlyTransaction(async (client) => {
        const result = await client.query<{ table_name: string }>(
          `SELECT table_name
             FROM information_schema.tables
            WHERE table_schema = current_schema()
              AND table_type = 'BASE TABLE'
            ORDER BY table_name`
        );
        return new Set(result.rows.map((row) => row.table_name));
      });
      const missingTables = missingRequiredTables(
        restoredTables,
        new Set([...POSTGRES_LAZY_STORAGE_TABLES, ...POSTGRES_SQLITE_ONLY_STORAGE_TABLES])
      );

      assert.deepEqual(sorted(missingTables), [], "Postgres dump/restore must contain every non-lazy required table");
    } finally {
      await closePostgresStorage();
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
test("storage migration inventory does not imply complete backup coverage", () => {
  const migratedTables = new Set(TABLES.filter((table) => !table.skipMigration).map((table) => table.name));
  const backupRequiredTables = Object.entries(BACKUP_TABLE_INVENTORY)
    .filter(([, entry]) => entry.classification === "backup_required")
    .map(([table]) => table);
  const backupRequiredNotMigrated = backupRequiredTables.filter((table) => !migratedTables.has(table));

  assert(backupRequiredNotMigrated.length > 0, "guard fixture must prove migration is a subset, not a full backup");
});

test("migration docs identify the backup policy API without claiming complete backup coverage", () => {
  const migrateDoc = readFileSync(join(repoRoot, "reference-implementation/docs/migrate-storage.md"), "utf8");
  assert.match(migrateDoc, BACKUP_POLICY_PATH_RE);
  assert.match(migrateDoc, LOGICAL_MIGRATION_SUBSET_RE);
});
