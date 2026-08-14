// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DERIVED_TABLES, SKIP_TABLES, TABLES } from "../scripts/migrate-storage/schema.ts";
import {
  BACKUP_TABLE_INVENTORY,
  isInternalBackupCatalogTable,
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
    assert.deepEqual(sorted(actualTables), sorted(POSTGRES_STORAGE_TABLES));
  } finally {
    await closePostgresStorage();
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
