import assert from "node:assert/strict";
import test from "node:test";
import { PDPP_PREVIEW_MAX_CHARS, safeTextPreview } from "./safe-text-preview.ts";

function assertTextPreview(preview: string | null): string {
  if (typeof preview !== "string") {
    assert.fail("expected preview to be a string");
  }
  return preview;
}

function assertReasonIncludes(reason: string | null, expected: string): void {
  if (typeof reason !== "string") {
    assert.fail("expected reason to be a string");
  }
  assert.ok(reason.includes(expected));
}

test("empty string → empty, preview null", () => {
  const result = safeTextPreview("");
  assert.equal(result.kind, "empty");
  assert.equal(result.preview, null);
  assert.equal(result.truncated, false);
  assert.equal(result.originalLength, 0);
});

test("null → empty, preview null", () => {
  const result = safeTextPreview(null);
  assert.equal(result.kind, "empty");
  assert.equal(result.preview, null);
});

test("undefined → empty, preview null", () => {
  const result = safeTextPreview(undefined);
  assert.equal(result.kind, "empty");
  assert.equal(result.preview, null);
});

test("number 42 → empty, preview null", () => {
  const result = safeTextPreview(42);
  assert.equal(result.kind, "empty");
  assert.equal(result.preview, null);
});

test("empty object {} → empty, preview null", () => {
  const result = safeTextPreview({});
  assert.equal(result.kind, "empty");
  assert.equal(result.preview, null);
});

test("simple ASCII string 'hello' → text, no truncation", () => {
  const result = safeTextPreview("hello");
  assert.equal(result.kind, "text");
  assert.equal(result.preview, "hello");
  assert.equal(result.truncated, false);
  assert.equal(result.originalLength, 5);
});

test("5000 x's → text, truncated with ellipsis", () => {
  const input = "x".repeat(5000);
  const result = safeTextPreview(input);
  assert.equal(result.kind, "text");
  assert.equal(result.truncated, true);
  assert.equal(result.originalLength, 5000);
  // Should be 4000 x's + U+2026
  const preview = assertTextPreview(result.preview);
  assert.equal(preview.length, 4001);
  assert(preview.endsWith("…"));
  assert.equal(preview.slice(0, 4000), "x".repeat(4000));
});

test("string with U+0000 (NUL) → binary", () => {
  const input = "hello\x00world";
  const result = safeTextPreview(input);
  assert.equal(result.kind, "binary");
  assert.equal(result.preview, null);
  assertReasonIncludes(result.reason, "U+0000");
  assertReasonIncludes(result.reason, "offset 5");
  assert.equal(result.originalLength, 11);
});

test("string with allowed whitespace (tab, newline, carriage return) → text", () => {
  const input = "hello\tworld\nline2\rok";
  const result = safeTextPreview(input);
  assert.equal(result.kind, "text");
  assert.equal(result.preview, input);
  assert.equal(result.truncated, false);
});

test("string with forbidden C0 control (U+000B vertical tab) → binary", () => {
  const input = "before\x0bafter"; // U+000B
  const result = safeTextPreview(input);
  assert.equal(result.kind, "binary");
  assert.equal(result.preview, null);
  assertReasonIncludes(result.reason, "U+000B");
});

test("string with forbidden C0 control (U+000C form feed) → binary", () => {
  const input = "before\x0cafter"; // U+000C
  const result = safeTextPreview(input);
  assert.equal(result.kind, "binary");
  assert.equal(result.preview, null);
  assertReasonIncludes(result.reason, "U+000C");
});

test("string with forbidden C0 control (U+001E record separator) → binary", () => {
  const input = "before\x1eafter"; // U+001E
  const result = safeTextPreview(input);
  assert.equal(result.kind, "binary");
  assert.equal(result.preview, null);
  assertReasonIncludes(result.reason, "U+001E");
});

test("string with DEL (U+007F) → binary", () => {
  const input = "before\x7fafter"; // U+007F
  const result = safeTextPreview(input);
  assert.equal(result.kind, "binary");
  assert.equal(result.preview, null);
  assertReasonIncludes(result.reason, "U+007F");
});

test("string with C1 control (U+0080) → binary", () => {
  const input = "before\x80after"; // U+0080
  const result = safeTextPreview(input);
  assert.equal(result.kind, "binary");
  assert.equal(result.preview, null);
  assertReasonIncludes(result.reason, "U+0080");
});

test("string with C1 control (U+009F) → binary", () => {
  const input = "before\x9fafter"; // U+009F
  const result = safeTextPreview(input);
  assert.equal(result.kind, "binary");
  assert.equal(result.preview, null);
  assertReasonIncludes(result.reason, "U+009F");
});

