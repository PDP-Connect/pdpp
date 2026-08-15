// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proof that the Netflix connector's manual-upload .ZIP extraction path
 * (index.ts's loadUploadedArtifactRows / parsers.ts's
 * extractViewingActivityArtifactFromFile's ZIP_EXT_RE branch) never buffers
 * a whole uploaded zip archive in memory before reading it — closing the
 * red-team-flagged residual at `netflix_export/parsers.ts` (readZipEntries
 * was the only path, with no file-backed alternative, unlike WhatsApp's
 * already-proven pair).
 *
 * SCOPE: this file proves the ZIP branch only. The plain-.CSV branch of
 * extractViewingActivityArtifactFromFile is explicitly NOT bounded-memory
 * (still a whole-file read, same memory-cost class as the readFile it
 * replaced) — see that function's own doc comment for why no streaming CSV
 * parser exists in this codebase to reuse, and the boundary test below only
 * proves its MAX_CSV_BYTES size cap is exact, not that it streams.
 *
 * Two complementary proofs for the ZIP branch, mirroring
 * whatsapp/no-whole-file-read.test.ts's structure:
 *
 * 1. A static guard that index.ts's upload-loading path does not import
 *    `readFile` from node:fs/promises (the whole-buffer API the residual
 *    named) — cheap, catches the specific regression class by name.
 *
 * 2. A SPARSE-FILE proof at the unit level: a zip whose single entry
 *    declares a multi-GB uncompressed size is fast-rejected by
 *    extractViewingActivityArtifactFromFile's declared-size check without
 *    ever reading the (unwritten, sparse) entry-data region — proving the
 *    file-backed ZIP path really does bound its reads to metadata plus
 *    whatever the policy allows, not "read everything then check". This is
 *    cheaper and more precise than an RSS-sampled subprocess proof (Netflix
 *    uploads are manifest-capped at 50 MiB, unlike WhatsApp's multi-GB
 *    case, so there is no realistic multi-GB Netflix upload to instrument
 *    against — the sparse-file technique proves the SAME structural
 *    property without needing one).
 */

import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { extractViewingActivityArtifactFromFile } from "./parsers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
const NETFLIX_ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "netflix_export", "index.ts");

test("static guard: index.ts's upload-loading path does not import readFile from node:fs/promises (whole-file read)", async () => {
  const source = await readFileAsync(NETFLIX_ENTRYPOINT, "utf8");
  const fsPromisesImportLines = source
    .split("\n")
    .filter((line) => line.includes('from "node:fs/promises"') || line.includes("from 'node:fs/promises'"));
  for (const line of fsPromisesImportLines) {
    assert.doesNotMatch(
      line,
      /\breadFile\b/,
      `index.ts must not import readFile from node:fs/promises (whole-file buffering) -- found in: ${line}`
    );
  }
  assert.doesNotMatch(
    source,
    /\breadFileSync\b/,
    "index.ts must not use readFileSync (whole-file buffering) anywhere in the upload-loading path"
  );
});

test("extractViewingActivityArtifactFromFile rejects a multi-GB-declared zip entry without ever reading its (sparse) data region", () => {
  // Same sparse-fixture technique as bounded-zip-archive.test.ts's own
  // multi-GB test: only the tiny local header, central directory, and EOCD
  // are actually written to disk; the multi-GB entry-data region between
  // them is never written (a filesystem hole), so this test costs no real
  // disk or memory even though the archive's reported fileSize spans
  // several GiB -- exactly what a real oversized upload's on-disk footprint
  // would look like.
  const GIB = 1024 * 1024 * 1024;
  const hugeDeclaredSize = 2 * GIB + 777;
  const nameBuf = Buffer.from("CONTENT_INTERACTION/ViewingActivity.csv", "utf8");

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04_03_4b_50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6); // no flags
  localHeader.writeUInt16LE(0, 8); // method 0 = STORE
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

  const dir = mkdtempSync(join(tmpdir(), "pdpp-netflix-zip-sparse-"));
  const path = join(dir, "netflix-report.zip");
  const fd = openSync(path, "w+");
  try {
    writeSync(fd, localHeaderAndName, 0, localHeaderAndName.length, 0);
    writeSync(fd, centralDir, 0, centralDir.length, centralDirStart);
    writeSync(fd, eocd, 0, eocd.length, centralDirStart + centralDir.length);

    const before = process.memoryUsage();
    const result = extractViewingActivityArtifactFromFile(fd, totalFileSize, "netflix-report.zip");
    const after = process.memoryUsage();

    assert.equal(result.ok, false, "a multi-GB-declared entry must be rejected, not read");
    if (!result.ok) {
      assert.equal(result.code, "entry_too_large");
    }
    const arrayBufferGrowth = after.arrayBuffers - before.arrayBuffers;
    assert.ok(
      arrayBufferGrowth < 10 * 1024 * 1024,
      `arrayBuffers grew by ${arrayBufferGrowth} bytes -- expected the oversized entry to be rejected before any large allocation, matching the sparse (never-written) entry-data region never being read`
    );
  } finally {
    closeSync(fd);
    rmSync(dir, { force: true, recursive: true });
  }
});

