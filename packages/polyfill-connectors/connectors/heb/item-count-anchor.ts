// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The `order_items` completeness anchor for H-E-B.
//
// WHY THIS IS A REAL ANCHOR
// -------------------------
// Every H-E-B order card on the list page states its own item count — the
// "$123.45 · 59 items" line the `LIST_TOTAL_COUNT_RE` parser already reads
// into `ListPageOrder.itemCount` and stores on the `orders` record as
// `item_count`. That number is computed by H-E-B, not by this connector, and
// it is read from the LIST page while the items themselves come from a
// separate DETAIL page. So comparing them compares two independent source
// surfaces rather than checking the connector's output against itself.
//
// Until now `item_count` was recorded and never checked. Live evidence for
// why that matters: one instance holds two orders declaring 59 and 85 items,
// but only 35 and 54 `order_items` records — 89 of 144. Both orders are
// partially hydrated, and nothing anywhere reported a problem, because
// nothing compared the two numbers.
//
// DELETION-SAFE, ONE-DIRECTIONAL
// ------------------------------
// Only "the provider says MORE than we hold" is a gap. Holding more items
// than the current card states is not loss: H-E-B restates an order's count
// when items are refunded or removed after fulfilment, and PDPP deliberately
// preserves the items it already captured. A two-way equality would flag
// that correct preservation as a defect — the same trap the fleet's other
// anchors avoid.
//
// REFUSES RATHER THAN FABRICATES
// ------------------------------
// A missing or malformed `item_count` yields `unavailable`, never zero. A
// zero denominator would make every order trivially "complete" and would be
// a denominator invented from the very data it is meant to verify.

/** One order's declared count against what was actually collected. */
export interface OrderItemTally {
  /** `order_items` records collected for this order this run. */
  collectedItemCount: number;
  /** The count H-E-B printed on the list card, or null when it did not. */
  declaredItemCount: number | null;
  orderId: string;
}

export type OrderItemVerdict =
  /** No sound anchor: the provider stated no usable count. */
  | { status: "unavailable"; orderId: string; reason: "no_declared_count" }
  /** Everything the provider declared is accounted for. */
  | { status: "complete"; orderId: string; considered: number; covered: number }
  /** The provider declared more items than were collected. */
  | { status: "short"; orderId: string; considered: number; covered: number; missing: number };

/**
 * Validate a provider-declared item count.
 *
 * Fails closed to `null` — a malformed count is NOT zero and NOT complete.
 * Mirrors jellyfin's `validateTotalRecordCount` discipline, minus its
 * monotonicity rule: H-E-B legitimately restates an order's count downward
 * after a refund, so a decrease is ordinary source behaviour here rather
 * than the anomaly it is for a Jellyfin library.
 */
export function validateDeclaredItemCount(value: unknown): number | null {
  if (typeof value !== "number") {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  if (!Number.isInteger(value)) {
    return null;
  }
  if (value < 0) {
    return null;
  }
  return value;
}

/**
 * Compare one order's declared count against what was collected.
 *
 * A declared zero is a real fact (an order genuinely holding no line items),
 * so it is honoured rather than treated as "unknown" — this is the same
 * distinction the fleet draws elsewhere between the provider SAYING zero and
 * the provider saying nothing.
 */
export function tallyOrderItems(tally: OrderItemTally): OrderItemVerdict {
  const declared = validateDeclaredItemCount(tally.declaredItemCount);
  if (declared === null) {
    return { status: "unavailable", orderId: tally.orderId, reason: "no_declared_count" };
  }
  const covered = Math.min(tally.collectedItemCount, declared);
  if (covered < declared) {
    return {
      status: "short",
      orderId: tally.orderId,
      considered: declared,
      covered,
      missing: declared - covered,
    };
  }
  return { status: "complete", orderId: tally.orderId, considered: declared, covered };
}

/** The run-level roll-up of every per-order verdict. */
export interface ItemCountAnchorSummary {
  /** Total items collected across those same orders. */
  collectedItems: number;
  /** Orders whose declared count was fully accounted for. */
  complete: number;
  /** Total items the provider declared across anchorable orders. */
  declaredItems: number;
  /** Orders holding fewer items than the provider declared. */
  short: number;
  /** Order ids that came up short, for a bounded diagnostic. */
  shortOrderIds: string[];
  /** Orders offering no sound anchor. */
  unavailable: number;
}

/** Cap on ids listed in the diagnostic. The COUNT is always exact; only the
 *  id sample is bounded, so a large shortfall stays legible without an
 *  unbounded diagnostic. Mirrors signal's and slack's id-sample caps. */
export const MAX_SHORT_ORDER_IDS_IN_DIAGNOSTIC = 50;

/**
 * Roll per-order verdicts into one run-level summary.
 *
 * `unavailable` orders contribute to neither total: including an order with
 * no declared count would silently treat its collected items as if they had
 * been verified against something.
 */
export function summarizeItemCounts(tallies: readonly OrderItemTally[]): ItemCountAnchorSummary {
  const summary: ItemCountAnchorSummary = {
    complete: 0,
    short: 0,
    unavailable: 0,
    declaredItems: 0,
    collectedItems: 0,
    shortOrderIds: [],
  };
  for (const tally of tallies) {
    const verdict = tallyOrderItems(tally);
    if (verdict.status === "unavailable") {
      summary.unavailable += 1;
      continue;
    }
    summary.declaredItems += verdict.considered;
    summary.collectedItems += verdict.covered;
    if (verdict.status === "short") {
      summary.short += 1;
      if (summary.shortOrderIds.length < MAX_SHORT_ORDER_IDS_IN_DIAGNOSTIC) {
        summary.shortOrderIds.push(verdict.orderId);
      }
    } else {
      summary.complete += 1;
    }
  }
  return summary;
}
