/**
 * WhatsApp fingerprint cursor tests.
 *
 * The WhatsApp connector is file-based and re-parses every exported .txt
 * file on every run. Without a fingerprint cursor it emits a fresh RECORD
 * version per (record, run) pair even when the export content has not
 * changed, accumulating unbounded churn downstream.
 *
 * These tests pin the four load-bearing scenarios against the exact record
 * shapes the WhatsApp connector emits (the authoritative fixture shape from
 * `schemas.test.ts`):
 *
 *   1. Fresh run emits every record.
 *   2. Identical second run suppresses all records (cursor hit).
 *   3. Changed record re-emits (source-field change).
 *   4. Deleted record is pruned from the next STATE cursor on a full-scan
 *      stream.
 *
 * These tests drive `openFingerprintCursor` directly with WhatsApp fixture
 * shapes because the connector has no exported helper seam. The production
 * wiring in `index.ts` applies `shouldEmit` per-record; these tests pin
 * that contract without requiring a real filesystem or subprocess.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";

// ─── WhatsApp fixture shapes (authoritative from schemas.test.ts) ──────────

const CHAT_A = {
  id: "0123456789abcdef",
  title: "Family Group",
  participants: ["Alice", "Bob", "Carol"],
  message_count: 3,
  first_message_date: "2024-06-05T13:45:22.000Z",
  last_message_date: "2024-06-06T09:10:00.000Z",
};

const CHAT_B = {
  id: "fedcba9876543210",
  title: "Work Chat",
  participants: ["Dave", "Eve"],
  message_count: 2,
  first_message_date: "2024-06-06T09:00:00.000Z",
  last_message_date: "2024-06-06T09:10:00.000Z",
};

const MSG_A1 = {
  id: "0123456789abcdef:0",
  chat_id: "0123456789abcdef",
  author: "Alice",
  content: "hey, are we still on for tomorrow?",
  has_attachment: false,
  sent_at: "2024-06-05T13:45:22.000Z",
};

const MSG_A2 = {
  id: "0123456789abcdef:1",
  chat_id: "0123456789abcdef",
  author: "Bob",
  content: "Yes! See you at 10.",
  has_attachment: false,
  sent_at: "2024-06-05T13:46:00.000Z",
};

// ─── Scenario 1: Fresh run — all records emitted ──────────────────────────

test("fresh run: all chats and messages emit (no prior cursor)", () => {
  const chatsCursor = openFingerprintCursor(undefined);
  assert.equal(chatsCursor.shouldEmit(CHAT_A), true, "CHAT_A emits on fresh run");
  assert.equal(chatsCursor.shouldEmit(CHAT_B), true, "CHAT_B emits on fresh run");

  const msgsCursor = openFingerprintCursor(undefined);
  assert.equal(msgsCursor.shouldEmit(MSG_A1), true, "MSG_A1 emits on fresh run");
  assert.equal(msgsCursor.shouldEmit(MSG_A2), true, "MSG_A2 emits on fresh run");

  // Both cursors carry fingerprints into STATE.
  assert.equal(chatsCursor.size(), 2, "two chat fingerprints in cursor");
  assert.equal(msgsCursor.size(), 2, "two message fingerprints in cursor");
});

// ─── Scenario 2: Identical second run — no records re-emitted ─────────────

test("identical second run: all records suppressed (fingerprint match)", () => {
  // Run 1: seed cursors.
  const chatsCursor1 = openFingerprintCursor(undefined);
  chatsCursor1.shouldEmit(CHAT_A);
  chatsCursor1.shouldEmit(CHAT_B);
  const chatsState1 = { fingerprints: chatsCursor1.toState() };

  const msgsCursor1 = openFingerprintCursor(undefined);
  msgsCursor1.shouldEmit(MSG_A1);
  msgsCursor1.shouldEmit(MSG_A2);
  const msgsState1 = { fingerprints: msgsCursor1.toState() };

  // Run 2: identical source state.
  const chatsCursor2 = openFingerprintCursor(chatsState1);
  assert.equal(chatsCursor2.shouldEmit(CHAT_A), false, "CHAT_A not re-emitted — unchanged");
  assert.equal(chatsCursor2.shouldEmit(CHAT_B), false, "CHAT_B not re-emitted — unchanged");

  const msgsCursor2 = openFingerprintCursor(msgsState1);
  assert.equal(msgsCursor2.shouldEmit(MSG_A1), false, "MSG_A1 not re-emitted — unchanged");
  assert.equal(msgsCursor2.shouldEmit(MSG_A2), false, "MSG_A2 not re-emitted — unchanged");

  // Carry-forward intact — fingerprints survive even when nothing emitted.
  assert.equal(chatsCursor2.size(), 2, "chats cursor carry-forward intact");
  assert.equal(msgsCursor2.size(), 2, "messages cursor carry-forward intact");
});

// ─── Scenario 3: Source-field change re-emits that record ─────────────────

test("changed record re-emits; unchanged records are still suppressed", () => {
  // Run 1: seed both chats.
  const chatsCursor1 = openFingerprintCursor(undefined);
  chatsCursor1.shouldEmit(CHAT_A);
  chatsCursor1.shouldEmit(CHAT_B);
  const chatsState1 = { fingerprints: chatsCursor1.toState() };

  // Run 2: CHAT_A gets a new message (message_count + last_message_date moved).
  const CHAT_A_UPDATED = {
    ...CHAT_A,
    message_count: 4,
    last_message_date: "2024-06-06T15:00:00.000Z",
  };
  const chatsCursor2 = openFingerprintCursor(chatsState1);
  assert.equal(chatsCursor2.shouldEmit(CHAT_A_UPDATED), true, "changed chat re-emits");
  assert.equal(chatsCursor2.shouldEmit(CHAT_B), false, "unchanged chat still suppressed");
});

// ─── Scenario 4: Deleted record pruned from STATE cursor ──────────────────

test("pruneStale: chat absent from this run is dropped from next STATE", () => {
  // Run 1: seed two chats.
  const chatsCursor1 = openFingerprintCursor(undefined);
  chatsCursor1.shouldEmit(CHAT_A);
  chatsCursor1.shouldEmit(CHAT_B);
  chatsCursor1.pruneStale();
  const chatsState1 = { fingerprints: chatsCursor1.toState() };
  assert.equal(Object.keys(chatsState1.fingerprints).length, 2, "two fingerprints after run 1");

  // Run 2: CHAT_B's file was deleted — only CHAT_A present.
  const chatsCursor2 = openFingerprintCursor(chatsState1);
  // CHAT_A processed (unchanged — suppressed, but seen).
  chatsCursor2.shouldEmit(CHAT_A);
  // CHAT_B not processed (file gone).
  chatsCursor2.pruneStale();

  const chatsState2 = { fingerprints: chatsCursor2.toState() };
  assert.ok(chatsState2.fingerprints[CHAT_A.id], "CHAT_A fingerprint retained");
  assert.equal(chatsState2.fingerprints[CHAT_B.id], undefined, "CHAT_B fingerprint pruned");
  assert.equal(Object.keys(chatsState2.fingerprints).length, 1, "only one fingerprint survives");
});

// ─── Scenario 5: WhatsApp has no run-clock field — fingerprint covers all ──

test("no run-clock exclusion needed: record is deterministic across runs (no fetched_at)", () => {
  // WhatsApp records are entirely derived from the export file content;
  // there are no run-clock fields to exclude. The fingerprint is stable
  // across identical runs without any excludeFromFingerprint option.
  const cursor1 = openFingerprintCursor(undefined);
  cursor1.shouldEmit(MSG_A1);
  const state1 = { fingerprints: cursor1.toState() };

  const cursor2 = openFingerprintCursor(state1);
  // Same record, no timestamp drift possible — must suppress.
  assert.equal(cursor2.shouldEmit(MSG_A1), false, "deterministic record suppressed without clock exclusion");
});