test("extractViewingActivityArtifactFromFile still extracts a real, well-formed zip via the file-backed path", () => {
  // Companion positive case: the file-backed rewrite must not have broken
  // the ordinary case while closing the whole-buffer residual.
  const csvText =
    "Profile Name,Start Time (UTC),Duration (H:MM:SS),Attributes,Title,Supplemental Video Type,Device Type,Bookmark,Latest Bookmark,Country\n";
  const content = Buffer.from(csvText, "utf8");
  const nameBuf = Buffer.from("CONTENT_INTERACTION/ViewingActivity.csv", "utf8");

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04_03_4b_50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(0, 8); // STORE
  localHeader.writeUInt32LE(content.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  const localEntry = Buffer.concat([localHeader, nameBuf, content]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02_01_4b_50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt32LE(content.length, 20);
  centralHeader.writeUInt32LE(content.length, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  centralHeader.writeUInt32LE(0, 42);
  const centralDir = Buffer.concat([centralHeader, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localEntry.length, 16);

  const zip = Buffer.concat([localEntry, centralDir, eocd]);
  const dir = mkdtempSync(join(tmpdir(), "pdpp-netflix-zip-real-"));
  const path = join(dir, "netflix-report.zip");
  const fd = openSync(path, "w+");
  try {
    writeSync(fd, zip, 0, zip.length, 0);
    const result = extractViewingActivityArtifactFromFile(fd, zip.length, "netflix-report.zip");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.format, "viewing_activity_zip");
      assert.match(result.csvText, /Profile Name/);
    }
  } finally {
    closeSync(fd);
    rmSync(dir, { force: true, recursive: true });
  }
});

test("extractViewingActivityArtifactFromFile reads a plain CSV upload via the file-backed path", () => {
  const csvText = 'Title,Date\n"The Crown",2024-01-15\n';
  const dir = mkdtempSync(join(tmpdir(), "pdpp-netflix-csv-real-"));
  const path = join(dir, "NetflixViewingHistory.csv");
  const fd = openSync(path, "w+");
  try {
    writeSync(fd, csvText, 0, "utf8");
    const result = extractViewingActivityArtifactFromFile(
      fd,
      Buffer.byteLength(csvText, "utf8"),
      "NetflixViewingHistory.csv"
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.format, "viewing_activity_csv");
      assert.equal(result.csvText, csvText);
    }
  } finally {
    closeSync(fd);
    rmSync(dir, { force: true, recursive: true });
  }
});

test("boundary: extractViewingActivityArtifactFromFile's CSV size check — exactly MAX_CSV_BYTES succeeds, +1 byte fails", () => {
  // MAX_CSV_BYTES (50 MiB) is internal to parsers.ts; derived here from the
  // same value gate-exact-size.test.ts already pins for parseCSVFile's
  // equivalent check.
  const MAX_CSV_BYTES = 50 * 1024 * 1024;
  const dir = mkdtempSync(join(tmpdir(), "pdpp-netflix-csv-boundary-"));
  try {
    const atCapPath = join(dir, "at-cap.csv");
    const atCapFd = openSync(atCapPath, "w+");
    try {
      // Sparse for the bulk (never actually allocate 50 MiB); a real 1-byte
      // write at the final offset makes the reported file size exact.
      writeSync(atCapFd, Buffer.from("x"), 0, 1, MAX_CSV_BYTES - 1);
      const atCapResult = extractViewingActivityArtifactFromFile(atCapFd, MAX_CSV_BYTES, "at-cap.csv");
      assert.equal(atCapResult.ok, true, "a CSV exactly at MAX_CSV_BYTES must be accepted");
    } finally {
      closeSync(atCapFd);
    }

    const overCapPath = join(dir, "over-cap.csv");
    const overCapFd = openSync(overCapPath, "w+");
    try {
      writeSync(overCapFd, Buffer.from("x"), 0, 1, MAX_CSV_BYTES);
      const before = process.memoryUsage();
      const overCapResult = extractViewingActivityArtifactFromFile(overCapFd, MAX_CSV_BYTES + 1, "over-cap.csv");
      const after = process.memoryUsage();
      assert.equal(overCapResult.ok, false, "a CSV at MAX_CSV_BYTES + 1 must be rejected");
      if (!overCapResult.ok) {
        assert.equal(overCapResult.code, "entry_too_large");
      }
      const arrayBufferGrowth = after.arrayBuffers - before.arrayBuffers;
      assert.ok(
        arrayBufferGrowth < 10 * 1024 * 1024,
        `arrayBuffers grew by ${arrayBufferGrowth} bytes -- expected the oversized CSV to be rejected before reading it, not after`
      );
    } finally {
      closeSync(overCapFd);
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
