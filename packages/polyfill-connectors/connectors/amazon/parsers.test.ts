import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  itemId,
  mergeDetailByKey,
  parseCurrencyCents,
  parseOrderDate,
  parseOrderDetailDom,
  parseOrdersListDom,
} from "./parsers.ts";
import type { DetailItem } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "__fixtures__");
const LOCAL_RAW_DIR = join(__dirname, "..", "..", "fixtures", "amazon", "raw", "2026-04-23T00-13-01-167Z", "dom");

function readFixture(relPath: string): string {
  return readFileSync(join(FIXTURE_DIR, relPath), "utf8");
}

// ─── parseOrderDate ──────────────────────────────────────────────────────

test("parseOrderDate: common value-span forms", () => {
  const cases: Array<[string, string]> = [
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
  // NOTE: the regex /(\d+(?:\.\d+)?)/ stops at the thousands comma, so
  // "$1,234.56" matches only "1" and yields 100. This is the current
  // production semantics — preserved here so a future fix is a conscious
  // change, not a silent one. See task report.
  assert.equal(parseCurrencyCents("$1,234.56"), 100);
  assert.equal(parseCurrencyCents("$0.99"), 99);
  assert.equal(parseCurrencyCents("$1"), 100);
  assert.equal(parseCurrencyCents("$15.54"), 1554);
});

test("parseCurrencyCents: negative / sign-prefixed is parsed as positive magnitude", () => {
  // Regex has no sign group; the minus is dropped.
  assert.equal(parseCurrencyCents("-$5.00"), 500);
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
  assert.equal(
    itemId("111-2222222-3333333", { asin: null, name: "Super Widget" }),
    "111-2222222-3333333|super widget"
  );
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

test("parseOrdersListDom: synthetic-minimal fixture extracts one full order", () => {
  const html = readFixture("orders-list-minimal.html");
  const orders = parseOrdersListDom(html);
  assert.equal(orders.length, 1);
  const o = orders[0];
  assert.ok(o);
  assert.equal(o.orderId, "111-2222222-3333333");
  assert.equal(o.orderDateRaw, "January 15, 2024");
  assert.equal(o.orderTotal, "$42.99");
  assert.equal(o.deliveryStatus, "Delivered January 17");
  assert.equal(o.items.length, 2);
  assert.deepEqual(o.items[0], {
    name: "Synthetic Widget Model A",
    url: "https://www.amazon.com/dp/B01ABCDEFG?ref=fake",
    asin: "B01ABCDEFG",
  });
  assert.deepEqual(o.items[1], {
    name: "Synthetic Gadget Model B",
    url: "https://www.amazon.com/gp/product/B02HIJKLMN?ref=fake",
    asin: "B02HIJKLMN",
  });
});

test("parseOrdersListDom: empty page returns []", () => {
  assert.deepEqual(parseOrdersListDom("<!doctype html><html><body><div>no orders</div></body></html>"), []);
  assert.deepEqual(parseOrdersListDom(""), []);
});

test("parseOrdersListDom: local real fixture parses ≥5 orders with ids + dates", { skip: !existsSync(LOCAL_RAW_DIR) }, () => {
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
  assert.equal(
    d.shipping_address_summary,
    "Fictional Person, Fictional Person, 123 Placeholder Ln, 123 Placeholder Ln, Fakeville, TX 00000, Fakeville, TX 00000"
  );
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

test("parseOrderDetailDom: missing #orderDetails container returns null", () => {
  assert.equal(parseOrderDetailDom("<!doctype html><html><body><div>no details</div></body></html>"), null);
  assert.equal(parseOrderDetailDom(""), null);
});

test("parseOrderDetailDom: #orderDetails present but no data-components returns empty-ish OrderDetail", () => {
  // Matches the original browser-context behavior: container exists → returns an
  // OrderDetail with every structural field null and items=[].
  const html = "<!doctype html><html><body><div id=\"orderDetails\"></div></body></html>";
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

test(
  "parseOrderDetailDom: local real fixtures yield items and grand_total",
  { skip: !existsSync(LOCAL_RAW_DIR) },
  () => {
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
  }
);

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
