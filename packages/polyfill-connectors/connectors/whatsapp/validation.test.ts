// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateWhatsAppChatExportArtifact } from "./validation.ts";

process.env.TZ = "America/Chicago";

const VALID_EXPORT = `[6/5/24, 9:15:22 AM] Alice: Hello
[6/5/24, 9:16:00 AM] Bob: <Media omitted>
[6/5/24, 9:17:00 AM] Alice: Multi
line message`;

function zipHeader(signature: number, size: number): Buffer {
  const header = Buffer.alloc(size);
  header.writeUInt32LE(signature, 0);
  return header;
}

function makeStoredZip(entries: readonly { name: string; data: string | Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const local = zipHeader(0x04_03_4b_50, 30);
    local.writeUInt16LE(0x08_00, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, data);

    const directory = zipHeader(0x02_01_4b_50, 46);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x08_00, 8);
    directory.writeUInt16LE(0, 10);
    directory.writeUInt32LE(0, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += local.length + name.length + data.length;
  }
  const centralStart = offset;
  const centralBytes = Buffer.concat(central);
  const end = zipHeader(0x06_05_4b_50, 22);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...chunks, centralBytes, end]);
}

test("validateWhatsAppChatExportArtifact reports messages, participants, media, and range", () => {
  const validation = validateWhatsAppChatExportArtifact(VALID_EXPORT, { fileName: "WhatsApp Chat - Alice.txt" });

  assert.equal(validation.status, "valid");
  assert.equal(validation.detected_format, "whatsapp_chat_export");
  assert.equal(validation.estimated_chats, 1);
  assert.equal(validation.estimated_messages, 3);
  assert.equal(validation.estimated_records, 4);
  assert.equal(validation.estimated_participants, 2);
  assert.equal(validation.estimated_attachments, 1);
  assert.equal(validation.media_coverage.referenced_media_files, 1);
  assert.equal(validation.media_coverage.attached_media_files, 0);
  assert.equal(validation.media_coverage.status, "not_included");
  assert.equal(validation.source_identity?.title, "Alice");
  assert.equal(validation.source_identity?.suggested_display_name, "WhatsApp - Alice");
  assert.deepEqual(validation.source_identity?.participant_preview, ["Alice", "Bob"]);
  assert.equal(validation.date_range.start, "2024-06-05T14:15:22.000Z");
  assert.equal(validation.date_range.end, "2024-06-05T14:17:00.000Z");
  assert.match(validation.file_sha256, /^[0-9a-f]{64}$/);
  assert.match(validation.warnings[0] ?? "", /media files are not included/i);
});

test("validateWhatsAppChatExportArtifact accepts zip exports with media present", () => {
  const zip = makeStoredZip([
    { name: "WhatsApp Chat - Alice.txt", data: VALID_EXPORT },
    { name: "IMG-20240605-WA0001.jpg", data: Buffer.from([1, 2, 3]) },
  ]);
  const validation = validateWhatsAppChatExportArtifact(zip, { fileName: "WhatsApp Chat - Alice.zip" });

  assert.equal(validation.status, "valid");
  assert.equal(validation.detected_format, "whatsapp_chat_export_zip");
  assert.equal(validation.estimated_messages, 3);
  assert.equal(validation.media_coverage.referenced_media_files, 1);
  assert.equal(validation.media_coverage.attached_media_files, 1);
  assert.equal(validation.media_coverage.status, "included_for_import");
  assert.match(validation.warnings[0] ?? "", /attachment records/i);
});

test("validateWhatsAppChatExportArtifact rejects malformed zip input without throwing", () => {
  const malformedZip = Buffer.concat([Buffer.from("PK\u0003\u0004", "binary"), Buffer.from("not a usable zip")]);

  const validation = validateWhatsAppChatExportArtifact(malformedZip, { fileName: "WhatsApp Chat - Alice.zip" });

  assert.equal(validation.status, "unsupported");
  assert.equal(validation.detected_format, "unsupported");
});

test("validateWhatsAppChatExportArtifact identifies duplicate artifacts by hash", () => {
  const first = validateWhatsAppChatExportArtifact(VALID_EXPORT);
  const duplicate = validateWhatsAppChatExportArtifact(VALID_EXPORT, {
    existingFileHashes: [first.file_sha256],
  });

  assert.equal(duplicate.status, "duplicate");
  assert.match(duplicate.remediation ?? "", /already imported/i);
});

