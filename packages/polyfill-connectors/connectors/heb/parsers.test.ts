// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Parser tests for the H-E-B connector.
 *
 * orders-list.html and order-detail.html mirror the REAL tag/class/attribute
 * structure captured from a live heb.com session on 2026-07-14 (see
 * heb-live-verify-report.md) — personal values (address, totals, order/
 * product ids, item names) are placeholders, but the DOM shape (card
 * boundary, item-row duplication, structured qty/price spans, department
 * sections) is real. orders-list-empty.html / incapsula-block.html /
 * sign-in-page.html remain synthetic (no live capture of those states) but
 * don't depend on any of the selectors this pass changed.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildOrderItemRecord,
  buildOrderRecord,
  diagnoseEmptyListPage,
  isIncapsulaBlocked,
  looksLoggedOut,
  mergeOrdersListPage,
  orderItemId,
  parseCurrencyCents,
  parseDetailQuantity,
  parseOrderDate,
  parseOrderDetailDom,
  parseOrdersListDom,
  parseOrdersListStructured,
  productImageUrl,
  resolveDomMaxPage,
  resolveMaxPage,
  resolveStructuredMaxPage,
} from "./parsers.ts";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

// ─── Orders list page ─────────────────────────────────────────────────────

test("parseOrdersListDom extracts every order card on the list page", () => {
  const orders = parseOrdersListDom(fixture("orders-list.html"));
  assert.equal(orders.length, 3);
});

test("parseOrdersListDom parses curbside order fields", () => {
  const orders = parseOrdersListDom(fixture("orders-list.html"));
  const first = orders[0];
  assert.ok(first);
  assert.equal(first.orderId, "HEB1029384756");
  assert.equal(first.orderDateRaw, "Jul 14, 2026");
  assert.equal(first.fulfillmentMethod, "curbside");
  assert.equal(first.fulfillmentLocation, "H-E-B plus! Austin Mueller");
  assert.equal(first.status, "Delivered");
  assert.equal(first.total, "$87.45");
  assert.equal(first.itemCount, 12);
});

test("parseOrdersListDom parses delivery order fields", () => {
  const orders = parseOrdersListDom(fixture("orders-list.html"));
  const second = orders[1];
  assert.ok(second);
  assert.equal(second.orderId, "HEB1029384700");
  assert.equal(second.fulfillmentMethod, "delivery");
  assert.equal(second.fulfillmentLocation, "123 Placeholder Ave");
  assert.equal(second.status, "Processing");
});

test("parseOrdersListDom handles a zero-total canceled order", () => {
  const orders = parseOrdersListDom(fixture("orders-list.html"));
  const third = orders[2];
  assert.ok(third);
  assert.equal(third.status, "Order canceled");
  assert.equal(third.total, "$0.00");
  assert.equal(third.itemCount, 0);
});

test("parseOrdersListDom parses a comma-separated (thousands-grouped) total (S4 regression)", () => {
  const html = `<html><body><main>
    <div data-qe-id="orderDetailsCard">
      <p>July 14, 2026</p>
      <p>$1,234.56, 12 items</p>
      <p>Status: Delivered</p>
      <p>Curbside at H-E-B plus! Austin Mueller</p>
      <a href="/my-account/order-history/HEB1000000099">View details</a>
    </div>
  </main></body></html>`;
  const orders = parseOrdersListDom(html);
  const order = orders[0];
  assert.ok(order);
  assert.equal(order.total, "$1,234.56", "a thousands-grouped total must not be dropped to null");
  assert.equal(order.itemCount, 12);
});

test("parseOrdersListDom dedupes an order id link appearing twice", () => {
  const html = `<html><body><main>
    <div data-qe-id="orderDetailsCard">
      <p>July 14, 2026</p>
      <a href="/my-account/order-history/HEB1000000001">View details</a>
      <a href="/my-account/order-history/HEB1000000001">duplicate link</a>
    </div>
  </main></body></html>`;
  const orders = parseOrdersListDom(html);
  assert.equal(orders.length, 1);
});

