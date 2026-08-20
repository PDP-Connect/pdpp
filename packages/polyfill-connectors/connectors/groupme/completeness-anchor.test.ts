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
import { groupMessageShortfall, providerMessageCount } from "./index.ts";

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
