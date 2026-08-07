// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fixture-based parser/schema unit tests for the Google Messages connector's
 * `gmcli --json` parsing. Proves parseGmcliMessagesJson against canned
 * fixtures and that every parsed record validates against messagesSchema.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEmptyMessagesJsonFixture,
  buildMalformedMessagesJsonFixture,
  buildMessagesJsonFixture,
  buildNotJsonFixture,
} from "./fixtures.ts";
import { GmcliError, parseGmcliMessagesJson } from "./index.ts";
import { messagesSchema } from "./schemas.ts";

test("parseGmcliMessagesJson parses the source-verified RichHit fixture shape", () => {
  const parsed = parseGmcliMessagesJson(buildMessagesJsonFixture());
  assert.equal(parsed.length, 2);
  const [first, second] = parsed;
  assert.equal(first?.id, "msg_0001");
  assert.equal(first?.chat_id, "chat_alice");
  assert.equal(first?.direction, "incoming");
  assert.equal(second?.direction, "outgoing");
  for (const message of parsed) {
    const result = messagesSchema.safeParse(message);
    assert.ok(result.success, result.success ? "" : JSON.stringify(result.error.issues));
  }
});

test("parseGmcliMessagesJson returns an empty array for an empty archive", () => {
  const parsed = parseGmcliMessagesJson(buildEmptyMessagesJsonFixture());
  assert.deepEqual(parsed, []);
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
