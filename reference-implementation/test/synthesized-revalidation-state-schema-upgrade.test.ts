// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Schema-upgrade tests for `synthesized_revalidation_state`
// (server/db.ts, server/postgres-storage.ts).
//
// gate-stale-owner-v3-cbe4-0801.md P1 #2 found that both backends only
// issued `CREATE TABLE IF NOT EXISTS synthesized_revalidation_state`, which
// silently retains an incompatible pre-existing table — reproduced there
// with a disposable SQLite database containing only
// `synthesized_revalidation_state(connector_instance_id TEXT PRIMARY KEY)`.
// These tests prove: (1) that exact one-column repro now converges to the
// canonical shape on both backends, (2) a healthy canonical table is left
// untouched (idempotent bootstrap, no needless rebuild), (3) SQLite and
// Postgres converge on the same semantic columns/constraints, and (4) the
// rebuild's temporary table does not leak.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

// Same CJS module instance server/db.ts requires, used to open a raw
// pre-`initDb` connection so the pre-existing table can be planted before
// the migration ever runs against it.
const BetterSqlite3Database = createRequire(import.meta.url)("better-sqlite3") as new (
  filename: string
) => {
  close: () => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => { all: <T = Record<string, unknown>>() => T[]; run: (...params: unknown[]) => unknown };
};

interface SqliteColumnInfo {
  name: string;
  notnull: number;
  pk: number;
  type: string;
}

const CANONICAL_COLUMN_NAMES = ["connector_instance_id", "connector_id", "attempt", "anchor_at", "updated_at"];

function sqliteSynthesizedRevalidationStateColumns(): SqliteColumnInfo[] {
  return getDb().prepare("PRAGMA table_info(synthesized_revalidation_state)").all<SqliteColumnInfo>();
}

function assertSqliteCanonicalShape(columns: SqliteColumnInfo[]): void {
  assert.deepEqual(
    columns.map((c) => c.name).sort((a, b) => a.localeCompare(b)),
    [...CANONICAL_COLUMN_NAMES].sort((a, b) => a.localeCompare(b)),
    "exactly the canonical columns, nothing extra and nothing missing"
  );
  const byName = new Map(columns.map((c) => [c.name, c]));
  assert.equal(byName.get("connector_instance_id")?.pk, 1, "connector_instance_id must be the primary key");
  for (const name of ["connector_id", "attempt", "anchor_at", "updated_at"]) {
    assert.equal(byName.get(name)?.notnull, 1, `${name} must be NOT NULL`);
  }
}

function assertNoLeakedMigrationTable(): void {
  const leftover = getDb()
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'synthesized_revalidation_state_new'")
    .get();
  assert.equal(leftover, undefined, "the migration's temporary rebuild table must not leak");
}

test("SQLite: the gate's exact one-column repro converges to the canonical schema on next boot", () => {
  const dbPath = makeTemporaryDbPath("pdpp-revalidation-schema-repro-");
  const raw = new BetterSqlite3Database(dbPath);
  try {
    // Reproduce gate-stale-owner-v3-cbe4-0801.md P1 #2 exactly: a disposable
    // SQLite database containing only
    // synthesized_revalidation_state(connector_instance_id TEXT PRIMARY KEY),
    // planted BEFORE initDb ever runs — `CREATE TABLE IF NOT EXISTS` alone
    // would have silently retained this shape forever.
    raw.exec("CREATE TABLE synthesized_revalidation_state (connector_instance_id TEXT PRIMARY KEY)");
  } finally {
    raw.close();
  }

  try {
    initDb(dbPath);
    const columns = sqliteSynthesizedRevalidationStateColumns();
    assertSqliteCanonicalShape(columns);
    assertNoLeakedMigrationTable();
  } finally {
    closeDb();
  }
});