test("Buffer with valid UTF-8 → text", () => {
  const buf = Buffer.from("hello world", "utf-8");
  const result = safeTextPreview(buf);
  assert.equal(result.kind, "text");
  assert.equal(result.preview, "hello world");
  assert.equal(result.truncated, false);
  assert.equal(result.originalLength, 11);
});

test("Buffer with invalid UTF-8 (0xFF 0xFF) → binary", () => {
  const buf = Buffer.from([0xff, 0xff]);
  const result = safeTextPreview(buf);
  assert.equal(result.kind, "binary");
  assert.equal(result.preview, null);
  assertReasonIncludes(result.reason, "UTF-8");
  assert.equal(result.originalLength, 2);
});

test("Buffer containing NUL byte → binary", () => {
  const buf = Buffer.from([0x68, 0x69, 0x00, 0x79]); // "hi\x00y"
  const result = safeTextPreview(buf);
  assert.equal(result.kind, "binary");
  assert.equal(result.preview, null);
  assertReasonIncludes(result.reason, "U+0000");
});

test("valid 4-byte UTF-8 emoji (U+10000) → text", () => {
  const input = "high𐀀surrogate-pair"; // U+10000 in the middle
  const result = safeTextPreview(input);
  assert.equal(result.kind, "text");
  assert.equal(result.preview, input);
  assert.equal(result.truncated, false);
});

test("lone high surrogate (U+D800) → text (not a control character)", () => {
  // Lone surrogates are technically Unicode invalid, but not control characters.
  // They're not forbidden by Postgres JSONB. This module filters control chars,
  // not Unicode validity.
  const input = "lone\ud800surrogate"; // U+D800 is an unpaired high surrogate
  const result = safeTextPreview(input);
  assert.equal(result.kind, "text");
  assert.equal(result.preview, input);
});

test("lone low surrogate (U+DC00) → text (not a control character)", () => {
  // Similar to high surrogate: technically invalid Unicode, but not a control char.
  const input = "lone\udc00surrogate"; // U+DC00 is an unpaired low surrogate
  const result = safeTextPreview(input);
  assert.equal(result.kind, "text");
  assert.equal(result.preview, input);
});

test("maxChars=0 with input 'ab' → text, preview is just ellipsis", () => {
  const result = safeTextPreview("ab", 0);
  assert.equal(result.kind, "text");
  assert.equal(result.preview, "…");
  assert.equal(result.truncated, true);
});

test("maxChars=3 with input 'ab' (shorter than max) → text, no truncation", () => {
  const result = safeTextPreview("ab", 3);
  assert.equal(result.kind, "text");
  assert.equal(result.preview, "ab");
  assert.equal(result.truncated, false);
});

test("maxChars=3 with input 'abcd' (longer than max) → text, truncated to 3 + ellipsis", () => {
  const result = safeTextPreview("abcd", 3);
  assert.equal(result.kind, "text");
  assert.equal(result.preview, "abc…");
  assert.equal(result.truncated, true);
});

test("truncation does not split a surrogate pair", () => {
  // Create a string where truncation would naturally fall in the middle of a surrogate pair.
  // 3999 x's + 😀 (U+1F600, which is a 2-code-unit surrogate pair) + "yy"
  // At maxChars=4000, we'd naturally truncate after the high surrogate of 😀.
  // We should back off by 1, leaving just the x's.
  const input = `${"x".repeat(3999)}😀yy`;
  const result = safeTextPreview(input, 4000);
  assert.equal(result.kind, "text");
  assert.equal(result.truncated, true);
  // After truncating at 4000, we'd cut the high surrogate of the emoji.
  // So we back off by 1, giving us 3999 x's + ellipsis.
  assert.equal(result.preview, `${"x".repeat(3999)}…`);
});

test("custom maxChars parameter is respected", () => {
  const result = safeTextPreview("a".repeat(100), 50);
  assert.equal(result.kind, "text");
  assert.equal(result.truncated, true);
  // Should be 50 a's + ellipsis
  const preview = assertTextPreview(result.preview);
  assert.equal(preview.length, 51);
  assert.equal(preview.slice(0, 50), "a".repeat(50));
  assert(preview.endsWith("…"));
});

test("PDPP_PREVIEW_MAX_CHARS is a reasonable default", () => {
  assert.equal(PDPP_PREVIEW_MAX_CHARS, 4000);
});

test("Uint8Array with valid UTF-8 → text", () => {
  const arr = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"
  const result = safeTextPreview(arr);
  assert.equal(result.kind, "text");
  assert.equal(result.preview, "hello");
  assert.equal(result.originalLength, 5);
});

