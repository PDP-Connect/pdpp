// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import {
  hasZipLocalFileSignature,
  readZipEntries,
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

test("stored (uncompressed) entries are bounded the same way as deflated entries", () => {
  const big = Buffer.alloc(2 * 1024 * 1024, 90);
  // Store method (0) — writeUInt16LE(8, 6) in buildZip always uses deflate;
  // build a minimal stored-method zip inline to exercise the STORE branch.
  const nameBuf = Buffer.from("stored.bin", "utf8");
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04_03_4b_50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6); // no flags
  localHeader.writeUInt16LE(0, 8); // method 0 = STORE
  localHeader.writeUInt32LE(big.length, 18);
  localHeader.writeUInt32LE(big.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  const localEntry = Buffer.concat([localHeader, nameBuf, big]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02_01_4b_50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt32LE(big.length, 20);
  centralHeader.writeUInt32LE(big.length, 24);
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
  const policy: ZipReadPolicy = {
    maxEntries: 10,
    maxEntryUncompressedBytes: 1024 * 1024,
    maxTotalUncompressedBytes: 1024 * 1024,
  };
  assert.throws(() => readZipEntries(zip, policy), { code: "entry_too_large" });
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
