// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fixture-based parser/schema unit tests for the Google Messages connector's
 * `gmcli --json` parsing (both `chats list` and `messages list --conv`).
 * Proves parseGmcliChatsJson/parseGmcliMessagesJson against canned fixtures
 * and that every parsed message record validates against messagesSchema.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatsJsonFixture,
  buildEmptyChatsJsonFixture,
  buildEmptyMessagesJsonFixture,
  buildFullPageMessagesJsonFixture,
  buildMalformedChatsJsonFixture,
  buildMalformedMessagesJsonFixture,
  buildMessagesJsonFixture,
  buildNotJsonFixture,
} from "./fixtures.ts";
import { GmcliError, parseGmcliChatsJson, parseGmcliMessagesJson } from "./index.ts";
import { messagesSchema } from "./schemas.ts";

test("parseGmcliChatsJson parses the source-verified Conversation fixture shape", () => {
  const chats = parseGmcliChatsJson(buildChatsJsonFixture());
  assert.equal(chats.length, 1);
  assert.equal(chats[0]?.id, "chat_alice");
  assert.equal(chats[0]?.name, "Alice");
});

test("parseGmcliChatsJson returns an empty array for a paired-but-empty archive", () => {
  assert.deepEqual(parseGmcliChatsJson(buildEmptyChatsJsonFixture()), []);
});

test("parseGmcliChatsJson throws a typed GmcliError on a chat missing conversation_id", () => {
  assert.throws(
    () => parseGmcliChatsJson(buildMalformedChatsJsonFixture()),
    (err: unknown) => {
      assert.ok(err instanceof GmcliError);
      assert.equal(err.kind, "query_failed");
      return true;
    }
  );
});

test("parseGmcliMessagesJson parses the source-verified Message fixture shape", () => {
  const parsed = parseGmcliMessagesJson(buildMessagesJsonFixture(), "Alice");
  assert.equal(parsed.length, 2);
  const [first, second] = parsed;
  assert.equal(first?.id, "msg_0001");
  assert.equal(first?.chat_id, "chat_alice");
  assert.equal(first?.chat_name, "Alice");
  assert.equal(first?.sender_id, "+15551230001");
  assert.equal(first?.direction, "incoming");
  assert.equal(second?.direction, "outgoing");
  for (const message of parsed) {
    const result = messagesSchema.safeParse(message);
    assert.ok(result.success, result.success ? "" : JSON.stringify(result.error.issues));
  }
});

test("parseGmcliMessagesJson returns an empty array for an empty conversation", () => {
  const parsed = parseGmcliMessagesJson(buildEmptyMessagesJsonFixture());
  assert.deepEqual(parsed, []);
});

test("parseGmcliMessagesJson returns exactly `limit` rows for a full-page fixture (truncation proxy)", () => {
  const parsed = parseGmcliMessagesJson(buildFullPageMessagesJsonFixture(50));
  assert.equal(parsed.length, 50);
});

test("parseGmcliMessagesJson throws a typed GmcliError on missing required fields", () => {
  assert.throws(
    () => parseGmcliMessagesJson(buildMalformedMessagesJsonFixture()),
    (err: unknown) => {
      assert.ok(err instanceof GmcliError);
      assert.equal(err.kind, "query_failed");
      return true;
    }
  );
});

test("parseGmcliMessagesJson rejects a zero timestamp_ms rather than stamping 1970 on sent_at", () => {
  const zeroTs = JSON.stringify([
    {
      message_id: "m1",
      conversation_id: "c1",
      body: "hi",
      timestamp_ms: 0,
      is_from_me: true,
    },
  ]);
  assert.throws(
    () => parseGmcliMessagesJson(zeroTs),
    (err: unknown) => {
      assert.ok(err instanceof GmcliError);
      assert.equal(err.kind, "query_failed");
      return true;
    }
  );
});

test("parseGmcliMessagesJson throws a typed GmcliError on non-JSON output", () => {
  assert.throws(
    () => parseGmcliMessagesJson(buildNotJsonFixture()),
    (err: unknown) => {
      assert.ok(err instanceof GmcliError);
      assert.equal(err.kind, "query_failed");
      return true;
    }
  );
});
