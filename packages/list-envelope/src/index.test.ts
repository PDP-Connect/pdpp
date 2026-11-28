// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { validateListEnvelope } from "./index.ts";

test("valid terminal page (has_more: false, no cursor)", () => {
  const result = validateListEnvelope({ data: [1, 2, 3], has_more: false, object: "list" });
  assert.deepEqual(result, { data: [1, 2, 3], hasMore: false, kind: "valid", nextCursor: undefined });
});

test("valid continuing page (has_more: true, usable cursor)", () => {
  const result = validateListEnvelope({ data: [], has_more: true, next_cursor: "abc123", object: "list" });
  assert.equal(result.kind, "valid");
  if (result.kind === "valid") {
    assert.equal(result.hasMore, true);
    assert.equal(result.nextCursor, "abc123");
  }
});

test("ADVERSARIAL: wrong discriminator (object !== 'list') is rejected", () => {
  const result = validateListEnvelope({ data: [], has_more: false, object: "wrong" });
  assert.equal(result.kind, "invalid");
});

test("ADVERSARIAL: non-array data is rejected even when object is correct", () => {
  const result = validateListEnvelope({ data: { bad: true }, has_more: false, object: "list" });
  assert.equal(result.kind, "invalid");
});

test("ADVERSARIAL: non-boolean has_more (string 'true') is rejected, never coerced", () => {
  const result = validateListEnvelope({ data: [], has_more: "true" as unknown as boolean, object: "list" });
  assert.equal(result.kind, "invalid");
});

test("ADVERSARIAL: non-boolean has_more (1/0) is rejected, never coerced", () => {
  const result = validateListEnvelope({ data: [], has_more: 1 as unknown as boolean, object: "list" });
  assert.equal(result.kind, "invalid");
});

test("ADVERSARIAL: has_more true with missing next_cursor is rejected", () => {
  const result = validateListEnvelope({ data: [], has_more: true, object: "list" });
  assert.equal(result.kind, "invalid");
});

test("ADVERSARIAL: has_more true with a whitespace-only next_cursor is rejected (blank after trim)", () => {
  const result = validateListEnvelope({ data: [], has_more: true, next_cursor: "   ", object: "list" });
  assert.equal(result.kind, "invalid");
});

test("ADVERSARIAL: has_more true with an empty-string next_cursor is rejected", () => {
  const result = validateListEnvelope({ data: [], has_more: true, next_cursor: "", object: "list" });
  assert.equal(result.kind, "invalid");
});

test("ADVERSARIAL: has_more false with a non-blank next_cursor present is rejected (terminal-page contradiction)", () => {
  const result = validateListEnvelope({ data: [], has_more: false, next_cursor: "still-here", object: "list" });
  assert.equal(result.kind, "invalid");
});

test("has_more false with a blank/whitespace next_cursor is still VALID (blank is treated as absent)", () => {
  const result = validateListEnvelope({ data: [], has_more: false, next_cursor: "   ", object: "list" });
  assert.equal(result.kind, "valid");
  if (result.kind === "valid") {
    assert.equal(result.nextCursor, undefined);
  }
});

test("a next_cursor with surrounding whitespace is validated as usable but returned UNTRIMMED (opaque value preserved)", () => {
  const result = validateListEnvelope({ data: [], has_more: true, next_cursor: "  raw-cursor  ", object: "list" });
  assert.equal(result.kind, "valid");
  if (result.kind === "valid") {
    // Trimming is validation-only — the actual opaque continuation value must
    // round-trip byte-for-byte, since the server may have encoded meaning in it.
    assert.equal(result.nextCursor, "  raw-cursor  ");
  }
});

test("continuation rejects numeric and object cursors without coercion", () => {
  for (const next_cursor of [123, { value: "opaque" }]) {
    assert.deepEqual(validateListEnvelope({ data: [], has_more: true, next_cursor, object: "list" }), {
      kind: "invalid",
      reason: "has_more is true but next_cursor is missing, non-string, or blank after trimming",
    });
  }
});

test("envelope validation preserves record values and order without applying a record schema", () => {
  const data = [{ id: "second" }, null, { id: "first" }];
  const result = validateListEnvelope({ data, has_more: false, object: "list" });
  assert.equal(result.kind, "valid");
  if (result.kind === "valid") {
    assert.equal(result.data, data);
    assert.deepEqual(result.data, [{ id: "second" }, null, { id: "first" }]);
  }
});

test("a terminal page with an explicit null cursor returns no continuation", () => {
  assert.deepEqual(validateListEnvelope({ data: ["last"], has_more: false, next_cursor: null, object: "list" }), {
    data: ["last"], hasMore: false, kind: "valid", nextCursor: undefined,
  });
});