test("Uint8Array with invalid UTF-8 → binary", () => {
  const arr = new Uint8Array([0xff, 0xfe]);
  const result = safeTextPreview(arr);
  assert.equal(result.kind, "binary");
  assert.equal(result.preview, null);
  assertReasonIncludes(result.reason, "UTF-8");
});

test("very long UTF-8 multibyte sequence → text, respects maxChars", () => {
  // Build a string of emoji (3-byte UTF-8 each when encoded).
  const emoji = "😀"; // 1 character, 4 bytes in UTF-8
  const input = emoji.repeat(1000);
  const result = safeTextPreview(input, 100);
  assert.equal(result.kind, "text");
  assert.equal(result.truncated, true);
  // 100 emoji + ellipsis = 101 characters
  const preview = assertTextPreview(result.preview);
  assert.equal(preview.length, 101);
  assert(preview.endsWith("…"));
});

test("mixed ASCII and multibyte UTF-8 → text", () => {
  const input = "Hello 🌍 World";
  const result = safeTextPreview(input);
  assert.equal(result.kind, "text");
  assert.equal(result.preview, input);
  assert.equal(result.truncated, false);
});

test("string ending with high surrogate that needs truncation → backs off correctly", () => {
  // Create exactly maxChars characters where the last one is a high surrogate.
  // We use a 2-code-unit character at position maxChars-1.
  const maxChars = 10;
  const input = `${"a".repeat(9)}😀`; // 9 + 2 = 11 code units total
  const result = safeTextPreview(input, maxChars);
  assert.equal(result.kind, "text");
  assert.equal(result.truncated, true);
  // We should back off from the surrogate pair and get 9 a's + ellipsis
  assert.equal(result.preview, `${"a".repeat(9)}…`);
});

test("ELF magic bytes (binary) → binary", () => {
  const buf = Buffer.from([0x7f, 0x45, 0x4c, 0x46]); // ELF header
  const result = safeTextPreview(buf);
  assert.equal(result.kind, "binary");
  assert.equal(result.preview, null);
  // 0x7F is DEL (U+007F), which is forbidden
  assertReasonIncludes(result.reason, "U+007F");
});

test("JPEG magic bytes (binary) → binary", () => {
  const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG header
  const result = safeTextPreview(buf);
  assert.equal(result.kind, "binary");
  assert.equal(result.preview, null);
  assertReasonIncludes(result.reason, "UTF-8");
});

test("truncation appends exactly one U+2026 character", () => {
  const input = "a".repeat(5000);
  const result = safeTextPreview(input);
  assert.equal(result.kind, "text");
  // The last character should be U+2026
  const preview = assertTextPreview(result.preview);
  assert.equal(preview.charCodeAt(preview.length - 1), 0x20_26);
});

test("reason field is null for 'text' kind", () => {
  const result = safeTextPreview("hello");
  assert.equal(result.kind, "text");
  assert.equal(result.reason, null);
});

test("reason field is null for 'empty' kind", () => {
  const result = safeTextPreview(null);
  assert.equal(result.kind, "empty");
  assert.equal(result.reason, null);
});

test("originalLength is zero for null/undefined", () => {
  const result1 = safeTextPreview(null);
  assert.equal(result1.originalLength, 0);

  const result2 = safeTextPreview(undefined);
  assert.equal(result2.originalLength, 0);
});

test("array input → empty", () => {
  const result = safeTextPreview([1, 2, 3]);
  assert.equal(result.kind, "empty");
  assert.equal(result.preview, null);
});

test("string 'false' (truthy string with falsy content) → text", () => {
  const result = safeTextPreview("false");
  assert.equal(result.kind, "text");
  assert.equal(result.preview, "false");
});

test("string with first forbidden byte at offset 0 → reason includes offset 0", () => {
  const input = "\x00start";
  const result = safeTextPreview(input);
  assert.equal(result.kind, "binary");
  assertReasonIncludes(result.reason, "offset 0");
});

test("string longer than default PDPP_PREVIEW_MAX_CHARS with no custom max", () => {
  const input = "a".repeat(PDPP_PREVIEW_MAX_CHARS + 100);
  const result = safeTextPreview(input); // uses default
  assert.equal(result.kind, "text");
  assert.equal(result.truncated, true);
  assert.equal(assertTextPreview(result.preview).length, PDPP_PREVIEW_MAX_CHARS + 1); // max + ellipsis
});

test("buffer of all null bytes → binary, reason mentions U+0000", () => {
  const buf = Buffer.from([0x00, 0x00, 0x00]);
  const result = safeTextPreview(buf);
  assert.equal(result.kind, "binary");
  assertReasonIncludes(result.reason, "U+0000");
  assert.equal(result.originalLength, 3);
});
