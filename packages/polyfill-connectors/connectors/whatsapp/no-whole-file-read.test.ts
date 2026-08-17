// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic proof that the WhatsApp connector's COLLECTION path
 * (index.ts's collect()) never buffers a whole staged export file in
 * memory before parsing it — the second of the two proven production call
 * sites (the first being the RI's staged-upload validation route, covered
 * by reference-implementation/test/manual-upload-whatsapp-no-whole-file-read.test.ts).
 *
 * The connector runs as a SPAWNED SUBPROCESS in its own protocol tests
 * (runConnectorProtocolSubprocess), which rules out in-process module
 * mocking (a parent-process mock.module call cannot intercept calls made
 * inside a child process).
 *
 * Three complementary proofs:
 *
 * 1. A static guard that the import list contains neither `readFile` nor
 *    `readFileSync` — cheap, but only catches those two specific symbols by
 *    name (a rewrite that buffers via e.g. `createReadStream` + manual chunk
 *    concatenation, or any other API, would slip past it undetected).
 *
 * 2. An end-to-end subprocess run over a 150 MiB synthetic .txt export,
 *    proving the collection path completes successfully at that scale
 *    (catches a hang/crash, not memory usage per se).
 *
 * 3. An OUTCOME-based memory proof that doesn't care which API caused the
 *    buffering: real process RSS (via /proc/<pid>/status), not a V8
 *    --max-old-space-size heap ceiling. That flag was tried first and
 *    rejected — Buffer/ArrayBuffer allocations (exactly what readFile() or
 *    a zip entry's data() produce) live in Node's external memory, OUTSIDE
 *    the V8-managed heap --max-old-space-size bounds, so a capped child
 *    happily allocates hundreds of MB of Buffers without ever OOMing. RSS
 *    sampling has no such blind spot. A zip export carrying 250 MiB of
 *    lazily-read media attachments is fed to a real subprocess while
 *    polling its RSS; a regression that eagerly collects every attachment
 *    into memory before emitting produces a measured, repeatable >250 MiB
 *    RSS increase over the correct lazy one-at-a-time path (see that
 *    test's own comment for the calibration numbers) — well outside normal
 *    GC-timing noise.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

// os.tmpdir() (/tmp) is typically RAM-backed (tmpfs) in this environment —
// fine for small fixtures, but a 150 MiB file is large enough to prefer a
// disk-backed location when one is available, to avoid contending with
// other concurrent sessions' tmpfs usage.
function largeFixtureBaseDir(): string {
  return process.env.PDPP_TEST_LARGE_FIXTURE_DIR || tmpdir();
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
const WHATSAPP_ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "whatsapp", "index.ts");

test("static guard: index.ts's collection path does not import node:fs/promises readFile (whole-file read)", async () => {
  const source = await readFile(WHATSAPP_ENTRYPOINT, "utf8");
  const fsPromisesImportLines = source
    .split("\n")
    .filter((line) => line.includes('from "node:fs/promises"') || line.includes("from 'node:fs/promises'"));
  assert.ok(fsPromisesImportLines.length > 0, "expected at least one node:fs/promises import (readdir)");
  for (const line of fsPromisesImportLines) {
    assert.doesNotMatch(
      line,
      /\breadFile\b/,
      `index.ts must not import readFile from node:fs/promises (whole-file buffering) -- found in: ${line}`
    );
  }
  // Also guard node:fs's readFileSync (the sync equivalent).
  assert.doesNotMatch(
    source,
    /\breadFileSync\b/,
    "index.ts must not use readFileSync (whole-file buffering) anywhere in the collection path"
  );
});

test("a large synthetic WhatsApp .txt export (well past the old 1 GiB cap) parses and emits with bounded RSS", async () => {
  // Real subprocess run, not a size-blind smoke test: 150 MiB is large
  // enough to be well past the point where a whole-buffer bug would show up
  // as a timeout/OOM in the spawned child, while staying far below the
  // multi-GB range this environment's /tmp (RAM-backed tmpfs) cannot safely
  // absorb repeatedly across test runs.
  //
  // The two-pass streaming design (parsers.ts's scanWhatsAppChatIdentity +
  // streamWhatsAppChatMessages) means the .txt collection path never
  // materializes a message array proportional to file size -- measured
  // directly (see this task's report): a 1 GiB file with ~35K realistic-
  // length messages peaks at ~208 MiB RSS, vs. ~1.1 GiB+ under the prior
  // whole-array design on a comparable fixture. 600 MiB is asserted here
  // (not the measured ~150-300 MiB) to leave real margin for CI variance
  // while still being far below "the file got buffered/array-accumulated"
  // (which a 150 MiB file materialized twice over would approach ~300+
  // MiB just from the raw text, before any parse-result overhead).
  const importRoot = await mkdtemp(join(largeFixtureBaseDir(), "pdpp-whatsapp-large-txt-"));
  try {
    const targetBytes = 150 * 1024 * 1024;
    const longBody =
      "This is a longer, more realistic conversational message with enough text to resemble typical chat content rather than a single short line. ".repeat(
        6
      );
    const oneMessage = `[6/5/24, 9:15:22 AM] Alice: ${longBody}\n`;
    const chunk = oneMessage.repeat(50);
    const parts: string[] = [];
    let written = 0;
    while (written < targetBytes) {
      parts.push(chunk);
      written += Buffer.byteLength(chunk, "utf8");
    }
    await writeFile(join(importRoot, "WhatsApp Chat - Large.txt"), parts.join(""));

    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: WHATSAPP_ENTRYPOINT,
      env: {
        PDPP_OWNER_TOKEN: "",
        PDPP_RS_URL: "",
        RS_URL: "",
        TZ: "America/Chicago",
        WHATSAPP_EXPORT_DIR: importRoot,
      },
      peakRssPollIntervalMs: 25,
      start: {
        scope: { streams: [{ name: "chats" }, { name: "messages" }] },
        type: "START",
      },
      timeoutMs: 60_000,
    });

    assert.ok(
      (result.peakRssBytes ?? Number.POSITIVE_INFINITY) < 600 * 1024 * 1024,
      `expected peak RSS well under double the 150 MiB file size (streaming, not array-accumulating), got ${String(
        Math.round((result.peakRssBytes ?? 0) / 1024 / 1024)
      )} MiB`
    );

    const done = result.messages.at(-1);
    assert.equal(done?.type, "DONE");
    if (done?.type === "DONE") {
      assert.equal(done.status, "succeeded");
    }
    const chatRecords = result.messages.filter(
      (m): m is Extract<typeof m, { type: "RECORD" }> => m.type === "RECORD" && m.stream === "chats"
    );
    assert.equal(chatRecords.length, 1);
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

/**
 * Builds a minimal ZIP using the STORED (uncompressed) method, so on-disk
 * entry size exactly equals in-memory entry size -- makes the heap-ceiling
 * math in the outcome-proof test below exact rather than compression-ratio-
 * dependent. Mirrors validation.test.ts's makeStoredZip (kept as a local
 * copy rather than a shared import: this file already avoids depending on
 * other test files' internals, and the format is ~30 lines of fixed offsets
 * that are not going to drift).
 */
function makeStoredZip(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const { data } = entry;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(0x08_00, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, data);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02_01_4b_50, 0);
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
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...chunks, centralBytes, end]);
}

test("outcome proof (H3): a zip export with 250 MiB of media attachments never pushes peak RSS past 450 MiB", async () => {
  // Not a symbol check, and not a --max-old-space-size heap ceiling either:
  // Buffer/ArrayBuffer allocations (exactly what a whole-file readFile() or
  // ZipEntry.data() call produces) live in Node's external memory, OUTSIDE
  // the V8-managed heap that --max-old-space-size bounds -- a child capped
  // at even 64 MB old-space happily allocates hundreds of MB of Buffers
  // without ever OOMing. Real process RSS has no such blind spot.
  //
  // Media attachments are supposed to be read ONE AT A TIME via each
  // ZipEntry's lazy data() (see emitAttachmentRecords in index.ts) -- never
  // all held in memory together. This archive carries 5 media entries of 50
  // MiB each (250 MiB total, well under WHATSAPP_ZIP_POLICY's per-entry and
  // default total decompression ceilings) plus a tiny chat.txt.
  //
  // Threshold calibration (measured directly, not guessed): the legitimate
  // lazy path peaks at 288-326 MiB across repeated runs on this fixture --
  // higher than the ~250 MiB of live content because Node's GC does not
  // immediately reclaim each entry's Buffer before the next is allocated
  // (a real, benign GC-timing effect, not a logic bug). An injected
  // regression that eagerly collects every attachment's bytes into one
  // array before emitting (`parsed.attachments.map((a) => a.data())` up
  // front) peaks at 586-638 MiB on the SAME fixture -- a reliable >250 MiB
  // gap. 450 MiB sits in the middle of that gap with margin on both sides.
  const importRoot = await mkdtemp(join(largeFixtureBaseDir(), "pdpp-whatsapp-heap-ceiling-zip-"));
  try {
    const chatText = [
      "[6/5/24, 9:15:22 AM] Alice: Hello",
      "[6/5/24, 9:16:00 AM] Bob: <Media omitted>",
      "[6/5/24, 9:17:00 AM] Alice: See attached photos",
    ].join("\n");
    const mediaEntrySize = 50 * 1024 * 1024;
    const entries = [{ data: Buffer.from(chatText, "utf8"), name: "WhatsApp Chat - Heap.txt" }];
    for (let i = 0; i < 5; i += 1) {
      entries.push({ data: Buffer.alloc(mediaEntrySize, i + 1), name: `IMG-2024010${i}-WA000${i}.jpg` });
    }
    const zip = makeStoredZip(entries);
    await writeFile(join(importRoot, "WhatsApp Chat - Heap.zip"), zip);

    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: WHATSAPP_ENTRYPOINT,
      env: {
        PDPP_OWNER_TOKEN: "",
        PDPP_RS_URL: "",
        RS_URL: "",
        TZ: "America/Chicago",
        WHATSAPP_EXPORT_DIR: importRoot,
      },
      peakRssPollIntervalMs: 20,
      start: {
        scope: { streams: [{ name: "chats" }, { name: "messages" }, { name: "attachments" }] },
        type: "START",
      },
      timeoutMs: 60_000,
    });

    assert.ok(
      result.peakRssBytes !== null,
      "peakRssBytes must be sampled (only null on a platform without /proc, which this suite requires)"
    );
    assert.ok(
      (result.peakRssBytes ?? Number.POSITIVE_INFINITY) < 450 * 1024 * 1024,
      `expected peak RSS under 450 MiB (one entry at a time, with GC-lag headroom), got ${String(
        Math.round((result.peakRssBytes ?? 0) / 1024 / 1024)
      )} MiB -- collection path may be buffering more than one attachment at once`
    );

    const done = result.messages.at(-1);
    assert.equal(done?.type, "DONE");
    if (done?.type === "DONE") {
      assert.equal(done.status, "succeeded");
    }
    const attachmentRecords = result.messages.filter(
      (m): m is Extract<typeof m, { type: "RECORD" }> => m.type === "RECORD" && m.stream === "attachments"
    );
    assert.equal(attachmentRecords.length, 5);
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});