test("malformed pages report the first invalid field in envelope order", () => {
  const page = { data: null, has_more: null, next_cursor: "unexpected", object: "page" };
  assert.deepEqual(validateListEnvelope(page), {
    kind: "invalid", reason: 'expected object: "list", got "page"',
  });
  assert.deepEqual(validateListEnvelope({ ...page, object: "list" }), {
    kind: "invalid", reason: "expected data to be an array",
  });
  assert.deepEqual(validateListEnvelope({ ...page, object: "list", data: [] }), {
    kind: "invalid", reason: "expected has_more to be a boolean, got null",
  });
});

test("non-object responses are rejected without throwing", () => {
  for (const response of ["list", 5, true, []]) {
    assert.deepEqual(validateListEnvelope(response as never), {
      kind: "invalid",
      reason: 'expected object: "list", got undefined',
    });
  }
});

test("a page with no object field at all is rejected (exact discriminator)", () => {
  assert.deepEqual(validateListEnvelope({ data: [], has_more: false } as never), {
    kind: "invalid",
    reason: 'expected object: "list", got undefined',
  });
});

test("the discriminator is case-sensitive (\"List\" is not \"list\")", () => {
  assert.equal(
    validateListEnvelope({ data: [], has_more: false, object: "List" }).kind,
    "invalid",
  );
});

test("a terminal page with a non-string next_cursor is valid and returns no continuation", () => {
  const result = validateListEnvelope({ data: [], has_more: false, next_cursor: 123, object: "list" });
  assert.deepEqual(result, { data: [], hasMore: false, kind: "valid", nextCursor: undefined });
});

test("unknown extra fields on a page are ignored", () => {
  const result = validateListEnvelope({ data: [], has_more: false, object: "list", extra: 1 } as never);
  assert.equal(result.kind, "valid");
});

test("continuation failures name the exact reason callers surface", () => {
  assert.deepEqual(validateListEnvelope({ data: [], has_more: true, object: "list" }), {
    kind: "invalid",
    reason: "has_more is true but next_cursor is missing, non-string, or blank after trimming",
  });
  assert.deepEqual(validateListEnvelope({ data: [], has_more: true, next_cursor: "   ", object: "list" }), {
    kind: "invalid",
    reason: "has_more is true but next_cursor is missing, non-string, or blank after trimming",
  });
  assert.deepEqual(validateListEnvelope({ data: [], has_more: false, next_cursor: "still-here", object: "list" }), {
    kind: "invalid",
    reason: "has_more is false but next_cursor carries a non-blank continuation (terminal page contradiction)",
  });
});

test("a non-boolean has_more names the offending value in the reason", () => {
  assert.deepEqual(validateListEnvelope({ data: [], has_more: "true" as unknown as boolean, object: "list" }), {
    kind: "invalid",
    reason: 'expected has_more to be a boolean, got "true"',
  });
  assert.deepEqual(validateListEnvelope({ data: [], has_more: 1 as unknown as boolean, object: "list" }), {
    kind: "invalid",
    reason: "expected has_more to be a boolean, got 1",
  });
});

test("check order: cursor coherence is judged only after object, data, and has_more all pass", () => {
  // A wrong object beats a missing cursor.
  assert.deepEqual(validateListEnvelope({ data: [], has_more: true, object: "wrong" }), {
    kind: "invalid",
    reason: 'expected object: "list", got "wrong"',
  });
  // Non-array data beats a missing cursor.
  assert.deepEqual(validateListEnvelope({ data: "nope", has_more: true, object: "list" }), {
    kind: "invalid",
    reason: "expected data to be an array",
  });
  // A non-boolean has_more beats any cursor reasoning.
  assert.deepEqual(validateListEnvelope({ data: [], has_more: "yes" as unknown as boolean, next_cursor: "x", object: "list" }), {
    kind: "invalid",
    reason: 'expected has_more to be a boolean, got "yes"',
  });
});

test("terminal-page contradiction judges the cursor after trimming, and an empty cursor is absent", () => {
  // Non-blank after trimming, even with surrounding whitespace: contradiction.
  assert.deepEqual(validateListEnvelope({ data: [], has_more: false, next_cursor: "  still-here  ", object: "list" }), {
    kind: "invalid",
    reason: "has_more is false but next_cursor carries a non-blank continuation (terminal page contradiction)",
  });
  // An empty-string cursor is absent, the same as a whitespace-only one.
  assert.deepEqual(validateListEnvelope({ data: [], has_more: false, next_cursor: "", object: "list" }), {
    data: [], hasMore: false, kind: "valid", nextCursor: undefined,
  });
});

test("a long opaque cursor with encoded characters round-trips byte-for-byte", () => {
  const cursor = `eyJ2IjoxLCJvZmZzZXQiOjEyMzQ1fQ==/abc+def/ghi?cursor=${"x".repeat(200)}`;
  const result = validateListEnvelope({ data: [], has_more: true, next_cursor: cursor, object: "list" });
  assert.equal(result.kind, "valid");
  if (result.kind === "valid") {
    assert.equal(result.nextCursor, cursor);
  }
});
