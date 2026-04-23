import assert from "node:assert/strict";
import { test } from "node:test";
import { itemId, mergeDetailByKey, parseCurrencyCents, parseOrderDate } from "./parsers.ts";
import type { DetailItem } from "./types.ts";

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
