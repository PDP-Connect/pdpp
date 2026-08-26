// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildConversationRecord,
  buildMessageRecord,
  buildReactionRecord,
  extractReactionsFromMessageJson,
  parseMessageJson,
  signalEpochMsToIso,
} from "./parsers.ts";

// ─── signalEpochMsToIso ───────────────────────────────────────────────────

test("signalEpochMsToIso converts a positive epoch-ms value to ISO", () => {
  assert.equal(signalEpochMsToIso(1_717_594_922_000), "2024-06-05T13:42:02.000Z");
});

test("signalEpochMsToIso returns null for null/undefined/zero/negative/non-finite", () => {
  assert.equal(signalEpochMsToIso(null), null);
  assert.equal(signalEpochMsToIso(undefined), null);
  assert.equal(signalEpochMsToIso(0), null);
  assert.equal(signalEpochMsToIso(-5), null);
  assert.equal(signalEpochMsToIso(Number.NaN), null);
  assert.equal(signalEpochMsToIso(Number.POSITIVE_INFINITY), null);
});

// ─── parseMessageJson ─────────────────────────────────────────────────────

test("parseMessageJson decodes a well-formed messageJSON blob", () => {
  const json = parseMessageJson('{"attachments":[{"path":"a"}],"reactions":[{"emoji":"👍","fromId":"x"}]}');
  assert.equal(json.attachments?.length, 1);
  assert.equal(json.reactions?.length, 1);
});

test("parseMessageJson returns {} for null/empty/malformed input", () => {
  assert.deepEqual(parseMessageJson(null), {});
  assert.deepEqual(parseMessageJson(undefined), {});
  assert.deepEqual(parseMessageJson(""), {});
  assert.deepEqual(parseMessageJson("not json"), {});
  assert.deepEqual(parseMessageJson("42"), {});
  assert.deepEqual(parseMessageJson("null"), {});
});

// ─── buildMessageRecord ───────────────────────────────────────────────────

test("buildMessageRecord builds a record from a fully-populated row", () => {
  const built = buildMessageRecord({
    body: "hey there",
    conversationId: "11111111-1111-1111-1111-111111111111",
    id: "22222222-2222-2222-2222-222222222222",
    json: '{"attachments":[{"path":"a"}],"editHistory":[{"body":"old"}]}',
    receivedAtMs: 1_717_594_930_000,
    sentAt: 1_717_594_922_000,
    sourceServiceId: "33333333-3333-3333-3333-333333333333",
    type: "incoming",
  });
  assert.equal(built.record.id, "22222222-2222-2222-2222-222222222222");
  assert.equal(built.record.conversation_id, "11111111-1111-1111-1111-111111111111");
  assert.equal(built.record.sender, "33333333-3333-3333-3333-333333333333");
  assert.equal(built.record.sent_at, "2024-06-05T13:42:02.000Z");
  assert.equal(built.record.body, "hey there");
  assert.equal(built.record.type, "incoming");
  assert.equal(built.record.has_attachments, true);
  assert.equal(built.record.is_edited, true);
  assert.equal(built.sentAtMs, 1_717_594_922_000);
});

test("buildMessageRecord falls back to receivedAtMs when sentAt is unusable", () => {
  const built = buildMessageRecord({
    body: null,
    conversationId: "11111111-1111-1111-1111-111111111111",
    id: "22222222-2222-2222-2222-222222222222",
    json: null,
    receivedAtMs: 1_717_594_930_000,
    sentAt: null,
    sourceServiceId: null,
    type: null,
  });
  assert.equal(built.record.sent_at, "2024-06-05T13:42:10.000Z");
  assert.equal(built.sentAtMs, 1_717_594_930_000);
  assert.equal(built.record.sender, null);
});

test("buildMessageRecord reports sentAtMs=null and sent_at=null when neither timestamp is usable (skip signal for index.ts)", () => {
  const built = buildMessageRecord({
    body: "no usable date",
    conversationId: "11111111-1111-1111-1111-111111111111",
    id: "22222222-2222-2222-2222-222222222222",
    json: null,
    receivedAtMs: null,
    sentAt: 0,
    sourceServiceId: null,
    type: null,
  });
  assert.equal(built.record.sent_at, null);
  assert.equal(built.sentAtMs, null);
});