test("parseOrdersListDom returns an empty array for a page with no order links", () => {
  const orders = parseOrdersListDom(fixture("orders-list-empty.html"));
  assert.deepEqual(orders, []);
});

test("resolveDomMaxPage reads the highest page= from the pagination nav", () => {
  assert.deepEqual(resolveDomMaxPage(fixture("orders-list.html")), { kind: "resolved", source: "dom", value: 3 });
});

test("resolveDomMaxPage is absent (not silently 1) when there is no pagination nav", () => {
  assert.deepEqual(resolveDomMaxPage(fixture("orders-list-empty.html")), { kind: "absent" });
});

test("resolveDomMaxPage resolves a genuine single-page nav (one page=1 link) to value 1", () => {
  const html = `<html><body><main>
    <nav aria-label="Pagination Navigation">
      <a href="/my-account/your-orders?page=1">1</a>
    </nav>
  </main></body></html>`;
  assert.deepEqual(resolveDomMaxPage(html), { kind: "resolved", source: "dom", value: 1 });
});

test("resolveDomMaxPage is contradictory when a nav is present but no page= link parses", () => {
  const html = `<html><body><main>
    <nav aria-label="Pagination Navigation">
      <a href="/my-account/your-orders?page=">malformed page link</a>
    </nav>
  </main></body></html>`;
  assert.deepEqual(resolveDomMaxPage(html), {
    kind: "contradictory",
    reason: "pagination nav present but no page= link parsed",
  });
});

test("resolveMaxPage falls back to DOM when structured __NEXT_DATA__ is absent", () => {
  assert.deepEqual(resolveMaxPage(fixture("orders-list.html")), { kind: "resolved", source: "dom", value: 3 });
});

test("resolveMaxPage prefers structured pages[] over DOM when both are present", () => {
  const resolution = resolveMaxPage(fixture("orders-list-nextdata.html"));
  assert.deepEqual(resolution, { kind: "resolved", source: "structured", value: 4 });
});

test("resolveMaxPage does not mask a contradictory structured result with a clean DOM fallback (regression lock for the combinator's documented contract)", () => {
  // structured page:9 exceeds structured pages[] max of 2 (contradictory), while
  // the DOM nav is clean and would otherwise resolve to 4 — the combinator must
  // surface the contradiction, not silently fall back to the DOM value.
  const html = `<html><body><main>
    <nav role="navigation" aria-label="Pagination Navigation">
      <ul data-qe-id="paginationList">
        <li><a data-qe-id="paginationListNum" href="/my-account/your-orders?page=1">1</a></li>
        <li><a data-qe-id="paginationListNum" href="/my-account/your-orders?page=2">2</a></li>
        <li><a data-qe-id="paginationListNum" href="/my-account/your-orders?page=3">3</a></li>
        <li><a data-qe-id="paginationListNum" href="/my-account/your-orders?page=4">4</a></li>
      </ul>
    </nav>
  </main>
  <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"page":9,"pages":[{"to":"?page=1"},{"to":"?page=2"}]}}}</script>
  </body></html>`;
  assert.deepEqual(resolveMaxPage(html), {
    kind: "contradictory",
    reason: "structured current page exceeds structured pages[] max",
  });
});

test("resolveStructuredMaxPage is absent when pageProps is null", () => {
  assert.deepEqual(resolveStructuredMaxPage(null), { kind: "absent" });
});

test("resolveStructuredMaxPage is absent when pages[] is missing", () => {
  assert.deepEqual(resolveStructuredMaxPage({ page: 1 }), { kind: "absent" });
});

test("resolveStructuredMaxPage resolves the max ?page=N across pages[]", () => {
  assert.deepEqual(resolveStructuredMaxPage({ page: 1, pages: [{ to: "?page=1" }, { to: "?page=4" }] }), {
    kind: "resolved",
    source: "structured",
    value: 4,
  });
});