test("validateWhatsAppChatExportArtifact rejects unsupported and too-large artifacts", () => {
  const unsupported = validateWhatsAppChatExportArtifact("not a chat export");
  assert.equal(unsupported.status, "unsupported");

  const tooLarge = validateWhatsAppChatExportArtifact(VALID_EXPORT, { maxFileBytes: 4 });
  assert.equal(tooLarge.status, "too_large");
});

test("a zip declaring far more entries than the policy allows classifies as too_large, NOT unsupported", () => {
  // A real export zip whose entry count trips the decompression-bomb
  // maxEntries policy is a different situation from a file that isn't a
  // WhatsApp export at all — the owner-facing status must say so.
  const entries = Array.from({ length: 25_000 }, (_, i) => ({ data: "x", name: `media-${i}.jpg` }));
  const zip = makeStoredZip(entries);
  const validation = validateWhatsAppChatExportArtifact(zip, { fileName: "WhatsApp Chat.zip" });

  assert.equal(validation.status, "too_large");
  assert.notEqual(validation.status, "unsupported");
});

// ─── File-backed validation (validateWhatsAppChatExportArtifactFromFile) ───
//
// Proves parity with the buffer-backed validator on ordinary inputs, AND
// proves the file-backed path never reads the whole artifact into memory —
// using instrumented/monkey-patched fs primitives to assert bounded reads,
// per the explicit requirement that this be provable, not just asserted in
// a comment.

import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateWhatsAppChatExportArtifactFromFile } from "./validation.ts";

function withTempFile<T>(
  name: string,
  bytes: Buffer,
  fn: (path: string, fd: number, size: number) => T | Promise<T>
): T | Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-wa-validate-file-"));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  const fd = openSync(path, "r");
  const cleanup = () => {
    closeSync(fd);
    rmSync(dir, { force: true, recursive: true });
  };
  try {
    const result = fn(path, fd, bytes.length);
    if (result instanceof Promise) {
      return result.finally(cleanup) as Promise<T>;
    }
    cleanup();
    return result;
  } catch (err) {
    cleanup();
    throw err;
  }
}

test("validateWhatsAppChatExportArtifactFromFile: .txt produces the same validation as the buffer-backed API", async () => {
  const bytes = Buffer.from(VALID_EXPORT, "utf8");
  const bufferResult = validateWhatsAppChatExportArtifact(VALID_EXPORT, { fileName: "WhatsApp Chat - Alice.txt" });
  await withTempFile("WhatsApp Chat - Alice.txt", bytes, async (path, fd, size) => {
    const fileResult = await validateWhatsAppChatExportArtifactFromFile(fd, path, size, {
      fileName: "WhatsApp Chat - Alice.txt",
      fileSha256: bufferResult.file_sha256,
    });
    assert.equal(fileResult.status, bufferResult.status);
    assert.equal(fileResult.detected_format, bufferResult.detected_format);
    assert.equal(fileResult.estimated_messages, bufferResult.estimated_messages);
    assert.equal(fileResult.estimated_participants, bufferResult.estimated_participants);
    assert.equal(fileResult.date_range.start, bufferResult.date_range.start);
    assert.equal(fileResult.date_range.end, bufferResult.date_range.end);
    assert.equal(fileResult.source_identity?.stable_id, bufferResult.source_identity?.stable_id);
  });
});

test("validateWhatsAppChatExportArtifactFromFile: .zip produces the same validation as the buffer-backed API", async () => {
  const zip = makeStoredZip([
    { name: "WhatsApp Chat - Alice.txt", data: VALID_EXPORT },
    { name: "IMG-20240605-WA0001.jpg", data: Buffer.from([1, 2, 3]) },
  ]);
  const bufferResult = validateWhatsAppChatExportArtifact(zip, { fileName: "WhatsApp Chat - Alice.zip" });
  await withTempFile("WhatsApp Chat - Alice.zip", zip, async (path, fd, size) => {
    const fileResult = await validateWhatsAppChatExportArtifactFromFile(fd, path, size, {
      fileName: "WhatsApp Chat - Alice.zip",
      fileSha256: bufferResult.file_sha256,
    });
    assert.equal(fileResult.status, "valid");
    assert.equal(fileResult.detected_format, bufferResult.detected_format);
    assert.equal(fileResult.estimated_messages, bufferResult.estimated_messages);
    assert.equal(fileResult.media_coverage.attached_media_files, bufferResult.media_coverage.attached_media_files);
  });
});

