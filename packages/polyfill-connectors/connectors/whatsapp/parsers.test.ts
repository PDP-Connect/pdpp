// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves `sent_at` is always a real parsed export timestamp. `sent_at` is the
 * manifest's semantic-time source for the messages stream, so a line whose
 * date won't parse must not be stamped with the run's clock.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWhatsAppChatFile, parseWhatsAppDateTime } from "./parsers.ts";

process.env.TZ = "America/Chicago";

test("parseWhatsAppDateTime: returns null for an impossible calendar date", () => {
  assert.equal(parseWhatsAppDateTime("31/02/2024", "09:15"), null);
  assert.equal(parseWhatsAppDateTime("1/1/1969", "09:15"), null);
  assert.ok(parseWhatsAppDateTime("6/5/24", "9:15:22 AM"));
});

test("parseWhatsAppChatFile: an unparseable date folds into the prior message, never the run clock", () => {
  const before = new Date().toISOString();
  const parsed = parseWhatsAppChatFile(
    "WhatsApp Chat with Alice.txt",
    ["[6/5/24, 9:15:22 AM] Alice: real message", "[31/02/24, 9:16:00 AM] Bob: impossible date"].join("\n")
  );

  // The impossible-date line contributes text but never its own record.
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0]?.author, "Alice");
  assert.match(parsed.messages[0]?.content ?? "", /impossible date/);

  // No message carries a timestamp from this run.
  for (const message of parsed.messages) {
    assert.ok(message.sent_at < before, `sent_at ${message.sent_at} looks like ingest time`);
  }
});

test("parseWhatsAppChatFile: parses well-formed lines into one record each", () => {
  const parsed = parseWhatsAppChatFile(
    "WhatsApp Chat with Alice.txt",
    ["[6/5/24, 9:15:22 AM] Alice: first", "[6/5/24, 9:16:00 AM] Bob: second"].join("\n")
  );

  assert.equal(parsed.messages.length, 2);
  assert.deepEqual(parsed.participants, ["Alice", "Bob"]);
});
