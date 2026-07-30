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
