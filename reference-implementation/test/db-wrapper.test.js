// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded-statement wrapper tests for `lib/db.ts`.
 *
 * These tests construct registered query handles via the registry's
 * test-only loader (`loadReferenceQueries(tmpDir)`) and exercise each
 * primitive against an ephemeral in-memory SQLite. Tests do not depend
 * on the production schema; they create their own tables.
 *
 * Spec: openspec/changes/bound-spine-and-record-read-paths/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Database from "better-sqlite3";

import { closeDb, getDb, initDb } from "../server/db.js";
import {
  decodeCursor,
  encodeCursor,
  exec,
  execReturningOne,
  getMany,
  getOne,
  InvalidCursorError,
  iterate,
  iterateDynamicSqlAcknowledged,
  MAX_PAGE_LIMIT,
  SmallEnumerationOverflowError,
  transaction,
  UnboundedReadError,
  allowUnboundedReadAcknowledged,
  writeTransaction,
} from "../lib/db.ts";
import { loadReferenceQueries } from "../server/queries/index.ts";

const PRODUCTION_QUERIES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "server",
  "queries"
);

function setupQueriesDir(builder) {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-db-wrapper-"));
  // Copy the production queries tree so the registry's required-keys
  // assertion is satisfied. The test then layers its own ad-hoc
  // artifacts on top via `builder`.
  cpSync(PRODUCTION_QUERIES_DIR, dir, {
    recursive: true,
    filter: (src) => !src.endsWith("index.ts"),
  });
  builder(dir);
  return dir;
}

