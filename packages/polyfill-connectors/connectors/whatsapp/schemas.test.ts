/**
 * Schema tests for the WhatsApp connector. The parsing logic is inline in
 * index.ts (no parsers.ts), so these tests assert the schema against literal
 * records shaped exactly as index.ts's `emitRecord` calls build them — the
 * authoritative emitted shape. SLVP "validate representative emitted records".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { chatsSchema, messagesSchema, validateRecord } from "./schemas.ts";

// A chat record exactly as index.ts emits it: 16-hex id, filename-derived
// title, participant list, count, first/last sent_at.
const CHAT_RECORD = {
  id: "0123456789abcdef",
  title: "Family Group",
  participants: ["Alice", "Bob", "Carol"],
  message_count: 3,
  first_message_date: "2024-06-05T13:45:22.000Z",
  last_message_date: "2024-06-06T09:10:00.000Z",
};

// A message record exactly as index.ts emits it: "<chatId>:<index>" id.
const MESSAGE_RECORD = {
  id: "0123456789abcdef:0",
  chat_id: "0123456789abcdef",
  author: "Alice",
  content: "hey, are we still on for tomorrow?",
  has_attachment: false,
  sent_at: "2024-06-05T13:45:22.000Z",
};

test("chats schema accepts a representative emitted record", () => {
  const result = chatsSchema.safeParse(CHAT_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("chats schema accepts an empty chat (null date range)", () => {
  const result = chatsSchema.safeParse({
    ...CHAT_RECORD,
    participants: [],
    message_count: 0,
    first_message_date: null,
    last_message_date: null,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("messages schema accepts a representative emitted record", () => {
  const result = messagesSchema.safeParse(MESSAGE_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("messages schema accepts an attachment-only message (empty content)", () => {
  const result = messagesSchema.safeParse({
    ...MESSAGE_RECORD,
    content: "",
    has_attachment: true,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("messages schema rejects a malformed id (not <chatId>:<index>)", () => {
  assert.equal(messagesSchema.safeParse({ ...MESSAGE_RECORD, id: "no-colon" }).success, false);
});

test("chats schema rejects a non-hex chat id (filename-hash drift)", () => {
  assert.equal(chatsSchema.safeParse({ ...CHAT_RECORD, id: "Family Group.txt" }).success, false);
});

test("validateRecord routes by stream and passes unknown streams through", () => {
  assert.equal(validateRecord("chats", CHAT_RECORD).ok, true);
  assert.equal(validateRecord("messages", MESSAGE_RECORD).ok, true);
  assert.equal(validateRecord("unknown_stream", { x: 1 }).ok, true);
});
