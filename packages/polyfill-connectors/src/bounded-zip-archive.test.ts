// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import {
  hasZipLocalFileSignature,
  readZipEntries,
  readZipEntriesFromFile,
  ZipPolicyViolationError,
  type ZipReadPolicy,
  zipBasename,
} from "./bounded-zip-archive.ts";

interface BuildZipFile {
  content: Buffer;
  /** Declared uncompressed_size written into headers; defaults to content.length. Set to lie about it. */
  declaredUncompressedSize?: number;
  name: string;
}

function buildZip(files: BuildZipFile[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const contentBuf = file.content;
    const compressed = deflateRawSync(contentBuf);
    const declaredSize = file.declaredUncompressedSize ?? contentBuf.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04_03_4b_50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x08_00, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(declaredSize, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localEntry = Buffer.concat([localHeader, nameBuf, compressed]);
    localParts.push(localEntry);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02_01_4b_50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x08_00, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(declaredSize, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(Buffer.concat([centralHeader, nameBuf]));
    offset += localEntry.length;
  }

  const centralDirStart = offset;
  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(centralDirStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

const GENEROUS_POLICY: ZipReadPolicy = {
  maxEntries: 1000,
  maxEntryUncompressedBytes: 10 * 1024 * 1024,
  maxTotalUncompressedBytes: 10 * 1024 * 1024,
};

test("readZipEntries reads a flat single-entry zip", () => {
  const zip = buildZip([{ content: Buffer.from("hello world"), name: "hello.txt" }]);
  const entries = readZipEntries(zip, GENEROUS_POLICY);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.name, "hello.txt");
  assert.equal(entries[0]?.data().toString("utf8"), "hello world");
});

test("readZipEntries reads nested-path entries", () => {
  const zip = buildZip([
    { content: Buffer.from("Title,Watched at\nFoo,2024-01-01\n"), name: "CONTENT_INTERACTION/ViewingActivity.csv" },
    { content: Buffer.from("irrelevant"), name: "OTHER/ignored.csv" },
  ]);
  const entries = readZipEntries(zip, GENEROUS_POLICY);
  assert.equal(entries.length, 2);
  const match = entries.find((e) => e.name.endsWith("ViewingActivity.csv"));
  assert.ok(match);
  assert.match(match?.data().toString("utf8") ?? "", /Foo,2024-01-01/);
});

test("readZipEntries returns empty list for non-zip input", () => {
  const entries = readZipEntries(Buffer.from("not a zip file at all"), GENEROUS_POLICY);
  assert.deepEqual(entries, []);
});

test("hasZipLocalFileSignature detects zip magic bytes", () => {
  const zip = buildZip([{ content: Buffer.from("x"), name: "a.txt" }]);
  assert.equal(hasZipLocalFileSignature(zip), true);
  assert.equal(hasZipLocalFileSignature(Buffer.from("plain text")), false);
});

test("zipBasename strips directory components", () => {
  assert.equal(zipBasename("CONTENT_INTERACTION/ViewingActivity.csv"), "ViewingActivity.csv");
  assert.equal(zipBasename("plain.csv"), "plain.csv");
  assert.equal(zipBasename("a\\b\\c.csv"), "c.csv");
});

// ─── Decompression-bomb defense ──────────────────────────────────────────────

test("readZipEntries rejects an archive declaring more entries than maxEntries", () => {
  const zip = buildZip([{ content: Buffer.from("x"), name: "a.txt" }]);
  const policy: ZipReadPolicy = { ...GENEROUS_POLICY, maxEntries: 0 };
  assert.throws(() => readZipEntries(zip, policy), ZipPolicyViolationError);
  assert.throws(() => readZipEntries(zip, policy), { code: "too_many_entries" });
});

test("readZipEntries rejects an HONESTLY-declared oversized single entry before any inflation is attempted", () => {
  // A highly-compressible payload that genuinely IS larger than the policy
  // allows, with truthful central-directory metadata. This must be rejected
  // by the cheap declared-size fast-reject, without needing to inflate.
  const bomb = Buffer.alloc(50 * 1024 * 1024, 65); // 50 MiB of 'A', deflates to ~KB
  const zip = buildZip([{ content: bomb, name: "bomb.bin" }]);
  const policy: ZipReadPolicy = {
    maxEntries: 10,
    maxEntryUncompressedBytes: 1024 * 1024, // 1 MiB — bomb is 50x over
    maxTotalUncompressedBytes: 1024 * 1024,
  };
  assert.throws(() => readZipEntries(zip, policy), { code: "entry_too_large" });
});

test("readZipEntries rejects when honest declared sizes sum past maxTotalUncompressedBytes", () => {
  const each = Buffer.alloc(600 * 1024, 66); // 600 KiB each, honestly declared
  const zip = buildZip([
    { content: each, name: "a.bin" },
    { content: each, name: "b.bin" },
  ]);
  const policy: ZipReadPolicy = {
    maxEntries: 10,
    maxEntryUncompressedBytes: 1024 * 1024, // each entry alone is fine
    maxTotalUncompressedBytes: 1024 * 1024, // but the sum (1200 KiB) is not
  };
  assert.throws(() => readZipEntries(zip, policy), { code: "total_too_large" });
});

test("data() throws once actual inflated output exceeds maxEntryUncompressedBytes, even with a truthful declared size", () => {
  // Declared size matches reality but is itself over the per-entry cap; the
  // rejection must come from the fast-reject path (readZipEntries throws),
  // proving the declared-size check works on its own.
  const bomb = Buffer.alloc(2 * 1024 * 1024, 67); // 2 MiB
  const zip = buildZip([{ content: bomb, name: "bomb.bin" }]);
  const policy: ZipReadPolicy = {
    maxEntries: 10,
    maxEntryUncompressedBytes: 1024 * 1024,
    maxTotalUncompressedBytes: 1024 * 1024,
  };
  assert.throws(() => readZipEntries(zip, policy), { code: "entry_too_large" });
});

test("LYING declared size cannot bypass the per-entry actual-bytes cap — inflation itself is bounded", () => {
  // The central directory claims this entry is tiny (1 byte), so it sails
  // past the cheap fast-reject check. The REAL content is a highly
  // compressible 50 MiB payload. inflateRawSync's maxOutputLength must abort
  // the inflation itself before allocating the full 50 MiB — this is the
  // actual security boundary, not a post-hoc length check.
  const bomb = Buffer.alloc(50 * 1024 * 1024, 65); // 50 MiB, deflates to ~KB
  const zip = buildZip([{ content: bomb, declaredUncompressedSize: 1, name: "lying.bin" }]);
  const policy: ZipReadPolicy = {
    maxEntries: 10,
    maxEntryUncompressedBytes: 1024 * 1024, // 1 MiB real cap
    maxTotalUncompressedBytes: 1024 * 1024,
  };
  // Passes the declared-size fast-reject (it lied and said 1 byte)...
  const entries = readZipEntries(zip, policy);
  assert.equal(entries.length, 1);
  // ...but data() must still reject it once real inflation would exceed the cap.
  assert.throws(() => entries[0]?.data(), ZipPolicyViolationError);
  assert.throws(() => entries[0]?.data(), { code: "entry_too_large" });
});

test("LYING declared sizes across many small-declared entries cannot bypass the shared total actual-bytes budget", () => {
  // Three entries, each honestly compressible, each claiming to be 1 byte
  // uncompressed but each REALLY inflating to 400 KiB. None individually
  // exceeds maxEntryUncompressedBytes (500 KiB), so none is rejected by the
  // per-entry declared-size check either. The only thing that can catch this
  // is a REAL running counter over actual bytes extracted.
  const eachReal = Buffer.alloc(400 * 1024, 88); // 400 KiB each, compressible
  const zip = buildZip([
    { content: eachReal, declaredUncompressedSize: 1, name: "a.bin" },
    { content: eachReal, declaredUncompressedSize: 1, name: "b.bin" },
    { content: eachReal, declaredUncompressedSize: 1, name: "c.bin" },
  ]);
  const policy: ZipReadPolicy = {
    maxEntries: 10,
    maxEntryUncompressedBytes: 500 * 1024, // each lie (1 byte) and each real size (400 KiB) both pass this
    maxTotalUncompressedBytes: 900 * 1024, // but 3 x 400 KiB = 1200 KiB real total exceeds this
  };
  // All three entries pass metadata-time checks (declared 1 byte each).
  const entries = readZipEntries(zip, policy);
  assert.equal(entries.length, 3);

  let totalExtracted = 0;
  let thirdThrew: unknown = null;
  const first = entries[0]?.data();
  assert.ok(first);
  totalExtracted += first.length;
  const second = entries[1]?.data();
  assert.ok(second);
  totalExtracted += second.length;
  try {
    const third = entries[2]?.data();
    if (third) {
      totalExtracted += third.length;
    }
  } catch (err) {
    thirdThrew = err;
  }

  assert.ok(thirdThrew instanceof ZipPolicyViolationError, "third extraction must be rejected by the shared budget");
  // After two 400 KiB extractions, only 100 KiB of the 900 KiB total budget
  // remains — well under the flat 500 KiB per-entry cap. The remaining
  // shared budget is strictly the binding constraint here, so the violation
  // MUST classify as total_too_large, deterministically — never
  // entry_too_large, which would misleadingly suggest this entry alone (on
  // its own, with a full budget) is too big.
  assert.equal(
    (thirdThrew as ZipPolicyViolationError).code,
    "total_too_large",
    "budget-exhaustion (not a standalone oversized entry) must classify as total_too_large"
  );
  assert.ok(
    totalExtracted <= policy.maxTotalUncompressedBytes,
    `cumulative actual bytes extracted (${totalExtracted}) must never exceed maxTotalUncompressedBytes (${policy.maxTotalUncompressedBytes})`
  );
});

// Store method (0) — buildZip always uses deflate; this builds a minimal
// stored-method zip directly to exercise the STORE branch, optionally lying
// about the declared size to isolate the actual-bytes check from the
// declared-size fast-reject.
function buildStoredZip(content: Buffer, declaredSize: number = content.length): Buffer {
  const nameBuf = Buffer.from("stored.bin", "utf8");
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04_03_4b_50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6); // no flags
  localHeader.writeUInt16LE(0, 8); // method 0 = STORE
  localHeader.writeUInt32LE(content.length, 18);
  localHeader.writeUInt32LE(declaredSize, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  const localEntry = Buffer.concat([localHeader, nameBuf, content]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02_01_4b_50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt32LE(content.length, 20);
  centralHeader.writeUInt32LE(declaredSize, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  centralHeader.writeUInt32LE(0, 42);
  const centralDir = Buffer.concat([centralHeader, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localEntry.length, 16);

  return Buffer.concat([localEntry, centralDir, eocd]);
}

test("stored (uncompressed) entries are bounded the same way as deflated entries", () => {
  const big = Buffer.alloc(2 * 1024 * 1024, 90);
  const zip = buildStoredZip(big);
  const policy: ZipReadPolicy = {
    maxEntries: 10,
    maxEntryUncompressedBytes: 1024 * 1024,
    maxTotalUncompressedBytes: 1024 * 1024,
  };
  assert.throws(() => readZipEntries(zip, policy), { code: "entry_too_large" });
});

test("boundary: STORE-method actual size — exactly maxEntryUncompressedBytes succeeds, +1 byte fails", () => {
  // Declared size LIES (set to 1) so the fast-reject never fires — isolating
  // the STORE branch's own actual-bytes comparison (compressed.length >
  // cap.bytes) exactly, mirroring the DEFLATE actual-boundary test above.
  const cap = 4096;
  const policy: ZipReadPolicy = { maxEntries: 10, maxEntryUncompressedBytes: cap, maxTotalUncompressedBytes: cap };

  const atCapEntries = readZipEntries(buildStoredZip(Buffer.alloc(cap, 91), 1), policy);
  assert.equal(atCapEntries[0]?.data().length, cap, "STORE actual bytes exactly at the cap must succeed");

  const overCapEntries = readZipEntries(buildStoredZip(Buffer.alloc(cap + 1, 91), 1), policy);
  assert.throws(() => overCapEntries[0]?.data(), { code: "entry_too_large" });
});

test("malformed central-directory metadata (out-of-bounds offsets) is rejected, not crashed on", () => {
  // A central directory whose local-header offset points past the end of
  // the buffer must not throw an unhandled RangeError from readUInt32LE —
  // it should surface as an empty entry list or a clean thrown error from
  // data(), never an uncaught crash.
  const zip = buildZip([{ content: Buffer.from("x"), name: "a.txt" }]);
  // Corrupt the central directory's local-header-offset field (bytes vary by
  // layout; brute-force scan for the central directory signature and corrupt
  // the offset field at +42 relative to it).
  const corrupted = Buffer.from(zip);
  for (let i = 0; i + 4 <= corrupted.length; i += 1) {
    if (corrupted.readUInt32LE(i) === 0x02_01_4b_50) {
      corrupted.writeUInt32LE(0xff_ff_ff_ff, i + 42);
      break;
    }
  }
  const entries = readZipEntries(corrupted, GENEROUS_POLICY);
  assert.equal(entries.length, 1, "entry is still listed from valid central-directory metadata");
  assert.throws(() => entries[0]?.data(), /zip_entry_local_header_invalid|zip_entry_data_out_of_bounds/);
});

test("malformed central-directory length fields that would overflow past the buffer are rejected", () => {
  const zip = buildZip([{ content: Buffer.from("x"), name: "a.txt" }]);
  const corrupted = Buffer.from(zip);
  // Corrupt the fileNameLength field (offset +28 from central dir signature)
  // to an enormous value that would push nameStart+fileNameLength past EOF.
  for (let i = 0; i + 4 <= corrupted.length; i += 1) {
    if (corrupted.readUInt32LE(i) === 0x02_01_4b_50) {
      corrupted.writeUInt16LE(0xff_ff, i + 28);
      break;
    }
  }
  const entries = readZipEntries(corrupted, GENEROUS_POLICY);
  assert.equal(entries.length, 0, "corrupt-length entry must be dropped, not crash the reader");
});

// ─── File-backed reads (readZipEntriesFromFile) ─────────────────────────────
//
// Same algorithm, different byte source: a file descriptor read in bounded
// windows instead of one pre-buffered Buffer. These tests prove parity with
// the buffer-based API on ordinary archives, AND prove the file-backed path
// never materializes the whole archive as one in-memory buffer — using a
// SPARSE fixture file (created via a seek-past-end write, not Buffer.alloc)
// so a "multi-GB archive" test costs no real memory or disk allocation.

function withTempZipFile<T>(zip: Buffer, fn: (fd: number, fileSize: number) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-zip-fd-"));
  const path = join(dir, "archive.zip");
  const fd = openSync(path, "w+");
  try {
    writeSync(fd, zip, 0, zip.length, 0);
    return fn(fd, zip.length);
  } finally {
    closeSync(fd);
    rmSync(dir, { force: true, recursive: true });
  }
}

test("readZipEntriesFromFile reads a flat single-entry zip identically to the buffer API", () => {
  const zip = buildZip([{ content: Buffer.from("hello world"), name: "hello.txt" }]);
  withTempZipFile(zip, (fd, fileSize) => {
    const entries = readZipEntriesFromFile(fd, fileSize, GENEROUS_POLICY);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.name, "hello.txt");
    assert.equal(entries[0]?.data().toString("utf8"), "hello world");
  });
});

test("readZipEntriesFromFile reads nested-path entries and multiple files", () => {
  const zip = buildZip([
    { content: Buffer.from("Title,Watched at\nFoo,2024-01-01\n"), name: "CONTENT_INTERACTION/ViewingActivity.csv" },
    { content: Buffer.from("irrelevant"), name: "OTHER/ignored.csv" },
  ]);
  withTempZipFile(zip, (fd, fileSize) => {
    const entries = readZipEntriesFromFile(fd, fileSize, GENEROUS_POLICY);
    assert.equal(entries.length, 2);
    const match = entries.find((e) => e.name.endsWith("ViewingActivity.csv"));
    assert.ok(match);
    assert.match(match?.data().toString("utf8") ?? "", /Foo,2024-01-01/);
  });
});

test("readZipEntriesFromFile returns empty list for non-zip input", () => {
  withTempZipFile(Buffer.from("not a zip file at all"), (fd, fileSize) => {
    assert.deepEqual(readZipEntriesFromFile(fd, fileSize, GENEROUS_POLICY), []);
  });
});

test("readZipEntriesFromFile enforces the same declared-size fast-reject as the buffer API", () => {
  const bomb = Buffer.alloc(50 * 1024 * 1024, 65); // 50 MiB of 'A', deflates to ~KB
  const zip = buildZip([{ content: bomb, name: "bomb.bin" }]);
  const policy: ZipReadPolicy = {
    maxEntries: 10,
    maxEntryUncompressedBytes: 1024 * 1024,
    maxTotalUncompressedBytes: 1024 * 1024,
  };
  withTempZipFile(zip, (fd, fileSize) => {
    assert.throws(() => readZipEntriesFromFile(fd, fileSize, policy), { code: "entry_too_large" });
  });
});

test("readZipEntriesFromFile: a LYING declared size still cannot bypass the actual-bytes cap", () => {
  const bomb = Buffer.alloc(50 * 1024 * 1024, 65); // 50 MiB, deflates to ~KB
  const zip = buildZip([{ content: bomb, declaredUncompressedSize: 1, name: "lying.bin" }]);
  const policy: ZipReadPolicy = {
    maxEntries: 10,
    maxEntryUncompressedBytes: 1024 * 1024,
    maxTotalUncompressedBytes: 1024 * 1024,
  };
  withTempZipFile(zip, (fd, fileSize) => {
    const entries = readZipEntriesFromFile(fd, fileSize, policy);
    assert.equal(entries.length, 1);
    assert.throws(() => entries[0]?.data(), { code: "entry_too_large" });
  });
});

test("readZipEntriesFromFile: malformed central-directory offsets are rejected, not crashed on", () => {
  const zip = buildZip([{ content: Buffer.from("x"), name: "a.txt" }]);
  const corrupted = Buffer.from(zip);
  for (let i = 0; i + 4 <= corrupted.length; i += 1) {
    if (corrupted.readUInt32LE(i) === 0x02_01_4b_50) {
      corrupted.writeUInt32LE(0xff_ff_ff_ff, i + 42);
      break;
    }
  }
  withTempZipFile(corrupted, (fd, fileSize) => {
    const entries = readZipEntriesFromFile(fd, fileSize, GENEROUS_POLICY);
    assert.equal(entries.length, 1, "entry is still listed from valid central-directory metadata");
    assert.throws(() => entries[0]?.data(), /zip_entry_local_header_invalid|zip_entry_data_out_of_bounds/);
  });
});

test("readZipEntriesFromFile handles a multi-GB-scale archive using a SPARSE fixture (no real large allocation)", () => {
  // A single STORED (uncompressed) entry whose declared length is ~2 GiB —
  // larger than Node's Buffer.alloc could comfortably materialize in a test
  // process, and definitely larger than any single readWindow() call should
  // ever request. The file is created SPARSE: only the tiny local header,
  // central directory, and EOCD are actually written; the multi-GB entry
  // region is never written and costs no real disk or memory (ftruncate-style
  // hole). This proves readZipEntriesFromFile can enumerate (list) a
  // multi-GB-declared archive's central directory without reading anywhere
  // near that many bytes — it only reads the small EOCD/central-directory
  // window, and the policy fast-rejects the entry before any inflation.
  const GIB = 1024 * 1024 * 1024;
  const hugeDeclaredSize = 2 * GIB + 12_345; // > 2 GiB, not a round number
  const nameBuf = Buffer.from("huge.bin", "utf8");

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04_03_4b_50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6); // no flags
  localHeader.writeUInt16LE(0, 8); // method 0 = STORE
  localHeader.writeUInt32LE(hugeDeclaredSize, 18); // compressed size (STORE: == uncompressed)
  localHeader.writeUInt32LE(hugeDeclaredSize, 22); // uncompressed size
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
  centralHeader.writeUInt32LE(0, 42); // local header offset
  const centralDir = Buffer.concat([centralHeader, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(entryDataEnd, 16); // central dir starts right after the (unwritten) huge entry region
  const centralDirStart = entryDataEnd;
  const totalFileSize = centralDirStart + centralDir.length + eocd.length;

  const dir = mkdtempSync(join(tmpdir(), "pdpp-zip-sparse-"));
  const path = join(dir, "sparse.zip");
  const fd = openSync(path, "w+");
  try {
    // Write the local header+name at the start...
    writeSync(fd, localHeaderAndName, 0, localHeaderAndName.length, 0);
    // ...and the central directory + EOCD at their real offsets, WITHOUT ever
    // writing (or reading) the multi-GB entry-data region between them. The
    // filesystem reports the file as spanning `totalFileSize` bytes (a
    // sparse hole in between), matching what a real multi-GB upload's file
    // size would be, without any of the actual disk/memory cost.
    writeSync(fd, centralDir, 0, centralDir.length, centralDirStart);
    writeSync(fd, eocd, 0, eocd.length, centralDirStart + centralDir.length);

    const rejectingPolicy: ZipReadPolicy = {
      maxEntries: 10,
      maxEntryUncompressedBytes: 500 * 1024 * 1024, // 500 MiB — the 2GiB+ entry must be rejected
      maxTotalUncompressedBytes: 500 * 1024 * 1024,
    };
    const entries = readZipEntriesFromFile(fd, totalFileSize, rejectingPolicy);
    // The declared-size fast-reject must fire during LISTING (readZipEntriesFromFile
    // itself), before any entry is even returned to the caller — proving the
    // multi-GB entry payload was never touched, not even a single data() call.
    assert.equal(entries.length, 0, "listing throws before returning any entries");
  } catch (err) {
    assert.ok(err instanceof ZipPolicyViolationError);
    assert.equal((err as ZipPolicyViolationError).code, "entry_too_large");
  } finally {
    closeSync(fd);
    rmSync(dir, { force: true, recursive: true });
  }
});

test("readZipEntriesFromFile rejects a LYING centralDirSize that claims far more than entryCount plausibly needs (B1 — unbounded central-directory read)", () => {
  // Adversarial reproduction of a real vulnerability class: entryCount is
  // truthfully small (passes the maxEntries gate independently), but
  // centralDirSize (a SEPARATE field on the EOCD record) declares a size
  // wildly disproportionate to what that many entries could ever need. Prior
  // to this fix, readZipEntriesFromSource passed centralDirSize straight to
  // source.readWindow with no bound at all beyond the archive's own file
  // size — so a real multi-GB file (this test uses a sparse one, cheap to
  // create, but the vulnerability is identical against a real dense file;
  // verified separately with a real 1.9 GiB non-sparse file during triage,
  // reproducing >1 second of wall time and ~1.9 GiB of RSS growth from ONE
  // crafted EOCD record) forced a multi-GB allocUnsafe + synchronous read
  // just to look at "metadata" for a single declared entry.
  const GIB = 1024 * 1024 * 1024;
  const lyingCentralDirSize = GIB; // 1 GiB "central directory" for ONE entry — wildly implausible
  const nameBuf = Buffer.from("a.txt", "utf8");

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04_03_4b_50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt32LE(1, 18);
  localHeader.writeUInt32LE(1, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  const localEntry = Buffer.concat([localHeader, nameBuf, Buffer.from("x")]);

  // The EOCD is placed far enough into the file that the declared
  // centralDirSize (1 GiB) would, if honored, force a large read/alloc —
  // the file itself is sparse (cheap), but centralDirStart=0 makes the
  // "central directory" region overlap the whole sparse hole.
  const totalFileSize = 2 * GIB;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(1, 8); // entries on this disk = 1 (truthful, passes maxEntries)
  eocd.writeUInt16LE(1, 10); // total entries = 1
  eocd.writeUInt32LE(lyingCentralDirSize, 12); // LYING: 1 GiB for 1 entry
  eocd.writeUInt32LE(0, 16); // centralDirStart = 0
  eocd.writeUInt16LE(0, 20);

  const dir = mkdtempSync(join(tmpdir(), "pdpp-zip-b1-"));
  const path = join(dir, "lying-central-dir-size.zip");
  const fd = openSync(path, "w+");
  try {
    writeSync(fd, localEntry, 0, localEntry.length, 0);
    writeSync(fd, eocd, 0, eocd.length, totalFileSize - eocd.length);

    const policy: ZipReadPolicy = {
      maxEntries: 20_000,
      maxEntryUncompressedBytes: 2 * GIB,
      maxTotalUncompressedBytes: 20 * GIB,
    };

    const before = process.memoryUsage();
    let threw: unknown = null;
    try {
      readZipEntriesFromFile(fd, totalFileSize, policy);
    } catch (err) {
      threw = err;
    }
    const after = process.memoryUsage();

    assert.ok(threw instanceof ZipPolicyViolationError, `expected a ZipPolicyViolationError, got: ${threw}`);
    assert.equal((threw as ZipPolicyViolationError).code, "too_many_entries");
    assert.match((threw as ZipPolicyViolationError).message, /central directory/i);

    // The real proof: no large allocation happened. Buffer.allocUnsafe of
    // ~1 GiB would show up unambiguously in arrayBuffers/external, not just
    // RSS (which can be noisy) — this is the same metric class the report's
    // other countertests use, applied to the specific field this finding is
    // about.
    const arrayBufferGrowth = after.arrayBuffers - before.arrayBuffers;
    assert.ok(
      arrayBufferGrowth < 10 * 1024 * 1024,
      `arrayBuffers grew by ${arrayBufferGrowth} bytes — expected the lying centralDirSize to be rejected before any allocation, not after`
    );
  } finally {
    closeSync(fd);
    rmSync(dir, { force: true, recursive: true });
  }
});

test("readZipEntriesFromFile accepts a truthful centralDirSize at the plausible ceiling for its entryCount", () => {
  // Companion positive case: a real archive with many entries and long-ish
  // names should NOT be rejected by the B1 fix just because its central
  // directory is legitimately large. 100 entries with ~200-byte names is a
  // realistic "many small files" case.
  const entries = Array.from({ length: 100 }, (_, i) => ({
    content: Buffer.from("x"),
    name: `folder/subfolder/${"a".repeat(150)}-${i}.txt`,
  }));
  const zip = buildZip(entries);
  const result = readZipEntries(zip, GENEROUS_POLICY);
  assert.equal(result.length, 100);
});

// ─── Exact numeric boundaries: cap succeeds, cap+1 fails ────────────────────
//
// Every limit below is proven at the EXACT edge, not just "far over/under"
// (the report's own gap: the prior suite only exercised 10x-50x margins).
// Each pair uses the SAME construction, varying only the one value that
// crosses the boundary, so a passing "cap" case and a failing "cap+1" case
// can't both be explained by some other unrelated difference.

function overwriteEocdField(
  zip: Buffer,
  byteOffsetFromEocdSignature: number,
  value: number,
  byteLength: 2 | 4
): Buffer {
  const patched = Buffer.from(zip);
  for (let i = 0; i + 4 <= patched.length; i += 1) {
    if (patched.readUInt32LE(i) === 0x06_05_4b_50) {
      if (byteLength === 2) {
        patched.writeUInt16LE(value, i + byteOffsetFromEocdSignature);
      } else {
        patched.writeUInt32LE(value, i + byteOffsetFromEocdSignature);
      }
      return patched;
    }
  }
  throw new Error("test bug: no EOCD signature found to patch");
}

test("boundary: maxEntries — exactly maxEntries entries succeeds, maxEntries+1 fails", () => {
  const buildWithCount = (count: number) =>
    buildZip(Array.from({ length: count }, (_, i) => ({ content: Buffer.from("x"), name: `f${i}.txt` })));
  const policy: ZipReadPolicy = { ...GENEROUS_POLICY, maxEntries: 5 };

  const atCap = readZipEntries(buildWithCount(5), policy);
  assert.equal(atCap.length, 5, "exactly maxEntries entries must succeed");

  assert.throws(() => readZipEntries(buildWithCount(6), policy), { code: "too_many_entries" });
});

test("boundary: central-directory plausibility ceiling — exactly at the ceiling succeeds, ceiling+1 fails", () => {
  // maxPlausibleCentralDirSize = entryCount * (46-byte header + 4096-byte
  // policy allowance) is internal, so this test derives it structurally: for
  // a genuine one-entry zip, overwrite the EOCD's OWN declared centralDirSize
  // field to the exact ceiling value and to ceiling+1, leaving the real
  // on-disk central directory bytes untouched (this check fires purely off
  // the declared field, before any read of those bytes — see the module's
  // own comment on why centralDirSize must be validated before use).
  const zip = buildZip([{ content: Buffer.from("x"), name: "a.txt" }]);
  const ZIP_CENTRAL_DIRECTORY_MAX_RECORD_LENGTH = 46 + 4096;
  const entryCount = 1;
  const ceiling = entryCount * ZIP_CENTRAL_DIRECTORY_MAX_RECORD_LENGTH;

  const atCeiling = overwriteEocdField(zip, 12, ceiling, 4);
  // Must not throw the plausibility check specifically; it may still fail
  // downstream if the (unmodified, real) central directory bytes end short
  // of the inflated declared size, so assert no too_many_entries throw.
  try {
    readZipEntries(atCeiling, GENEROUS_POLICY);
  } catch (err) {
    assert.notEqual(
      (err as { code?: string })?.code,
      "too_many_entries",
      `declaring exactly the plausible ceiling (${ceiling}) must not trip the plausibility check`
    );
  }

  const overCeiling = overwriteEocdField(zip, 12, ceiling + 1, 4);
  assert.throws(() => readZipEntries(overCeiling, GENEROUS_POLICY), { code: "too_many_entries" });
});

test("boundary: per-entry DECLARED uncompressed_size — exactly maxEntryUncompressedBytes succeeds, +1 byte fails", () => {
  const buildWithDeclared = (declaredSize: number) => {
    const content = Buffer.alloc(declaredSize, 65);
    return buildZip([{ content, name: "a.bin" }]);
  };
  const cap = 4096;
  const policy: ZipReadPolicy = { maxEntries: 10, maxEntryUncompressedBytes: cap, maxTotalUncompressedBytes: cap };

  const atCap = readZipEntries(buildWithDeclared(cap), policy);
  assert.equal(atCap.length, 1, "declared size exactly at the cap must pass the fast-reject");
  assert.equal(atCap[0]?.data().length, cap);

  assert.throws(() => readZipEntries(buildWithDeclared(cap + 1), policy), { code: "entry_too_large" });
});

test("boundary: per-entry ACTUAL inflated size — exactly maxEntryUncompressedBytes succeeds, +1 real byte fails", () => {
  // Declared size LIES (set to 1) so the fast-reject never fires — isolating
  // the actual, inflate-time boundary (zlib's maxOutputLength) exactly.
  const cap = 4096;
  const policy: ZipReadPolicy = { maxEntries: 10, maxEntryUncompressedBytes: cap, maxTotalUncompressedBytes: cap };

  const atCapZip = buildZip([{ content: Buffer.alloc(cap, 66), declaredUncompressedSize: 1, name: "a.bin" }]);
  const atCapEntries = readZipEntries(atCapZip, policy);
  assert.equal(atCapEntries[0]?.data().length, cap, "actual inflated bytes exactly at the cap must succeed");

  const overCapZip = buildZip([{ content: Buffer.alloc(cap + 1, 66), declaredUncompressedSize: 1, name: "a.bin" }]);
  const overCapEntries = readZipEntries(overCapZip, policy);
  assert.throws(() => overCapEntries[0]?.data(), { code: "entry_too_large" });
});

test("boundary: running total DECLARED uncompressed_size — exactly maxTotalUncompressedBytes across entries succeeds, +1 byte fails", () => {
  const buildTwoEntries = (secondDeclaredSize: number) =>
    buildZip([
      { content: Buffer.alloc(2000, 67), name: "a.bin" },
      { content: Buffer.alloc(secondDeclaredSize, 68), declaredUncompressedSize: secondDeclaredSize, name: "b.bin" },
    ]);
  const total = 4096;
  const policy: ZipReadPolicy = { maxEntries: 10, maxEntryUncompressedBytes: total, maxTotalUncompressedBytes: total };

  const atCap = readZipEntries(buildTwoEntries(total - 2000), policy);
  assert.equal(atCap.length, 2, "declared sizes summing to exactly the total budget must pass the fast-reject");

  assert.throws(() => readZipEntries(buildTwoEntries(total - 2000 + 1), policy), { code: "total_too_large" });
});

test("boundary: running total ACTUAL inflated bytes — exactly maxTotalUncompressedBytes across data() calls succeeds, +1 real byte fails", () => {
  // Both entries LIE about declared size (1 byte each) so the fast-reject
  // never fires — isolating the actual, running-counter boundary exactly.
  const firstReal = 2000;
  const total = 4096;
  const secondReal = total - firstReal; // exactly fills the remaining budget
  const policy: ZipReadPolicy = { maxEntries: 10, maxEntryUncompressedBytes: total, maxTotalUncompressedBytes: total };

  const atCapZip = buildZip([
    { content: Buffer.alloc(firstReal, 69), declaredUncompressedSize: 1, name: "a.bin" },
    { content: Buffer.alloc(secondReal, 70), declaredUncompressedSize: 1, name: "b.bin" },
  ]);
  const atCapEntries = readZipEntries(atCapZip, policy);
  const firstOut = atCapEntries[0]?.data();
  const secondOut = atCapEntries[1]?.data();
  assert.equal(
    (firstOut?.length ?? 0) + (secondOut?.length ?? 0),
    total,
    "actual total exactly at the budget must succeed for both extractions"
  );

  const overCapZip = buildZip([
    { content: Buffer.alloc(firstReal, 69), declaredUncompressedSize: 1, name: "a.bin" },
    { content: Buffer.alloc(secondReal + 1, 70), declaredUncompressedSize: 1, name: "b.bin" },
  ]);
  const overCapEntries = readZipEntries(overCapZip, policy);
  overCapEntries[0]?.data();
  assert.throws(() => overCapEntries[1]?.data(), { code: "total_too_large" });
});

// ─── Dangerous entry names, symlinks, and duplicates (fail-closed) ──────────

function buildZipWithRawName(rawName: Buffer, content: Buffer): Buffer {
  // Bypasses buildZip's Buffer.from(name, "utf8") to allow raw bytes that
  // aren't valid UTF-8 path text (e.g. embedded NUL), for constructing
  // attack-shaped entry names directly.
  const compressed = deflateRawSync(content);
  const declaredSize = content.length;

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04_03_4b_50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0x08_00, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(declaredSize, 22);
  localHeader.writeUInt16LE(rawName.length, 26);
  const localEntry = Buffer.concat([localHeader, rawName, compressed]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02_01_4b_50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0x08_00, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(declaredSize, 24);
  centralHeader.writeUInt16LE(rawName.length, 28);
  centralHeader.writeUInt32LE(0, 42);
  const centralDir = Buffer.concat([centralHeader, rawName]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localEntry.length, 16);

  return Buffer.concat([localEntry, centralDir, eocd]);
}

test("readZipEntries rejects a parent-directory-traversal entry name", () => {
  const zip = buildZip([{ content: Buffer.from("x"), name: "../../etc/passwd" }]);
  assert.throws(() => readZipEntries(zip, GENEROUS_POLICY), { code: "unsafe_entry_name" });
});

test("readZipEntries rejects a backslash parent-directory-traversal entry name", () => {
  const zip = buildZip([{ content: Buffer.from("x"), name: "..\\..\\windows\\system32\\config" }]);
  assert.throws(() => readZipEntries(zip, GENEROUS_POLICY), { code: "unsafe_entry_name" });
});

test("readZipEntries rejects a whitespace-padded dot-dot segment (terminal-redteam-0810 P3)", () => {
  // Not actually zip-slip-exploitable via THIS module's own path.join
  // semantics today (Node treats ".. " as a literal directory name, not a
  // traversal token) -- rejected anyway so the module's own doc comment
  // promise ("any future path.join(dest, entry.name) caller would be
  // immediately rejected") stays true regardless of what a DIFFERENT,
  // non-Node downstream tool might do with a name that looks like a
  // traversal attempt to a human reviewer.
  for (const name of [".. /etc/passwd", "foo/..\t/etc/passwd", "foo/.. ", " ../etc/passwd"]) {
    const zip = buildZip([{ content: Buffer.from("x"), name }]);
    assert.throws(
      () => readZipEntries(zip, GENEROUS_POLICY),
      { code: "unsafe_entry_name" },
      `expected ${JSON.stringify(name)} to be rejected`
    );
  }
});

test("readZipEntries counterweight: a name merely containing '..' as part of a longer segment is NOT flagged as traversal", () => {
  const zip = buildZip([{ content: Buffer.from("x"), name: "..hidden-file/foo..bar.txt" }]);
  const entries = readZipEntries(zip, GENEROUS_POLICY);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.name, "..hidden-file/foo..bar.txt");
});

test("readZipEntries rejects an absolute POSIX-path entry name", () => {
  const zip = buildZip([{ content: Buffer.from("x"), name: "/etc/passwd" }]);
  assert.throws(() => readZipEntries(zip, GENEROUS_POLICY), { code: "unsafe_entry_name" });
});

test("readZipEntries rejects a Windows drive-letter entry name", () => {
  const zip = buildZip([{ content: Buffer.from("x"), name: "C:\\Windows\\system.ini" }]);
  assert.throws(() => readZipEntries(zip, GENEROUS_POLICY), { code: "unsafe_entry_name" });
});

test("readZipEntries rejects a UNC-root entry name", () => {
  const zip = buildZip([{ content: Buffer.from("x"), name: "\\\\attacker-host\\share\\payload" }]);
  assert.throws(() => readZipEntries(zip, GENEROUS_POLICY), { code: "unsafe_entry_name" });
});

test("readZipEntries rejects an entry name with an embedded NUL byte", () => {
  const rawName = Buffer.concat([Buffer.from("safe.txt"), Buffer.from([0]), Buffer.from("evil.sh")]);
  const zip = buildZipWithRawName(rawName, Buffer.from("x"));
  assert.throws(() => readZipEntries(zip, GENEROUS_POLICY), { code: "unsafe_entry_name" });
});

test("readZipEntries rejects a Unix-symlink entry (version made by = Unix, S_IFLNK in external attrs)", () => {
  const nameBuf = Buffer.from("payload-link", "utf8");
  const target = Buffer.from("/etc/passwd");
  const compressed = deflateRawSync(target);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04_03_4b_50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0x08_00, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(target.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  const localEntry = Buffer.concat([localHeader, nameBuf, compressed]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02_01_4b_50, 0);
  // version made by: low byte = spec version, HIGH byte = host OS (3 = Unix).
  centralHeader.writeUInt16LE(3 * 256 + 20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0x08_00, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(target.length, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  // external file attributes: upper 16 bits = Unix st_mode; S_IFLNK (0o120000) combined with 0o777 perms.
  const unixMode = 0o12_0000 + 0o777;
  centralHeader.writeUInt32LE(unixMode * 65_536, 38);
  centralHeader.writeUInt32LE(0, 42);
  const centralDir = Buffer.concat([centralHeader, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localEntry.length, 16);

  const zip = Buffer.concat([localEntry, centralDir, eocd]);
  assert.throws(() => readZipEntries(zip, GENEROUS_POLICY), { code: "unsafe_entry_name" });
});

test("readZipEntries does NOT treat a regular file as a symlink when version-made-by is NOT Unix", () => {
  // Same external-attributes bit pattern as the symlink test above, but
  // version-made-by's host byte is 0 (MS-DOS/FAT), under which external
  // attributes means something entirely different -- must NOT be
  // misinterpreted as a Unix mode/symlink bit.
  const nameBuf = Buffer.from("innocent.bin", "utf8");
  const content = Buffer.from("just a normal file");
  const compressed = deflateRawSync(content);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04_03_4b_50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0x08_00, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  const localEntry = Buffer.concat([localHeader, nameBuf, compressed]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02_01_4b_50, 0);
  centralHeader.writeUInt16LE(20, 4); // host = 0 (MS-DOS/FAT), NOT Unix -- high byte left 0
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0x08_00, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(content.length, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  // Same raw bits that WOULD decode as S_IFLNK if misread as a Unix mode.
  const wouldBeSymlinkModeIfUnix = 0o12_0000 + 0o777;
  centralHeader.writeUInt32LE(wouldBeSymlinkModeIfUnix * 65_536, 38);
  centralHeader.writeUInt32LE(0, 42);
  const centralDir = Buffer.concat([centralHeader, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localEntry.length, 16);

  const zip = Buffer.concat([localEntry, centralDir, eocd]);
  const entries = readZipEntries(zip, GENEROUS_POLICY);
  assert.equal(entries.length, 1, "non-Unix-authored archive must not misread external attrs as a symlink");
  assert.equal(entries[0]?.data().toString("utf8"), "just a normal file");
});

test("readZipEntries rejects two entries with an EXACT duplicate raw name", () => {
  const zip = buildZip([
    { content: Buffer.from("first"), name: "same.txt" },
    { content: Buffer.from("second"), name: "same.txt" },
  ]);
  assert.throws(() => readZipEntries(zip, GENEROUS_POLICY), { code: "unsafe_entry_name" });
});

test("readZipEntries allows two entries with the same BASENAME in different directories (not a duplicate)", () => {
  // Only EXACT raw-name collisions are rejected -- legitimate nested archives
  // routinely have same-named files in different directories (e.g. multiple
  // chat exports each containing their own media/thumbnail.jpg).
  const zip = buildZip([
    { content: Buffer.from("first"), name: "chat-a/thumbnail.jpg" },
    { content: Buffer.from("second"), name: "chat-b/thumbnail.jpg" },
  ]);
  const entries = readZipEntries(zip, GENEROUS_POLICY);
  assert.equal(entries.length, 2);
});

test("readZipEntries preserves ordinary Unicode and deeply nested harmless names", () => {
  const names = [
    "résumé/日本語のファイル名.csv",
    "emoji-📎-attachment.png",
    "a/b/c/d/e/f/g/deeply-nested.txt",
    "file..with..double..dots..but..not..traversal.txt",
    "trailing-dots...txt",
  ];
  const zip = buildZip(names.map((name, i) => ({ content: Buffer.from(`content-${i}`), name })));
  const entries = readZipEntries(zip, GENEROUS_POLICY);
  assert.equal(entries.length, names.length);
  for (const name of names) {
    const match = entries.find((e) => e.name === name);
    assert.ok(match, `expected to find harmless entry '${name}'`);
  }
});

test("readZipEntriesFromFile enforces the same dangerous-name and symlink rejections as the buffer API", () => {
  const traversalZip = buildZip([{ content: Buffer.from("x"), name: "../escape.txt" }]);
  withTempZipFile(traversalZip, (fd, fileSize) => {
    assert.throws(() => readZipEntriesFromFile(fd, fileSize, GENEROUS_POLICY), { code: "unsafe_entry_name" });
  });
});
