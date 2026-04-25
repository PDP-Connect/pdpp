import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildOrderItemRecord,
  buildOrderRecord,
  itemId,
  mergeDetailByKey,
  mergeOrderItems,
  parseCurrencyCents,
  parseOrderDate,
  parseOrderDetailDom,
  parseOrdersListDom,
} from "./parsers.ts";
import type { DetailItem, ListPageOrder, OrderDetail } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "__fixtures__");
const LOCAL_RAW_DIR = join(__dirname, "..", "..", "fixtures", "amazon", "raw", "2026-04-23T00-13-01-167Z", "dom");
const SCRUBBED_FIXTURE_DIR = join(__dirname, "..", "..", "fixtures", "amazon", "scrubbed", "pilot-real-shape", "dom");

function readFixture(relPath: string): string {
  return readFileSync(join(FIXTURE_DIR, relPath), "utf8");
}

// ─── parseOrderDate ──────────────────────────────────────────────────────

test("parseOrderDate: common value-span forms", () => {
  const cases: [string, string][] = [
    ["January 5, 2024", "2024-01-05"],
    ["Jan 5, 2024", "2024-01-05"],
    ["December 31, 2023", "2023-12-31"],
    // ISO date (Date parses as UTC midnight)
    ["2024-01-05", "2024-01-05"],
    // RFC 2822-ish
    ["Fri, 05 Jan 2024 00:00:00 GMT", "2024-01-05"],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(parseOrderDate(raw), expected, `input=${JSON.stringify(raw)}`);
  }
});

test("parseOrderDate: returns null for empty / nullish / malformed", () => {
  assert.equal(parseOrderDate(undefined), null);
  assert.equal(parseOrderDate(null), null);
  assert.equal(parseOrderDate(""), null);
  assert.equal(parseOrderDate("not a date at all"), null);
  assert.equal(parseOrderDate("Febtober 99, 2099"), null);
});

test("parseOrderDate: V8 Date parser is lenient with label-prefixed input", () => {
  // Discovered while writing tests: `new Date("Ordered on January 5, 2024")`
  // is accepted by V8 and yields the correct day — it silently ignores
  // the prefix. In practice the connector never passes such strings
  // (it calls findHeaderValue which returns the value span separately
  // from the label), so this is a harmless quirk, not a bug. Recording
  // the behavior in a test so any future divergence is intentional.
  assert.equal(parseOrderDate("Ordered on January 5, 2024"), "2024-01-05");
});

// ─── parseCurrencyCents ──────────────────────────────────────────────────

test("parseCurrencyCents: basic dollar amounts", () => {
  assert.equal(parseCurrencyCents("$0.99"), 99);
  assert.equal(parseCurrencyCents("$1"), 100);
  assert.equal(parseCurrencyCents("$15.54"), 1554);
});

test("parseCurrencyCents: handles thousands separators", () => {
  // Regression: the old regex stopped at the comma and read "$1,234.56" as
  // 100 cents. Amazon totals >= $1,000 would be dramatically understated.
  assert.equal(parseCurrencyCents("$1,234.56"), 123_456);
  assert.equal(parseCurrencyCents("$12,345.00"), 1_234_500);
  assert.equal(parseCurrencyCents("$1,000,000"), 100_000_000);
});

test("parseCurrencyCents: handles negative values (leading minus or parens)", () => {
  // Refund amounts on detail pages can be negative. Previously the sign
  // was dropped and a refund was recorded as a positive charge.
  assert.equal(parseCurrencyCents("-$5.00"), -500);
  assert.equal(parseCurrencyCents("($5.00)"), -500);
  assert.equal(parseCurrencyCents("-$1,234.56"), -123_456);
});

test("parseCurrencyCents: unparseable / empty / nullish returns null", () => {
  assert.equal(parseCurrencyCents(undefined), null);
  assert.equal(parseCurrencyCents(null), null);
  assert.equal(parseCurrencyCents(""), null);
  assert.equal(parseCurrencyCents("Free"), null);
  assert.equal(parseCurrencyCents("$"), null);
  assert.equal(parseCurrencyCents("no digits here"), null);
});

// ─── itemId ──────────────────────────────────────────────────────────────

