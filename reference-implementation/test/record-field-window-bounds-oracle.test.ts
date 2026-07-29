// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure-logic oracle for clampWindowBounds and sqliteFieldJsonPath
// (server/record-field-window.js) — both previously had ZERO test references.
//
// clampWindowBounds is the paging-bound contract: it defaults the limit, clamps
// to FIELD_WINDOW_MAX_LIMIT (setting limitClamped so the caller can warn), and
// REJECTS non-integer / negative offsets and non-positive limits rather than
// silently coercing (a silently shifted window is a correctness trap for a
// paging client). sqliteFieldJsonPath is the injection-safe single-key path
// builder: wrapping the key in JSON.stringify makes a key containing `.` or `"`
// resolve to that exact literal key, never a nested path or a SQL break-out.
//
// Pure, no DB.
//
// Spec: openspec/changes/add-mcp-content-ladder/specs/mcp-adapter/spec.md

import assert from "node:assert/strict";
import test from "node:test";
import {
  clampWindowBounds,
  FIELD_WINDOW_DEFAULT_LIMIT,
  FIELD_WINDOW_MAX_LIMIT,
  sqliteFieldJsonPath,
} from "../server/record-field-window.ts";

interface FieldWindowError extends Error {
  code?: string;
  httpStatus?: number;
}

function isFieldWindowError(value: unknown): value is FieldWindowError {
  return value instanceof Error;
}

function isInvalidWindow(messageSubstring: string) {
  return (err: unknown) => {
    assert.ok(isFieldWindowError(err), `expected an Error, got ${JSON.stringify(err)}`);
    assert.equal(err.code, "invalid_window");
    assert.equal(err.httpStatus, 400);
    assert.ok(
      err.message.includes(messageSubstring),
      `expected message to include ${JSON.stringify(messageSubstring)}, got ${JSON.stringify(err.message)}`
    );
    return true;
  };
}

test("clampWindowBounds defaults offset to 0 and limit to FIELD_WINDOW_DEFAULT_LIMIT", () => {
  assert.deepEqual(clampWindowBounds({}), {
    limit: FIELD_WINDOW_DEFAULT_LIMIT,
    limitClamped: false,
    offset: 0,
  });
  // null/undefined offset and limit are treated as absent (defaulted), not rejected.
  assert.deepEqual(clampWindowBounds({ limitChars: null, offsetChars: null }), {
    limit: FIELD_WINDOW_DEFAULT_LIMIT,
    limitClamped: false,
    offset: 0,
  });
});

test("clampWindowBounds passes through a valid in-range offset and limit", () => {
  assert.deepEqual(clampWindowBounds({ limitChars: 100, offsetChars: 5 }), {
    limit: 100,
    limitClamped: false,
    offset: 5,
  });
});

test("clampWindowBounds clamps an over-max limit and flags limitClamped", () => {
  assert.deepEqual(clampWindowBounds({ limitChars: FIELD_WINDOW_MAX_LIMIT + 1000 }), {
    limit: FIELD_WINDOW_MAX_LIMIT,
    limitClamped: true,
    offset: 0,
  });
});

test("clampWindowBounds does NOT flag limitClamped for a limit exactly at the ceiling", () => {
  assert.deepEqual(clampWindowBounds({ limitChars: FIELD_WINDOW_MAX_LIMIT }), {
    limit: FIELD_WINDOW_MAX_LIMIT,
    limitClamped: false,
    offset: 0,
  });
});

test("clampWindowBounds rejects non-integer or negative offset", () => {
  assert.throws(
    () => clampWindowBounds({ offsetChars: -1 }),
    isInvalidWindow("offset_chars must be a non-negative integer")
  );
  assert.throws(
    () => clampWindowBounds({ offsetChars: 1.5 }),
    isInvalidWindow("offset_chars must be a non-negative integer")
  );
});

test("clampWindowBounds rejects non-positive or non-integer limit", () => {
  assert.throws(() => clampWindowBounds({ limitChars: 0 }), isInvalidWindow("limit_chars must be a positive integer"));
  assert.throws(() => clampWindowBounds({ limitChars: -3 }), isInvalidWindow("limit_chars must be a positive integer"));
  assert.throws(
    () => clampWindowBounds({ limitChars: 2.2 }),
    isInvalidWindow("limit_chars must be a positive integer")
  );
});

test("sqliteFieldJsonPath wraps a plain key as a quoted single-key path", () => {
  assert.equal(sqliteFieldJsonPath("body"), '$."body"');
});

test("sqliteFieldJsonPath treats a dotted key as one literal key, not a nested path", () => {
  // The whole `a.b` is one JSON key: `$."a.b"`, never `$.a.b`.
  assert.equal(sqliteFieldJsonPath("a.b"), '$."a.b"');
});

test("sqliteFieldJsonPath escapes an embedded double-quote so the key cannot break out", () => {
  assert.equal(sqliteFieldJsonPath('weird"key'), '$."weird\\"key"');
});
