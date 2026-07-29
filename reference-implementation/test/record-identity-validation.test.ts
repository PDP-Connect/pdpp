const TOP_LEVEL_REGEX_1 = /account_id/;
const TOP_LEVEL_REGEX_2 = /account_number/;
const TOP_LEVEL_REGEX_3 = /txn_id/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pins the shared write-path record-identity guard used by both the SQLite and
// Postgres record stores. Before this guard, identity validation only checked
// `data.id`, so streams with a non-`id` primary key or a compound primary key
// received no identity validation at all (R2 / spec-core primary_key contract).

import assert from "node:assert/strict";
import { test } from "node:test";
import { assertRecordIdentity } from "../server/record-expand-helpers.ts";

interface QueryError extends Error {
  code?: string;
}

function isQueryError(value: unknown): value is QueryError {
  return value instanceof Error;
}

function identityError(fields: string[], key: unknown, data: unknown): QueryError | null {
  try {
    assertRecordIdentity(fields, key, data);
    return null;
  } catch (err) {
    assert.ok(isQueryError(err), `expected an Error, got ${JSON.stringify(err)}`);
    return err;
  }
}

test("single non-id primary key: data field must match the key", () => {
  // Stream keyed by account_number, not id.
  assert.equal(identityError(["account_number"], "12345", { account_number: "12345", balance: 10 }), null);

  const err = identityError(["account_number"], "12345", { account_number: "99999" });
  assert.ok(err, "mismatched non-id key must throw");
  assert.equal(err.code, "invalid_record_identity");
  assert.match(err.message, TOP_LEVEL_REGEX_2);
});

test("compound primary key: every present field must match its key position", () => {
  const fields = ["account_id", "txn_id"];
  assert.equal(identityError(fields, ["acc_1", "txn_9"], { account_id: "acc_1", txn_id: "txn_9" }), null);

  const wrongSecond = identityError(fields, ["acc_1", "txn_9"], { account_id: "acc_1", txn_id: "txn_X" });
  assert.ok(wrongSecond, "mismatch on a compound key component must throw");
  assert.equal(wrongSecond.code, "invalid_record_identity");
  assert.match(wrongSecond.message, TOP_LEVEL_REGEX_3);

  const wrongFirst = identityError(fields, ["acc_1", "txn_9"], { account_id: "acc_OTHER", txn_id: "txn_9" });
  assert.ok(wrongFirst, "mismatch on the first compound component must throw");
  assert.match(wrongFirst.message, TOP_LEVEL_REGEX_1);
});

test("fields absent from data are not checked (key tuple may carry implied values)", () => {
  // account_id present and correct; txn_id omitted from data is allowed.
  assert.equal(identityError(["account_id", "txn_id"], ["acc_1", "txn_9"], { account_id: "acc_1" }), null);
});

test("empty primary_key falls back to legacy data.id guard", () => {
  assert.equal(identityError([], "rec_1", { id: "rec_1" }), null);

  const err = identityError([], "rec_1", { id: "rec_DIFFERENT" });
  assert.ok(err, "legacy data.id mismatch must still throw when no primary_key is known");
  assert.equal(err.code, "invalid_record_identity");
});

test("single-element array key behaves like a one-field key", () => {
  assert.equal(identityError(["account_number"], ["12345"], { account_number: "12345" }), null);
  const err = identityError(["account_number"], ["12345"], { account_number: "0" });
  assert.ok(err);
  assert.equal(err.code, "invalid_record_identity");
});

test("numeric vs string key values compare by string form (storage normalizes keys)", () => {
  // A record whose data carries a numeric id but whose key is the string form
  // must be accepted (keys are encoded as strings downstream).
  assert.equal(identityError(["id"], "42", { id: 42 }), null);
});

test("a numeric scalar key is accepted, not treated as an empty tuple", () => {
  // Regression: a single-field key can arrive as a number; it must be coerced
  // to its string form, not fall through to an empty keyParts tuple (which
  // would compare String(undefined) and falsely throw).
  assert.equal(identityError(["id"], 42, { id: 42 }), null);
  const err = identityError(["id"], 42, { id: 99 });
  assert.ok(err, "a genuine numeric-key mismatch must still throw");
  assert.equal(err.code, "invalid_record_identity");
});

test("a key tuple shorter than the declared compound key does not falsely throw on the missing part", () => {
  // Regression: when the key tuple omits a trailing field, the absent position
  // must be skipped rather than compared against String(undefined).
  assert.equal(identityError(["account_id", "txn_id"], "acc_1", { account_id: "acc_1", txn_id: "txn_9" }), null);
});

test("non-object data is a no-op (deletes / tombstones carry no data)", () => {
  assert.equal(identityError(["account_number"], "12345", null), null);
  assert.equal(identityError(["account_number"], "12345", undefined), null);
});
