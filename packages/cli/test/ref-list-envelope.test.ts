// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Direct unit tests for the CLI's vendored `validateListEnvelope`
 * (`src/ref/list-envelope.ts`) — this is intentionally a byte-for-byte
 * duplicate of `packages/list-envelope/src/index.ts` (see that file's
 * header for why `@pdpp/cli`, a publicly published package, cannot import
 * the shared private workspace package). These tests mirror
 * `packages/list-envelope/src/index.test.ts` exactly so a drift between the
 * two copies would be caught here too.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { validateListEnvelope } from "../src/ref/list-envelope.ts";

test("valid terminal page (has_more: false, no cursor)", () => {
  const result = validateListEnvelope({ data: [1, 2, 3], has_more: false, object: "list" });
  assert.deepEqual(result, { data: [1, 2, 3], hasMore: false, kind: "valid", nextCursor: undefined });
});

test("valid continuing page (has_more: true, usable cursor)", () => {
  const result = validateListEnvelope({ data: [], has_more: true, next_cursor: "abc123", object: "list" });
  assert.equal(result.kind, "valid");
});

test("ADVERSARIAL: wrong discriminator (object !== 'list') is rejected", () => {
  const result = validateListEnvelope({ data: [], has_more: false, object: "not-a-list" });
  assert.equal(result.kind, "invalid");
});

test("ADVERSARIAL: non-array data is rejected even when object is correct", () => {
  const result = validateListEnvelope({ data: { bad: true }, has_more: false, object: "list" });
  assert.equal(result.kind, "invalid");
});

test("ADVERSARIAL: non-boolean has_more is rejected, never coerced", () => {
  const result = validateListEnvelope({ data: [], has_more: "true", object: "list" });
  assert.equal(result.kind, "invalid");
});

test("ADVERSARIAL: has_more true with missing next_cursor is rejected", () => {
  const result = validateListEnvelope({ data: [], has_more: true, object: "list" });
  assert.equal(result.kind, "invalid");
});

test("ADVERSARIAL: has_more true with a blank (whitespace-only) next_cursor is rejected — the CLI must never issue ?cursor=+", () => {
  const result = validateListEnvelope({ data: [], has_more: true, next_cursor: " ", object: "list" });
  assert.equal(result.kind, "invalid");
});

test("ADVERSARIAL: has_more false with a non-blank next_cursor present is rejected (terminal-page contradiction)", () => {
  const result = validateListEnvelope({ data: [], has_more: false, next_cursor: "still-here", object: "list" });
  assert.equal(result.kind, "invalid");
});

test("a next_cursor with surrounding whitespace is validated as usable but returned UNTRIMMED", () => {
  const result = validateListEnvelope({ data: [], has_more: true, next_cursor: "  raw  ", object: "list" });
  assert.equal(result.kind, "valid");
  if (result.kind === "valid") {
    assert.equal(result.nextCursor, "  raw  ");
  }
});
