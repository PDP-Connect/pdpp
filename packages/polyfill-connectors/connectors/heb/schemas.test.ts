/**
 * Schema tests for the H-E-B connector.
 *
 * IMPORTANT: heb/index.ts does not yet emit any RECORD (DOM extraction is
 * deferred; it emits SKIP_RESULT). So these fixtures are NOT parser-derived —
 * they are records shaped to the connector's MANIFEST stream contract
 * (manifests/heb.json). They prove the schema accepts the declared contract and
 * rejects representative drift, so the first real emit is shape-checked.
 * Whoever wires extraction MUST replace these with fixture-proven records and
 * tighten the id/upc/nutrition shapes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { orderItemsSchema, ordersSchema, validateRecord } from "./schemas.ts";

const ORDER_RECORD = {
  id: "ORD-10293",
  order_date: "2024-05-01T18:22:05.000Z",
  store: "H-E-B plus! Austin Mueller",
  status: "delivered",
  method: "curbside",
  total_cents: 8745,
  item_count: 12,
};

const ORDER_ITEM_RECORD = {
  id: "ORD-10293-ITEM-3",
  order_id: "ORD-10293",
  name: "Organic Bananas",
  upc: "00000004011",
  quantity: 2.5,
  unit_price_cents: 79,
  department: "Produce",
  nutrition: { calories: 105, potassium_mg: 422 },
};

test("orders schema accepts a contract-shaped record", () => {
  assert.ok(ordersSchema.safeParse(ORDER_RECORD).success);
});

test("orders schema accepts an in-flight order (nulls for not-yet-known fields)", () => {
  const result = ordersSchema.safeParse({
    ...ORDER_RECORD,
    order_date: null,
    store: null,
    status: "processing",
    method: null,
    total_cents: null,
    item_count: null,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("orders schema rejects a negative total_cents", () => {
  assert.equal(ordersSchema.safeParse({ ...ORDER_RECORD, total_cents: -1 }).success, false);
});

test("orders schema rejects a non-ISO order_date (raw DOM text leaked in)", () => {
  assert.equal(ordersSchema.safeParse({ ...ORDER_RECORD, order_date: "May 1, 2024" }).success, false);
});

test("order_items schema accepts a contract-shaped record with a nutrition object", () => {
  assert.ok(orderItemsSchema.safeParse(ORDER_ITEM_RECORD).success);
});

test("order_items schema accepts an item with no UPC match and null nutrition", () => {
  const result = orderItemsSchema.safeParse({
    ...ORDER_ITEM_RECORD,
    upc: null,
    department: null,
    nutrition: null,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("order_items schema rejects a missing order_id (manifest-required FK)", () => {
  const { order_id: _omit, ...withoutFk } = ORDER_ITEM_RECORD;
  assert.equal(orderItemsSchema.safeParse(withoutFk).success, false);
});

test("order_items schema rejects a non-digit UPC", () => {
  assert.equal(orderItemsSchema.safeParse({ ...ORDER_ITEM_RECORD, upc: "ABC-123" }).success, false);
});

test("order_items schema rejects a non-object nutrition (array/string leaked into the bag)", () => {
  assert.equal(orderItemsSchema.safeParse({ ...ORDER_ITEM_RECORD, nutrition: "105 cal" }).success, false);
});

test("validateRecord routes both streams and passes unknown streams through", () => {
  assert.equal(validateRecord("orders", ORDER_RECORD).ok, true);
  assert.equal(validateRecord("order_items", ORDER_ITEM_RECORD).ok, true);
  assert.equal(validateRecord("receipts", { id: "x" }).ok, true);
});
