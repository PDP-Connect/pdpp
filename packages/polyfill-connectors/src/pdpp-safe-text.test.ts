// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * pdppSafeText brand tests.
 *
 * Pins the schema-level invariant: U+0000 and non-whitelisted control
 * characters are rejected by pdppSafeText. Composition with .max() and
 * .nullable() works as expected. The branded type is nominally
 * distinct (verified at compile time + runtime).
 *
 * Design contract: docs/reference/binary-content-invariant-design-brief.md §4.3.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { nullablePdppSafeText, type PdppSafeText, pdppSafeText } from "./pdpp-safe-text.ts";

test("pdppSafeText accepts ordinary printable text", () => {
  const result = pdppSafeText.safeParse("Hello, world!");
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data, "Hello, world!");
  }
});

test("pdppSafeText accepts text with tab, newline, carriage return", () => {
  const result = pdppSafeText.safeParse("line1\nline2\tcol\rdone");
  assert.equal(result.success, true);
});

test("pdppSafeText accepts emoji and combining marks", () => {
  const result = pdppSafeText.safeParse("👋 café naïve 🇺🇸");
  assert.equal(result.success, true);
});

test("pdppSafeText accepts empty string", () => {
  const result = pdppSafeText.safeParse("");
  assert.equal(result.success, true);
});

test("pdppSafeText rejects U+0000", () => {
  const result = pdppSafeText.safeParse("hello\u0000world");
  assert.equal(result.success, false);
  if (!result.success) {
    const issue = result.error.issues[0];
    assert.ok(issue);
    assert.match(issue.message, /PDPP-safe Unicode text/);
  }
});

test("pdppSafeText rejects C0 controls (U+0001-U+0008)", () => {
  for (let code = 0x01; code <= 0x08; code++) {
    const char = String.fromCharCode(code);
    const result = pdppSafeText.safeParse(`prefix${char}suffix`);
    assert.equal(result.success, false, `U+${code.toString(16).padStart(4, "0")} should be rejected`);
  }
});

test("pdppSafeText rejects U+000B (vertical tab) and U+000C (form feed)", () => {
  assert.equal(pdppSafeText.safeParse("ab").success, false);
  assert.equal(pdppSafeText.safeParse("ab").success, false);
});

test("pdppSafeText rejects C0 controls U+000E-U+001F", () => {
  for (let code = 0x0e; code <= 0x1f; code++) {
    const char = String.fromCharCode(code);
    const result = pdppSafeText.safeParse(`prefix${char}suffix`);
    assert.equal(result.success, false, `U+${code.toString(16).padStart(4, "0")} should be rejected`);
  }
});

test("pdppSafeText rejects DEL (U+007F)", () => {
  const result = pdppSafeText.safeParse("ab");
  assert.equal(result.success, false);
});

test("pdppSafeText rejects C1 controls (U+0080-U+009F)", () => {
  for (const code of [0x80, 0x90, 0x9f]) {
    const char = String.fromCharCode(code);
    const result = pdppSafeText.safeParse(`a${char}b`);
    assert.equal(result.success, false, `U+${code.toString(16).padStart(4, "0")} should be rejected`);
  }
});

test("nullablePdppSafeText accepts null", () => {
  const result = nullablePdppSafeText.safeParse(null);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data, null);
  }
});

test("nullablePdppSafeText accepts safe text", () => {
  const result = nullablePdppSafeText.safeParse("hello");
  assert.equal(result.success, true);
});

test("nullablePdppSafeText rejects U+0000", () => {
  const result = nullablePdppSafeText.safeParse("bad\u0000content");
  assert.equal(result.success, false);
});

test("pdppSafeText composes with .max()", () => {
  const bounded = pdppSafeText.max(5);
  assert.equal(bounded.safeParse("hi").success, true);
  assert.equal(bounded.safeParse("toolong").success, false);
});

test("pdppSafeText composes with .nullable() and .max() in any order", () => {
  const a = pdppSafeText.max(10).nullable();
  const b = pdppSafeText.nullable();
  assert.equal(a.safeParse("ok").success, true);
  assert.equal(a.safeParse(null).success, true);
  assert.equal(b.safeParse(null).success, true);
  assert.equal(a.safeParse("hello\u0000").success, false);
});

test("brand: type assignment at compile time enforces the brand (smoke test at runtime)", () => {
  // The compile-time check is the value here; at runtime we verify the
  // parsed result is a string with the brand marker invisible to JS.
  const parsed = pdppSafeText.parse("branded");
  const fn = (s: PdppSafeText): string => s;
  assert.equal(fn(parsed), "branded");
  // Plain strings would fail TS compile if passed to `fn(...)`; we
  // can't assert that at runtime, but the explicit parse here is the
  // gate.
});

test("brand: the schema rejects non-string inputs (Zod baseline)", () => {
  // sanity — confirms we still get z.string()'s base behavior.
  assert.equal(pdppSafeText.safeParse(42).success, false);
  assert.equal(pdppSafeText.safeParse(null).success, false);
  assert.equal(pdppSafeText.safeParse(undefined).success, false);
  assert.equal(pdppSafeText.safeParse(Buffer.from("ok")).success, false);
});

test("error message references blobs table for caller remediation", () => {
  const result = pdppSafeText.safeParse("bad\u0000");
  assert.equal(result.success, false);
  if (!result.success) {
    const issue = result.error.issues[0];
    assert.ok(issue);
    assert.match(issue.message, /blobs table/);
  }
});

test("pdppSafeText accepts a fairly long safe string", () => {
  const long = "x".repeat(100_000);
  const result = pdppSafeText.safeParse(long);
  assert.equal(result.success, true);
});
