/**
 * Schema tests for the Twitter/X archive connector. These prove the emit-time
 * schemas in schemas.ts accept the records the parsers actually build (using
 * the same synthetic archive fixtures parsers.test.ts exercises) and reject
 * representative drift. This is the SLVP "validate representative emitted
 * records" check — the schema is verified against real builder output, not an
 * aspirational shape.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DM_ENTRY, TWEET_ENTRY_LEGACY, TWEET_ENTRY_MODERN, TWEET_REPLY } from "./__fixtures__/archive-samples.ts";
import { buildDmRecord, buildTweetRecord, unwrapDmConversation, unwrapDmMessage, unwrapTweetEntry } from "./parsers.ts";
import { directMessagesSchema, tweetsSchema, validateRecord } from "./schemas.ts";

test("tweets schema accepts a modern parser-built record", () => {
  const rec = buildTweetRecord(unwrapTweetEntry(TWEET_ENTRY_MODERN));
  assert.ok(rec);
  const result = tweetsSchema.safeParse(rec);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("tweets schema accepts a legacy parser-built record", () => {
  const rec = buildTweetRecord(unwrapTweetEntry(TWEET_ENTRY_LEGACY));
  assert.ok(rec);
  assert.ok(tweetsSchema.safeParse(rec).success);
});

test("tweets schema accepts a reply record with reply fields populated", () => {
  const rec = buildTweetRecord(unwrapTweetEntry(TWEET_REPLY));
  assert.ok(rec);
  assert.ok(tweetsSchema.safeParse(rec).success);
});

test("direct_messages schema accepts parser-built DM records", () => {
  const convo = unwrapDmConversation(DM_ENTRY);
  for (const m of convo.messages ?? []) {
    const rec = buildDmRecord(unwrapDmMessage(m), convo.conversationId ?? null);
    assert.ok(rec);
    const result = directMessagesSchema.safeParse(rec);
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  }
});

test("validateRecord routes by stream name and passes through unknown streams", () => {
  const rec = buildTweetRecord(unwrapTweetEntry(TWEET_ENTRY_MODERN));
  assert.ok(rec);
  assert.equal(validateRecord("tweets", { ...rec }).ok, true);
  // Unknown stream → pass-through per makeValidateRecord contract.
  assert.equal(validateRecord("not_a_stream", { anything: true }).ok, true);
});

test("tweets schema rejects a non-numeric id (drift signal)", () => {
  const rec = buildTweetRecord(unwrapTweetEntry(TWEET_ENTRY_MODERN));
  assert.ok(rec);
  const bad = { ...rec, id: "not-a-snowflake" };
  assert.equal(tweetsSchema.safeParse(bad).success, false);
});

test("tweets schema rejects a non-ISO created_at (parse leak)", () => {
  const rec = buildTweetRecord(unwrapTweetEntry(TWEET_ENTRY_MODERN));
  assert.ok(rec);
  const bad = { ...rec, created_at: "Wed Jun 05 13:45:22 +0000 2024" };
  assert.equal(tweetsSchema.safeParse(bad).success, false);
});