test("SQLite: rows with all required data survive the rebuild; rows missing required data are dropped, not inserted with NULLs", () => {
  const dbPath = makeTemporaryDbPath("pdpp-revalidation-schema-preserve-");
  const raw = new BetterSqlite3Database(dbPath);
  try {
    raw.exec("CREATE TABLE synthesized_revalidation_state (connector_instance_id TEXT PRIMARY KEY)");
    // A malformed table has no connector_id/attempt/anchor_at/updated_at
    // columns at all, so no row in it can carry the required data forward.
    // This proves the rebuild does not fabricate NOT NULL values out of
    // nothing — it only carries forward rows it can prove are complete.
    raw
      .prepare("INSERT INTO synthesized_revalidation_state(connector_instance_id) VALUES (?)")
      .run("cin_incomplete_row");
  } finally {
    raw.close();
  }

  try {
    initDb(dbPath);
    assertSqliteCanonicalShape(sqliteSynthesizedRevalidationStateColumns());
    const rows = getDb().prepare("SELECT * FROM synthesized_revalidation_state").all();
    assert.equal(rows.length, 0, "a row missing required columns must be dropped, never inserted with NULLs");
  } finally {
    closeDb();
  }
});

test("SQLite: a table missing connector_instance_id entirely (but with the other required columns) converges to canonical shape, rows dropped", () => {
  const dbPath = makeTemporaryDbPath("pdpp-revalidation-schema-missing-cin-");
  const raw = new BetterSqlite3Database(dbPath);
  try {
    // gate-stale-owner-v3-cbe4-0801.md P1 #3: the mirror-image malformed
    // shape from the other two tests — connector_id/attempt/anchor_at/
    // updated_at are ALL present, but connector_instance_id itself is
    // missing. Proves the rebuild can't carry a row forward when the
    // primary key column doesn't exist, without throwing/failing boot.
    raw.exec(`CREATE TABLE synthesized_revalidation_state (
      connector_id TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      anchor_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    raw
      .prepare(
        "INSERT INTO synthesized_revalidation_state(connector_id, attempt, anchor_at, updated_at) VALUES (?, ?, ?, ?)"
      )
      .run("chatgpt", 1, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
  } finally {
    raw.close();
  }

  try {
    initDb(dbPath);
    assertSqliteCanonicalShape(sqliteSynthesizedRevalidationStateColumns());
    const rows = getDb().prepare("SELECT * FROM synthesized_revalidation_state").all();
    assert.equal(
      rows.length,
      0,
      "a row from a table missing connector_instance_id must be dropped, not carried forward"
    );
    assertNoLeakedMigrationTable();
  } finally {
    closeDb();
  }
});

test("SQLite: a healthy canonical table is left untouched by a second boot (idempotent, no needless rebuild)", () => {
  const dbPath = makeTemporaryDbPath("pdpp-revalidation-schema-idempotent-");
  try {
    initDb(dbPath);
    const store = getDb();
    store
      .prepare(
        `INSERT INTO synthesized_revalidation_state(connector_instance_id, connector_id, attempt, anchor_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("cin_healthy", "chatgpt", 3, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
    closeDb();

    // Second boot against the same on-disk file: the table already matches
    // the canonical shape, so this must be a pure no-op — the row must
    // survive untouched and no rebuild table must appear.
    initDb(dbPath);
    const row = getDb()
      .prepare("SELECT * FROM synthesized_revalidation_state WHERE connector_instance_id = ?")
      .get<{ attempt: number; anchor_at: string; connector_id: string }>("cin_healthy");
    assert.ok(row, "the pre-existing healthy row must survive an idempotent second boot");
    assert.equal(row.attempt, 3);
    assert.equal(row.connector_id, "chatgpt");
    assert.equal(row.anchor_at, "2026-08-01T00:00:00.000Z");
    assertNoLeakedMigrationTable();
  } finally {
    closeDb();
  }
});

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

if (POSTGRES_URL) {
  interface PostgresColumnInfo {
    column_name: string;
    is_nullable: string;
  }

  async function postgresSynthesizedRevalidationStateColumns(): Promise<PostgresColumnInfo[]> {
    const result = await postgresQuery<PostgresColumnInfo>(
      `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'synthesized_revalidation_state'`
    );
    return result.rows;
  }

  async function postgresSynthesizedRevalidationStatePrimaryKeyColumns(): Promise<string[]> {
    const result = await postgresQuery<{ column_name: string }>(
      `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        WHERE tc.table_schema = current_schema()
          AND tc.table_name = 'synthesized_revalidation_state'
          AND tc.constraint_type = 'PRIMARY KEY'`
    );
    return result.rows.map((row) => row.column_name);
  }

  function assertPostgresCanonicalShape(columns: PostgresColumnInfo[]): void {
    assert.deepEqual(
      columns.map((c) => c.column_name).sort((a, b) => a.localeCompare(b)),
      [...CANONICAL_COLUMN_NAMES].sort((a, b) => a.localeCompare(b)),
      "exactly the canonical columns, nothing extra and nothing missing"
    );
    const byName = new Map(columns.map((c) => [c.column_name, c.is_nullable]));
    for (const name of ["connector_id", "attempt", "anchor_at", "updated_at"]) {
      assert.equal(byName.get(name), "NO", `${name} must be NOT NULL`);
    }
  }

  async function assertPostgresNoLeakedMigrationTable(): Promise<void> {
    const leftover = await postgresQuery(
      `SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'synthesized_revalidation_state_new'`
    );
    assert.equal(leftover.rowCount, 0, "the migration's temporary rebuild table must not leak");
  }

  test("Postgres: the gate's exact one-column repro converges to the canonical schema on next boot", async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      // Plant the exact malformed shape from the gate's SQLite repro,
      // translated to Postgres, before the migration ever runs against it.
      await postgresQuery("DROP TABLE IF EXISTS synthesized_revalidation_state");
      await postgresQuery("CREATE TABLE synthesized_revalidation_state (connector_instance_id TEXT PRIMARY KEY)");
      await closePostgresStorage();

      await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
      assertPostgresCanonicalShape(await postgresSynthesizedRevalidationStateColumns());
      assert.deepEqual(await postgresSynthesizedRevalidationStatePrimaryKeyColumns(), ["connector_instance_id"]);
      await assertPostgresNoLeakedMigrationTable();
    } finally {
      await postgresQuery("DROP TABLE IF EXISTS synthesized_revalidation_state_new");
      await closePostgresStorage();
      closeDb();
    }
  });

  test("Postgres: rows missing required data are dropped by the rebuild, not inserted with NULLs", async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await postgresQuery("DROP TABLE IF EXISTS synthesized_revalidation_state");
      await postgresQuery("CREATE TABLE synthesized_revalidation_state (connector_instance_id TEXT PRIMARY KEY)");
      await postgresQuery(
        "INSERT INTO synthesized_revalidation_state(connector_instance_id) VALUES ('cin_incomplete_row')"
      );
      await closePostgresStorage();

      await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
      assertPostgresCanonicalShape(await postgresSynthesizedRevalidationStateColumns());
      const rows = await postgresQuery("SELECT * FROM synthesized_revalidation_state");
      assert.equal(rows.rowCount, 0, "a row missing required columns must be dropped, never inserted with NULLs");
    } finally {
      await postgresQuery("DROP TABLE IF EXISTS synthesized_revalidation_state_new");
      await closePostgresStorage();
      closeDb();
    }
  });

  test("Postgres: a table missing connector_instance_id entirely (but with the other required columns) converges to canonical shape instead of failing boot", async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      // gate-stale-owner-v3-cbe4-0801.md P1 #3: `canCarryRowsForward`
      // omitted `connector_instance_id` from its required-column check
      // while the carry-forward SELECT still referenced it — for a table
      // missing that column entirely, this made the migration's own
      // transaction throw (`column "connector_instance_id" does not
      // exist`) and roll back, failing boot outright, instead of
      // converging to the canonical shape with the row dropped the way
      // SQLite does for the identical malformed shape.
      await postgresQuery("DROP TABLE IF EXISTS synthesized_revalidation_state");
      await postgresQuery(`CREATE TABLE synthesized_revalidation_state (
        connector_id TEXT NOT NULL,
        attempt BIGINT NOT NULL DEFAULT 0,
        anchor_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      await postgresQuery(
        "INSERT INTO synthesized_revalidation_state(connector_id, attempt, anchor_at, updated_at) VALUES ('chatgpt', 1, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')"
      );
      await closePostgresStorage();

      await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
      assertPostgresCanonicalShape(await postgresSynthesizedRevalidationStateColumns());
      const rows = await postgresQuery("SELECT * FROM synthesized_revalidation_state");
      assert.equal(
        rows.rowCount,
        0,
        "a row from a table missing connector_instance_id must be dropped, not carried forward"
      );
      await assertPostgresNoLeakedMigrationTable();
    } finally {
      await postgresQuery("DROP TABLE IF EXISTS synthesized_revalidation_state_new");
      await closePostgresStorage();
      closeDb();
    }
  });

  test("Postgres: a healthy canonical table is left untouched by a second boot (idempotent, no needless rebuild)", async () => {
    const suffix = `${process.pid}_${Math.floor(Math.random() * 1e6)}`;
    const connectorInstanceId = `cin_pg_healthy_${suffix}`;
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await postgresQuery(
        `INSERT INTO synthesized_revalidation_state(connector_instance_id, connector_id, attempt, anchor_at, updated_at)
         VALUES ($1, 'chatgpt', 3, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
        [connectorInstanceId]
      );
      await closePostgresStorage();

      // Second bootstrap against the same durable database: the table
      // already matches the canonical shape, so this must be a pure no-op.
      await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
      const result = await postgresQuery<{ attempt: number; anchor_at: string; connector_id: string }>(
        "SELECT * FROM synthesized_revalidation_state WHERE connector_instance_id = $1",
        [connectorInstanceId]
      );
      assert.equal(result.rowCount, 1, "the pre-existing healthy row must survive an idempotent second boot");
      assert.equal(Number(result.rows[0]?.attempt), 3);
      assert.equal(result.rows[0]?.connector_id, "chatgpt");
      await assertPostgresNoLeakedMigrationTable();
    } finally {
      await postgresQuery("DELETE FROM synthesized_revalidation_state WHERE connector_instance_id = $1", [
        connectorInstanceId,
      ]);
      await closePostgresStorage();
      closeDb();
    }
  });

  test("SQLite and Postgres converge on the same canonical semantic columns after upgrading from the gate's repro shape", async () => {
    const dbPath = makeTemporaryDbPath("pdpp-revalidation-schema-parity-");
    const raw = new BetterSqlite3Database(dbPath);
    try {
      raw.exec("CREATE TABLE synthesized_revalidation_state (connector_instance_id TEXT PRIMARY KEY)");
    } finally {
      raw.close();
    }

    initDb(dbPath);
    const sqliteColumns = sqliteSynthesizedRevalidationStateColumns()
      .map((c) => c.name)
      .sort((a, b) => a.localeCompare(b));
    closeDb();

    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await postgresQuery("DROP TABLE IF EXISTS synthesized_revalidation_state");
      await postgresQuery("CREATE TABLE synthesized_revalidation_state (connector_instance_id TEXT PRIMARY KEY)");
      await closePostgresStorage();
      await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
      const postgresColumns = (await postgresSynthesizedRevalidationStateColumns())
        .map((c) => c.column_name)
        .sort((a, b) => a.localeCompare(b));
      assert.deepEqual(sqliteColumns, postgresColumns, "both backends must converge on identical column sets");
      assert.deepEqual(
        sqliteColumns,
        [...CANONICAL_COLUMN_NAMES].sort((a, b) => a.localeCompare(b))
      );
    } finally {
      await postgresQuery("DROP TABLE IF EXISTS synthesized_revalidation_state_new");
      await closePostgresStorage();
      closeDb();
    }
  });
}