test("resolveStructuredMaxPage resolves a genuine single page (pages: [{to:'?page=1'}])", () => {
  assert.deepEqual(resolveStructuredMaxPage({ page: 1, pages: [{ to: "?page=1" }] }), {
    kind: "resolved",
    source: "structured",
    value: 1,
  });
});

test("resolveStructuredMaxPage is contradictory when current page exceeds the pages[] max", () => {
  assert.deepEqual(resolveStructuredMaxPage({ page: 9, pages: [{ to: "?page=1" }, { to: "?page=2" }] }), {
    kind: "contradictory",
    reason: "structured current page exceeds structured pages[] max",
  });
});

// ─── Structured order-list source (__NEXT_DATA__) ─────────────────────────
// orders-list-nextdata.html is a hand-scrubbed, structurally-faithful
// transcription of the __NEXT_DATA__ shape observed in the retained
// out-of-repo live capture (see the fixture's own header comment and
// design.md Decision 1) — every key name/nesting is real, every PII value is
// synthetic.

test("parseOrdersListStructured extracts every trustworthy row from props.pageProps.orders[]", () => {
  const orders = parseOrdersListStructured(fixture("orders-list-nextdata.html"));
  assert.ok(orders);
  // 5 rows in the fixture; the last ("not-a-real-heb-order-id") has an
  // orderId but no other evidenced fields, so it IS trustworthy (orderId is
  // the only required field) — it still yields a row with everything else
  // null except statusCode being also null since status is absent too.
  assert.equal(orders.length, 5);
});

test("parseOrdersListStructured maps status vs status_code as two distinct evidenced fields", () => {
  const orders = parseOrdersListStructured(fixture("orders-list-nextdata.html"));
  const first = orders?.find((o) => o.orderId === "HEBFIXTURE0000000001");
  assert.ok(first);
  assert.equal(first.status, "Delivered", "status keeps the human-readable orderStatusMessageShort meaning");
  assert.equal(first.statusCode, "PAYMENT_RECEIPTED", "status_code carries the distinct machine-readable value");
});

test("parseOrdersListStructured maps evidenced timeslot/store/unfulfilled fields", () => {
  const orders = parseOrdersListStructured(fixture("orders-list-nextdata.html"));
  const first = orders?.find((o) => o.orderId === "HEBFIXTURE0000000001");
  assert.ok(first);
  assert.equal(first.timeslotStart, "2026-07-07T16:00:00Z");
  assert.equal(first.timeslotEnd, "2026-07-07T17:00:00Z");
  assert.equal(first.storeName, "H-E-B Synthetic Store");
  assert.equal(first.unfulfilledCount, 0);
  assert.equal(first.source, "structured");
});

test("parseOrdersListStructured surfaces a nonzero unfulfilled_count distinct from productCount/item_count", () => {
  const orders = parseOrdersListStructured(fixture("orders-list-nextdata.html"));
  const second = orders?.find((o) => o.orderId === "HEBFIXTURE0000000002");
  assert.ok(second);
  assert.equal(second.unfulfilledCount, 2);
});

test("parseOrdersListStructured does NOT populate order_date/item_count/fulfillment_method/fulfillment_location from structured data (no proven semantic equivalence)", () => {
  const orders = parseOrdersListStructured(fixture("orders-list-nextdata.html"));
  const first = orders?.find((o) => o.orderId === "HEBFIXTURE0000000001");
  assert.ok(first);
  // orderDateRaw is fed from the timeslot only as a structured-row fallback
  // fill (see mergeOrdersListPage), but total/itemCount/fulfillmentMethod/
  // fulfillmentLocation stay null/"unknown" from the structured parser itself
  // — DOM remains authoritative for these per design.md Decision 1.
  assert.equal(first.total, null);
  assert.equal(first.itemCount, null);
  assert.equal(first.fulfillmentMethod, "unknown");
  assert.equal(first.fulfillmentLocation, null);
});

