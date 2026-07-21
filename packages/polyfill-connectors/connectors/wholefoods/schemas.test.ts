// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests for the Whole Foods connector.
 *
 * IMPORTANT: wholefoods/index.ts does not yet emit any RECORD (Amazon-side
 * extraction is deferred; it emits SKIP_RESULT). So these fixtures are NOT
 * parser-derived — they are records shaped to the connector's MANIFEST stream
 * contract (manifests/wholefoods.json). They prove the schema accepts the
 * declared contract and rejects representative drift, so the first real emit is
 * shape-checked. Whoever wires extraction MUST replace these with fixture-proven
 * records and tighten the id/nutrition shapes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { orderItemsSchema, ordersSchema, validateRecord } from "./schemas.ts";

const ORDER_RECORD = {
  id: "112-1234567-7654321",
  order_date: "2024-05-01T18:22:05.000Z",
  store: "Whole Foods Market — Domain",
  method: "delivery",
  total_cents: 6432,
  item_count: 8,
};

const ORDER_ITEM_RECORD = {
  id: "112-1234567-7654321-ITEM-2",
  order_id: "112-1234567-7654321",
  name: "365 Organic Whole Milk, 1 gal",
  quantity: 1,
  unit_price_cents: 449,
  nutrition: { calories: 150, calcium_mg: 300 },
};

test("orders schema accepts a contract-shaped record", () => {
  assert.ok(ordersSchema.safeParse(ORDER_RECORD).success);
});

test("orders schema accepts an order with null store/method/total", () => {
  const result = ordersSchema.safeParse({
    ...ORDER_RECORD,
    store: null,
    method: null,
    total_cents: null,
    item_count: null,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("orders schema rejects a negative total_cents", () => {
  assert.equal(ordersSchema.safeParse({ ...ORDER_RECORD, total_cents: -1 }).success, false);
});

test("order_items schema accepts a contract-shaped record with a nutrition object", () => {
  assert.ok(orderItemsSchema.safeParse(ORDER_ITEM_RECORD).success);
});

test("order_items schema accepts a by-weight quantity and null nutrition", () => {
  const result = orderItemsSchema.safeParse({ ...ORDER_ITEM_RECORD, quantity: 0.73, nutrition: null });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("order_items schema rejects a missing name (manifest-required field)", () => {
  const { name: _omit, ...withoutName } = ORDER_ITEM_RECORD;
  assert.equal(orderItemsSchema.safeParse(withoutName).success, false);
});

test("order_items schema rejects a non-object nutrition", () => {
  assert.equal(orderItemsSchema.safeParse({ ...ORDER_ITEM_RECORD, nutrition: [1, 2, 3] }).success, false);
});

test("validateRecord routes both streams and passes unknown streams through", () => {
  assert.equal(validateRecord("orders", ORDER_RECORD).ok, true);
  assert.equal(validateRecord("order_items", ORDER_ITEM_RECORD).ok, true);
  assert.equal(validateRecord("deliveries", { id: "x" }).ok, true);
});
