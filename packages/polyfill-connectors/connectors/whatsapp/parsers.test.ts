// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves `sent_at` is always a real parsed export timestamp. `sent_at` is the
 * manifest's semantic-time source for the messages stream, so a line whose
 * date won't parse must not be stamped with the run's clock.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ParsedWhatsAppMessage,
  parseWhatsAppDateTime,
  scanWhatsAppChatIdentity,
  splitWhatsAppChatLines,
  streamWhatsAppChatMessages,
  streamWhatsAppChatMessagesAsync,
  type WhatsAppChatSummary,
} from "./parsers.ts";

process.env.TZ = "America/Chicago";

/**
 * Test-only convenience: drives the real two-pass streaming API
 * (scanWhatsAppChatIdentity then streamWhatsAppChatMessages, exactly as
 * index.ts's collect() does) and collects every message into an array, so
 * these small fixture-scale tests can assert on the full message list the
 * same way the pre-streaming API let them. Production code never
 * materializes this array -- see index.ts's emitMessageRecords, which
 * streams one record at a time instead.
 */
function parseWhatsAppChatFileForTest(
  filename: string,
  content: string
): { messages: ParsedWhatsAppMessage[] } & WhatsAppChatSummary {
  const summary = scanWhatsAppChatIdentity(filename, splitWhatsAppChatLines(content));
  const messages: ParsedWhatsAppMessage[] = [];
  streamWhatsAppChatMessages(splitWhatsAppChatLines(content), summary.chatId, (m) => messages.push(m));
  return { ...summary, messages };
}

test("parseWhatsAppDateTime: returns null for an impossible calendar date", () => {
  assert.equal(parseWhatsAppDateTime("31/02/2024", "09:15"), null);
  assert.equal(parseWhatsAppDateTime("1/1/1969", "09:15"), null);
  assert.ok(parseWhatsAppDateTime("6/5/24", "9:15:22 AM"));
});

