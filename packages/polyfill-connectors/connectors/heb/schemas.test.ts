// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests for the H-E-B connector.
 *
 * Records here are shape-derived from parsers.ts output, LIVE-VERIFIED
 * (2026-07-14) against a real captured heb.com session — see
 * heb-live-verify-report.md.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { orderItemsSchema, ordersSchema, validateRecord } from "./schemas.ts";

const ORDER_RECORD = {
  id: "HEB1029384756",
  order_date: "2026-07-14",
  fulfillment_method: "curbside",
  fulfillment_location: "H-E-B plus! Austin Mueller",
  status: "Delivered",
  status_code: "PAYMENT_RECEIPTED",
  store_name: "H-E-B plus! Austin Mueller",
  timeslot_start: "2026-07-14T16:00:00Z",
  timeslot_end: "2026-07-14T17:00:00Z",
  total: "$87.45",
  total_cents: 8745,
  item_count: 12,
  unfulfilled_count: 0,
  fetched_at: "2026-07-14T12:00:00.000Z",
};

const ORDER_ITEM_RECORD = {
  id: "HEB1029384756|123456789",
  order_id: "HEB1029384756",
  name: "H-E-B Organic 2% Reduced Fat Milk",
  department: "Dairy & eggs",
  product_id: "123456789",
  product_url: "https://www.heb.com/product-detail/heb-organic-2-reduced-fat-milk/123456789",
  image_url: "https://images.heb.com/is/image/HEBGrocery/prd-small/123456789.jpg",
  quantity: 2,
  line_total: "$4.29",
  line_total_cents: 429,
  order_date: "2026-07-14",
  fetched_at: "2026-07-14T12:00:00.000Z",
};

test("orders schema accepts a parser-shaped record", () => {
  const result = ordersSchema.safeParse(ORDER_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("orders schema accepts an in-flight order (nulls for not-yet-known fields)", () => {
  const result = ordersSchema.safeParse({
    ...ORDER_RECORD,
    fulfillment_location: null,
    status: null,
    status_code: null,
    store_name: null,
    timeslot_start: null,
    timeslot_end: null,
    total: null,
    total_cents: null,
    item_count: null,
    unfulfilled_count: null,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("orders schema accepts a DOM-sourced record (structured-only fields null)", () => {
  const result = ordersSchema.safeParse({
    ...ORDER_RECORD,
    status_code: null,
    store_name: null,
    timeslot_start: null,
    timeslot_end: null,
    unfulfilled_count: null,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("orders schema rejects a non-ISO timeslot_start (raw structured text leaked in)", () => {
  assert.equal(ordersSchema.safeParse({ ...ORDER_RECORD, timeslot_start: "not-a-timestamp" }).success, false);
});

test("orders schema rejects a non-ISO timeslot_end", () => {
  assert.equal(ordersSchema.safeParse({ ...ORDER_RECORD, timeslot_end: "not-a-timestamp" }).success, false);
});

test("orders schema rejects a negative unfulfilled_count", () => {
  assert.equal(ordersSchema.safeParse({ ...ORDER_RECORD, unfulfilled_count: -1 }).success, false);
});

test("orders schema accepts an open (non-enum) status_code string, honoring Stop Condition #5", () => {
  const result = ordersSchema.safeParse({ ...ORDER_RECORD, status_code: "SOME_FUTURE_STATUS_NOT_YET_OBSERVED" });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("orders schema accepts fulfillment_method unknown", () => {
  const result = ordersSchema.safeParse({ ...ORDER_RECORD, fulfillment_method: "unknown" });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("orders schema rejects an invalid fulfillment_method", () => {
  assert.equal(ordersSchema.safeParse({ ...ORDER_RECORD, fulfillment_method: "in_store" }).success, false);
});

test("orders schema rejects an id without the HEB prefix", () => {
  assert.equal(ordersSchema.safeParse({ ...ORDER_RECORD, id: "1029384756" }).success, false);
});

test("orders schema rejects a non-ISO-date order_date (raw DOM text leaked in)", () => {
  assert.equal(ordersSchema.safeParse({ ...ORDER_RECORD, order_date: "July 14, 2026" }).success, false);
});

test("orders schema rejects a negative total_cents", () => {
  assert.equal(ordersSchema.safeParse({ ...ORDER_RECORD, total_cents: -1 }).success, false);
});

test("orders schema rejects a fulfillment_location that leaked a Status:/price cruft pattern", () => {
  assert.equal(ordersSchema.safeParse({ ...ORDER_RECORD, fulfillment_location: "Status: Delivered" }).success, false);
  assert.equal(ordersSchema.safeParse({ ...ORDER_RECORD, fulfillment_location: "$87.45" }).success, false);
});

test("order_items schema accepts a parser-shaped record", () => {
  const result = orderItemsSchema.safeParse(ORDER_ITEM_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("order_items schema accepts a weighted item with null quantity and null product_id", () => {
  const result = orderItemsSchema.safeParse({
    ...ORDER_ITEM_RECORD,
    product_id: null,
    product_url: null,
    image_url: null,
    quantity: null,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("order_items schema accepts a null department (row outside a recognized category section)", () => {
  const result = orderItemsSchema.safeParse({ ...ORDER_ITEM_RECORD, department: null });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("order_items schema rejects a missing order_id (manifest-required FK)", () => {
  const { order_id: _omit, ...withoutFk } = ORDER_ITEM_RECORD;
  assert.equal(orderItemsSchema.safeParse(withoutFk).success, false);
});

test("order_items schema rejects an order_id without the HEB prefix", () => {
  assert.equal(orderItemsSchema.safeParse({ ...ORDER_ITEM_RECORD, order_id: "1029384756" }).success, false);
});

test("order_items schema rejects a name that leaked UI cruft (wrong-node grab)", () => {
  assert.equal(orderItemsSchema.safeParse({ ...ORDER_ITEM_RECORD, name: "Quantity: 2." }).success, false);
});

test("order_items schema rejects a negative quantity", () => {
  assert.equal(orderItemsSchema.safeParse({ ...ORDER_ITEM_RECORD, quantity: -1 }).success, false);
});

test("order_items schema rejects a non-ISO-date order_date", () => {
  assert.equal(orderItemsSchema.safeParse({ ...ORDER_ITEM_RECORD, order_date: "July 14, 2026" }).success, false);
});

test("validateRecord routes both streams and passes unknown streams through", () => {
  assert.equal(validateRecord("orders", ORDER_RECORD).ok, true);
  assert.equal(validateRecord("order_items", ORDER_ITEM_RECORD).ok, true);
  assert.equal(validateRecord("receipts", { id: "x" }).ok, true);
});

test("validateRecord rejects a malformed orders record via shape check", () => {
  const result = validateRecord("orders", { ...ORDER_RECORD, id: "not-heb" });
  assert.equal(result.ok, false);
});