test("buildMessageRecord degrades has_attachments/is_edited to false on malformed json without failing", () => {
  const built = buildMessageRecord({
    body: "x",
    conversationId: "11111111-1111-1111-1111-111111111111",
    id: "22222222-2222-2222-2222-222222222222",
    json: "not valid json {",
    receivedAtMs: null,
    sentAt: 1_717_594_922_000,
    sourceServiceId: null,
    type: null,
  });
  assert.equal(built.record.has_attachments, false);
  assert.equal(built.record.is_edited, false);
});

test("buildMessageRecord: empty attachments/editHistory arrays report false, not true", () => {
  const built = buildMessageRecord({
    body: "x",
    conversationId: "11111111-1111-1111-1111-111111111111",
    id: "22222222-2222-2222-2222-222222222222",
    json: '{"attachments":[],"editHistory":[]}',
    receivedAtMs: null,
    sentAt: 1_717_594_922_000,
    sourceServiceId: null,
    type: null,
  });
  assert.equal(built.record.has_attachments, false);
  assert.equal(built.record.is_edited, false);
});

// ─── buildConversationRecord ──────────────────────────────────────────────

test("buildConversationRecord builds a private conversation record", () => {
  const record = buildConversationRecord({
    e164: "+15551234567",
    groupId: null,
    id: "11111111-1111-1111-1111-111111111111",
    name: "Alice",
    serviceId: "33333333-3333-3333-3333-333333333333",
    type: "private",
  });
  assert.equal(record.id, "11111111-1111-1111-1111-111111111111");
  assert.equal(record.type, "private");
  assert.equal(record.title, "Alice");
  assert.equal(record.member_count, null);
});

test("buildConversationRecord builds a group conversation record with null title when name is absent", () => {
  const record = buildConversationRecord({
    e164: null,
    groupId: "group-abc",
    id: "44444444-4444-4444-4444-444444444444",
    name: null,
    serviceId: null,
    type: "group",
  });
  assert.equal(record.type, "group");
  assert.equal(record.title, null);
});

test("buildConversationRecord treats an unrecognized type as null rather than passing it through raw", () => {
  const record = buildConversationRecord({
    e164: null,
    groupId: null,
    id: "44444444-4444-4444-4444-444444444444",
    name: "x",
    serviceId: null,
    type: "some-future-type",
  });
  assert.equal(record.type, null);
});

// ─── buildReactionRecord / extractReactionsFromMessageJson ───────────────

test("buildReactionRecord builds the composite message_id:emoji:sender id", () => {
  const record = buildReactionRecord({
    emoji: "👍",
    fromId: "33333333-3333-3333-3333-333333333333",
    messageId: "22222222-2222-2222-2222-222222222222",
  });
  assert.equal(record.id, "22222222-2222-2222-2222-222222222222:👍:33333333-3333-3333-3333-333333333333");
  assert.equal(record.message_id, "22222222-2222-2222-2222-222222222222");
  assert.equal(record.emoji, "👍");
  assert.equal(record.sender, "33333333-3333-3333-3333-333333333333");
});

test("extractReactionsFromMessageJson extracts every well-formed reaction", () => {
  const json = parseMessageJson(
    '{"reactions":[{"emoji":"👍","fromId":"a","targetTimestamp":1},{"emoji":"❤️","fromId":"b","targetTimestamp":2}]}'
  );
  const reactions = extractReactionsFromMessageJson("msg-1", json);
  assert.equal(reactions.length, 2);
  assert.deepEqual(reactions[0], { emoji: "👍", fromId: "a", messageId: "msg-1" });
  assert.deepEqual(reactions[1], { emoji: "❤️", fromId: "b", messageId: "msg-1" });
});

test("extractReactionsFromMessageJson returns [] when reactions is absent or not an array", () => {
  assert.deepEqual(extractReactionsFromMessageJson("msg-1", {}), []);
  assert.deepEqual(extractReactionsFromMessageJson("msg-1", parseMessageJson('{"reactions":"not-an-array"}')), []);
});

test("extractReactionsFromMessageJson drops a reaction missing emoji or fromId rather than fabricating a placeholder", () => {
  const json = parseMessageJson(
    '{"reactions":[{"emoji":"","fromId":"a"},{"emoji":"👍","fromId":""},{"fromId":"a"},{"emoji":"👍"}]}'
  );
  assert.deepEqual(extractReactionsFromMessageJson("msg-1", json), []);
});
