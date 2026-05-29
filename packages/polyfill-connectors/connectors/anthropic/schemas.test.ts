/**
 * Schema tests for the Anthropic/Claude connector.
 *
 * IMPORTANT: anthropic/index.ts does not yet emit any RECORD (Claude API
 * extraction is deferred; it emits SKIP_RESULT). So these fixtures are NOT
 * parser-derived — they are records shaped to the connector's MANIFEST stream
 * contract (manifests/anthropic.json). They prove the schema accepts the
 * declared contract and rejects representative drift, so the first real emit is
 * shape-checked. Whoever wires extraction MUST replace these with
 * fixture-proven records and tighten the id shapes (Claude ids are expected to
 * be UUIDs).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationsSchema, messagesSchema, projectsSchema, validateRecord } from "./schemas.ts";

const CONVERSATION_RECORD = {
  id: "9f8e7d6c-1234-4abc-9def-0123456789ab",
  title: "Debugging the connector gate",
  create_time: "2024-05-01T10:00:00.000Z",
  update_time: "2024-05-02T14:30:00.000Z",
  project_id: "11112222-3333-4444-5555-666677778888",
  model: "claude-3-5-sonnet",
  message_count: 12,
};

const MESSAGE_RECORD = {
  id: "msg_01ABCdefGHIjklMNOpqr",
  conversation_id: "9f8e7d6c-1234-4abc-9def-0123456789ab",
  role: "assistant",
  content: "Here's how the build-time gate works...",
  model: "claude-3-5-sonnet",
  create_time: "2024-05-02T14:30:00.000Z",
};

const PROJECT_RECORD = {
  id: "11112222-3333-4444-5555-666677778888",
  name: "PDPP connectors",
  description: "All connector work for the reference implementation.",
  create_time: "2024-04-01T09:00:00.000Z",
  update_time: "2024-05-02T14:30:00.000Z",
};

test("conversations schema accepts a contract-shaped record", () => {
  const result = conversationsSchema.safeParse(CONVERSATION_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("conversations schema accepts a minimal record (only id, rest null)", () => {
  const result = conversationsSchema.safeParse({
    id: "9f8e7d6c-1234-4abc-9def-0123456789ab",
    title: null,
    create_time: null,
    update_time: null,
    project_id: null,
    model: null,
    message_count: null,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("messages schema accepts a contract-shaped record", () => {
  const result = messagesSchema.safeParse(MESSAGE_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("projects schema accepts a contract-shaped record", () => {
  const result = projectsSchema.safeParse(PROJECT_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("messages schema rejects a missing conversation_id (manifest-required field)", () => {
  const { conversation_id: _omit, ...withoutConv } = MESSAGE_RECORD;
  assert.equal(messagesSchema.safeParse(withoutConv).success, false);
});

test("conversations schema rejects a negative message_count", () => {
  assert.equal(conversationsSchema.safeParse({ ...CONVERSATION_RECORD, message_count: -1 }).success, false);
});

test("projects schema rejects a missing name (manifest-required field)", () => {
  const { name: _omit, ...withoutName } = PROJECT_RECORD;
  assert.equal(projectsSchema.safeParse(withoutName).success, false);
});

test("validateRecord routes all three streams and passes unknown streams through", () => {
  assert.equal(validateRecord("conversations", CONVERSATION_RECORD).ok, true);
  assert.equal(validateRecord("messages", MESSAGE_RECORD).ok, true);
  assert.equal(validateRecord("projects", PROJECT_RECORD).ok, true);
  assert.equal(validateRecord("unknown_stream", { x: 1 }).ok, true);
});