function setupDb() {
  // Open an ephemeral DB and create the test table the wrapper tests use.
  initDb();
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      value INTEGER NOT NULL
    );
  `);
  return db;
}

function teardown(dir) {
  closeDb();
  rmSync(dir, { force: true, recursive: true });
}

// ---------------------------------------------------------------------------
// getOne
// ---------------------------------------------------------------------------

test("getOne returns the row when one matches", () => {
  const dir = setupQueriesDir((d) => {
    writeFileSync(
      join(d, "get-test-item-by-id.sql"),
      "-- @terminator: one\nSELECT id, name, value FROM test_items WHERE id = ?\n"
    );
  });
  try {
    const db = setupDb();
    db.prepare("INSERT INTO test_items (name, value) VALUES (?, ?)").run("alpha", 1);
    const reg = loadReferenceQueries(dir);
    const row = getOne(reg.getTestItemById, [1]);
    assert.deepEqual(row, { id: 1, name: "alpha", value: 1 });
  } finally {
    teardown(dir);
  }
});

test("getOne returns null when no row matches", () => {
  const dir = setupQueriesDir((d) => {
    writeFileSync(
      join(d, "get-test-item-by-id.sql"),
      "-- @terminator: one\nSELECT id FROM test_items WHERE id = ?\n"
    );
  });
  try {
    setupDb();
    const reg = loadReferenceQueries(dir);
    const row = getOne(reg.getTestItemById, [999]);
    assert.equal(row, null);
  } finally {
    teardown(dir);
  }
});

// ---------------------------------------------------------------------------
// getMany
// ---------------------------------------------------------------------------

test("getMany returns rows up to limit and signals truncated when more exist", () => {
  const dir = setupQueriesDir((d) => {
    writeFileSync(
      join(d, "list-test-items.sql"),
      "-- @terminator: many\n-- @cursor_field: id\nSELECT id, name, value FROM test_items ORDER BY id LIMIT ?\n"
    );
  });
  try {
    const db = setupDb();
    const insert = db.prepare("INSERT INTO test_items (name, value) VALUES (?, ?)");
    for (let i = 1; i <= 5; i++) insert.run(`row-${i}`, i);
    const reg = loadReferenceQueries(dir);
    const page = getMany(reg.listTestItems, [], { limit: 3 });
    assert.equal(page.rows.length, 3);
    assert.equal(page.truncated, true);
    assert.notEqual(page.nextCursor, null);
  } finally {
    teardown(dir);
  }
});

test("getMany returns truncated=false when fewer rows exist", () => {
  const dir = setupQueriesDir((d) => {
    writeFileSync(
      join(d, "list-test-items.sql"),
      "-- @terminator: many\n-- @cursor_field: id\nSELECT id, name, value FROM test_items ORDER BY id LIMIT ?\n"
    );
  });
  try {
    const db = setupDb();
    db.prepare("INSERT INTO test_items (name, value) VALUES (?, ?)").run("only", 1);
    const reg = loadReferenceQueries(dir);
    const page = getMany(reg.listTestItems, [], { limit: 10 });
    assert.equal(page.rows.length, 1);
    assert.equal(page.truncated, false);
    assert.equal(page.nextCursor, null);
  } finally {
    teardown(dir);
  }
});

test("getMany rejects limit=0", () => {
  const dir = setupQueriesDir((d) => {
    writeFileSync(
      join(d, "list-test-items.sql"),
      "-- @terminator: many\n-- @cursor_field: id\nSELECT id FROM test_items LIMIT ?\n"
    );
  });
  try {
    setupDb();
    const reg = loadReferenceQueries(dir);
    assert.throws(
      () => getMany(reg.listTestItems, [], { limit: 0 }),
      UnboundedReadError
    );
  } finally {
    teardown(dir);
  }
});

test("getMany rejects negative limit", () => {
  const dir = setupQueriesDir((d) => {
    writeFileSync(
      join(d, "list-test-items.sql"),
      "-- @terminator: many\n-- @cursor_field: id\nSELECT id FROM test_items LIMIT ?\n"
    );
  });
  try {
    setupDb();
    const reg = loadReferenceQueries(dir);
    assert.throws(
      () => getMany(reg.listTestItems, [], { limit: -1 }),
      UnboundedReadError
    );
  } finally {
    teardown(dir);
  }
});

test("getMany rejects limit above MAX_PAGE_LIMIT", () => {
  const dir = setupQueriesDir((d) => {
    writeFileSync(
      join(d, "list-test-items.sql"),
      "-- @terminator: many\n-- @cursor_field: id\nSELECT id FROM test_items LIMIT ?\n"
    );
  });
  try {
    setupDb();
    const reg = loadReferenceQueries(dir);
    assert.throws(
      () => getMany(reg.listTestItems, [], { limit: MAX_PAGE_LIMIT + 1 }),
      UnboundedReadError
    );
  } finally {
    teardown(dir);
  }
});

// ---------------------------------------------------------------------------
// iterate
// ---------------------------------------------------------------------------

test("iterate yields rows lazily and the caller can break early", () => {
  const dir = setupQueriesDir((d) => {
    writeFileSync(
      join(d, "iterate-test-items.sql"),
      "-- @terminator: iterate\n-- @cursor_field: id\nSELECT id, name FROM test_items ORDER BY id\n"
    );
  });
  try {
    const db = setupDb();
    const insert = db.prepare("INSERT INTO test_items (name, value) VALUES (?, ?)");
    for (let i = 1; i <= 10; i++) insert.run(`row-${i}`, i);
    const reg = loadReferenceQueries(dir);
    const seen = [];
    for (const row of iterate(reg.iterateTestItems)) {
      seen.push(row);
      if (seen.length >= 3) break;
    }
    assert.equal(seen.length, 3);
    assert.equal(seen[0].id, 1);
  } finally {
    teardown(dir);
  }
});

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

test("exec runs a mutation and returns changes plus lastInsertRowid", () => {
  const dir = setupQueriesDir((d) => {
    writeFileSync(
      join(d, "insert-test-item.sql"),
      "-- @terminator: exec\nINSERT INTO test_items (name, value) VALUES (?, ?)\n"
    );
  });
  try {
    setupDb();
    const reg = loadReferenceQueries(dir);
    const result = exec(reg.insertTestItem, ["alpha", 7]);
    assert.equal(result.changes, 1);
    assert.equal(typeof result.lastInsertRowid, "number");
    assert.ok(result.lastInsertRowid > 0);
  } finally {
    teardown(dir);
  }
});

// ---------------------------------------------------------------------------
// execReturningOne
// ---------------------------------------------------------------------------

test("execReturningOne runs a mutation and returns the RETURNING row", () => {
  const dir = setupQueriesDir((d) => {
    writeFileSync(
      join(d, "insert-test-item-returning.sql"),
      "-- @terminator: exec_one\nINSERT INTO test_items (name, value) VALUES (?, ?) RETURNING id, name, value\n"
    );
  });
  try {
    setupDb();
    const reg = loadReferenceQueries(dir);
    const handle = reg.insertTestItemReturning;
    assert.equal(handle.terminator, "exec_one");
    const row = execReturningOne(handle, ["alpha", 7]);
    assert.equal(row.name, "alpha");
    assert.equal(row.value, 7);
    assert.equal(typeof row.id, "number");
  } finally {
    teardown(dir);
  }
});

test("execReturningOne mutates the underlying table — atomic upsert+RETURNING returns the freshly written value", () => {
  // Pins the load-bearing semantic the wrapper offers over a `getOne`
  // call on the same RETURNING SQL: callers can rely on the mutation
  // having happened in the same statement that produced the row, so the
  // returned value is the post-mutation state, not a pre-mutation read.
  const dir = setupQueriesDir((d) => {
    writeFileSync(
      join(d, "upsert-test-counter.sql"),
      [
        "-- @terminator: exec_one",
        "INSERT INTO test_items (name, value) VALUES (?, 1)",
        "ON CONFLICT(name) DO UPDATE SET value = test_items.value + 1",
        "RETURNING value\n",
      ].join("\n")
    );
  });
  try {
    const db = setupDb();
    db.exec("CREATE UNIQUE INDEX idx_test_items_name ON test_items (name)");
    const reg = loadReferenceQueries(dir);
    const first = execReturningOne(reg.upsertTestCounter, ["counter"]);
    assert.equal(first.value, 1);
    const second = execReturningOne(reg.upsertTestCounter, ["counter"]);
    assert.equal(second.value, 2);
    const third = execReturningOne(reg.upsertTestCounter, ["counter"]);
    assert.equal(third.value, 3);
    const persisted = db.prepare("SELECT value FROM test_items WHERE name = ?").get("counter");
    assert.equal(persisted.value, 3, "mutation persisted; RETURNING value reflects post-mutation state");
  } finally {
    teardown(dir);
  }
});

test("execReturningOne throws when the statement returns zero rows", () => {
  const dir = setupQueriesDir((d) => {
    writeFileSync(
      join(d, "delete-test-item-returning.sql"),
      "-- @terminator: exec_one\nDELETE FROM test_items WHERE id = ? RETURNING id\n"
    );
  });
  try {
    setupDb();
    const reg = loadReferenceQueries(dir);
    assert.throws(
      () => execReturningOne(reg.deleteTestItemReturning, [9999]),
      /returned no rows/
    );
  } finally {
    teardown(dir);
  }
});

// ---------------------------------------------------------------------------
// transaction
// ---------------------------------------------------------------------------

test("transaction commits on normal return", () => {
  const dir = setupQueriesDir(() => {});
  try {
    const db = setupDb();
    const insert = db.prepare("INSERT INTO test_items (name, value) VALUES (?, ?)");
    transaction(() => {
      insert.run("alpha", 1);
      insert.run("beta", 2);
    });
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM test_items")
      .get();
    assert.equal(count.n, 2);
  } finally {
    teardown(dir);
  }
});

test("transaction rolls back when the callback throws", () => {
  const dir = setupQueriesDir(() => {});
  try {
    const db = setupDb();
    const insert = db.prepare("INSERT INTO test_items (name, value) VALUES (?, ?)");
    assert.throws(() =>
      transaction(() => {
        insert.run("alpha", 1);
        throw new Error("boom");
      })
    );
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM test_items")
      .get();
    assert.equal(count.n, 0);
  } finally {
    teardown(dir);
  }
});

// ---------------------------------------------------------------------------
// writeTransaction (BEGIN IMMEDIATE)
// ---------------------------------------------------------------------------

test("writeTransaction commits on normal return", () => {
  const dir = setupQueriesDir(() => {});
  try {
    const db = setupDb();
    const insert = db.prepare("INSERT INTO test_items (name, value) VALUES (?, ?)");
    writeTransaction(() => {
      insert.run("alpha", 1);
      insert.run("beta", 2);
    });
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM test_items")
      .get();
    assert.equal(count.n, 2);
  } finally {
    teardown(dir);
  }
});

test("writeTransaction rolls back when the callback throws", () => {
  const dir = setupQueriesDir(() => {});
  try {
    const db = setupDb();
    const insert = db.prepare("INSERT INTO test_items (name, value) VALUES (?, ?)");
    assert.throws(() =>
      writeTransaction(() => {
        insert.run("alpha", 1);
        throw new Error("boom");
      })
    );
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM test_items")
      .get();
    assert.equal(count.n, 0);
  } finally {
    teardown(dir);
  }
});

test("writeTransaction acquires the write lock at transaction start (BEGIN IMMEDIATE)", () => {
  // Proof that writeTransaction uses BEGIN IMMEDIATE rather than the
  // default deferred BEGIN: opening a sibling write transaction on a
  // separate connection while writeTransaction is mid-flight must fail
  // with SQLITE_BUSY *before* any write statement runs. Under deferred
  // BEGIN the sibling would only collide on first write inside the
  // body, not at the BEGIN itself.
  const dir = setupQueriesDir(() => {});
  // Use an on-disk DB so a second connection can open the same file;
  // :memory: connections are independent and would not contend.
  const tmpDb = mkdtempSync(join(tmpdir(), "pdpp-write-tx-"));
  const dbPath = join(tmpDb, "wtx.sqlite");
  let sibling;
  try {
    closeDb();
    initDb(dbPath, { busyTimeoutMs: 0 });
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        value INTEGER NOT NULL
      );
    `);

    // Sibling connection on the same file, also with no busy timeout
    // so the contention surfaces synchronously instead of queueing.
    sibling = new Database(dbPath, { timeout: 0 });

    let observedBusy = false;
    writeTransaction(() => {
      // No write yet — under BEGIN IMMEDIATE the lock is already held.
      try {
        sibling.exec("BEGIN IMMEDIATE");
        sibling.exec("ROLLBACK");
      } catch (err) {
        observedBusy = /SQLITE_BUSY|database is locked/i.test(String(err));
      }
    });
    assert.equal(observedBusy, true, "expected sibling BEGIN IMMEDIATE to see SQLITE_BUSY while writeTransaction held the write lock");
  } finally {
    if (sibling) sibling.close();
    teardown(dir);
    rmSync(tmpDb, { force: true, recursive: true });
  }
});

