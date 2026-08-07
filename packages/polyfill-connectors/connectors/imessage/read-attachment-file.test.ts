// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Direct unit tests of readAttachmentFileSync — the fd-based, O_NOFOLLOW-gated
 * read primitive in index.ts. Unlike integration.test.ts (which drives the
 * connector through a real subprocess), these tests import the primitive
 * directly and call it with a path that is a symlink AT THE MOMENT OF THE
 * CALL, so the assertion actually exercises O_NOFOLLOW's own rejection —
 * not an earlier realpathSync-based containment check (resolveSafeAttachmentPath
 * is not invoked at all in this file; there is no root/containment concept
 * here, only the fd-open primitive itself).
 *
 * This replaces a prior approach that used a test-only env-var backdoor
 * (IMESSAGE_TEST_SWAP_ATTACHMENT_PATH/TARGET) to make the connector swap a
 * file on disk mid-run — an owner-rejected pattern (a test-only environment
 * variable that mutates a user's filesystem is not an acceptable production
 * seam, even when gated). Exporting and directly testing the real primitive
 * needs no such mechanism: the test simply creates a symlink itself, with
 * ordinary filesystem calls, before ever calling the function under test —
 * no timing, no env backdoor, no source-text regex, no duplicate
 * reimplementation of the read logic.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_MAX_ATTACHMENT_BYTES, readAttachmentFileSync } from "./index.ts";

test("readAttachmentFileSync rejects a final-component symlink (O_NOFOLLOW is the exercised authority)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-imessage-fd-read-"));
  try {
    const outsideBytes = Buffer.from("bytes that must never be read through a followed symlink");
    const outsideTargetPath = join(dir, "outside-target.bin");
    await writeFile(outsideTargetPath, outsideBytes);
    const outsideSha256 = createHash("sha256").update(outsideBytes).digest("hex");

    // The path handed to readAttachmentFileSync IS a symlink at call time —
    // no earlier containment check runs in this test file, so the only
    // thing standing between this call and the outside file's bytes is
    // O_NOFOLLOW on the open() call inside the primitive itself.
    const symlinkPath = join(dir, "attachment-symlink.bin");
    await symlink(outsideTargetPath, symlinkPath);

    const result = readAttachmentFileSync(symlinkPath, DEFAULT_MAX_ATTACHMENT_BYTES);

    assert.equal(result.hydrationStatus, "missing");
    assert.equal(result.bytes, null);
    assert.equal(result.contentSha256, null);
    assert.equal(result.blobRef, null);
    // The outside file's real content/hash never appears anywhere in the
    // result — proving the symlink was never followed, not merely that
    // some generic failure occurred.
    assert.notEqual(result.contentSha256, outsideSha256);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(outsideSha256));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("readAttachmentFileSync hydrates a real regular file (not a symlink) successfully", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-imessage-fd-read-"));
  try {
    const bytes = Buffer.from("a real, ordinary attachment file's content");
    const filePath = join(dir, "real-attachment.bin");
    await writeFile(filePath, bytes);
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");

    const result = readAttachmentFileSync(filePath, DEFAULT_MAX_ATTACHMENT_BYTES);

    assert.equal(result.hydrationStatus, "deferred");
    assert.equal(result.contentSha256, expectedSha256);
    assert.equal(result.sizeBytes, bytes.byteLength);
    assert.ok(result.bytes);
    assert.equal(Buffer.from(result.bytes).equals(bytes), true);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("readAttachmentFileSync hydrates a real file nested several directories deep", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-imessage-fd-read-"));
  try {
    const nestedDir = join(dir, "ab", "cd-ef01-guid");
    await mkdir(nestedDir, { recursive: true });
    const bytes = Buffer.from("nested attachment bytes");
    const filePath = join(nestedDir, "IMG_0002.heic");
    await writeFile(filePath, bytes);
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");

    const result = readAttachmentFileSync(filePath, DEFAULT_MAX_ATTACHMENT_BYTES);

    assert.equal(result.hydrationStatus, "deferred");
    assert.equal(result.contentSha256, expectedSha256);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("readAttachmentFileSync returns missing for a genuinely absent file (no symlink involved)", () => {
  const result = readAttachmentFileSync("/nonexistent/definitely-not-a-real-path.bin", DEFAULT_MAX_ATTACHMENT_BYTES);
  assert.equal(result.hydrationStatus, "missing");
  assert.equal(result.bytes, null);
  assert.equal(result.contentSha256, null);
});

test("readAttachmentFileSync marks an oversized real file too_large without reading its bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-imessage-fd-read-"));
  try {
    const bytes = Buffer.alloc(2048, 9);
    const filePath = join(dir, "big.bin");
    await writeFile(filePath, bytes);

    const result = readAttachmentFileSync(filePath, 1024);

    assert.equal(result.hydrationStatus, "too_large");
    assert.equal(result.bytes, null);
    assert.equal(result.contentSha256, null);
    assert.equal(result.sizeBytes, 2048);
    assert.match(String(result.hydrationError), /exceeds max size/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