test("itemId: prefers ASIN when present", () => {
  assert.equal(itemId("111-2222222-3333333", { asin: "B01ABCDEFG", name: "Widget" }), "111-2222222-3333333|B01ABCDEFG");
});

test("itemId: falls back to normalized name when ASIN missing", () => {
  assert.equal(itemId("111-2222222-3333333", { asin: null, name: "Super Widget" }), "111-2222222-3333333|super widget");
});

test("itemId: normalizes whitespace in name fallback", () => {
  assert.equal(
    itemId("111-2222222-3333333", { name: "  Super   Widget\tPro\n" }),
    "111-2222222-3333333|super widget pro"
  );
});

test("itemId: falls back to 'unknown' when both ASIN and name are absent/empty", () => {
  assert.equal(itemId("111-2222222-3333333", {}), "111-2222222-3333333|unknown");
  assert.equal(itemId("111-2222222-3333333", { asin: null, name: "" }), "111-2222222-3333333|unknown");
  // Whitespace-only name collapses to empty -> falsy -> "unknown"
  assert.equal(itemId("111-2222222-3333333", { name: "   " }), "111-2222222-3333333|unknown");
});

// ─── mergeDetailByKey (covered as a sanity check on the extracted helper) ─

// ─── parseOrdersListDom ──────────────────────────────────────────────────

test("parseOrdersListDom: scrubbed real-shape fixture extracts full orders", () => {
  const html = readFileSync(join(SCRUBBED_FIXTURE_DIR, "orders-list-2026.html"), "utf8");
  const orders = parseOrdersListDom(html);
  assert.equal(orders.length, 1);
  const o = orders[0];
  assert.ok(o);
  assert.equal(o.orderId, "113-7654321-4567890");
  assert.equal(o.orderDateRaw, "April 18, 2026");
  assert.equal(o.orderTotal, "$86.42");
  assert.equal(o.deliveryStatus, "Delivered April 20 to [REDACTED_NAME] at [REDACTED_ADDRESS]");
  assert.equal(o.items.length, 2);
  assert.deepEqual(o.items[0], {
    name: "Noise Canceling Headphones",
    url: "https://www.amazon.com/dp/B0REALSH1A?ref=ppx_yo_dt_b_product_details",
    asin: "B0REALSH1A",
  });
  assert.deepEqual(o.items[1], {
    name: "USB-C Travel Charger",
    url: "https://www.amazon.com/gp/product/B0REALSH2B?ref=ppx_yo_dt_b_product_details",
    asin: "B0REALSH2B",
  });
});

test("parseOrdersListDom: empty page returns []", () => {
  assert.deepEqual(parseOrdersListDom("<!doctype html><html><body><div>no orders</div></body></html>"), []);
  assert.deepEqual(parseOrdersListDom(""), []);
});

test("parseOrdersListDom: local real fixture parses ≥5 orders with ids + dates", {
  skip: !existsSync(LOCAL_RAW_DIR),
}, () => {
  const path = join(LOCAL_RAW_DIR, "orders-list-2024.html");
  if (!existsSync(path)) {
    return;
  }
  const html = readFileSync(path, "utf8");
  const orders = parseOrdersListDom(html);
  assert.ok(orders.length >= 5, `expected ≥5 orders, got ${orders.length}`);
  for (const o of orders) {
    assert.match(o.orderId, /^\d{3}-\d{7}-\d{7}$/);
    assert.ok(o.orderDateRaw, `order ${o.orderId} missing orderDateRaw`);
  }
});

// ─── parseOrderDetailDom ─────────────────────────────────────────────────