// ---------------------------------------------------------------------------
// allowUnboundedReadAcknowledged
// ---------------------------------------------------------------------------

test("allowUnboundedReadAcknowledged returns rows when count <= maxRows", () => {
  const dir = setupQueriesDir((d) => {
    writeFileSync(
      join(d, "list-all-items.sql"),
      "-- @terminator: many\n-- @bounded_by: small_enumeration_table\n-- @table: test_items\n-- @max_rows: 10\nSELECT id, name FROM test_items ORDER BY id\n"
    );
  });
  try {
    const db = setupDb();
    const insert = db.prepare("INSERT INTO test_items (name, value) VALUES (?, ?)");
    for (let i = 1; i <= 5; i++) insert.run(`row-${i}`, i);
    const reg = loadReferenceQueries(dir);
    const rows = allowUnboundedReadAcknowledged(reg.listAllItems);
    assert.equal(rows.length, 5);
  } finally {
    teardown(dir);
  }
});

test("allowUnboundedReadAcknowledged throws when count exceeds @max_rows", () => {
  const dir = setupQueriesDir((d) => {
    writeFileSync(
      join(d, "list-all-items.sql"),
      "-- @terminator: many\n-- @bounded_by: small_enumeration_table\n-- @table: test_items\n-- @max_rows: 3\nSELECT id, name FROM test_items ORDER BY id\n"
    );
  });
  try {
    const db = setupDb();
    const insert = db.prepare("INSERT INTO test_items (name, value) VALUES (?, ?)");
    for (let i = 1; i <= 5; i++) insert.run(`row-${i}`, i);
    const reg = loadReferenceQueries(dir);
    assert.throws(
      () => allowUnboundedReadAcknowledged(reg.listAllItems),
      SmallEnumerationOverflowError
    );
  } finally {
    teardown(dir);
  }
});