test("parseOrdersListStructured drops a row with no orderId (untrustworthy row falls back to DOM)", () => {
  const orders = parseOrdersListStructured(fixture("orders-list-nextdata.html"));
  assert.ok(orders);
  assert.ok(!orders.some((o) => o.orderId === ""));
});

test("parseOrdersListStructured returns null when __NEXT_DATA__ is absent (page-level fallback trigger)", () => {
  assert.equal(parseOrdersListStructured(fixture("orders-list.html")), null);
});

test("parseOrdersListStructured returns null when __NEXT_DATA__ contains malformed JSON", () => {
  const html = '<html><body><script id="__NEXT_DATA__" type="application/json">{not valid json</script></body></html>';
  assert.equal(parseOrdersListStructured(html), null);
});

test("parseOrdersListStructured returns null when pageProps.orders is missing", () => {
  const html =
    '<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script></body></html>';
  assert.equal(parseOrdersListStructured(html), null);
});

test("parseOrdersListStructured returns an empty array (not null) when orders[] is present but every row is untrustworthy", () => {
  const html =
    '<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"orders":[{"status":"X"},{}]}}}</script></body></html>';
  assert.deepEqual(parseOrdersListStructured(html), []);
});

// ─── Structured/DOM merge (precedence + fallback) ──────────────────────────

test("mergeOrdersListPage prefers the structured row's evidenced fields but keeps DOM-only fields", () => {
  const structured = [
    {
      orderId: "HEB1",
      orderDateRaw: "2026-07-07T16:00:00Z",
      total: null,
      itemCount: null,
      status: "Delivered",
      statusCode: "PAYMENT_RECEIPTED",
      fulfillmentMethod: "unknown" as const,
      fulfillmentLocation: null,
      source: "structured" as const,
      storeName: "Store A",
      timeslotStart: "2026-07-07T16:00:00Z",
      timeslotEnd: "2026-07-07T17:00:00Z",
      unfulfilledCount: 0,
    },
  ];
  const dom = [
    {
      orderId: "HEB1",
      orderDateRaw: "Jul 7, 2026",
      total: "$100.00",
      itemCount: 10,
      status: "Delivered",
      statusCode: null,
      fulfillmentMethod: "curbside" as const,
      fulfillmentLocation: "Store A",
      source: "dom" as const,
      storeName: null,
      timeslotStart: null,
      timeslotEnd: null,
      unfulfilledCount: null,
    },
  ];
  const merged = mergeOrdersListPage(structured, dom);
  assert.equal(merged.length, 1);
  const row = merged[0];
  assert.ok(row);
  assert.equal(row.source, "structured");
  assert.equal(row.statusCode, "PAYMENT_RECEIPTED", "structured-only field is preserved");
  assert.equal(row.total, "$100.00", "DOM-only field is carried over onto the preferred structured row");
  assert.equal(row.itemCount, 10);
  assert.equal(row.fulfillmentMethod, "curbside");
  assert.equal(row.fulfillmentLocation, "Store A");
  assert.equal(
    row.orderDateRaw,
    "Jul 7, 2026",
    "orderDateRaw stays DOM-authoritative on a merged row, not the structured UTC timeslot"
  );
});

