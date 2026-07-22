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
