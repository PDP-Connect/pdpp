// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { type BindValue, iterateDynamicSqlAcknowledged } from "../lib/db.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { type CountRow, sqliteCountIndexableTextValues } from "../server/search-index-counts.ts";

afterEach(() => {
  closeDb();
});

function isBindValue(value: unknown): value is BindValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  );
}

// `sqliteCountIndexableTextValues` declares its `iterateDynamicSql` dependency
// with a narrow `params: unknown[]` so callers cannot assume anything about
// the shape of bind values; the concrete `iterateDynamicSqlAcknowledged`
// primitive requires the stricter `BindParams`. This adapter re-validates the
// params at the real call boundary instead of asserting the type away.
function iterateDynamicSql(sql: string, params: unknown[]): Iterable<CountRow> {
  if (!params.every(isBindValue)) {
    throw new TypeError("iterateDynamicSql received a param that is not a valid SQL bind value");
  }
  return iterateDynamicSqlAcknowledged<CountRow>(sql, params);
}

test("sqlite grouped indexable field count preserves per-field loop semantics", () => {
  initDb(":memory:");
  const db = getDb();
  const connectorId = "sqlite_index_counts";
  const connectorInstanceId = "cin_sqlite_index_counts";
  const stream = "messages";
  const insertRecord = db.prepare(
    `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted)
     VALUES(?, ?, ?, ?, ?, ?, 1, ?)`
  );
  const now = new Date().toISOString();
  insertRecord.run(
    connectorId,
    connectorInstanceId,
    stream,
    "a",
    JSON.stringify({ body: "  ", title: "Alpha" }),
    now,
    0
  );
  insertRecord.run(connectorId, connectorInstanceId, stream, "b", JSON.stringify({ body: "Beta", title: "" }), now, 0);
  insertRecord.run(
    connectorId,
    connectorInstanceId,
    stream,
    "c",
    JSON.stringify({ body: "Delta", title: "Gamma" }),
    now,
    0
  );
  insertRecord.run(
    connectorId,
    connectorInstanceId,
    stream,
    "deleted",
    JSON.stringify({ body: "Hidden", title: "Hidden" }),
    now,
    1
  );

  assert.equal(
    sqliteCountIndexableTextValues({
      connectorInstanceId,
      declaredFields: ["title", "body", "missing", "title"],
      iterateDynamicSql,
      jsonPathForField: (field) => `$."${field}"`,
      stream,
    }),
    7
  );
});