test("parseOrderDetailDom: synthetic-minimal fixture parses full OrderDetail", () => {
  const html = readFixture("order-detail-minimal.html");
  const d = parseOrderDetailDom(html);
  assert.ok(d, "expected non-null OrderDetail");
  assert.equal(d.grand_total, "$42.99");
  assert.equal(d.recipient_name, "Fictional Person");
  assert.equal(d.shipping_address_summary, "Fictional Person, 123 Placeholder Ln, Fakeville, TX 00000");
  assert.equal(d.payment_method_summary, "Visa ending in 1234");
  assert.equal(d.gift_order, false);
  assert.equal(d.digital_order, false);
  assert.equal(d.status_detail, null);
  assert.equal(d.items.length, 1);
  const item = d.items[0];
  assert.ok(item);
  assert.equal(item.asin, "B01ABCDEFG");
  assert.equal(item.name, "Synthetic Widget Model A");
  assert.equal(item.url, "https://www.amazon.com/dp/B01ABCDEFG?ref=fake");
  assert.equal(item.seller, "Fictional Seller Inc");
  assert.equal(item.unit_price, "$39.99");
  assert.equal(item.quantity, 1);
  assert.equal(item.item_image_url, "https://example.com/img.jpg");
  assert.equal(item.refund_status, null);
});

test("parseOrderDetailDom: shipping address <li>-only fallback (no inner span)", () => {
  // Old Amazon layouts render address lines as plain <li> without the
  // a-list-item <span>. The parser must still extract one line per <li>,
  // not match both outer + inner and duplicate.
  const html = `<!doctype html><html><body><div id="orderDetails">
    <div data-component="shippingAddress">
      <ul>
        <li>Jane Doe</li>
        <li>456 Main St</li>
        <li>Oakland, CA 94607</li>
      </ul>
    </div>
  </div></body></html>`;
  const d = parseOrderDetailDom(html);
  assert.ok(d);
  assert.equal(d.recipient_name, "Jane Doe");
  assert.equal(d.shipping_address_summary, "Jane Doe, 456 Main St, Oakland, CA 94607");
});

test("parseOrderDetailDom: missing #orderDetails container returns null", () => {
  assert.equal(parseOrderDetailDom("<!doctype html><html><body><div>no details</div></body></html>"), null);
  assert.equal(parseOrderDetailDom(""), null);
});

test("parseOrderDetailDom: #orderDetails present but no data-components returns empty-ish OrderDetail", () => {
  // Matches the original browser-context behavior: container exists → returns an
  // OrderDetail with every structural field null and items=[].
  const html = '<!doctype html><html><body><div id="orderDetails"></div></body></html>';
  const d = parseOrderDetailDom(html);
  assert.ok(d);
  assert.equal(d.grand_total, null);
  assert.equal(d.recipient_name, null);
  assert.equal(d.shipping_address_summary, null);
  assert.equal(d.payment_method_summary, null);
  assert.equal(d.status_detail, null);
  assert.equal(d.gift_order, false);
  assert.equal(d.digital_order, false);
  assert.deepEqual(d.items, []);
});

test("parseOrderDetailDom: cancelled order returns cancelled shape with empty items", () => {
  const html = `<!doctype html><html><body>
    <div id="orderDetails">
      <div data-component="cancelled">This order has been cancelled</div>
      <div data-component="purchasedItemsRightGrid">
        <div data-component="itemTitle"><a href="/dp/B01ABCDEFG">Synthetic Widget</a></div>
      </div>
    </div>
  </body></html>`;
  const d = parseOrderDetailDom(html);
  assert.ok(d);
  assert.equal(d.status_detail, "This order has been cancelled");
  assert.equal(d.recipient_name, null);
  assert.equal(d.grand_total, null);
  assert.deepEqual(d.items, []);
});

test("parseOrderDetailDom: local real fixtures yield items and grand_total", {
  skip: !existsSync(LOCAL_RAW_DIR),
}, () => {
  for (const name of ["order-detail-111-1177311-6377828.html", "order-detail-111-2841132-0656246.html"]) {
    const path = join(LOCAL_RAW_DIR, name);
    if (!existsSync(path)) {
      continue;
    }
    const html = readFileSync(path, "utf8");
    const d = parseOrderDetailDom(html);
    assert.ok(d, `${name}: expected non-null OrderDetail`);
    assert.ok(d.items.length >= 1, `${name}: expected at least 1 item`);
    assert.ok(d.grand_total, `${name}: expected non-null grand_total`);
    assert.match(d.grand_total, /^\$[\d,]+\.\d{2}$/);
  }
});

// ─── mergeOrderItems + buildOrderRecord + buildOrderItemRecord ──────────

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