// ---------------------------------------------------------------------------
// iterateDynamicSqlAcknowledged
// ---------------------------------------------------------------------------

test("iterateDynamicSqlAcknowledged streams rows from a dynamically-built SQL string", () => {
  const dir = setupQueriesDir(() => {});
  try {
    const db = setupDb();
    const insert = db.prepare("INSERT INTO test_items (name, value) VALUES (?, ?)");
    for (let i = 1; i <= 5; i++) insert.run(`row-${i}`, i);

    // REVIEWED-DYNAMIC: test exercises the dynamic-SQL escape hatch.
    const dynamicSql = "SELECT id, name FROM test_items WHERE value > ? ORDER BY id LIMIT ?";
    const seen = [];
    for (const row of iterateDynamicSqlAcknowledged(dynamicSql, [2, 10])) {
      seen.push(row);
    }
    assert.equal(seen.length, 3);
    assert.equal(seen[0].name, "row-3");
  } finally {
    teardown(dir);
  }
});

test("iterateDynamicSqlAcknowledged supports caller break-out", () => {
  const dir = setupQueriesDir(() => {});
  try {
    const db = setupDb();
    const insert = db.prepare("INSERT INTO test_items (name, value) VALUES (?, ?)");
    for (let i = 1; i <= 100; i++) insert.run(`row-${i}`, i);

    // REVIEWED-DYNAMIC: test exercises early-break behavior.
    const seen = [];
    for (const row of iterateDynamicSqlAcknowledged(
      "SELECT id FROM test_items ORDER BY id LIMIT ?",
      [100]
    )) {
      seen.push(row);
      if (seen.length >= 3) break;
    }
    assert.equal(seen.length, 3);
  } finally {
    teardown(dir);
  }
});