test("mergeOrdersListPage keeps order_date DOM-authoritative for an evening-local timeslot that crosses into the next UTC day (adversarial regression for BLOCKER 1)", () => {
  // H-E-B delivery at 7-9pm US Central = 00:00-02:00Z the *next* UTC day. DOM
  // free text renders the owner-visible local calendar date (Jul 7); the
  // structured orderTimeslot.startDateTime is already Jul 8 in UTC. A merge
  // that sources order_date from the structured timestamp would silently
  // shift the owner-visible date forward by one day.
  const structured = [
    {
      orderId: "HEB1",
      orderDateRaw: "2026-07-08T02:00:00Z",
      total: null,
      itemCount: null,
      status: "Delivered",
      statusCode: "PAYMENT_RECEIPTED",
      fulfillmentMethod: "unknown" as const,
      fulfillmentLocation: null,
      source: "structured" as const,
      storeName: "Store A",
      timeslotStart: "2026-07-08T02:00:00Z",
      timeslotEnd: "2026-07-08T03:00:00Z",
      unfulfilledCount: 0,
    },
  ];
  const dom = [
    {
      orderId: "HEB1",
      orderDateRaw: "Jul 7, 2026",
      total: "$100.00",
      itemCount: 10,
      status: "Delivered",
      statusCode: null,
      fulfillmentMethod: "curbside" as const,
      fulfillmentLocation: "Store A",
      source: "dom" as const,
      storeName: null,
      timeslotStart: null,
      timeslotEnd: null,
      unfulfilledCount: null,
    },
  ];
  const merged = mergeOrdersListPage(structured, dom);
  const row = merged[0];
  assert.ok(row);
  assert.equal(
    row.orderDateRaw,
    "Jul 7, 2026",
    "merged row keeps the DOM orderDateRaw, not the structured UTC timeslot"
  );
  assert.equal(
    parseOrderDate(row.orderDateRaw),
    "2026-07-07",
    "emitted/parsed order_date stays the DOM-rendered local day, not the next UTC day"
  );
});

test("mergeOrdersListPage falls back to the DOM row when no structured row shares its order id (per-row fallback)", () => {
  const structured = [
    {
      orderId: "HEB-STRUCTURED-ONLY",
      orderDateRaw: null,
      total: null,
      itemCount: null,
      status: null,
      statusCode: null,
      fulfillmentMethod: "unknown" as const,
      fulfillmentLocation: null,
      source: "structured" as const,
      storeName: null,
      timeslotStart: null,
      timeslotEnd: null,
      unfulfilledCount: null,
    },
  ];
  const dom = [
    {
      orderId: "HEB-DOM-ONLY",
      orderDateRaw: "Jul 7, 2026",
      total: "$5.00",
      itemCount: 1,
      status: "Delivered",
      statusCode: null,
      fulfillmentMethod: "delivery" as const,
      fulfillmentLocation: "123 Ave",
      source: "dom" as const,
      storeName: null,
      timeslotStart: null,
      timeslotEnd: null,
      unfulfilledCount: null,
    },
  ];
  const merged = mergeOrdersListPage(structured, dom);
  const domRow = merged.find((o) => o.orderId === "HEB-DOM-ONLY");
  assert.ok(domRow);
  assert.equal(domRow.source, "dom");
  const structuredRow = merged.find((o) => o.orderId === "HEB-STRUCTURED-ONLY");
  assert.ok(structuredRow, "a structured-only row with no DOM counterpart is still retained");
});

test("mergeOrdersListPage returns the DOM list unchanged when structured is null (page-level fallback)", () => {
  const dom = parseOrdersListDom(fixture("orders-list.html"));
  assert.deepEqual(mergeOrdersListPage(null, dom), dom);
});

test("mergeOrdersListPage on the real fixture: structured rows for HEBFIXTURE ids fall back to DOM entirely (no DOM counterpart in this fixture, so total/itemCount stay null)", () => {
  const html = fixture("orders-list-nextdata.html");
  const structured = parseOrdersListStructured(html);
  const dom = parseOrdersListDom(html);
  const merged = mergeOrdersListPage(structured, dom);
  const first = merged.find((o) => o.orderId === "HEBFIXTURE0000000001");
  assert.ok(first);
  assert.equal(first.source, "structured");
});

// ─── Order-detail page ────────────────────────────────────────────────────

test("parseOrderDetailDom extracts every line item", () => {
  const detail = parseOrderDetailDom(fixture("order-detail.html"));
  assert.ok(detail);
  assert.equal(detail.items.length, 3);
});

