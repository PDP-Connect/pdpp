// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure-helper unit coverage for the storage-agnostic record helpers in
// server/record-expand-helpers.js that back the record read/write paths.
//
// record-identity-validation.test.js already pins `assertRecordIdentity`.
// This file pins the other pure, non-grant helpers that had NO direct
// coverage and back real contracts on the record surface:
//
//   - normalizePrimaryKey      — the primary-key normalization used to derive
//                                the identity guard's field list.
//   - parseIntegerValue        — strict integer coercion for numeric query
//                                params (whitespace/sign/non-numeric rules).
//   - assertNonEmptyJsonField preserves arbitrary literal top-level JSON
//                                keys so a backend can quote or bind them.
//   - invalidQueryError        — the typed query-error factory + default code.
//
// These do not touch grant/scope logic; assertions observe behavior only.

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNonEmptyJsonField,
  invalidQueryError,
  normalizePrimaryKey,
  parseIntegerValue,
} from "../server/record-expand-helpers.ts";
import { jsonPathForTopLevelField } from "../server/record-filters.ts";

interface QueryError extends Error {
  code?: string;
}

const NON_EMPTY_STRING_ERROR = /non-empty string/;

function isQueryError(value: unknown): value is QueryError {
  return value instanceof Error;
}

// ─── invalidQueryError ──────────────────────────────────────────────────────

test("invalidQueryError defaults to invalid_request and preserves an explicit code", () => {
  const def = invalidQueryError("bad");
  assert.ok(isQueryError(def));
  assert.equal(def.message, "bad");
  assert.equal(def.code, "invalid_request");

  const explicit = invalidQueryError("nope", "invalid_sort");
  assert.ok(isQueryError(explicit));
  assert.equal(explicit.code, "invalid_sort");
  assert.equal(explicit.message, "nope");
});

// ─── normalizePrimaryKey ────────────────────────────────────────────────────

test("normalizePrimaryKey wraps a non-empty string key into a single-element list", () => {
  assert.deepEqual(normalizePrimaryKey("id"), ["id"]);
});

test("normalizePrimaryKey keeps a compound array and drops empty/non-string members", () => {
  assert.deepEqual(normalizePrimaryKey(["a", "b"]), ["a", "b"]);
  // Empty strings and non-strings are filtered out, preserving order.
  assert.deepEqual(normalizePrimaryKey(["a", "", "b", 0, null, undefined, "c"]), ["a", "b", "c"]);
});

test("normalizePrimaryKey returns an empty list for empty/invalid input (legacy id fallback)", () => {
  assert.deepEqual(normalizePrimaryKey(""), []);
  assert.deepEqual(normalizePrimaryKey([]), []);
  assert.deepEqual(normalizePrimaryKey(null), []);
  assert.deepEqual(normalizePrimaryKey(undefined), []);
  assert.deepEqual(normalizePrimaryKey(42), []);
  assert.deepEqual(normalizePrimaryKey(["", null]), []);
});

// ─── parseIntegerValue ──────────────────────────────────────────────────────

test("parseIntegerValue passes through an integer number", () => {
  assert.equal(parseIntegerValue(0), 0);
  assert.equal(parseIntegerValue(42), 42);
  assert.equal(parseIntegerValue(-7), -7);
});

test("parseIntegerValue rejects a non-integer number", () => {
  assert.equal(parseIntegerValue(1.5), null);
  assert.equal(parseIntegerValue(Number.NaN), null);
  assert.equal(parseIntegerValue(Number.POSITIVE_INFINITY), null);
});

test("parseIntegerValue parses a clean integer string, tolerating surrounding whitespace", () => {
  assert.equal(parseIntegerValue("42"), 42);
  assert.equal(parseIntegerValue("  42  "), 42);
  assert.equal(parseIntegerValue("-7"), -7);
  assert.equal(parseIntegerValue("0"), 0);
});

test("parseIntegerValue rejects non-numeric, decimal, and mixed strings", () => {
  for (const bad of ["", "abc", "4.2", "4px", "0x10", "1e3", "4 2", "+", "-", "12,000"]) {
    assert.equal(parseIntegerValue(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

test("parseIntegerValue rejects non-string, non-number inputs", () => {
  for (const bad of [null, undefined, {}, [], true]) {
    assert.equal(parseIntegerValue(bad), null);
  }
});

// ─── assertNonEmptyJsonField ────────────────────────────────────────────────

test("assertNonEmptyJsonField accepts arbitrary literal keys", () => {
  for (const field of ["created_at", "1field", "a.b", "a-b", 'a"b', "a'b", "時刻"]) {
    assert.doesNotThrow(() => assertNonEmptyJsonField(field, "cursor_field"));
  }
});

test("assertNonEmptyJsonField rejects empty and non-string values", () => {
  assert.throws(() => assertNonEmptyJsonField("", "field"), NON_EMPTY_STRING_ERROR);
  for (const bad of [null, undefined, 42, {}, ["id"]]) {
    assert.throws(() => assertNonEmptyJsonField(bad, "field"), Error);
  }
});

// ─── SQL-literal escaping at the interpolation choke points ─────────────────
// Main replaced staging's identifier-allowlist regex (SAFE_JSON_FIELD,
// /^[A-Za-z_][A-Za-z_0-9]*$/) with assertNonEmptyJsonField PLUS single-quote
// escaping applied where a field name is spliced into SQL text. These pin the
// escaping half: the assertion alone would typecheck and load while silently
// dropping injection defense.

test("jsonPathForTopLevelField escapes quotes/backslashes so a field cannot break the JSON path", () => {
  assert.equal(jsonPathForTopLevelField('a"b'), '$."a\\"b"');
  assert.equal(jsonPathForTopLevelField("a\\b"), '$."a\\\\b"');
  // A hyphenated key is legal here; staging's old regex rejected it outright.
  assert.equal(jsonPathForTopLevelField("event-time"), '$."event-time"');
});

test("single-quote escaping keeps a hostile field name inside its SQL string literal", () => {
  // Mirrors postgresTopLevelJsonExpr / sqliteTopLevelJsonExpr: escape ' as ''
  // immediately before interpolation. Quote parity inside the literal region
  // is what proves the value cannot terminate the literal early.
  for (const field of ["event-time", "a' OR '1'='1", "x'; DROP TABLE records; --"]) {
    const expr = `(record_json->>'${field.replace(/'/g, "''")}')`;
    const inner = expr.slice(expr.indexOf("'") + 1, expr.lastIndexOf("'"));
    assert.equal((inner.match(/'/g) ?? []).length % 2, 0, `unbalanced quotes for ${field}`);
  }
});
