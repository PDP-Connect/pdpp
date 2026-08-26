// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `item_count` had no independent source. It was
 * `Math.max(list.items.length, detail.items.length)` against a non-nullable
 * `min(0)` schema, so an order whose detail page was never fetched asserted a
 * confident `item_count: 0` — indistinguishable from a genuinely empty order.
 *
 * That mattered because the list card only renders item titles for SMALL
 * orders; Amazon collapses 3+ item orders behind a "+N more items" affordance
 * that carries no per-item markup. For those orders the list contributes 0 and
 * the count rests entirely on the detail page, which the connector defers under
 * its per-run attempt budget, its temporary-failure cap, or a latched session
 * repair.
 *
 * The live signature is unambiguous: across 1,183 collected orders,
 * `item_count === 0` never occurs on an order holding 1 or 2 item records, and
 * occurs on 53 orders holding 3-7 — every one of which also has a null
 * `shipping_address_summary`, proving the detail page (not the parse) was
 * missing. Those records claimed an empty order while the database held their
 * items.
 *
 * These tests pin the distinction the old shape could not express: a count of
 * zero must mean "we looked and there were none", never "we did not look".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOrderRecord } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { DetailItem, ListPageOrder, OrderDetail } from "./types.ts";

function makeListOrder(overrides: Partial<ListPageOrder> = {}): ListPageOrder {
  return {
    orderId: "111-2222222-3333333",
    orderDateRaw: "January 15, 2024",
    orderTotal: "$10.00",
    deliveryStatus: "Delivered Jan 17",
    items: [],
    ...overrides,
  };
}

function makeDetailItem(overrides: Partial<DetailItem> = {}): DetailItem {
  return {
    asin: null,
    name: "",
    url: null,
    unit_price: null,
    quantity: 1,
    seller: null,
    item_image_url: null,
    refund_status: null,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<OrderDetail> = {}): OrderDetail {
  return {
    status_detail: null,
    recipient_name: null,
    shipping_address_summary: null,
    payment_method_summary: null,
    grand_total: null,
    gift_order: false,
    digital_order: false,
    items: [],
    ...overrides,
  };
}

function build(listOrder: ListPageOrder, detail: OrderDetail | null) {
  return buildOrderRecord(listOrder, detail, "2024-01-15", "2024-01-20T00:00:00Z");
}

test("amazon item_count: an unfetched detail page reports unknown, not an empty order", () => {
  // The exact live shape: a 3+ item order whose list card collapsed its titles
  // and whose detail fetch was deferred. Before this, the record asserted 0.
  const rec = build(makeListOrder({ items: [] }), null);

  assert.equal(rec.item_count, null, "no surface saw an item and none was fetched — the count is unknown");
  assert.notEqual(rec.item_count, 0, "0 would claim a proven-empty order we never actually looked at");
});

test("amazon item_count: a fetched detail page with no items is a proven-empty order", () => {
  // We DID look at the surface that carries items, and it carried none. That is
  // a fact, and it must stay distinguishable from the case above.
  const rec = build(makeListOrder({ items: [] }), makeDetail({ items: [] }));

  assert.equal(rec.item_count, 0, "a successful detail fetch that found nothing proves zero");
});

test("amazon item_count: the detail page count wins when the list card collapsed its titles", () => {
  // The 3+ item case with the detail page present: list contributes 0, detail
  // carries the real count.
  const rec = build(
    makeListOrder({ items: [] }),
    makeDetail({
      items: [
        makeDetailItem({ asin: "B01", name: "A" }),
        makeDetailItem({ asin: "B02", name: "B" }),
        makeDetailItem({ asin: "B03", name: "C" }),
      ],
    })
  );

  assert.equal(rec.item_count, 3);
});

test("amazon item_count: the list card alone still counts when no detail was fetched", () => {
  // A small order whose titles the list card did render. We saw real items, so
  // the count is known even without a detail page — this must not regress to
  // null just because `detail` is absent.
  const rec = build(
    makeListOrder({
      items: [
        { asin: "B01", name: "A", url: null },
        { asin: "B02", name: "B", url: null },
      ],
    }),
    null
  );

  assert.equal(rec.item_count, 2, "observed items are observed regardless of which surface showed them");
});

test("amazon item_count: the larger of the two surfaces is kept", () => {
  const rec = build(
    makeListOrder({ items: [{ asin: "B01", name: "A", url: null }] }),
    makeDetail({ items: [makeDetailItem({ asin: "B01" }), makeDetailItem({ asin: "B02" })] })
  );

  assert.equal(rec.item_count, 2, "the detail page saw more than the list card");
});

test("amazon item_count: a null count is accepted by the orders schema", () => {
  // The schema was non-nullable, which is what forced the unknown to be encoded
  // as 0 in the first place. If this regresses, the honest value cannot be
  // emitted at all and the connector silently falls back to the old lie.
  const rec = build(makeListOrder({ items: [] }), null);
  const result = validateRecord("orders", rec as unknown as Record<string, unknown>);

  assert.equal(result.ok, true, `a null item_count must validate: ${JSON.stringify(result.ok ? [] : result.issues)}`);
});

test("amazon item_count: a real count still validates", () => {
  const rec = build(makeListOrder({ items: [{ asin: "B01", name: "A", url: null }] }), makeDetail());
  const result = validateRecord("orders", rec as unknown as Record<string, unknown>);

  assert.equal(result.ok, true);
  assert.equal(rec.item_count, 1);
});