test("parseOrderDetailDom parses a whole-number quantity item with its department", () => {
  const detail = parseOrderDetailDom(fixture("order-detail.html"));
  const milk = detail?.items[0];
  assert.ok(milk);
  assert.equal(milk.name, "H-E-B Organic 2% Reduced Fat Milk");
  assert.equal(milk.productId, "123456789");
  assert.equal(milk.department, "Dairy & eggs");
  assert.equal(milk.quantity, 2);
  assert.equal(milk.lineTotal, "$4.29");
  assert.equal(milk.imageUrl, "https://images.heb.com/is/image/HEBGrocery/prd-small/123456789.jpg");
});

test("parseOrderDetailDom prefers the structured 'Qty: N of M' actual-fulfilled amount for a substituted item", () => {
  const detail = parseOrderDetailDom(fixture("order-detail.html"));
  const eggs = detail?.items[1];
  assert.ok(eggs);
  assert.equal(eggs.name, "H-E-B Select Ingredients Large Eggs");
  // Structured span says "Qty: 1 of 2" (1 = actual, substituted down from 2
  // ordered); the free-text a11y line still says "Quantity: 1 each" — the
  // structured actual-fulfilled amount is preferred.
  assert.equal(eggs.quantity, 1);
  assert.equal(eggs.lineTotal, "$3.98");
});

test("parseOrderDetailDom parses a weighted item's fractional actual-fulfilled quantity, never a truncated integer", () => {
  const detail = parseOrderDetailDom(fixture("order-detail.html"));
  const bananas = detail?.items[2];
  assert.ok(bananas);
  assert.equal(bananas.name, "Organic Bananas");
  assert.equal(bananas.department, "Fruit & vegetables");
  // Structured span "Qty: 1.2 of 1.2 lbs" — the real value is a fraction of a
  // pound, must not truncate/round to a false integer.
  assert.equal(bananas.quantity, 1.2);
  assert.equal(bananas.lineTotal, "$1.12");
});

// parseDetailQuantity: prefers the structured "Qty: N[ of M[ unit]]" span
// (actual fulfilled/charged amount) over the free-text "Quantity: ..." line
// (ordered amount). Falls back to the free-text line only when no structured
// span is present. Never fabricates/truncates a wrong integer.
test("parseDetailQuantity: a structured 'Qty: N' span parses cleanly", () => {
  assert.equal(parseDetailQuantity("Qty: 3"), 3);
});

test("parseDetailQuantity: a structured 'Qty: N of M unit' substitution reports the actual (first) amount", () => {
  assert.equal(parseDetailQuantity("Qty: 1.25 of 2.4 lbs"), 1.25);
});

test("parseDetailQuantity: a structured 'Qty: N of M' count substitution (no unit) reports the actual amount", () => {
  assert.equal(parseDetailQuantity("Qty: 3 of 4"), 3);
});

test("parseDetailQuantity: falls back to the free-text 'Quantity: N' line when no structured span is present", () => {
  assert.equal(parseDetailQuantity("Quantity: 3."), 3);
});

test("parseDetailQuantity: a free-text decimal weight with a unit returns null when no structured span is present (P1 regression)", () => {
  assert.equal(parseDetailQuantity("Quantity: 1.5 lb."), null);
});

test("parseDetailQuantity: a free-text whole-number weight with a unit returns null when no structured span is present", () => {
  assert.equal(parseDetailQuantity("Quantity: 2 kg"), null);
});

test("parseOrderDetailDom: every product-detail row emits a duplicate aria-hidden image-wrapper anchor with no name; the name anchor is selected instead (S2 regression)", () => {
  const html = `<html><body><main><ul>
    <li data-qe-id="itemRow">
      <div><a tabindex="-1" aria-hidden="true" href="/product-detail/ground-beef/700100"><img alt="Ground Beef"></a></div>
      <div>
        <a data-qe-id="itemRowDetailsName" href="/product-detail/ground-beef/700100">Ground Beef</a>
        <span data-qe-id="checkoutItemPrice">$8.97</span>
        <span data-qe-id="orderItemQty">Qty: 1.5 lb</span>
      </div>
    </li>
  </ul></main></body></html>`;
  const detail = parseOrderDetailDom(html);
  assert.equal(detail?.items.length, 1);
  const beef = detail?.items[0];
  assert.ok(beef);
  assert.equal(beef.name, "Ground Beef");
  assert.equal(beef.quantity, 1.5);
  assert.equal(beef.lineTotal, "$8.97");
});

