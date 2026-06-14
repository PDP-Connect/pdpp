import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
const WHATSAPP_ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "whatsapp", "index.ts");

const VALID_EXPORT = `[6/5/24, 9:15:22 AM] Alice: Hello
[6/5/24, 9:16:00 AM] Bob: <attached: IMG-20240605-WA0001.jpg>`;

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

function records(messages: readonly EmittedMessage[], stream: string): Record<string, unknown>[] {
  return messages
    .filter((message): message is Extract<EmittedMessage, { type: "RECORD" }> => message.type === "RECORD")
    .filter((message) => message.stream === stream)
    .map((message) => message.data);
}

test("WhatsApp connector imports zip media as attachment records", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-whatsapp-media-"));
  try {
    const stagedDir = join(importRoot, "artifact_123");
    await mkdir(stagedDir, { recursive: true });
    const zip = makeStoredZip([
      { name: "WhatsApp Chat - Alice.txt", data: VALID_EXPORT },
      { name: "IMG-20240605-WA0001.jpg", data: Buffer.from([1, 2, 3, 4]) },
    ]);
    await writeFile(join(stagedDir, "Alice export.zip"), zip);

    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: WHATSAPP_ENTRYPOINT,
      env: {
        PDPP_OWNER_TOKEN: "",
        PDPP_RS_URL: "",
        RS_URL: "",
        WHATSAPP_EXPORT_DIR: importRoot,
      },
      start: {
        scope: { streams: [{ name: "chats" }, { name: "messages" }, { name: "attachments" }] },
        type: "START",
      },
    });

    const attachmentRecords = records(result.messages, "attachments");
    assert.equal(attachmentRecords.length, 1);
    assert.deepEqual(attachmentRecords[0]?.blob_ref, null);
    assert.equal(attachmentRecords[0]?.filename, "IMG-20240605-WA0001.jpg");
    assert.equal(attachmentRecords[0]?.content_type, "image/jpeg");
    assert.equal(attachmentRecords[0]?.size_bytes, 4);
    assert.equal(attachmentRecords[0]?.hydration_status, "deferred");
    assert.match(String(attachmentRecords[0]?.content_sha256), /^[0-9a-f]{64}$/);
    assert.match(String(attachmentRecords[0]?.message_id), /^[0-9a-f]{16}:1$/);

    assert.equal(records(result.messages, "chats").length, 1);
    assert.equal(records(result.messages, "messages").length, 2);
    const done = result.messages.at(-1);
    assert.equal(done?.type, "DONE");
    if (done?.type === "DONE") {
      assert.equal(done.status, "succeeded");
      assert.equal(done.records_emitted, 4);
    }
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});