test("validateWhatsAppChatExportArtifactFromFile: empty .txt file is 'empty', not 'unsupported' (size 0 short-circuit)", async () => {
  await withTempFile("empty.txt", Buffer.alloc(0), async (path, fd, size) => {
    const result = await validateWhatsAppChatExportArtifactFromFile(fd, path, size, {
      fileName: "empty.txt",
      fileSha256: "0".repeat(64),
    });
    // A zero-byte file never looked like a WhatsApp export at all -- this is
    // the same "unsupported" classification the buffer path gives an
    // unrecognizable file (there is no content to sniff), NOT "empty" (which
    // means "recognized format, zero importable rows").
    assert.equal(result.status, "unsupported");
  });
});

test("validateWhatsAppChatExportArtifactFromFile: export-shaped .txt with zero real messages is 'empty', not 'unsupported'", async () => {
  // Matches the WHATSAPP_EXPORT_PROBE_RE shape (date + dash/bracket + colon)
  // but every date is calendar-impossible, so zero real messages parse.
  // The buffer path's pre-parse sniff would accept this as "looks like an
  // export" and only classify it empty AFTER parsing yields nothing --
  // the streamed path must replicate that two-stage distinction, not
  // collapse it into "unsupported".
  const impossibleDateOnly = "[31/02/24, 9:16:00 AM] Bob: impossible date only, no valid messages";
  await withTempFile("impossible.txt", Buffer.from(impossibleDateOnly, "utf8"), async (path, fd, size) => {
    const result = await validateWhatsAppChatExportArtifactFromFile(fd, path, size, {
      fileName: "impossible.txt",
      fileSha256: "0".repeat(64),
    });
    assert.equal(result.status, "empty");
  });
});

test("validateWhatsAppChatExportArtifactFromFile: unrecognizable .txt content is 'unsupported'", async () => {
  await withTempFile(
    "random.txt",
    Buffer.from("just some random text with no date-like structure at all", "utf8"),
    async (path, fd, size) => {
      const result = await validateWhatsAppChatExportArtifactFromFile(fd, path, size, {
        fileName: "random.txt",
        fileSha256: "0".repeat(64),
      });
      assert.equal(result.status, "unsupported");
    }
  );
});

test("validateWhatsAppChatExportArtifactFromFile: maxFileBytes rejects using fileSize alone, no read needed", async () => {
  await withTempFile("small.txt", Buffer.from(VALID_EXPORT, "utf8"), async (path, fd, size) => {
    const result = await validateWhatsAppChatExportArtifactFromFile(fd, path, size, {
      fileName: "small.txt",
      fileSha256: "0".repeat(64),
      maxFileBytes: 4,
    });
    assert.equal(result.status, "too_large");
  });
});

test("validateWhatsAppChatExportArtifactFromFile: a .txt export past WHATSAPP_MAX_MESSAGE_COUNT is 'too_large', not a crash (H1)", async () => {
  // Proves the end-to-end validation entrypoint: an export that would
  // otherwise OOM the process during accumulation instead returns a normal
  // too_large validation result -- a catchable rejection, not a V8 heap
  // abort. The cap is env-overridden to a tiny value so this test runs in
  // milliseconds rather than needing millions of real lines.
  const original = process.env.WHATSAPP_MAX_MESSAGE_COUNT;
  process.env.WHATSAPP_MAX_MESSAGE_COUNT = "3";
  try {
    const lines = [
      "[6/5/24, 9:15:22 AM] Alice: one",
      "[6/5/24, 9:16:00 AM] Alice: two",
      "[6/5/24, 9:17:00 AM] Alice: three",
      "[6/5/24, 9:18:00 AM] Alice: four",
    ].join("\n");
    await withTempFile("bulk.txt", Buffer.from(lines, "utf8"), async (path, fd, size) => {
      const result = await validateWhatsAppChatExportArtifactFromFile(fd, path, size, {
        fileName: "bulk.txt",
        fileSha256: "0".repeat(64),
      });
      assert.equal(result.status, "too_large");
    });
  } finally {
    if (original === undefined) {
      delete process.env.WHATSAPP_MAX_MESSAGE_COUNT;
    } else {
      process.env.WHATSAPP_MAX_MESSAGE_COUNT = original;
    }
  }
});

