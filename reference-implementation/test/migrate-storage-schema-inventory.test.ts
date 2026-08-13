// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DERIVED_TABLES, TABLES } from "../scripts/migrate-storage/schema.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const POSTGRES_STORAGE = join(__dirname, "..", "server", "postgres-storage.ts");
const CREATE_TABLE_RE = /CREATE TABLE IF NOT EXISTS\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
const COMMENT_WORD_FALSE_POSITIVES = new Set(["in", "is", "or"]);
const compareText = (left: string, right: string) => left.localeCompare(right);

function currentPostgresBootstrapTables(): string[] {
  const ddl = readFileSync(POSTGRES_STORAGE, "utf8");
  const tables = [...ddl.matchAll(CREATE_TABLE_RE)].flatMap(([, name]) =>
    name && !COMMENT_WORD_FALSE_POSITIVES.has(name) ? [name] : []
  );
  return [...new Set(tables)];
}

test("migrate-storage schema inventory covers every current Postgres bootstrap table", () => {
  const inventoried = new Set(TABLES.map((table) => table.name));
  const missing = currentPostgresBootstrapTables().filter((table) => !inventoried.has(table));

  assert.deepEqual(missing, []);
});

test("migrate-storage keeps only rebuildable search artifacts out of data migration", () => {
  const skipped = TABLES.filter((table) => table.skipMigration).map((table) => table.name);
  assert.deepEqual(skipped.sort(compareText), [...DERIVED_TABLES].sort(compareText));

  const durableTables = TABLES.filter((table) => !table.skipMigration).map((table) => table.name);
  for (const table of [
    "record_rejection_quota",
    "record_rejections",
    "retained_size_global",
    "retained_size_connection",
    "retained_size_stream",
    "retained_size_record_family",
    "retained_size_top_rows",
    "connector_summary_evidence",
    "connector_maintenance_cursor",
    "manifest_write_violations",
    "search_index_dirty",
  ]) {
    assert.ok(durableTables.includes(table), `${table} must stay in the conservative backup/restore set`);
  }
});
