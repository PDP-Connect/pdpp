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
import {
  groupMessageShortfall,
  pageEndedShortOfProviderCount,
  partitionGroupMessageShortfalls,
  providerMessageCount,
} from "./index.ts";

const GROUP_ID = "g-anchor";

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
    unprovenBoundary: false,
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
// The partition keys on `unprovenBoundary` — whether the walk ran out of
// servable history before reaching the provider's lifetime total (`count > 0`
// alongside `messages: []`).
//
// It deliberately does NOT key on `walked === 0`. Measured live against this
// API, an empty page carries no status code, `Retry-After`, or rate-limit
// header distinguishing "these messages are gone" from "not serving them
// now", so `walked === 0` is precisely the ambiguous observation. Keying an
// "unrecoverable" verdict on it would let the connector assert a certainty
// the response cannot support.

test("partitionGroupMessageShortfalls routes a short-of-total empty page to unexplained", () => {
  const { partial, unexplained } = partitionGroupMessageShortfalls([
    { groupId: "g-alpha", providerCount: 98, unprovenBoundary: true, walked: 0 },
  ]);
  assert.equal(unexplained.length, 1);
  assert.equal(partial.length, 0);
  assert.equal(unexplained[0]?.providerCount, 98);
});

test("partitionGroupMessageShortfalls routes a genuinely partial walk to partial", () => {
  const { partial, unexplained } = partitionGroupMessageShortfalls([
    { groupId: "g-beta", providerCount: 61, unprovenBoundary: false, walked: 40 },
  ]);
  assert.equal(partial.length, 1);
  assert.equal(unexplained.length, 0);
  assert.equal(partial[0]?.walked, 40);
});

test("partitionGroupMessageShortfalls does NOT route a zero-message walk to unexplained on walked===0 alone", () => {
  // The regression guard for the unproven-boundary defect. A walk that saw
  // nothing but ended on a COHERENT page (the provider's own count agreed at
  // zero) is an ordinary shortfall, not an ambiguous one. If this ever routes
  // on `walked === 0` again, the connector is back to inferring a verdict from
  // the one signal that cannot carry it.
  const { partial, unexplained } = partitionGroupMessageShortfalls([
    { groupId: "g-gamma", providerCount: 7, unprovenBoundary: false, walked: 0 },
  ]);
  assert.equal(unexplained.length, 0);
  assert.equal(partial.length, 1);
});

test("partitionGroupMessageShortfalls preserves every message of the gap across both buckets", () => {
  // The whole point: classification must not lose a single claimed message.
  // The combined total must equal the pre-split total.
  const shortfalls = [
    { groupId: "g-alpha", providerCount: 98, unprovenBoundary: true, walked: 0 },
    { groupId: "g-delta", providerCount: 1, unprovenBoundary: true, walked: 0 },
    { groupId: "g-beta", providerCount: 61, unprovenBoundary: false, walked: 40 },
  ];
  const before = shortfalls.reduce((sum, s) => sum + (s.providerCount - s.walked), 0);
  const { partial, unexplained } = partitionGroupMessageShortfalls(shortfalls);
  const after =
    partial.reduce((sum, s) => sum + (s.providerCount - s.walked), 0) +
    unexplained.reduce((sum, s) => sum + (s.providerCount - s.walked), 0);
  assert.equal(after, before);
  assert.equal(partial.length + unexplained.length, shortfalls.length);
});

test("partitionGroupMessageShortfalls keeps an unexplained group's messages counted as missing", () => {
  // An unexplained group is NOT explained away: its unserved messages are
  // still absent from PDPP. Subtracting them to make the books balance would
  // be exactly the fabricated reconciliation this anchor exists to prevent.
  const { unexplained } = partitionGroupMessageShortfalls([
    { groupId: "g-epsilon", providerCount: 55, unprovenBoundary: true, walked: 0 },
  ]);
  assert.equal(
    unexplained.reduce((sum, s) => sum + (s.providerCount - s.walked), 0),
    55
  );
});

