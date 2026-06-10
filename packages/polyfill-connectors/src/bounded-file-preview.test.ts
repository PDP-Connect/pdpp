import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { BOUNDED_PREVIEW_MAX_BYTES, readBoundedFilePreview } from "./bounded-file-preview.ts";
import { safeTextPreview } from "./safe-text-preview.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pdpp-bounded-preview-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeBytes(name: string, data: Buffer | string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}

test("missing file → null (caller decides fatality)", async () => {
  const got = await readBoundedFilePreview(join(dir, "does-not-exist.txt"));
  assert.equal(got, null);
});

test("small file → full content, not truncated", async () => {
  const path = await writeBytes("small.txt", "hello world");
  const got = await readBoundedFilePreview(path);
  assert.ok(got);
  assert.equal(got.truncated, false);
  assert.equal(got.buffer.toString("utf8"), "hello world");
  assert.equal(got.bytesRead, Buffer.byteLength("hello world"));
});

test("empty file → empty buffer, not truncated", async () => {
  const path = await writeBytes("empty.txt", "");
  const got = await readBoundedFilePreview(path);
  assert.ok(got);
  assert.equal(got.truncated, false);
  assert.equal(got.bytesRead, 0);
});

test("file exactly maxBytes → not flagged truncated", async () => {
  const max = 1024;
  const path = await writeBytes("exact.txt", "a".repeat(max));
  const got = await readBoundedFilePreview(path, max);
  assert.ok(got);
  assert.equal(got.bytesRead, max);
  assert.equal(got.truncated, false);
});

test("file larger than maxBytes → bounded buffer + truncated flag", async () => {
  const max = 4096;
  // 8 MiB file; reading the whole thing would dwarf the 4 KiB budget.
  const path = await writeBytes("big.txt", "x".repeat(8 * 1024 * 1024));
  const got = await readBoundedFilePreview(path, max);
  assert.ok(got);
  assert.equal(got.truncated, true);
  assert.equal(got.bytesRead, max, "must retain at most maxBytes regardless of file size");
});

test("preview derived from prefix matches whole-file preview for the leading window", async () => {
  // The fix replaced a whole-file read feeding safeTextPreview. For any file
  // whose preview window fits inside the byte budget, the bounded path must
  // produce the identical preview string.
  const body = `${"line one\n".repeat(50)}TAIL-MARKER`;
  const path = await writeBytes("preview.txt", body);
  const bounded = await readBoundedFilePreview(path);
  assert.ok(bounded);
  const fromPrefix = safeTextPreview(bounded.buffer, 500);
  const fromWhole = safeTextPreview(body, 500);
  assert.equal(fromPrefix.preview, fromWhole.preview);
  assert.equal(fromPrefix.kind, "text");
});

test("UTF-8 multibyte sequence cut at the byte boundary is not misclassified as binary", async () => {
  // "😀" is a 4-byte code point (F0 9F 98 80). Fill with single-byte ASCII so
  // the budget lands mid-emoji, then assert the trimmed prefix still decodes as
  // clean text rather than tripping the fatal UTF-8 decode in safeTextPreview.
  const emoji = "😀";
  const emojiBytes = Buffer.byteLength(emoji); // 4
  // Choose maxBytes so the cut falls inside the trailing emoji.
  const prefixAscii = "z".repeat(10);
  const body = `${prefixAscii}${emoji}`; // 10 + 4 bytes
  const path = await writeBytes("emoji.txt", body);
  // Cut one byte into the emoji (10 ASCII + 1 of 4 emoji bytes).
  const got = await readBoundedFilePreview(path, prefixAscii.length + 1);
  assert.ok(got);
  // The incomplete trailing emoji byte must be trimmed away.
  assert.equal(got.bytesRead, prefixAscii.length, "incomplete trailing code point trimmed");
  const preview = safeTextPreview(got.buffer, 500);
  assert.equal(preview.kind, "text", "trimmed prefix must decode as text, not binary");
  assert.equal(preview.preview, prefixAscii);
  // Sanity: the untrimmed raw prefix WOULD have been classified binary.
  const rawPrefix = Buffer.from(body, "utf8").subarray(0, prefixAscii.length + 1);
  assert.equal(safeTextPreview(rawPrefix, 500).kind, "binary");
  assert.ok(emojiBytes === 4);
});

test("complete multibyte sequence at the exact boundary is retained", async () => {
  const body = "ok-😀"; // ends on a complete 4-byte code point
  const totalBytes = Buffer.byteLength(body);
  const path = await writeBytes("complete.txt", body);
  const got = await readBoundedFilePreview(path, totalBytes);
  assert.ok(got);
  assert.equal(got.bytesRead, totalBytes, "complete trailing code point not trimmed");
  assert.equal(got.buffer.toString("utf8"), body);
});

test("binary content within the prefix is still detected as binary", async () => {
  // A NUL byte in the leading window must still surface via safeTextPreview.
  const path = await writeBytes("binary.txt", Buffer.from([0x61, 0x62, 0x00, 0x63]));
  const got = await readBoundedFilePreview(path);
  assert.ok(got);
  const preview = safeTextPreview(got.buffer, 500);
  assert.equal(preview.kind, "binary");
});

test("maxBytes <= 0 short-circuits to empty without reading", async () => {
  const path = await writeBytes("any.txt", "content");
  const got = await readBoundedFilePreview(path, 0);
  assert.ok(got);
  assert.equal(got.bytesRead, 0);
  assert.equal(got.truncated, false);
});

test("default budget constant is a small bounded value", () => {
  assert.equal(BOUNDED_PREVIEW_MAX_BYTES, 64 * 1024);
});
