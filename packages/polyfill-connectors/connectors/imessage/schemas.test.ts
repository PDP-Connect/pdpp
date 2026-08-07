// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests for the iMessage connector. The record-building logic is inline
 * in index.ts (a SQLite row → record literal), so these tests assert the schema
 * against literal records shaped exactly as index.ts's `emitRecord` call builds
 * them — covering both the GUID id and the numeric-ROWID-fallback id. SLVP
 * "validate representative emitted records".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { attachmentsSchema, messagesSchema, participantsSchema, validateRecord } from "./schemas.ts";

// Record as index.ts emits it when the row has an Apple GUID.
const MESSAGE_GUID = {
  id: "A1B2C3D4-1111-2222-3333-444455556666",
  chat_id: "42",
  handle: "+15551234567",
  service: "iMessage",
  is_from_me: false,
  text: "see you then",
  date: "2024-06-05T13:45:22.000Z",
  date_read: "2024-06-05T13:50:00.000Z",
  has_attachments: false,
};

// Record when guid is null and index.ts falls back to String(ROWID), with a
// null chat_id (message not joined to a chat) and null text/date_read.
const MESSAGE_ROWID_FALLBACK = {
  id: "100294",
  chat_id: null,
  handle: "friend@example.com",
  service: "SMS",
  is_from_me: true,
  text: null,
  date: "2024-06-05T13:45:22.000Z",
  date_read: null,
  has_attachments: true,
};

test("messages schema accepts a GUID-id record", () => {
  const result = messagesSchema.safeParse(MESSAGE_GUID);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("messages schema accepts a ROWID-fallback record with null fields", () => {
  const result = messagesSchema.safeParse(MESSAGE_ROWID_FALLBACK);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("messages schema rejects a non-numeric chat_id (join leak)", () => {
  assert.equal(messagesSchema.safeParse({ ...MESSAGE_GUID, chat_id: "chat-uuid" }).success, false);
});

test("messages schema rejects a non-ISO date (Apple-epoch conversion bug)", () => {
  assert.equal(messagesSchema.safeParse({ ...MESSAGE_GUID, date: "707243122" }).success, false);
});

test("validateRecord routes messages and passes unknown streams through", () => {
  assert.equal(validateRecord("messages", MESSAGE_GUID).ok, true);
  assert.equal(validateRecord("unknown_stream", { x: 1 }).ok, true);
});

// participants stream: one record per (chat, handle) membership pair, as
// emitted by emitParticipantRows in index.ts.
const PARTICIPANT_RECORD = {
  id: "42:+15551234567",
  chat_id: "42",
  handle: "+15551234567",
  is_from_me: false,
};

test("participants schema accepts a membership record", () => {
  const result = participantsSchema.safeParse(PARTICIPANT_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("participants schema rejects a non-numeric chat_id", () => {
  assert.equal(participantsSchema.safeParse({ ...PARTICIPANT_RECORD, chat_id: "chat-uuid" }).success, false);
});

test("participants schema accepts a null handle (owner's own row)", () => {
  const result = participantsSchema.safeParse({ ...PARTICIPANT_RECORD, handle: null });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

// attachments stream: one record per attachment row, as emitted by
// emitAttachmentRows in index.ts. `id` is sha256(filename+rowid) — never a
// local path. `filename` is a basename, never a full local path.
const ATTACHMENT_HYDRATED = {
  id: "a".repeat(64),
  message_id: "B1B2C3D4-1111-2222-3333-444455556666",
  chat_id: "42",
  filename: "IMG_0001.jpg",
  content_type: "image/jpeg",
  size_bytes: 4096,
  content_sha256: "b".repeat(64),
  hydration_status: "hydrated",
  hydration_error: null,
  blob_ref: {
    blob_id: "blob_sha256_abc",
    mime_type: "image/jpeg",
    sha256: "b".repeat(64),
    size_bytes: 4096,
  },
};

test("attachments schema accepts a hydrated record", () => {
  const result = attachmentsSchema.safeParse(ATTACHMENT_HYDRATED);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("attachments schema accepts a deferred record with null blob_ref", () => {
  const result = attachmentsSchema.safeParse({
    ...ATTACHMENT_HYDRATED,
    hydration_status: "deferred",
    blob_ref: null,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("attachments schema accepts missing/too_large/failed statuses with null size/hash", () => {
  for (const status of ["missing", "too_large", "failed"] as const) {
    const result = attachmentsSchema.safeParse({
      ...ATTACHMENT_HYDRATED,
      hydration_status: status,
      hydration_error: "synthetic failure",
      blob_ref: null,
      content_sha256: null,
      size_bytes: null,
    });
    assert.ok(result.success, `${status}: ${JSON.stringify(result.error?.issues)}`);
  }
});

test("attachments schema rejects a non-hex id (would leak a raw local path)", () => {
  assert.equal(attachmentsSchema.safeParse({ ...ATTACHMENT_HYDRATED, id: "/Users/tim/Library/x.jpg" }).success, false);
});

test("attachments schema rejects an unknown hydration_status", () => {
  assert.equal(attachmentsSchema.safeParse({ ...ATTACHMENT_HYDRATED, hydration_status: "bogus" }).success, false);
});
