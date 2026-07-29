// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-adapter authority is deliberately tested with no initialized storage.
 * A typed rejection proves the manifest gate ran before any SQLite/Postgres
 * record, FTS/vector, blob, or snapshot call could be attempted.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  postgresGetRecord,
  postgresGetRecordFieldWindow,
  postgresListStreams,
  postgresQueryRecords,
} from "../server/postgres-records.ts";
import { aggregateRecords, getRecord, getRecordFieldWindow, listStreams, queryRecords } from "../server/records.ts";

const target = {
  connector_id: "authority-test",
  connector_instance_id: "cin_authority-test",
};
const grant = { streams: [{ name: "dormant" }] };

function assertClosed(error: unknown, { fieldWindow = false } = {}): boolean {
  assert.ok(typeof error === "object" && error !== null);
  const err = error as { code?: unknown; httpStatus?: unknown; statusCode?: unknown };
  assert.equal(err.code, "stream_not_declared");
  assert.equal(fieldWindow ? err.httpStatus : err.statusCode, 404);
  return true;
}

test("SQLite read adapters reject a missing current manifest before storage access", async () => {
  await assert.rejects(() => queryRecords(target, "dormant", grant, {}, null), assertClosed);
  await assert.rejects(() => getRecord(target, "dormant", "record_1", grant, null), assertClosed);
  await assert.rejects(() => aggregateRecords(target, "dormant", grant, {}, null), assertClosed);
  await assert.rejects(
    () => getRecordFieldWindow(target, "dormant", "record_1", "body", grant, null),
    (error) => assertClosed(error, { fieldWindow: true })
  );
  await assert.rejects(() => listStreams(target, grant, null), assertClosed);
});

test("Postgres read adapters reject a missing current manifest before any query", async () => {
  await assert.rejects(() => postgresQueryRecords(target, "dormant", grant, {}, null), assertClosed);
  await assert.rejects(() => postgresGetRecord(target, "dormant", "record_1", grant, null), assertClosed);
  await assert.rejects(
    () => postgresGetRecordFieldWindow(target, "dormant", "record_1", "body", grant, null),
    (error) => assertClosed(error, { fieldWindow: true })
  );
  await assert.rejects(() => postgresListStreams(target, grant, null), assertClosed);
});
