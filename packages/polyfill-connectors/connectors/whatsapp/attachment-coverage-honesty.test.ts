// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A WhatsApp media entry is only known to be unreadable once its own `data()`
 * is called during emission (see `findChatTextEntry`'s note about deferring
 * skip accounting to `emitAttachmentRecords`). Those skipped files are
 * discovered but never collected, so they must read as a coverage shortfall.
 *
 * Before this contract the attachments DETAIL_COVERAGE used the raw discovered
 * count for both `considered` and `covered`, so an export whose media failed to
 * extract still reported fully covered — the runtime's coverage contract
 * explicitly forbids counting a weighed-but-dropped item as covered.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..", "..");
const WHATSAPP_ENTRYPOINT = join(__dirname, "index.ts");

const CHAT_EXPORT = `[6/5/24, 9:15:22 AM] Alice: Hello
[6/5/24, 9:16:00 AM] Bob: <attached: IMG-20240605-WA0001.jpg>
[6/5/24, 9:17:00 AM] Bob: <attached: IMG-20240605-WA0002.jpg>`;

function zipHeader(signature: number, size: number): Buffer {
  const header = Buffer.alloc(size);
  header.writeUInt32LE(signature, 0);
  return header;
}

/**
 * Build a stored (uncompressed) zip. `corruptDeflate` marks an entry as
 * DEFLATE-compressed while storing raw bytes, so the entry lists cleanly but
 * throws when its `data()` is finally called — the real shape of an
 * unreadable media file.
 */
function makeZip(entries: readonly { name: string; data: string | Buffer; corruptDeflate?: boolean }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const method = entry.corruptDeflate ? 8 : 0;
    const local = zipHeader(0x04_03_4b_50, 30);
    local.writeUInt16LE(0x08_00, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, data);

    const directory = zipHeader(0x02_01_4b_50, 46);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x08_00, 8);
    directory.writeUInt16LE(method, 10);
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

function attachmentCoverage(
  messages: readonly EmittedMessage[]
): Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> | undefined {
  return messages
    .filter(
      (message): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> => message.type === "DETAIL_COVERAGE"
    )
    .find((message) => message.stream === "attachments");
}

test("WhatsApp attachments - media that fails to extract reads as a coverage shortfall", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-whatsapp-skip-"));
  try {
    const stagedDir = join(importRoot, "artifact_skip");
    await mkdir(stagedDir, { recursive: true });
    // Two media files are declared by the chat text and present in the zip.
    // The second is unreadable, so only one can actually be collected.
    await writeFile(
      join(stagedDir, "Alice export.zip"),
      makeZip([
        { name: "WhatsApp Chat - Alice.txt", data: CHAT_EXPORT },
        { name: "IMG-20240605-WA0001.jpg", data: Buffer.from([1, 2, 3, 4]) },
        { name: "IMG-20240605-WA0002.jpg", data: Buffer.from([9, 9, 9, 9]), corruptDeflate: true },
      ])
    );

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
      start: {
        scope: { streams: [{ name: "chats" }, { name: "messages" }, { name: "attachments" }] },
        type: "START",
      },
    });

    const emittedAttachments = result.messages.filter(
      (message) => message.type === "RECORD" && message.stream === "attachments"
    );
    const coverage = attachmentCoverage(result.messages);

    assert.equal(emittedAttachments.length, 1, "only the readable media file can be emitted");
    assert.equal(coverage?.considered, 2, "both media files were discovered in the export");
    assert.equal(coverage?.covered, 1, "the unreadable media file must not count as covered");
    assert.ok(
      (coverage?.covered ?? 0) < (coverage?.considered ?? 0),
      "an export with unreadable media must not report full coverage"
    );

    const skipResults = result.messages.filter(
      (message) => message.type === "SKIP_RESULT" && message.stream === "attachments"
    );
    assert.equal(skipResults.length, 1, "the skipped media file is still disclosed as a SKIP_RESULT");
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("WhatsApp attachments - a fully readable export still proves full coverage", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-whatsapp-clean-"));
  try {
    const stagedDir = join(importRoot, "artifact_clean");
    await mkdir(stagedDir, { recursive: true });
    await writeFile(
      join(stagedDir, "Alice export.zip"),
      makeZip([
        { name: "WhatsApp Chat - Alice.txt", data: CHAT_EXPORT },
        { name: "IMG-20240605-WA0001.jpg", data: Buffer.from([1, 2, 3, 4]) },
        { name: "IMG-20240605-WA0002.jpg", data: Buffer.from([5, 6, 7, 8]) },
      ])
    );

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
      start: {
        scope: { streams: [{ name: "chats" }, { name: "messages" }, { name: "attachments" }] },
        type: "START",
      },
    });

    const coverage = attachmentCoverage(result.messages);
    assert.equal(coverage?.considered, 2);
    assert.equal(coverage?.covered, 2, "no media was dropped, so coverage stays complete");
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});
