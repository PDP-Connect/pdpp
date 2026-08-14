// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure-logic oracle for three untested helpers in server/record-expand-helpers.js:
//   - normalizePrimaryKey: normalizes a manifest primary_key to a clean string[]
//     (filters non-string/empty array members, wraps a scalar, [] otherwise);
//   - parseIntegerValue: the integer coercion behind filter comparisons (accepts
//     integer numbers, trims decimal strings, rejects floats / non-numeric);
//   - assertNonEmptyJsonField: validates the Source contract's non-empty
//     literal top-level field reference before backends quote or bind it.
// All pure, all previously untested by name. No DB.

import assert from "node:assert/strict";
import test from "node:test";
import { assertNonEmptyJsonField, normalizePrimaryKey, parseIntegerValue } from "../server/record-expand-helpers.ts";

const NON_EMPTY_STRING_ERROR = /non-empty string/;

test("normalizePrimaryKey cleans an array, wraps a scalar string, and returns [] otherwise", () => {
  assert.deepEqual(normalizePrimaryKey(["a", "", "b", 123, null]), ["a", "b"]);
  assert.deepEqual(normalizePrimaryKey("id"), ["id"]);
  assert.deepEqual(normalizePrimaryKey(""), []);
  assert.deepEqual(normalizePrimaryKey(null), []);
  assert.deepEqual(normalizePrimaryKey(42), []);
});

test("parseIntegerValue accepts integer numbers and integer strings, rejecting floats and non-numeric", () => {
  assert.equal(parseIntegerValue(42), 42);
  assert.equal(parseIntegerValue(4.5), null); // a non-integer number is rejected
  assert.equal(parseIntegerValue("42"), 42);
  assert.equal(parseIntegerValue("-7"), -7);
  assert.equal(parseIntegerValue(" 10 "), 10); // surrounding whitespace is trimmed
  assert.equal(parseIntegerValue("4.5"), null);
  assert.equal(parseIntegerValue("abc"), null);
  assert.equal(parseIntegerValue("4a"), null);
  assert.equal(parseIntegerValue(""), null);
  assert.equal(parseIntegerValue(null), null);
  assert.equal(parseIntegerValue(undefined), null);
});

test("assertNonEmptyJsonField accepts arbitrary literal keys and rejects absent values", () => {
  for (const field of ["field_1", "1field", "a.b", "a b", "a-b", 'a"b', "時刻"]) {
    assert.doesNotThrow(() => assertNonEmptyJsonField(field, "field"));
  }
  assert.throws(() => assertNonEmptyJsonField(123, "field"), NON_EMPTY_STRING_ERROR);
  assert.throws(() => assertNonEmptyJsonField("", "field"), NON_EMPTY_STRING_ERROR);
});
