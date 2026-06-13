import assert from "node:assert/strict";
import { test } from "node:test";
import { validateWhatsAppChatExportArtifact } from "./validation.ts";

const VALID_EXPORT = `[6/5/24, 9:15:22 AM] Alice: Hello
[6/5/24, 9:16:00 AM] Bob: <Media omitted>
[6/5/24, 9:17:00 AM] Alice: Multi
line message`;

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
  assert.equal(validation.date_range.start, "2024-06-05T14:15:22.000Z");
  assert.equal(validation.date_range.end, "2024-06-05T14:17:00.000Z");
  assert.match(validation.file_sha256, /^[0-9a-f]{64}$/);
  assert.match(validation.warnings[0] ?? "", /media files are not included/i);
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