test("parseOrderDetailDom dedupes a product-detail href appearing twice", () => {
  const html = `<html><body><main><ul>
    <li data-qe-id="itemRow">
      <a data-qe-id="itemRowDetailsName" href="/product-detail/x/500">Widget</a>
      <span data-qe-id="checkoutItemPrice">$1.00</span>
      <span data-qe-id="orderItemQty">Qty: 1</span>
    </li>
    <li data-qe-id="itemRow">
      <a data-qe-id="itemRowDetailsName" href="/product-detail/x/500">Widget</a>
      <span data-qe-id="checkoutItemPrice">$1.00</span>
      <span data-qe-id="orderItemQty">Qty: 1</span>
    </li>
  </ul></main></body></html>`;
  const detail = parseOrderDetailDom(html);
  assert.equal(detail?.items.length, 1);
});

test("parseOrderDetailDom returns null for a page with zero item rows", () => {
  const detail = parseOrderDetailDom(fixture("orders-list-empty.html"));
  assert.equal(detail, null);
});

test("productImageUrl zero-pads a short numeric product id to 9 digits", () => {
  assert.equal(productImageUrl("2001"), "https://images.heb.com/is/image/HEBGrocery/prd-small/000002001.jpg");
});

test("productImageUrl returns null for a non-numeric product id", () => {
  assert.equal(productImageUrl("abc-123"), null);
});

test("productImageUrl returns null for a decimal-shaped product id (P2 regression)", () => {
  // A malformed/variant href could yield a decimal-like last segment. The CDN
  // convention only documents plain zero-padded digit product ids — a decimal
  // must not produce a plausible-looking but invalid image URL.
  assert.equal(productImageUrl("123.45"), null);
});

test("productImageUrl returns null for a product id containing whitespace", () => {
  assert.equal(productImageUrl("123 45"), null);
  assert.equal(productImageUrl(" 12345"), null);
  assert.equal(productImageUrl("12345 "), null);
});

test("productImageUrl returns null for a null product id", () => {
  assert.equal(productImageUrl(null), null);
});

// ─── Incapsula block detection ────────────────────────────────────────────

test("isIncapsulaBlocked detects the documented empty-shell heuristic", () => {
  assert.equal(isIncapsulaBlocked(fixture("incapsula-block.html")), true);
});

test("isIncapsulaBlocked is false for a normal populated page", () => {
  assert.equal(isIncapsulaBlocked(fixture("orders-list.html")), false);
});

test("isIncapsulaBlocked is false for a legitimate empty terminal page (has h3/breadcrumb/testid)", () => {
  assert.equal(isIncapsulaBlocked(fixture("orders-list-empty.html")), false);
});

test("isIncapsulaBlocked is false for an iframe-free shallow page (no false positive from body size alone)", () => {
  const html = "<html><body><p>hi</p></body></html>";
  assert.equal(isIncapsulaBlocked(html), false);
});

// ─── Session probe (deep check) ──────────────────────────────────────────

test("looksLoggedOut is true for a sign-in URL", () => {
  assert.equal(looksLoggedOut("https://www.heb.com/sign-in", fixture("orders-list.html")), true);
});

test("looksLoggedOut is true when a password form is visible even on a non-matching URL", () => {
  assert.equal(looksLoggedOut("https://www.heb.com/my-account/your-orders", fixture("sign-in-page.html")), true);
});

test("looksLoggedOut is false for a normal orders page", () => {
  assert.equal(looksLoggedOut("https://www.heb.com/my-account/your-orders", fixture("orders-list.html")), false);
});