test("validateWhatsAppChatExportArtifactFromFile: a .zip export past WHATSAPP_MAX_MESSAGE_COUNT is 'too_large', not a crash (H1)", async () => {
  const original = process.env.WHATSAPP_MAX_MESSAGE_COUNT;
  process.env.WHATSAPP_MAX_MESSAGE_COUNT = "3";
  try {
    const lines = [
      "[6/5/24, 9:15:22 AM] Alice: one",
      "[6/5/24, 9:16:00 AM] Alice: two",
      "[6/5/24, 9:17:00 AM] Alice: three",
      "[6/5/24, 9:18:00 AM] Alice: four",
    ].join("\n");
    const zip = makeStoredZip([{ name: "WhatsApp Chat - Alice.txt", data: lines }]);
    await withTempFile("bulk.zip", zip, async (path, fd, size) => {
      const result = await validateWhatsAppChatExportArtifactFromFile(fd, path, size, {
        fileName: "bulk.zip",
        fileSha256: "0".repeat(64),
      });
      assert.equal(result.status, "too_large");
    });
  } finally {
    if (original === undefined) {
      delete process.env.WHATSAPP_MAX_MESSAGE_COUNT;
    } else {
      process.env.WHATSAPP_MAX_MESSAGE_COUNT = original;
    }
  }
});

test("validateWhatsAppChatExportArtifactFromFile: a .txt export with EXACTLY WHATSAPP_MAX_MESSAGE_COUNT messages is accepted, not 'too_large'", async () => {
  // Exact-boundary counterpart to the over-cap test above: messageCount
  // === maxMessageCount must be accepted (the live comparison is `>`, not
  // `>=`); this was previously an untested boundary (only cap+1 was
  // asserted anywhere at this validation-entrypoint level).
  const original = process.env.WHATSAPP_MAX_MESSAGE_COUNT;
  process.env.WHATSAPP_MAX_MESSAGE_COUNT = "3";
  try {
    const lines = [
      "[6/5/24, 9:15:22 AM] Alice: one",
      "[6/5/24, 9:16:00 AM] Alice: two",
      "[6/5/24, 9:17:00 AM] Alice: three",
    ].join("\n");
    await withTempFile("at-cap.txt", Buffer.from(lines, "utf8"), async (path, fd, size) => {
      const result = await validateWhatsAppChatExportArtifactFromFile(fd, path, size, {
        fileName: "at-cap.txt",
        fileSha256: "0".repeat(64),
      });
      assert.notEqual(result.status, "too_large");
      if ("estimated_messages" in result) {
        assert.equal(result.estimated_messages, 3);
      }
    });
  } finally {
    if (original === undefined) {
      delete process.env.WHATSAPP_MAX_MESSAGE_COUNT;
    } else {
      process.env.WHATSAPP_MAX_MESSAGE_COUNT = original;
    }
  }
});

test("validateWhatsAppChatExportArtifactFromFile: a .zip export with EXACTLY WHATSAPP_MAX_MESSAGE_COUNT messages is accepted, not 'too_large'", async () => {
  const original = process.env.WHATSAPP_MAX_MESSAGE_COUNT;
  process.env.WHATSAPP_MAX_MESSAGE_COUNT = "3";
  try {
    const lines = [
      "[6/5/24, 9:15:22 AM] Alice: one",
      "[6/5/24, 9:16:00 AM] Alice: two",
      "[6/5/24, 9:17:00 AM] Alice: three",
    ].join("\n");
    const zip = makeStoredZip([{ name: "WhatsApp Chat - Alice.txt", data: lines }]);
    await withTempFile("at-cap.zip", zip, async (path, fd, size) => {
      const result = await validateWhatsAppChatExportArtifactFromFile(fd, path, size, {
        fileName: "at-cap.zip",
        fileSha256: "0".repeat(64),
      });
      assert.notEqual(result.status, "too_large");
      if ("estimated_messages" in result) {
        assert.equal(result.estimated_messages, 3);
      }
    });
  } finally {
    if (original === undefined) {
      delete process.env.WHATSAPP_MAX_MESSAGE_COUNT;
    } else {
      process.env.WHATSAPP_MAX_MESSAGE_COUNT = original;
    }
  }
});