test("mergeOrderItems: merges list-page + detail items by ASIN, preferring detail enrichment", () => {
  const listOrder = makeListOrder({
    items: [
      { asin: "B01ABCDEFG", name: "Widget", url: "/dp/B01ABCDEFG" },
      { asin: "B02HIJKLMN", name: "Gadget", url: "/dp/B02HIJKLMN" },
    ],
  });
  const detail = makeDetail({
    items: [
      makeDetailItem({
        asin: "B01ABCDEFG",
        name: "Widget Pro Edition",
        unit_price: "$9.99",
        quantity: 2,
        seller: "FirstSeller",
        item_image_url: "https://ex/img.jpg",
      }),
      makeDetailItem({
        asin: "B02HIJKLMN",
        name: "Gadget X",
        unit_price: "$14.99",
        quantity: 1,
        seller: "SecondSeller",
      }),
    ],
  });
  const merged = mergeOrderItems(listOrder, detail);
  assert.equal(merged.length, 2);
  // First item: list fields (url, asin) present, spread of detail wins for
  // name/unit_price/seller. Spread order in parsers.ts: ...it, ...d — so
  // detail fields override list fields.
  assert.equal(merged[0]?.asin, "B01ABCDEFG");
  assert.equal(merged[0]?.name, "Widget Pro Edition");
  assert.equal(merged[0]?.unit_price, "$9.99");
  assert.equal(merged[0]?.seller, "FirstSeller");
  assert.equal(merged[0]?.quantity, 2);
  assert.equal(merged[1]?.asin, "B02HIJKLMN");
  assert.equal(merged[1]?.unit_price, "$14.99");
});

test("mergeOrderItems: detail null — list items emitted as-is", () => {
  const listOrder = makeListOrder({
    items: [
      { asin: "B01ABCDEFG", name: "Widget", url: "/dp/B01ABCDEFG" },
      { asin: null, name: "Unboxed Thing", url: null },
    ],
  });
  const merged = mergeOrderItems(listOrder, null);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.asin, "B01ABCDEFG");
  assert.equal(merged[0]?.name, "Widget");
  assert.equal(merged[1]?.name, "Unboxed Thing");
  // Unit price is undefined since list items carry no price.
  assert.equal(merged[0]?.unit_price, undefined);
});

test("mergeOrderItems: detail has items the list page missed — appended after list items", () => {
  const listOrder = makeListOrder({
    items: [{ asin: "B01ABCDEFG", name: "Widget", url: "/dp/B01ABCDEFG" }],
  });
  const detail = makeDetail({
    items: [
      makeDetailItem({ asin: "B01ABCDEFG", name: "Widget", unit_price: "$9.99" }),
      makeDetailItem({ asin: "B09EXTRA01", name: "Bonus Extra", unit_price: "$5.00" }),
    ],
  });
  const merged = mergeOrderItems(listOrder, detail);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.asin, "B01ABCDEFG");
  assert.equal(merged[0]?.unit_price, "$9.99");
  // Detail-only item appended.
  assert.equal(merged[1]?.asin, "B09EXTRA01");
  assert.equal(merged[1]?.name, "Bonus Extra");
});

test("mergeOrderItems: matches by normalized name when ASIN missing", () => {
  // Matching collapses internal whitespace + trims + lowercases, so two
  // items that differ only in whitespace / case still merge.
  const listOrder = makeListOrder({
    items: [{ asin: null, name: "  Super   Widget\tPro ", url: null }],
  });
  const detail = makeDetail({
    items: [makeDetailItem({ asin: null, name: "super widget pro", unit_price: "$7.50", seller: "NameMatch" })],
  });
  const merged = mergeOrderItems(listOrder, detail);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.name, "super widget pro");
  assert.equal(merged[0]?.seller, "NameMatch");
  assert.equal(merged[0]?.unit_price, "$7.50");
});

test("mergeOrderItems: dedups duplicate ASINs across list+detail", () => {
  // Deduping is by final itemId (orderId|asin). If the list and detail
  // both reference ASIN B01X only the first emission is kept.
  const listOrder = makeListOrder({
    items: [
      { asin: "B01DUPDUPDX", name: "A", url: null },
      { asin: "B01DUPDUPDX", name: "A again", url: null },
    ],
  });
  const merged = mergeOrderItems(listOrder, null);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.name, "A");
});

