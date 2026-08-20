// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Completeness-anchor tests for the H-E-B `order_items` stream.
 *
 * The anchor is H-E-B's own declared item count, printed on each order card
 * ("$382.67 · 85 items") and already stored on the `orders` record as
 * `item_count`. It was recorded and never checked.
 *
 * The live numbers below are real: one instance holds two orders declaring
 * 59 and 85 items but only 35 and 54 `order_items` records — 89 of 144.
 * Nothing reported a problem because nothing compared the two.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_SHORT_ORDER_IDS_IN_DIAGNOSTIC,
  type OrderItemTally,
  summarizeItemCounts,
  tallyOrderItems,
  validateDeclaredItemCount,
} from "./item-count-anchor.ts";

// ─── validateDeclaredItemCount: fail closed, never fabricate ─────────────

test("validateDeclaredItemCount accepts a genuine count", () => {
  assert.equal(validateDeclaredItemCount(85), 85);
});

test("validateDeclaredItemCount accepts a genuine zero from the provider", () => {
  // The provider SAYING zero is a fact; it is not the same as saying nothing.
  assert.equal(validateDeclaredItemCount(0), 0);
});

test("validateDeclaredItemCount refuses a missing count rather than calling it zero", () => {
  // A zero denominator would make every order trivially complete.
  assert.equal(validateDeclaredItemCount(null), null);
  assert.equal(validateDeclaredItemCount(undefined), null);
});

test("validateDeclaredItemCount refuses malformed counts", () => {
  assert.equal(validateDeclaredItemCount(-1), null);
  assert.equal(validateDeclaredItemCount(1.5), null);
  assert.equal(validateDeclaredItemCount(Number.NaN), null);
  assert.equal(validateDeclaredItemCount(Number.POSITIVE_INFINITY), null);
  assert.equal(validateDeclaredItemCount("85"), null);
});

// ─── tallyOrderItems ─────────────────────────────────────────────────────

test("tallyOrderItems confirms a fully-collected order", () => {
  const verdict = tallyOrderItems({ orderId: "o1", declaredItemCount: 12, collectedItemCount: 12 });
  assert.equal(verdict.status, "complete");
  assert.equal(verdict.status === "complete" && verdict.covered, 12);
});

test("tallyOrderItems catches the real live shortfall", () => {
  // HEB20607368035: declared 85, collected 54.
  const verdict = tallyOrderItems({ orderId: "HEB20607368035", declaredItemCount: 85, collectedItemCount: 54 });
  assert.equal(verdict.status, "short");
  assert.equal(verdict.status === "short" && verdict.missing, 31);
  assert.equal(verdict.status === "short" && verdict.considered, 85);
  assert.equal(verdict.status === "short" && verdict.covered, 54);
});

test("tallyOrderItems catches the second real live shortfall", () => {
  // HEB20169324473: declared 59, collected 35.
  const verdict = tallyOrderItems({ orderId: "HEB20169324473", declaredItemCount: 59, collectedItemCount: 35 });
  assert.equal(verdict.status === "short" && verdict.missing, 24);
});

test("tallyOrderItems is deletion-safe: MORE held than declared is not a gap", () => {
  // H-E-B restates an order's count downward after a refund. PDPP preserves
  // the items it already captured, so holding more is correct behaviour —
  // flagging it would report preservation as loss.
  const verdict = tallyOrderItems({ orderId: "o1", declaredItemCount: 10, collectedItemCount: 14 });
  assert.equal(verdict.status, "complete");
  assert.equal(verdict.status === "complete" && verdict.covered, 10);
});

test("tallyOrderItems reports unavailable when the provider declared nothing", () => {
  const verdict = tallyOrderItems({ orderId: "o1", declaredItemCount: null, collectedItemCount: 7 });
  assert.equal(verdict.status, "unavailable");
});

test("tallyOrderItems honours a declared zero as a real anchor", () => {
  const verdict = tallyOrderItems({ orderId: "o1", declaredItemCount: 0, collectedItemCount: 0 });
  assert.equal(verdict.status, "complete");
});

// ─── summarizeItemCounts ─────────────────────────────────────────────────

const LIVE_TALLIES: OrderItemTally[] = [
  { orderId: "HEB20169324473", declaredItemCount: 59, collectedItemCount: 35 },
  { orderId: "HEB20607368035", declaredItemCount: 85, collectedItemCount: 54 },
];

test("summarizeItemCounts reproduces the live 89-of-144 shortfall", () => {
  const summary = summarizeItemCounts(LIVE_TALLIES);
  assert.equal(summary.short, 2);
  assert.equal(summary.complete, 0);
  assert.equal(summary.declaredItems, 144);
  assert.equal(summary.collectedItems, 89);
  assert.deepEqual(summary.shortOrderIds, ["HEB20169324473", "HEB20607368035"]);
});

test("summarizeItemCounts reports a fully-reconciled run cleanly", () => {
  const summary = summarizeItemCounts([{ orderId: "o1", declaredItemCount: 5, collectedItemCount: 5 }]);
  assert.equal(summary.short, 0);
  assert.equal(summary.complete, 1);
  assert.deepEqual(summary.shortOrderIds, []);
});

test("summarizeItemCounts excludes unanchored orders from both totals", () => {
  // Counting an order with no declared count would treat its collected
  // items as if they had been verified against something.
  const summary = summarizeItemCounts([
    { orderId: "o1", declaredItemCount: null, collectedItemCount: 9 },
    { orderId: "o2", declaredItemCount: 4, collectedItemCount: 4 },
  ]);
  assert.equal(summary.unavailable, 1);
  assert.equal(summary.declaredItems, 4);
  assert.equal(summary.collectedItems, 4);
});

test("summarizeItemCounts bounds the id sample but keeps the count exact", () => {
  const many: OrderItemTally[] = Array.from({ length: MAX_SHORT_ORDER_IDS_IN_DIAGNOSTIC + 20 }, (_, i) => ({
    orderId: `o${i}`,
    declaredItemCount: 2,
    collectedItemCount: 1,
  }));
  const summary = summarizeItemCounts(many);
  assert.equal(summary.short, MAX_SHORT_ORDER_IDS_IN_DIAGNOSTIC + 20, "the COUNT must stay exact");
  assert.equal(summary.shortOrderIds.length, MAX_SHORT_ORDER_IDS_IN_DIAGNOSTIC, "only the id sample is bounded");
});

test("summarizeItemCounts handles a run with no orders", () => {
  const summary = summarizeItemCounts([]);
  assert.equal(summary.short, 0);
  assert.equal(summary.declaredItems, 0);
});