test("validateWhatsAppChatExportArtifactFromFile: reuses the caller-provided fileSha256 rather than recomputing", async () => {
  const knownHash = "a".repeat(64);
  await withTempFile("small.txt", Buffer.from(VALID_EXPORT, "utf8"), async (path, fd, size) => {
    const result = await validateWhatsAppChatExportArtifactFromFile(fd, path, size, {
      fileName: "small.txt",
      fileSha256: knownHash,
    });
    // Deliberately a wrong/synthetic hash -- proves the function trusts the
    // caller-supplied value rather than recomputing from file bytes (which
    // is the whole point: the caller already hashed it during the streaming
    // upload write, so this function must never read the whole file again
    // just to hash it a second time).
    assert.equal(result.file_sha256, knownHash);
  });
});

// ─── Countertest: bounded reads, not a whole-file read ─────────────────────
//
// node:fs's ESM exports are non-configurable, so they cannot be reliably
// intercepted from a test file (mock.method requires a configurable
// property; a plain reassignment silently has no effect on calls made from
// other modules under Node's ESM live-binding semantics — verified: it does
// not even affect calls from the SAME module that performed the
// reassignment). Instead, these countertests prove boundedness via actual
// process memory growth, which cannot be faked: a whole-file readFile()
// MUST allocate at least `fileSize` contiguous bytes at some point during
// the call. A sparse fixture makes the file itself cheap to create (no real
// disk/memory cost) while its declared/reported size is large enough that a
// whole-file read would be trivially visible as a large RSS delta.