// ---------------------------------------------------------------------------
// Cursor encode/decode
// ---------------------------------------------------------------------------

test("encodeCursor and decodeCursor round-trip", () => {
  const payload = { v: 1, k: "abc-123", r: 42 };
  const encoded = encodeCursor(payload);
  const decoded = decodeCursor(encoded);
  assert.deepEqual(decoded, payload);
});

test("encodeCursor handles null cursor field", () => {
  const payload = { v: 1, k: null, r: 7 };
  const encoded = encodeCursor(payload);
  const decoded = decodeCursor(encoded);
  assert.deepEqual(decoded, payload);
});

test("decodeCursor rejects malformed base64", () => {
  assert.throws(() => decodeCursor("!!!not-base64!!!"), InvalidCursorError);
});

test("decodeCursor rejects non-JSON payloads", () => {
  const encoded = Buffer.from("not json", "utf8").toString("base64url");
  assert.throws(() => decodeCursor(encoded), InvalidCursorError);
});

test("decodeCursor rejects payloads missing required fields", () => {
  const encoded = Buffer.from(JSON.stringify({ v: 1 }), "utf8").toString("base64url");
  assert.throws(() => decodeCursor(encoded), InvalidCursorError);
});

test("decodeCursor rejects unsupported version", () => {
  const encoded = Buffer.from(
    JSON.stringify({ v: 999, k: "x", r: 1 }),
    "utf8"
  ).toString("base64url");
  assert.throws(() => decodeCursor(encoded), InvalidCursorError);
});

// ---------------------------------------------------------------------------
// getMany cursor pagination integration
// ---------------------------------------------------------------------------

test("getMany pagination yields a stable, non-overlapping sequence", () => {
  // Note: the SQL artifact owns the WHERE-cursor predicate; this test
  // verifies the end-to-end shape against a query that uses (id) > ?
  // for the cursor seek.
  const dir = setupQueriesDir((d) => {
    writeFileSync(
      join(d, "first-page.sql"),
      "-- @terminator: many\n-- @cursor_field: id\nSELECT id, name FROM test_items ORDER BY id LIMIT ?\n"
    );
    writeFileSync(
      join(d, "next-page.sql"),
      "-- @terminator: many\n-- @cursor_field: id\nSELECT id, name FROM test_items WHERE id > ? ORDER BY id LIMIT ?\n"
    );
  });
  try {
    const db = setupDb();
    const insert = db.prepare("INSERT INTO test_items (name, value) VALUES (?, ?)");
    for (let i = 1; i <= 7; i++) insert.run(`row-${i}`, i);
    const reg = loadReferenceQueries(dir);

    const page1 = getMany(reg.firstPage, [], { limit: 3 });
    assert.equal(page1.rows.length, 3);
    assert.equal(page1.truncated, true);
    const page1Cursor = decodeCursor(page1.nextCursor);

    const page2 = getMany(reg.nextPage, [page1Cursor.r], { limit: 3 });
    assert.equal(page2.rows.length, 3);
    assert.equal(page2.truncated, true);

    const allIds = [...page1.rows, ...page2.rows].map((r) => r.id);
    // No overlaps; strictly ascending.
    for (let i = 1; i < allIds.length; i++) {
      assert.ok(allIds[i] > allIds[i - 1], `expected ${allIds[i]} > ${allIds[i - 1]}`);
    }
  } finally {
    teardown(dir);
  }
});