test("buildOrderRecord: both list + detail present — detail wins for enrichment fields", () => {
  const listOrder = makeListOrder({
    orderId: "111-2222222-3333333",
    orderTotal: "$10.00",
    deliveryStatus: "Arriving tomorrow",
    items: [{ asin: "B01", name: "A", url: null }],
  });
  const detail = makeDetail({
    grand_total: "$11.50",
    recipient_name: "Fictional Person",
    shipping_address_summary: "Somewhere",
    payment_method_summary: "Visa ending in 1234",
    gift_order: false,
    items: [makeDetailItem({ asin: "B01", name: "A" }), makeDetailItem({ asin: "B02", name: "B" })],
  });
  const rec = buildOrderRecord(listOrder, detail, "2024-01-15", "2024-01-20T00:00:00Z");
  assert.equal(rec.id, "111-2222222-3333333");
  assert.equal(rec.order_date, "2024-01-15");
  assert.equal(rec.order_total, "$11.50");
  assert.equal(rec.order_total_cents, 1150);
  assert.equal(rec.delivery_status, "Arriving tomorrow");
  assert.equal(rec.recipient_name, "Fictional Person");
  assert.equal(rec.payment_method_summary, "Visa ending in 1234");
  // item_count = max(list.items.length, detail.items.length) = max(1, 2) = 2.
  assert.equal(rec.item_count, 2);
  assert.equal(rec.fetched_at, "2024-01-20T00:00:00Z");
});

test("buildOrderRecord: detail null — falls back to list-page fields", () => {
  const listOrder = makeListOrder({
    orderTotal: "$42.99",
    items: [
      { asin: "B01", name: "A", url: null },
      { asin: "B02", name: "B", url: null },
    ],
  });
  const rec = buildOrderRecord(listOrder, null, "2024-01-15", "2024-01-20T00:00:00Z");
  assert.equal(rec.order_total, "$42.99");
  // Parse bug: commas aren't consumed; "$42.99" has no comma so 4299.
  assert.equal(rec.order_total_cents, 4299);
  assert.equal(rec.recipient_name, null);
  assert.equal(rec.payment_method_summary, null);
  assert.equal(rec.gift_order, false);
  assert.equal(rec.digital_order, false);
  assert.equal(rec.item_count, 2);
});

test("buildOrderItemRecord: builds emit-ready shape with cents, returned flag, and itemId", () => {
  const rec = buildOrderItemRecord("111-2222222-3333333", "2024-01-15", {
    asin: "B01ABCDEFG",
    name: "Widget",
    url: "https://www.amazon.com/dp/B01ABCDEFG",
    unit_price: "$9.99",
    quantity: 3,
    seller: "Amazon.com",
    item_image_url: "https://img",
    refund_status: "Returned January 20",
  });
  assert.equal(rec.id, "111-2222222-3333333|B01ABCDEFG");
  assert.equal(rec.order_id, "111-2222222-3333333");
  assert.equal(rec.order_date, "2024-01-15");
  assert.equal(rec.asin, "B01ABCDEFG");
  assert.equal(rec.name, "Widget");
  assert.equal(rec.unit_price, "$9.99");
  assert.equal(rec.unit_price_cents, 999);
  assert.equal(rec.quantity, 3);
  assert.equal(rec.seller, "Amazon.com");
  assert.equal(rec.returned, true);
  assert.equal(rec.refund_status, "Returned January 20");
});

test("mergeDetailByKey: buckets by ASIN first, name second", () => {
  const items: DetailItem[] = [
    {
      asin: "B01ABCDEFG",
      name: "Widget",
      url: null,
      unit_price: null,
      quantity: 1,
      seller: null,
      item_image_url: null,
      refund_status: null,
    },
    {
      asin: null,
      name: "Gadget",
      url: null,
      unit_price: null,
      quantity: 1,
      seller: null,
      item_image_url: null,
      refund_status: null,
    },
  ];
  const { byAsin, byName } = mergeDetailByKey(items);
  assert.equal(byAsin.size, 1);
  assert.equal(byAsin.get("B01ABCDEFG")?.name, "Widget");
  assert.equal(byName.size, 1);
  assert.equal(byName.get("gadget")?.name, "Gadget");
});