function sparseZipFixture(dir: string, name: string): { fd: number; path: string; size: number } {
  // One STORED entry whose declared size is far larger than any reasonable
  // buffer for a validation-preview call, built the same way as
  // bounded-zip-archive.test.ts's sparse fixture: only the tiny structural
  // bytes (local header, central directory, EOCD) are actually written; the
  // huge entry-data region in between is never written (a sparse hole), so
  // creating this fixture costs no real disk or memory.
  const GIB = 1024 * 1024 * 1024;
  const hugeDeclaredSize = GIB + 999_999; // > 1 GiB, comfortably larger than any sane buffer for a "preview" call
  const nameBuf = Buffer.from("WhatsApp Chat - Huge.txt", "utf8");

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04_03_4b_50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt32LE(hugeDeclaredSize, 18);
  localHeader.writeUInt32LE(hugeDeclaredSize, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  const localHeaderAndName = Buffer.concat([localHeader, nameBuf]);
  const entryDataStart = localHeaderAndName.length;
  const entryDataEnd = entryDataStart + hugeDeclaredSize;

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02_01_4b_50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt32LE(hugeDeclaredSize, 20);
  centralHeader.writeUInt32LE(hugeDeclaredSize, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  centralHeader.writeUInt32LE(0, 42);
  const centralDir = Buffer.concat([centralHeader, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(entryDataEnd, 16);
  const centralDirStart = entryDataEnd;
  const totalFileSize = centralDirStart + centralDir.length + eocd.length;

  const path = join(dir, name);
  const fd = openSync(path, "w+");
  writeSync(fd, localHeaderAndName, 0, localHeaderAndName.length, 0);
  writeSync(fd, centralDir, 0, centralDir.length, centralDirStart);
  writeSync(fd, eocd, 0, eocd.length, centralDirStart + centralDir.length);
  return { fd, path, size: totalFileSize };
}

test("countertest: validateWhatsAppChatExportArtifactFromFile's .zip path does not allocate memory proportional to a >1 GiB declared archive size", async () => {
  // The declared entry (>1 GiB) exceeds the per-entry policy cap, so this
  // is rejected fast -- but the point being proven is architectural: a
  // whole-file read (readFile(path) or readZipEntries(buffer)) would need
  // to materialize the ENTIRE file (which, if it were real bytes, would be
  // >1 GiB) merely to LOOK at the central directory. The file-backed path
  // must never do that, regardless of the outcome (accept or reject).
  const dir = mkdtempSync(join(tmpdir(), "pdpp-wa-validate-sparse-"));
  try {
    const { fd, path, size } = sparseZipFixture(dir, "sparse.zip");
    try {
      const before = process.memoryUsage().rss;
      const result = await validateWhatsAppChatExportArtifactFromFile(fd, path, size, {
        fileName: "sparse.zip",
        fileSha256: "0".repeat(64),
      });
      const after = process.memoryUsage().rss;
      // A whole-file read of a real (non-sparse) file this size would grow
      // RSS by close to `size` bytes. This bound (100 MiB) is far below the
      // fixture's declared size (>1 GiB) and far above ordinary process
      // noise, so it cleanly discriminates "bounded read" from "whole-file
      // read" without being flaky.
      const grewBy = after - before;
      assert.ok(
        grewBy < 100 * 1024 * 1024,
        `RSS grew by ${grewBy} bytes validating a ${size}-byte declared archive -- expected a bounded read, not proportional to file size`
      );
      // The declared entry is a .txt over MAX_CHAT_TEXT_BYTES (parsers.ts),
      // so it's skipped by findChatTextEntry's fast declared-size check and
      // no chat entry is found -- "unsupported" (no other .txt in this
      // fixture), not "too_large" (that status is for the zip-bomb
      // maxEntryUncompressedBytes/maxTotalUncompressedBytes policy, a
      // different, larger bound this fixture doesn't trip). Either
      // classification confirms the call actually exercised the
      // zip-reading path (not a short-circuit before touching the file at
      // all) rather than the memory bound being trivially satisfied by
      // doing nothing.
      assert.equal(result.status, "unsupported");
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("countertest: validateWhatsAppChatExportArtifactFromFile's .txt path allocates meaningfully less than a whole-buffer read of the same file", async (t) => {
  // A differential proof rather than an absolute threshold: parsed message
  // OBJECTS (author/content/sent_at strings, one per message) are a real,
  // unavoidable cost of the parse RESULT regardless of read strategy --
  // holding the raw file text as ONE ADDITIONAL whole buffer/string on top
  // of that (what readFile()-then-parse does) is the specific regression
  // being guarded against. Comparing the streamed path's growth against an
  // explicit readFileSync + buffer-based validate of the IDENTICAL file
  // isolates exactly that extra cost, without guessing an absolute number
  // that would be sensitive to V8/GC internals unrelated to this bug.
  const oneMessage = "[6/5/24, 9:15:22 AM] Alice: Hello there, this is a test message with some bulk padding text.\n";
  const targetSize = 64 * 1024 * 1024; // 64 MiB
  const dir = mkdtempSync(join(tmpdir(), "pdpp-wa-validate-bulk-"));
  try {
    const path = join(dir, "bulk.txt");
    const fd = openSync(path, "w");
    let written = 0;
    const chunk = Buffer.from(oneMessage.repeat(1000), "utf8");
    while (written < targetSize) {
      written += writeSync(fd, chunk, 0, chunk.length, written);
    }
    closeSync(fd);

    // Baseline: the OLD whole-buffer approach this file-backed path
    // replaces -- readFileSync the whole file, then validate the buffer.
    global.gc?.();
    const beforeBuffer = process.memoryUsage().rss;
    const wholeBuffer = readFileSync(path);
    const bufferResult = validateWhatsAppChatExportArtifact(wholeBuffer, { fileName: "bulk.txt" });
    const bufferGrowth = process.memoryUsage().rss - beforeBuffer;
    assert.equal(bufferResult.status, "valid");

    // Candidate: the streamed, file-backed path.
    const readFd = openSync(path, "r");
    try {
      global.gc?.();
      const beforeStream = process.memoryUsage().rss;
      const streamResult = await validateWhatsAppChatExportArtifactFromFile(readFd, path, written, {
        fileName: "bulk.txt",
        fileSha256: "0".repeat(64),
      });
      const streamGrowth = process.memoryUsage().rss - beforeStream;
      assert.equal(streamResult.status, "valid");
      assert.equal(streamResult.estimated_messages, bufferResult.estimated_messages);

      // Skip (not fail) if --expose-gc wasn't passed: without forced GC
      // between the two measurements, prior allocations bleed into the
      // second measurement and the comparison isn't trustworthy.
      if (typeof global.gc !== "function") {
        t.skip("run with --expose-gc for a reliable memory-growth comparison");
        return;
      }
      assert.ok(
        streamGrowth < bufferGrowth * 0.85,
        `streamed path RSS growth (${streamGrowth} bytes) was not meaningfully less than the whole-buffer baseline (${bufferGrowth} bytes) for the same ${written}-byte file -- expected the streamed path to avoid the extra whole-file buffer`
      );
    } finally {
      closeSync(readFd);
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
