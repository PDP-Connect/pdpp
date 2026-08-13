// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the storage-agnostic record helpers
// (server/record-expand-helpers.js) — the pure, non-grant functions only.
//
// Covered: primary-key normalization, the write-path identity guard (single
// and compound keys, the data.id fallback, and short-key-tuple handling),
// integer parsing, and the safe-JSON-field regex guard.
//
// NOTE: `normalizeExpandRequest` and `buildEffectiveFilter` are intentionally
// NOT exercised here — they are grant-projection / scope-enforcement code and
// out of scope for this refactor-safe test set.

import { strict as assert } from "node:assert/strict";
import { test } from "node:test";

import {
  assertNonEmptyJsonField,
  assertRecordIdentity,
  invalidQueryError,
  normalizePrimaryKey,
  parseIntegerValue,
} from "../server/record-expand-helpers.ts";

interface QueryError extends Error {
  code?: string;
}

function isQueryError(value: unknown): value is QueryError {
  return value instanceof Error;
}

test("invalidQueryError attaches the given code (default invalid_request)", () => {
  const def = invalidQueryError("boom");
  assert.ok(isQueryError(def));
  assert.equal(def.code, "invalid_request");
  const explicit = invalidQueryError("boom", "invalid_expand");
  assert.ok(isQueryError(explicit));
  assert.equal(explicit.code, "invalid_expand");
});

test("normalizePrimaryKey normalizes arrays, strings, and rejects junk", () => {
  assert.deepEqual(normalizePrimaryKey(["a", "b"]), ["a", "b"]);
  // Non-string / empty entries are filtered out.
  assert.deepEqual(normalizePrimaryKey(["a", "", 3, null, "b"]), ["a", "b"]);
  assert.deepEqual(normalizePrimaryKey("id"), ["id"]);
  assert.deepEqual(normalizePrimaryKey(""), []);
  assert.deepEqual(normalizePrimaryKey(null), []);
  assert.deepEqual(normalizePrimaryKey(42), []);
});

test("assertRecordIdentity is a no-op for null / non-object data", () => {
  assert.doesNotThrow(() => assertRecordIdentity(["id"], "k", null));
  assert.doesNotThrow(() => assertRecordIdentity(["id"], "k", "not-an-object"));
});

test("assertRecordIdentity falls back to data.id when no primary-key fields known", () => {
  // No PK fields → single-key data.id guard.
  assert.doesNotThrow(() => assertRecordIdentity([], "abc", { id: "abc" }));
  // data.id absent → not checked.
  assert.doesNotThrow(() => assertRecordIdentity([], "abc", { other: 1 }));
  // Mismatch throws.
  assert.throws(
    () => assertRecordIdentity([], "abc", { id: "xyz" }),
    (err: unknown) => isQueryError(err) && err.code === "invalid_record_identity"
  );
});

test("assertRecordIdentity checks a single declared primary-key field", () => {
  assert.doesNotThrow(() => assertRecordIdentity(["id"], "rec-1", { id: "rec-1" }));
  // Numeric key vs string data compare via String().
  assert.doesNotThrow(() => assertRecordIdentity(["id"], 5, { id: 5 }));
  assert.throws(
    () => assertRecordIdentity(["id"], "rec-1", { id: "rec-2" }),
    (err: unknown) => isQueryError(err) && err.code === "invalid_record_identity"
  );
});

test("assertRecordIdentity checks each position of a compound key", () => {
  assert.doesNotThrow(() => assertRecordIdentity(["a", "b"], ["1", "2"], { a: "1", b: "2" }));
  // Second position disagrees → throw.
  assert.throws(
    () => assertRecordIdentity(["a", "b"], ["1", "2"], { a: "1", b: "9" }),
    (err: unknown) => isQueryError(err) && err.code === "invalid_record_identity"
  );
});

test("assertRecordIdentity skips fields omitted from data", () => {
  // `b` absent from data → not checked, no throw.
  assert.doesNotThrow(() => assertRecordIdentity(["a", "b"], ["1", "2"], { a: "1" }));
});

test("assertRecordIdentity skips key positions the tuple does not provide", () => {
  // Key tuple shorter than declared PK: position 1 is undefined → skipped,
  // so a present data.b is not falsely compared against String(undefined).
  assert.doesNotThrow(() => assertRecordIdentity(["a", "b"], ["1"], { a: "1", b: "anything" }));
});

test("parseIntegerValue accepts integer numbers and integer strings", () => {
  assert.equal(parseIntegerValue(7), 7);
  assert.equal(parseIntegerValue(-3), -3);
  assert.equal(parseIntegerValue("42"), 42);
  assert.equal(parseIntegerValue("  -5  "), -5);
});

test("parseIntegerValue rejects non-integers and non-numeric strings", () => {
  assert.equal(parseIntegerValue(1.5), null);
  assert.equal(parseIntegerValue("1.5"), null);
  assert.equal(parseIntegerValue("abc"), null);
  assert.equal(parseIntegerValue(""), null);
  assert.equal(parseIntegerValue(null), null);
  assert.equal(parseIntegerValue("12x"), null);
});

test("assertNonEmptyJsonField accepts literal top-level JSON keys", () => {
  for (const field of ["body", "has-dash", "has.dot", 'said "when"', "時刻"]) {
    assert.doesNotThrow(() => assertNonEmptyJsonField(field, "field"));
  }
});

test("assertNonEmptyJsonField rejects absent field names", () => {
  assert.throws(() => assertNonEmptyJsonField("", "field"));
  assert.throws(() => assertNonEmptyJsonField(null, "field"));
});