// ─── pageEndedShortOfProviderCount: the unproven-boundary detector ─────────
//
// `count` is GroupMe's LIFETIME TOTAL for the conversation, not the size of
// the page just served (see connectors/groupme/docs/groupme-message-count-shortfall.md).
// So an empty page against a non-zero count is NOT the provider
// contradicting itself — it means this walk ran out of servable history
// before reaching everything the total implies, most often because the
// oldest messages are no longer stored on GroupMe's side.
//
// It is still ambiguous as to CAUSE: retention and a transient refusal
// produce byte-identical responses (same status, same `meta.code`, no
// `Retry-After`, no rate-limit header), so the walk records the boundary as
// unproven and names no cause. These tests pin that predicate.

test("pageEndedShortOfProviderCount flags an empty page served against a non-zero count", () => {
  assert.equal(pageEndedShortOfProviderCount({ count: 29, messages: [] }), true);
});

test("pageEndedShortOfProviderCount accepts an empty page whose count agrees at zero", () => {
  // Nothing to serve and the provider says so. An ordinary natural end.
  assert.equal(pageEndedShortOfProviderCount({ count: 0, messages: [] }), false);
});

test("pageEndedShortOfProviderCount never fires on GroupMe's documented 304 terminal page", () => {
  // GroupMe documents: "If no messages are found (e.g. when filtering with
  // `before_id`) we return code 304." `fetchMessagesPage` normalizes that
  // 304 into a SYNTHETIC `{count: 0, messages: []}` — a count GroupMe never
  // sent. This test pins that the synthesized shape reads as a clean natural
  // end, so the documented end-of-history signal can never be reported as a
  // shortfall against the provider. If `fetchMessagesPage` ever synthesizes a
  // non-zero count, every fully-collected group would be accused of holding
  // back data.
  const synthesizedBy304 = { count: 0, messages: [] };
  assert.equal(pageEndedShortOfProviderCount(synthesizedBy304), false);
});

test("pageEndedShortOfProviderCount never flags a page that actually served messages", () => {
  // A served page is self-consistent regardless of how `count` compares:
  // `count` describes the conversation, the array describes this page.
  const served = [{ id: "m1" }, { id: "m2" }] as unknown as Parameters<
    typeof pageEndedShortOfProviderCount
  >[0]["messages"];
  assert.equal(pageEndedShortOfProviderCount({ count: 900, messages: served }), false);
  assert.equal(pageEndedShortOfProviderCount({ count: 2, messages: served }), false);
});

test("pageEndedShortOfProviderCount treats a missing/non-numeric count as no shortfall", () => {
  // Unknown is not a contradiction. An absent count cannot testify against
  // the empty array, so it must not manufacture an ambiguity finding.
  const noCount = { messages: [] } as unknown as Parameters<typeof pageEndedShortOfProviderCount>[0];
  assert.equal(pageEndedShortOfProviderCount(noCount), false);
  const nullCount = { count: null, messages: [] } as unknown as Parameters<typeof pageEndedShortOfProviderCount>[0];
  assert.equal(pageEndedShortOfProviderCount(nullCount), false);
});

test("groupMessageShortfall carries the unproven-boundary flag into the shortfall", () => {
  // The flag must survive the hop from the walk to the shortfall record, or
  // the partition downstream silently sees every gap as explained.
  const verdict = groupMessageShortfall(group({ messages: { count: 29 } }), 0, true);
  assert.equal(verdict.kind, "short");
  assert.equal(verdict.kind === "short" ? verdict.shortfall.unprovenBoundary : null, true);
});

test("groupMessageShortfall defaults the unproven-boundary flag to false", () => {
  const verdict = groupMessageShortfall(group({ messages: { count: 29 } }), 10);
  assert.equal(verdict.kind, "short");
  assert.equal(verdict.kind === "short" ? verdict.shortfall.unprovenBoundary : null, false);
});
