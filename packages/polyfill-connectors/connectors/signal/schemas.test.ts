// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests for the Signal connector. Ground truth is `parsers.ts`'s
 * record builders (index.ts calls those, never builds a record literal
 * itself) — these tests assert the schema against literal records shaped
 * exactly as those builders produce them.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { attachmentsSchema, conversationsSchema, messagesSchema, reactionsSchema, validateRecord } from "./schemas.ts";

const MESSAGE_ID = "22222222-2222-2222-2222-222222222222";
const CONVERSATION_ID = "11111111-1111-1111-1111-111111111111";
const SENDER_ID = "33333333-3333-3333-3333-333333333333";

const MESSAGE_RECORD = {
  id: MESSAGE_ID,
  conversation_id: CONVERSATION_ID,
  sender: SENDER_ID,
  sent_at: "2024-06-05T13:22:02.000Z",
  body: "hey there",
  type: "incoming",
  has_attachments: false,
  is_edited: false,
};

test("messages schema accepts a fully-populated record", () => {
  const result = messagesSchema.safeParse(MESSAGE_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("messages schema accepts null sender/body/type", () => {
  const result = messagesSchema.safeParse({ ...MESSAGE_RECORD, sender: null, body: null, type: null });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("messages schema accepts a non-UUID sender (legacy e164/conversation-id-shaped value)", () => {
  const result = messagesSchema.safeParse({ ...MESSAGE_RECORD, sender: "+15551234567" });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("messages schema rejects a non-UUID id", () => {
  assert.equal(messagesSchema.safeParse({ ...MESSAGE_RECORD, id: "not-a-uuid" }).success, false);
});

test("messages schema rejects a non-ISO sent_at", () => {
  assert.equal(messagesSchema.safeParse({ ...MESSAGE_RECORD, sent_at: "1717594922000" }).success, false);
});

test("messages schema rejects a missing sent_at (null must never be emitted for this stream)", () => {
  assert.equal(messagesSchema.safeParse({ ...MESSAGE_RECORD, sent_at: null }).success, false);
});

test("validateRecord routes messages and passes unknown streams through", () => {
  assert.equal(validateRecord("messages", MESSAGE_RECORD).ok, true);
  assert.equal(validateRecord("unknown_stream", { x: 1 }).ok, true);
});

// ─── conversations ────────────────────────────────────────────────────────

const CONVERSATION_RECORD = {
  id: CONVERSATION_ID,
  type: "private",
  title: "Alice",
  member_count: null,
};

test("conversations schema accepts a private conversation record", () => {
  const result = conversationsSchema.safeParse(CONVERSATION_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("conversations schema accepts a group conversation record with null title", () => {
  const result = conversationsSchema.safeParse({ ...CONVERSATION_RECORD, type: "group", title: null });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("conversations schema accepts a null type", () => {
  const result = conversationsSchema.safeParse({ ...CONVERSATION_RECORD, type: null });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("conversations schema rejects an unrecognized type literal", () => {
  assert.equal(conversationsSchema.safeParse({ ...CONVERSATION_RECORD, type: "channel" }).success, false);
});

test("conversations schema rejects a non-UUID id", () => {
  assert.equal(conversationsSchema.safeParse({ ...CONVERSATION_RECORD, id: "not-a-uuid" }).success, false);
});

// ─── reactions ────────────────────────────────────────────────────────────

const REACTION_RECORD = {
  id: `${MESSAGE_ID}:👍:${SENDER_ID}`,
  message_id: MESSAGE_ID,
  emoji: "👍",
  sender: SENDER_ID,
};

test("reactions schema accepts a well-formed reaction record", () => {
  const result = reactionsSchema.safeParse(REACTION_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("reactions schema accepts a non-UUID sender (legacy e164/conversation-id-shaped value)", () => {
  const result = reactionsSchema.safeParse({ ...REACTION_RECORD, sender: "+15551234567" });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("reactions schema rejects an empty emoji", () => {
  assert.equal(reactionsSchema.safeParse({ ...REACTION_RECORD, emoji: "" }).success, false);
});

test("reactions schema rejects a non-UUID message_id", () => {
  assert.equal(reactionsSchema.safeParse({ ...REACTION_RECORD, message_id: "not-a-uuid" }).success, false);
});

// ─── attachments ──────────────────────────────────────────────────────────

const ATTACHMENT_HYDRATED = {
  id: "a".repeat(64),
  message_id: MESSAGE_ID,
  conversation_id: CONVERSATION_ID,
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

test("attachments schema accepts a deferred record with null blob_ref and null message_id/conversation_id (unjoined metadata)", () => {
  const result = attachmentsSchema.safeParse({
    ...ATTACHMENT_HYDRATED,
    hydration_status: "deferred",
    blob_ref: null,
    message_id: null,
    conversation_id: null,
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
  assert.equal(
    attachmentsSchema.safeParse({ ...ATTACHMENT_HYDRATED, id: "/home/tim/.config/Signal/x.jpg" }).success,
    false
  );
});

test("attachments schema rejects an unknown hydration_status", () => {
  assert.equal(attachmentsSchema.safeParse({ ...ATTACHMENT_HYDRATED, hydration_status: "bogus" }).success, false);
});