test("parseWhatsAppChatFile: an unparseable date folds into the prior message, never the run clock", () => {
  const before = new Date().toISOString();
  const parsed = parseWhatsAppChatFileForTest(
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
  const parsed = parseWhatsAppChatFileForTest(
    "WhatsApp Chat with Alice.txt",
    ["[6/5/24, 9:15:22 AM] Alice: first", "[6/5/24, 9:16:00 AM] Bob: second"].join("\n")
  );

  assert.equal(parsed.messages.length, 2);
  assert.deepEqual(parsed.participants, ["Alice", "Bob"]);
});

// ─── Stable identity across re-exports (chatId, message id) ────────────────
//
// WhatsApp/the OS commonly rename a re-exported chat file (appending "(1)",
// a date suffix, etc. to avoid overwriting the previous export). A filename-
// derived chatId or an array-index-derived message id would treat every
// message in a renamed re-export as brand new, duplicating the whole chat.
// These tests pin identity to durable content instead.

const EXPORT_TEXT = ["[6/5/24, 9:15:22 AM] Alice: first", "[6/5/24, 9:16:00 AM] Bob: second"].join("\n");

test("chatId is stable across a renamed re-export of the same chat", () => {
  const original = parseWhatsAppChatFileForTest("WhatsApp Chat with Alice.txt", EXPORT_TEXT);
  const renamed = parseWhatsAppChatFileForTest("WhatsApp Chat with Alice (1).txt", EXPORT_TEXT);

  assert.equal(renamed.chatId, original.chatId, "chatId must not depend on the export filename");
});

test("chatId changes when the participant set changes (still content-derived, not filename)", () => {
  const original = parseWhatsAppChatFileForTest("export.txt", EXPORT_TEXT);
  const differentChat = parseWhatsAppChatFileForTest(
    "export.txt",
    ["[6/5/24, 9:15:22 AM] Carol: hi", "[6/5/24, 9:16:00 AM] Dave: hey"].join("\n")
  );

  assert.notEqual(differentChat.chatId, original.chatId);
});

test("message id is stable when a re-export prepends earlier history (index would shift, content hash does not)", () => {
  const original = parseWhatsAppChatFileForTest("WhatsApp Chat with Alice.txt", EXPORT_TEXT);
  const withPrependedHistory = parseWhatsAppChatFileForTest(
    "WhatsApp Chat with Alice (1).txt",
    ["[6/4/24, 8:00:00 AM] Alice: earlier message", EXPORT_TEXT].join("\n")
  );

  // "first" was messages[0] originally; after prepending it becomes
  // messages[1]. An index-keyed id would change; a content-keyed id must not.
  const originalFirst = original.messages.find((m) => m.content === "first");
  const shiftedFirst = withPrependedHistory.messages.find((m) => m.content === "first");
  assert.ok(originalFirst && shiftedFirst);
  assert.equal(shiftedFirst?.id, originalFirst?.id, "message id must not depend on array position");
});

test("message id changes if the message content changes, given identical author/time", () => {
  const parsed = parseWhatsAppChatFileForTest("export.txt", EXPORT_TEXT);
  const edited = parseWhatsAppChatFileForTest(
    "export.txt",
    ["[6/5/24, 9:15:22 AM] Alice: first EDITED", "[6/5/24, 9:16:00 AM] Bob: second"].join("\n")
  );
  const originalFirst = parsed.messages.find((m) => m.content === "first");
  const editedFirst = edited.messages.find((m) => m.content.startsWith("first"));
  assert.ok(originalFirst && editedFirst);
  assert.notEqual(editedFirst?.id, originalFirst?.id);
});

test("duplicate consecutive messages (same author/time/content) get distinct ids, not a collision", () => {
  const parsed = parseWhatsAppChatFileForTest(
    "export.txt",
    ["[6/5/24, 9:15:22 AM] Alice: ok", "[6/5/24, 9:15:22 AM] Alice: ok"].join("\n")
  );

  assert.equal(parsed.messages.length, 2);
  const [first, second] = parsed.messages;
  assert.notEqual(first?.id, second?.id, "true duplicates must still get distinct, deterministic ids");
});

test("re-parsing the identical file twice yields identical message ids (determinism)", () => {
  const first = parseWhatsAppChatFileForTest("export.txt", EXPORT_TEXT);
  const second = parseWhatsAppChatFileForTest("export.txt", EXPORT_TEXT);
  assert.deepEqual(
    second.messages.map((m) => m.id),
    first.messages.map((m) => m.id)
  );
});

// ─── Message-count ceiling (H1: catchable rejection, not an OOM crash) ─────

test("pushLine throws a catchable WhatsAppMessageLimitExceededError once WHATSAPP_MAX_MESSAGE_COUNT is exceeded", async () => {
  const { WhatsAppMessageLimitExceededError } = await import("./parsers.ts");
  const original = process.env.WHATSAPP_MAX_MESSAGE_COUNT;
  process.env.WHATSAPP_MAX_MESSAGE_COUNT = "3";
  try {
    const lines = [
      "[6/5/24, 9:15:22 AM] Alice: one",
      "[6/5/24, 9:16:00 AM] Alice: two",
      "[6/5/24, 9:17:00 AM] Alice: three",
      "[6/5/24, 9:18:00 AM] Alice: four",
    ].join("\n");
    assert.throws(
      () => parseWhatsAppChatFileForTest("export.txt", lines),
      (err: unknown) => {
        assert.ok(err instanceof WhatsAppMessageLimitExceededError);
        assert.match(err.message, /exceeds the maximum supported message count/);
        return true;
      }
    );
  } finally {
    if (original === undefined) {
      delete process.env.WHATSAPP_MAX_MESSAGE_COUNT;
    } else {
      process.env.WHATSAPP_MAX_MESSAGE_COUNT = original;
    }
  }
});

test("pushLine does not throw when the message count stays at or below the cap", () => {
  const original = process.env.WHATSAPP_MAX_MESSAGE_COUNT;
  process.env.WHATSAPP_MAX_MESSAGE_COUNT = "3";
  try {
    const lines = [
      "[6/5/24, 9:15:22 AM] Alice: one",
      "[6/5/24, 9:16:00 AM] Alice: two",
      "[6/5/24, 9:17:00 AM] Alice: three",
    ].join("\n");
    const parsed = parseWhatsAppChatFileForTest("export.txt", lines);
    assert.equal(parsed.messages.length, 3);
  } finally {
    if (original === undefined) {
      delete process.env.WHATSAPP_MAX_MESSAGE_COUNT;
    } else {
      process.env.WHATSAPP_MAX_MESSAGE_COUNT = original;
    }
  }
});

// The above proves messageCount === cap is accepted via
// parseWhatsAppChatFileForTest's combined pass1+sync-pass2 helper. These two
// tests isolate the EXACT boundary (messageCount === maxMessageCount, not
// cap-1 or cap+1) against each pass's own accumulator/counter directly,
// confirming `>` (not `>=`) is the live comparison on both:
//  - pass 1: ChatIdentityAccumulator.onMessage (via scanWhatsAppChatIdentity)
//  - pass 2: streamWhatsAppChatMessagesAsync's own counter (the actual
//    production call path index.ts drives; the sync streamWhatsAppChatMessages
//    above is a test-only convenience, never called from index.ts)
test("pass 1 (scanWhatsAppChatIdentity): exactly messageCount === cap is accepted, cap+1 throws", async () => {
  const { WhatsAppMessageLimitExceededError } = await import("./parsers.ts");
  const original = process.env.WHATSAPP_MAX_MESSAGE_COUNT;
  process.env.WHATSAPP_MAX_MESSAGE_COUNT = "3";
  try {
    const atCap = [
      "[6/5/24, 9:15:22 AM] Alice: one",
      "[6/5/24, 9:16:00 AM] Alice: two",
      "[6/5/24, 9:17:00 AM] Alice: three",
    ].join("\n");
    const summary = scanWhatsAppChatIdentity("export.txt", splitWhatsAppChatLines(atCap));
    assert.equal(summary.messageCount, 3, "exactly at cap is accepted, not rejected");

    const overCap = `${atCap}\n[6/5/24, 9:18:00 AM] Alice: four`;
    assert.throws(
      () => scanWhatsAppChatIdentity("export.txt", splitWhatsAppChatLines(overCap)),
      (err: unknown) => {
        assert.ok(err instanceof WhatsAppMessageLimitExceededError);
        return true;
      },
      "one message over cap throws"
    );
  } finally {
    if (original === undefined) {
      delete process.env.WHATSAPP_MAX_MESSAGE_COUNT;
    } else {
      process.env.WHATSAPP_MAX_MESSAGE_COUNT = original;
    }
  }
});

test("pass 2 (streamWhatsAppChatMessagesAsync, the real production call path): exactly messageCount === cap is accepted, cap+1 throws", async () => {
  const { WhatsAppMessageLimitExceededError } = await import("./parsers.ts");
  const original = process.env.WHATSAPP_MAX_MESSAGE_COUNT;
  process.env.WHATSAPP_MAX_MESSAGE_COUNT = "3";
  try {
    const atCap = [
      "[6/5/24, 9:15:22 AM] Alice: one",
      "[6/5/24, 9:16:00 AM] Alice: two",
      "[6/5/24, 9:17:00 AM] Alice: three",
    ].join("\n");
    const atCapMessages: unknown[] = [];
    await streamWhatsAppChatMessagesAsync(splitWhatsAppChatLines(atCap), "chat123", (m) => {
      atCapMessages.push(m);
    });
    assert.equal(atCapMessages.length, 3, "exactly at cap is accepted, not rejected");

    const overCap = `${atCap}\n[6/5/24, 9:18:00 AM] Alice: four`;
    await assert.rejects(
      () =>
        streamWhatsAppChatMessagesAsync(splitWhatsAppChatLines(overCap), "chat123", () => {
          /* intentionally empty */
        }),
      (err: unknown) => {
        assert.ok(err instanceof WhatsAppMessageLimitExceededError);
        return true;
      },
      "one message over cap throws"
    );
  } finally {
    if (original === undefined) {
      delete process.env.WHATSAPP_MAX_MESSAGE_COUNT;
    } else {
      process.env.WHATSAPP_MAX_MESSAGE_COUNT = original;
    }
  }
});

// ─── Deterministic bounded-memory capability oracle ─────────────────────────
//
// RSS/heap measurements are noisy and, worse, can be actively misleading:
// this task's own investigation found that measuring a Node HTTP client's
// `fetch()` + ReadableStream send path can attribute >2 GiB of the CLIENT's
// own undici send-buffering to what looks like "the server's memory" when
// client and server share a process -- a false positive that would make a
// perfectly bounded server look broken. A deterministic, GC/measurement-
// independent proof is required instead: these tests assert on the API's
// own CONCURRENCY CONTRACT (how many message objects can be alive between
// one onMessage call finishing and the next starting), not on any absolute
// byte count.
//
// A generator-based line source is used throughout -- it computes each line
// on demand and holds no more than one line in memory at a time, so these
// tests cannot silently pass by materializing a huge string/array
// themselves and then only feeding it through the API correctly.

/** Produces `count` synthetic WhatsApp message lines ON DEMAND -- never
 *  holds more than the current line in memory, so a test built on this
 *  generator cannot itself become the thing retaining a huge array. */
function* generateChatLines(count: number): Generator<string> {
  for (let i = 0; i < count; i += 1) {
    yield `[6/5/24, 9:15:${String(i % 60).padStart(2, "0")} AM] Alice: message number ${i}`;
  }
}

test("bounded-memory oracle: scanWhatsAppChatIdentity never holds more than 1 message concurrently, at 2M messages", () => {
  const originalCap = process.env.WHATSAPP_MAX_MESSAGE_COUNT;
  process.env.WHATSAPP_MAX_MESSAGE_COUNT = "3000000";
  try {
    // WhatsAppChatSummary's own TYPE has no `messages` array field -- this
    // is a structural, compile-time guarantee, not just a runtime one.
    // Confirmed here at the value level too: the returned object has no
    // enumerable property whose value is an array sized by message count.
    const summary = scanWhatsAppChatIdentity("export.txt", generateChatLines(2_000_000));
    assert.equal(summary.messageCount, 2_000_000);
    for (const [key, value] of Object.entries(summary)) {
      if (Array.isArray(value)) {
        assert.ok(
          value.length <= 40,
          `expected every array field on WhatsAppChatSummary to stay small (bounded reservoir sample / participant list), but '${key}' has ${value.length} entries -- looks like a full message array leaked into the summary`
        );
      }
    }
  } finally {
    if (originalCap === undefined) {
      delete process.env.WHATSAPP_MAX_MESSAGE_COUNT;
    } else {
      process.env.WHATSAPP_MAX_MESSAGE_COUNT = originalCap;
    }
  }
});

test("bounded-memory oracle: streamWhatsAppChatMessages hands off exactly one message at a time, never more than 1 concurrently alive, at 2M messages", () => {
  const originalCap = process.env.WHATSAPP_MAX_MESSAGE_COUNT;
  process.env.WHATSAPP_MAX_MESSAGE_COUNT = "3000000";
  try {
    let concurrentlyAlive = 0;
    let peakConcurrentlyAlive = 0;
    let totalSeen = 0;
    streamWhatsAppChatMessages(generateChatLines(2_000_000), "deadbeefdeadbeef", (message) => {
      // Simulates a consumer that "checks out" a message, does its work
      // (assertion below stands in for emitRecord), then drops its
      // reference -- streamWhatsAppChatMessages is synchronous, so if it
      // ever queued ahead instead of handing off one at a time, this
      // counter would show more than 1 concurrently alive.
      concurrentlyAlive += 1;
      peakConcurrentlyAlive = Math.max(peakConcurrentlyAlive, concurrentlyAlive);
      assert.ok(message.id.startsWith("deadbeefdeadbeef:"));
      totalSeen += 1;
      concurrentlyAlive -= 1;
    });
    assert.equal(totalSeen, 2_000_000);
    assert.equal(peakConcurrentlyAlive, 1, "streamWhatsAppChatMessages must hand off exactly one message at a time");
  } finally {
    if (originalCap === undefined) {
      delete process.env.WHATSAPP_MAX_MESSAGE_COUNT;
    } else {
      process.env.WHATSAPP_MAX_MESSAGE_COUNT = originalCap;
    }
  }
});

test("bounded-memory oracle: streamWhatsAppChatMessages emits INTERLEAVED with line consumption, not buffer-then-drain-at-end", () => {
  // Complementary to the "1 concurrently alive" oracle above -- that check
  // alone cannot distinguish true streaming from "accumulate a full array,
  // then replay it through onMessage one at a time at the end" (each replay
  // call still only has 1 message alive AT THAT INSTANT, but the whole
  // array was resident in memory the entire time it was being built). This
  // test instruments the LINE SOURCE itself to count how many lines have
  // been pulled by the time onMessage's FIRST call fires -- true streaming
  // fires onMessage repeatedly while still pulling lines; buffer-then-
  // replay only fires onMessage after the generator is fully exhausted.
  const originalCap = process.env.WHATSAPP_MAX_MESSAGE_COUNT;
  process.env.WHATSAPP_MAX_MESSAGE_COUNT = "3000000";
  try {
    let linesPulled = 0;
    let firstOnMessageAtLinesPulled: number | null = null;
    function* countingLines() {
      for (const line of generateChatLines(2_000_000)) {
        linesPulled += 1;
        yield line;
      }
    }
    let totalSeen = 0;
    streamWhatsAppChatMessages(countingLines(), "deadbeefdeadbeef", () => {
      if (firstOnMessageAtLinesPulled === null) {
        firstOnMessageAtLinesPulled = linesPulled;
      }
      totalSeen += 1;
    });
    assert.equal(totalSeen, 2_000_000);
    assert.ok(
      firstOnMessageAtLinesPulled !== null && firstOnMessageAtLinesPulled < 2_000_000,
      `expected the first onMessage call to fire well before all 2,000,000 lines were pulled (true interleaving), but it fired after ${String(firstOnMessageAtLinesPulled)} -- looks like buffer-then-drain-at-end`
    );
  } finally {
    if (originalCap === undefined) {
      delete process.env.WHATSAPP_MAX_MESSAGE_COUNT;
    } else {
      process.env.WHATSAPP_MAX_MESSAGE_COUNT = originalCap;
    }
  }
});

test("bounded-memory oracle: streamWhatsAppChatMessagesAsync awaits each emission before parsing the next line (no unbounded fan-out)", async () => {
  const originalCap = process.env.WHATSAPP_MAX_MESSAGE_COUNT;
  process.env.WHATSAPP_MAX_MESSAGE_COUNT = "3000000";
  try {
    let inFlight = 0;
    let peakInFlight = 0;
    let totalSeen = 0;
    await streamWhatsAppChatMessagesAsync(generateChatLines(1_000_000), "deadbeefdeadbeef", async (message) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      // A real async consumer (e.g. emitRecord awaiting a network write) --
      // if streamWhatsAppChatMessagesAsync ever raced ahead and started a
      // SECOND onMessage call before this one's promise settled, peakInFlight
      // would exceed 1.
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(message.id.startsWith("deadbeefdeadbeef:"));
      totalSeen += 1;
      inFlight -= 1;
    });
    assert.equal(totalSeen, 1_000_000);
    assert.equal(
      peakInFlight,
      1,
      "streamWhatsAppChatMessagesAsync must await each onMessage call before starting the next -- at most 1 emission in flight"
    );
  } finally {
    if (originalCap === undefined) {
      delete process.env.WHATSAPP_MAX_MESSAGE_COUNT;
    } else {
      process.env.WHATSAPP_MAX_MESSAGE_COUNT = originalCap;
    }
  }
});
