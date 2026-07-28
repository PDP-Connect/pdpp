// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure-logic oracle for the read_record_field window-selector validators
// (server/record-field-window.js).
//
// normalizeWindowSelector, assertFieldPath, classifyFieldType, and
// assertReadableStringField are the RS-substrate validators that decide the
// selector mode (offset vs query) and emit the typed FieldWindowError vocabulary
// the route surfaces verbatim (each error carries .code AND .httpStatus). The
// DB-backed conformance test exercises these only through the storage path and
// never asserts the pure validation boundaries or the typed error codes.
//
// This is a no-DB oracle: these validators are pure and import without a
// Postgres connection.
//
// Spec: openspec/changes/add-mcp-content-ladder/specs/mcp-adapter/spec.md

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertFieldPath,
  assertReadableStringField,
  classifyFieldType,
  FIELD_WINDOW_DEFAULT_LIMIT,
  FIELD_WINDOW_MAX_CONTEXT_CHARS,
  normalizeWindowSelector,
} from "../server/record-field-window.ts";

interface FieldWindowError extends Error {
  code?: string;
  httpStatus?: number;
}

function isFieldWindowError(value: unknown): value is FieldWindowError {
  return value instanceof Error;
}

// Matcher factory: assert the typed FieldWindowError code + httpStatus (both are
// mapped by the route) and a message substring.
function fieldWindowError(code: string, httpStatus: number, messageSubstring?: string) {
  return (err: unknown) => {
    assert.ok(isFieldWindowError(err), `expected a FieldWindowError, got ${JSON.stringify(err)}`);
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    assert.equal(err.httpStatus, httpStatus, `expected httpStatus ${httpStatus}, got ${err.httpStatus}`);
    if (messageSubstring !== undefined) {
      assert.ok(
        err.message.includes(messageSubstring),
        `expected message to include ${JSON.stringify(messageSubstring)}, got ${JSON.stringify(err.message)}`
      );
    }
    return true;
  };
}

test("normalizeWindowSelector rejects before_chars/after_chars without q", () => {
  assert.throws(
    () => normalizeWindowSelector({ before_chars: 10 }),
    fieldWindowError("invalid_window", 400, "before_chars and after_chars require q")
  );
});

test("normalizeWindowSelector rejects q combined with offset_chars", () => {
  assert.throws(
    () => normalizeWindowSelector({ offset_chars: 5, q: "x" }),
    fieldWindowError("invalid_window", 400, "q is exclusive with offset_chars")
  );
});

test("normalizeWindowSelector rejects an empty q", () => {
  assert.throws(
    () => normalizeWindowSelector({ q: "" }),
    fieldWindowError("invalid_window", 400, "q must be a non-empty string")
  );
});

test("normalizeWindowSelector enforces the context-chars ceiling", () => {
  assert.throws(
    () => normalizeWindowSelector({ before_chars: FIELD_WINDOW_MAX_CONTEXT_CHARS + 1, q: "x" }),
    fieldWindowError("invalid_window", 400, "before_chars must be <= 8192")
  );
});

test("normalizeWindowSelector returns an offset-mode selector for a valid offset request", () => {
  const selector = normalizeWindowSelector({ limit_chars: 100, offset_chars: 4 });
  assert.equal(selector.mode, "offset");
  assert.equal(selector.offset, 4);
  assert.equal(selector.limit, 100);

  const defaultLimitSelector = normalizeWindowSelector({ offset_chars: 4 });
  assert.equal(defaultLimitSelector.mode, "offset");
  assert.equal(defaultLimitSelector.offset, 4);
  assert.equal(defaultLimitSelector.limit, FIELD_WINDOW_DEFAULT_LIMIT);
});

test("normalizeWindowSelector returns a query-mode selector whose limit is the explicit-context sum", () => {
  const selector = normalizeWindowSelector({ after_chars: 20, before_chars: 10, q: "foo" });
  assert.equal(selector.mode, "query");
  assert.equal(selector.before, 10);
  assert.equal(selector.after, 20);
  // before + q.length + after = 10 + 3 + 20 = 33 when no explicit limit_chars.
  assert.equal(selector.limit, 33);
});

test("assertFieldPath rejects NUL, empty, and non-string, and accepts a plain key", () => {
  assert.throws(() => assertFieldPath("a\u0000b"), fieldWindowError("invalid_field_path", 400, "must not contain NUL"));
  assert.throws(() => assertFieldPath(""), fieldWindowError("invalid_field_path", 400));
  assert.throws(() => assertFieldPath(123), fieldWindowError("invalid_field_path", 400));
  assert.doesNotThrow(() => assertFieldPath("body"));
});

test("classifyFieldType maps engine type names to coarse classes", () => {
  const table = {
    array: "array",
    boolean: "boolean",
    false: "boolean",
    integer: "number",
    null: "null",
    number: "number",
    object: "object",
    real: "number",
    string: "string",
    text: "string",
    true: "boolean",
    weird: "other",
  };
  for (const [engineType, expected] of Object.entries(table)) {
    assert.equal(classifyFieldType(engineType), expected, `classifyFieldType(${engineType})`);
  }
  assert.equal(classifyFieldType(null), "absent");
  assert.equal(classifyFieldType(undefined), "absent");
});

test("assertReadableStringField distinguishes absent (404), non-text (422), and readable string (ok)", () => {
  assert.throws(() => assertReadableStringField("f", "absent"), fieldWindowError("field_not_found", 404));
  assert.throws(() => assertReadableStringField("f", "object"), fieldWindowError("field_not_text", 422));
  assert.throws(() => assertReadableStringField("f", "number"), fieldWindowError("field_not_text", 422));
  assert.doesNotThrow(() => assertReadableStringField("f", "string"));
});