// ─── Empty-list-page diagnostics ─────────────────────────────────────────

test("diagnoseEmptyListPage reports zero order_cards for a legitimate terminal page", () => {
  const diag = diagnoseEmptyListPage(fixture("orders-list-empty.html"), "https://www.heb.com/my-account/your-orders");
  assert.equal(diag.order_cards, 0);
  assert.equal(diag.incapsula_block, false);
  assert.equal(diag.password_form, false);
});

test("diagnoseEmptyListPage flags an Incapsula block", () => {
  const diag = diagnoseEmptyListPage(fixture("incapsula-block.html"), "https://www.heb.com/my-account/your-orders");
  assert.equal(diag.incapsula_block, true);
});

// ─── Pure helpers ─────────────────────────────────────────────────────────

test("parseOrderDate normalizes a long-form US date to YYYY-MM-DD", () => {
  assert.equal(parseOrderDate("July 14, 2026"), "2026-07-14");
});

test("parseOrderDate returns null for unparseable input", () => {
  assert.equal(parseOrderDate("not a date"), null);
  assert.equal(parseOrderDate(null), null);
  assert.equal(parseOrderDate(undefined), null);
});

test("parseCurrencyCents converts a dollar string to integer cents", () => {
  assert.equal(parseCurrencyCents("$87.45"), 8745);
});

test("parseCurrencyCents handles thousands separators", () => {
  assert.equal(parseCurrencyCents("$1,234.56"), 123_456);
});

test("parseCurrencyCents returns null for null/empty input", () => {
  assert.equal(parseCurrencyCents(null), null);
  assert.equal(parseCurrencyCents(""), null);
});

test("orderItemId prefers product_id over name", () => {
  assert.equal(orderItemId("HEB123", { productId: "999", name: "Milk" }, 0), "HEB123|999");
});

test("orderItemId falls back to a normalized name + item index when product_id is absent", () => {
  assert.equal(
    orderItemId("HEB123", { productId: null, name: "  Organic   Bananas  " }, 0),
    "HEB123|organic bananas|0"
  );
});

test("orderItemId: two same-name, product-id-null items in one order get distinct ids", () => {
  const first = orderItemId("HEB123", { productId: null, name: "Fresh Produce" }, 0);
  const second = orderItemId("HEB123", { productId: null, name: "Fresh Produce" }, 1);
  assert.notEqual(first, second, "two null-product-id items with the same name must not collide");
  assert.equal(first, "HEB123|fresh produce|0");
  assert.equal(second, "HEB123|fresh produce|1");
});

// ─── Record builders ──────────────────────────────────────────────────────

test("buildOrderRecord maps a parsed list order into the emitted orders shape", () => {
  const orders = parseOrdersListDom(fixture("orders-list.html"));
  const first = orders[0];
  assert.ok(first);
  const record = buildOrderRecord(first, "2026-07-14", "2026-07-14T12:00:00.000Z");
  assert.equal(record.id, "HEB1029384756");
  assert.equal(record.order_date, "2026-07-14");
  assert.equal(record.fulfillment_method, "curbside");
  assert.equal(record.total_cents, 8745);
  assert.equal(record.fetched_at, "2026-07-14T12:00:00.000Z");
});

test("buildOrderItemRecord maps a parsed detail item into the emitted order_items shape", () => {
  const detail = parseOrderDetailDom(fixture("order-detail.html"));
  const milk = detail?.items[0];
  assert.ok(milk);
  const record = buildOrderItemRecord("HEB1029384756", "2026-07-14", milk, 0, "2026-07-14T12:00:00.000Z");
  assert.equal(record.id, "HEB1029384756|123456789");
  assert.equal(record.order_id, "HEB1029384756");
  assert.equal(record.name, "H-E-B Organic 2% Reduced Fat Milk");
  assert.equal(record.department, "Dairy & eggs");
  assert.equal(record.line_total_cents, 429);
  assert.equal(record.order_date, "2026-07-14");
});
