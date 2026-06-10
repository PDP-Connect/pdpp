/**
 * Schema tests for the DoorDash connector.
 *
 * IMPORTANT: doordash/index.ts does not yet emit any RECORD (GraphQL extraction
 * is deferred; it emits SKIP_RESULT). So these fixtures are NOT parser-derived —
 * they are records shaped to the connector's MANIFEST stream contract
 * (manifests/doordash.json). They prove the schema accepts the declared
 * contract and rejects representative drift, so the first real emit is
 * shape-checked. Whoever wires extraction MUST replace these with fixture-proven
 * records and tighten the id/customizations shapes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { orderItemsSchema, ordersSchema, validateRecord } from "./schemas.ts";

const ORDER_RECORD = {
  id: "order_9f3a2b",
  order_date: "2024-05-01T18:22:05.000Z",
  restaurant_name: "Tatsu-ya Ramen",
  status: "delivered",
  subtotal_cents: 2895,
  tax_cents: 239,
  tip_cents: 500,
  delivery_fee_cents: 399,
  service_fee_cents: 290,
  total_cents: 4323,
  delivery_address: "123 Main St, Apt 4, Austin, TX 78701",
  payment_method_summary: "Visa ••4242",
  item_count: 2,
};

const ORDER_ITEM_RECORD = {
  id: "order_9f3a2b-item-1",
  order_id: "order_9f3a2b",
  name: "Tonkotsu Original",
  quantity: 1,
  unit_price_cents: 1495,
  customizations: ["Extra chashu", "Spice level: medium"],
};

test("orders schema accepts a contract-shaped record", () => {
  assert.ok(ordersSchema.safeParse(ORDER_RECORD).success);
});

test("orders schema accepts an order with a null fee breakdown", () => {
  const result = ordersSchema.safeParse({
    ...ORDER_RECORD,
    subtotal_cents: null,
    tax_cents: null,
    tip_cents: null,
    delivery_fee_cents: null,
    service_fee_cents: null,
    total_cents: null,
    delivery_address: null,
    payment_method_summary: null,
    item_count: null,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("orders schema rejects a negative tip_cents", () => {
  assert.equal(ordersSchema.safeParse({ ...ORDER_RECORD, tip_cents: -100 }).success, false);
});

test("order_items schema accepts a contract-shaped record", () => {
  assert.ok(orderItemsSchema.safeParse(ORDER_ITEM_RECORD).success);
});

test("order_items schema accepts an item with no customizations", () => {
  const result = orderItemsSchema.safeParse({ ...ORDER_ITEM_RECORD, customizations: [] });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("order_items schema rejects a missing quantity (manifest declares it required + integer)", () => {
  const { quantity: _omit, ...withoutQty } = ORDER_ITEM_RECORD;
  assert.equal(orderItemsSchema.safeParse(withoutQty).success, false);
});

test("order_items schema rejects a fractional quantity (manifest declares integer)", () => {
  assert.equal(orderItemsSchema.safeParse({ ...ORDER_ITEM_RECORD, quantity: 1.5 }).success, false);
});

test("order_items schema rejects a non-string customization element", () => {
  assert.equal(orderItemsSchema.safeParse({ ...ORDER_ITEM_RECORD, customizations: [{ name: "x" }] }).success, false);
});

test("validateRecord routes both streams and passes unknown streams through", () => {
  assert.equal(validateRecord("orders", ORDER_RECORD).ok, true);
  assert.equal(validateRecord("order_items", ORDER_ITEM_RECORD).ok, true);
  assert.equal(validateRecord("dashers", { id: "x" }).ok, true);
});
