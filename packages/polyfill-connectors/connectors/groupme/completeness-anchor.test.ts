// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Completeness-anchor tests for the GroupMe connector.
 *
 * `providerMessageCount` reads GroupMe's per-group message count from
 * whichever shape the API returned — the documented nested
 * `messages.count`, or the flat `messages_count` this connector modelled
 * before. Live evidence drove this: all 156 of this owner's groups carried
 * `messages_count: null` across every version ever collected, while the
 * sibling `members_count` populated normally, so the flat field was never
 * the one GroupMe actually sends for the count.
 *
 * `groupMessageShortfall` compares that count against a full walk. It is
 * one-directional: only "provider says MORE than we walked" is a gap.
 * Holdings that exceed the provider count are messages GroupMe deleted
 * after we preserved them — reporting those as loss would flag correct
 * preservation behavior as a defect.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { groupMessageShortfall, partitionGroupMessageShortfalls, providerMessageCount } from "./index.ts";

const GROUP_ID = "1618492";

function group(overrides: Record<string, unknown>): Parameters<typeof providerMessageCount>[0] {
  return { id: GROUP_ID, ...overrides } as Parameters<typeof providerMessageCount>[0];
}

// ─── providerMessageCount: read either shape, never fabricate ────────────

test("providerMessageCount reads the documented nested messages.count", () => {
  assert.equal(providerMessageCount(group({ messages: { count: 142 } })), 142);
});

test("providerMessageCount reads the flat messages_count when that is what arrived", () => {
  assert.equal(providerMessageCount(group({ messages_count: 99 })), 99);
});

test("providerMessageCount prefers the nested count when both shapes are present", () => {
  assert.equal(providerMessageCount(group({ messages: { count: 142 }, messages_count: 7 })), 142);
});

test("providerMessageCount accepts a genuine zero from the provider", () => {
  // The provider SAYING zero is a fact; it is not the same as saying nothing.
  assert.equal(providerMessageCount(group({ messages: { count: 0 } })), 0);
});

test("providerMessageCount returns null when the provider reported no count", () => {
  // This is the live case: unknown must NOT collapse to a zero denominator.
  assert.equal(providerMessageCount(group({})), null);
  assert.equal(providerMessageCount(group({ messages_count: null })), null);
  assert.equal(providerMessageCount(group({ messages: null })), null);
  assert.equal(providerMessageCount(group({ messages: {} })), null);
});

test("providerMessageCount rejects a malformed count rather than coercing it", () => {
  assert.equal(providerMessageCount(group({ messages: { count: -1 } })), null);
  assert.equal(providerMessageCount(group({ messages: { count: 1.5 } })), null);
  assert.equal(providerMessageCount(group({ messages_count: Number.NaN })), null);
  assert.equal(providerMessageCount(group({ messages_count: Number.POSITIVE_INFINITY })), null);
});

// ─── groupMessageShortfall: one-directional ──────────────────────────────

test("groupMessageShortfall reports a gap when the provider claims more than we walked", () => {
  const verdict = groupMessageShortfall(group({ messages: { count: 500 } }), 320);
  assert.equal(verdict.kind, "short");
  assert.deepEqual(verdict.kind === "short" ? verdict.shortfall : null, {
    groupId: GROUP_ID,
    providerCount: 500,
    walked: 320,
  });
});

test("groupMessageShortfall reports ok on an exact match", () => {
  assert.equal(groupMessageShortfall(group({ messages: { count: 320 } }), 320).kind, "ok");
});

test("groupMessageShortfall does NOT report a gap when holdings exceed the provider count", () => {
  // Messages GroupMe deleted after we preserved them. PDPP retains those on
  // purpose, so a surplus must never read as loss.
  assert.equal(groupMessageShortfall(group({ messages: { count: 300 } }), 320).kind, "ok");
});

test("groupMessageShortfall reports unanchored when the provider gave no count", () => {
  assert.equal(groupMessageShortfall(group({}), 320).kind, "unanchored");
});

test("groupMessageShortfall treats a provider zero as a real anchor, not as unanchored", () => {
  assert.equal(groupMessageShortfall(group({ messages: { count: 0 } }), 0).kind, "ok");
});

test("groupMessageShortfall reports a gap for an empty walk against a non-zero count", () => {
  const verdict = groupMessageShortfall(group({ messages: { count: 12 } }), 0);
  assert.equal(verdict.kind, "short");
  assert.equal(verdict.kind === "short" ? verdict.shortfall.providerCount : null, 12);
});

// ─── partitionGroupMessageShortfalls: classify, never subtract ───────────
//
// Live evidence from this owner's workspace (run_1787279998931, and an
// independent un-throttled sweep of all 156 groups): 42 groups report a
// non-zero `messages.count` yet return HTTP 200 with an empty `messages`
// array on EVERY documented access path — plain, `limit=1`, `after_id=0`,
// and 304 on `before_id`/`since_id` anchored at the group's own
// `last_message_id`. Those 1601 messages are counted by GroupMe and served
// by nothing, so telling the owner to retry is a false promise. The split
// exists to say that honestly — never to shrink the gap.

test("partitionGroupMessageShortfalls routes a zero-message walk to withheld", () => {
  const { partial, withheld } = partitionGroupMessageShortfalls([{ groupId: "2561292", providerCount: 98, walked: 0 }]);
  assert.equal(withheld.length, 1);
  assert.equal(partial.length, 0);
  assert.equal(withheld[0]?.providerCount, 98);
});

test("partitionGroupMessageShortfalls routes a genuinely partial walk to partial", () => {
  const { partial, withheld } = partitionGroupMessageShortfalls([
    { groupId: "1618492", providerCount: 61, walked: 40 },
  ]);
  assert.equal(partial.length, 1);
  assert.equal(withheld.length, 0);
  assert.equal(partial[0]?.walked, 40);
});

test("partitionGroupMessageShortfalls preserves every message of the gap across both buckets", () => {
  // The whole point: classification must not lose a single claimed message.
  // A withheld group's full providerCount is still missing (walked 0), so the
  // combined total must equal the pre-split total.
  const shortfalls = [
    { groupId: "2561292", providerCount: 98, walked: 0 },
    { groupId: "4747691", providerCount: 1, walked: 0 },
    { groupId: "1618492", providerCount: 61, walked: 40 },
  ];
  const before = shortfalls.reduce((sum, s) => sum + (s.providerCount - s.walked), 0);
  const { partial, withheld } = partitionGroupMessageShortfalls(shortfalls);
  const after =
    partial.reduce((sum, s) => sum + (s.providerCount - s.walked), 0) +
    withheld.reduce((sum, s) => sum + (s.providerCount - s.walked), 0);
  assert.equal(after, before);
  assert.equal(partial.length + withheld.length, shortfalls.length);
});

test("partitionGroupMessageShortfalls keeps a withheld group's messages counted as missing", () => {
  // A withheld group is NOT explained away: its provider count is the number
  // of messages still absent from PDPP. Subtracting it to make the books
  // balance would be exactly the fabricated reconciliation this anchor exists
  // to prevent.
  const { withheld } = partitionGroupMessageShortfalls([{ groupId: "2368502", providerCount: 55, walked: 0 }]);
  assert.equal(
    withheld.reduce((sum, s) => sum + (s.providerCount - s.walked), 0),
    55
  );
});
