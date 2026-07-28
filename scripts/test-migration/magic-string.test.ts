// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { createMagicString } from "./magic-string.ts";

const OVERLAPPING_EDITS_PATTERN = /overlapping edits/;
const INVALID_RANGE_PATTERN = /invalid range/;

test("overwrite + toString applies a single edit", () => {
  const ms = createMagicString("hello world");
  ms.overwrite(6, 11, "there");
  assert.equal(ms.toString(), "hello there");
});

test("multiple non-overlapping edits apply correctly regardless of insertion order", () => {
  const ms = createMagicString("aaa bbb ccc");
  ms.overwrite(8, 11, "CCC");
  ms.overwrite(0, 3, "AAA");
  assert.equal(ms.toString(), "AAA bbb CCC");
});

test("edits at original-string offsets remain valid even when a REPLACEMENT changes length", () => {
  // The whole point of splice-by-offset: the second edit's [start,end) is
  // still expressed in ORIGINAL coordinates even though the first edit's
  // replacement text is a different length than what it replaced.
  const ms = createMagicString("[A][B]");
  ms.overwrite(1, 2, "REPLACED_A");
  ms.overwrite(4, 5, "REPLACED_B");
  assert.equal(ms.toString(), "[REPLACED_A][REPLACED_B]");
});

test("overlapping edits throw", () => {
  const ms = createMagicString("abcdef");
  ms.overwrite(0, 3, "X");
  assert.throws(() => ms.overwrite(2, 5, "Y"), OVERLAPPING_EDITS_PATTERN);
});

test("out-of-range edits throw", () => {
  const ms = createMagicString("abc");
  assert.throws(() => ms.overwrite(0, 10, "X"), INVALID_RANGE_PATTERN);
  assert.throws(() => ms.overwrite(-1, 2, "X"), INVALID_RANGE_PATTERN);
  assert.throws(() => ms.overwrite(3, 1, "X"), INVALID_RANGE_PATTERN);
});

test("toString with no edits returns the original string unchanged", () => {
  const ms = createMagicString("unchanged");
  assert.equal(ms.toString(), "unchanged");
});
