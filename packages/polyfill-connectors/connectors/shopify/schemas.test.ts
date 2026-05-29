/**
 * Schema tests for the Shopify (Shop app) connector.
 *
 * IMPORTANT: shopify/index.ts does not yet emit any RECORD (Apollo extraction
 * is deferred; it emits SKIP_RESULT). So these fixtures are NOT parser-derived —
 * they are records shaped to the connector's MANIFEST stream contract
 * (manifests/shopify.json). They prove the schema accepts the declared contract
 * and rejects representative drift, so the first real emit is shape-checked.
 * Whoever wires extraction MUST replace these with fixture-proven records and
 * tighten the id/currency shapes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ordersSchema, validateRecord } from "./schemas.ts";

const ORDER_RECORD = {
  id: "gid://shopify/Order/12345",
  order_date: "2024-05-01T18:22:05.000Z",
  merchant_name: "Acme Goods",
  status: "fulfilled",
  total_cents: 4999,
  currency: "USD",
  tracking_number: "1Z999AA10123456784",
  tracking_url: "https://www.ups.com/track?tracknum=1Z999AA10123456784",
  item_count: 3,
};

test("orders schema accepts a contract-shaped record", () => {
  const result = ordersSchema.safeParse(ORDER_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("orders schema accepts a pending order (nulls for not-yet-known fields)", () => {
  const result = ordersSchema.safeParse({
    ...ORDER_RECORD,
    order_date: null,
    status: "pending",
    total_cents: null,
    currency: null,
    tracking_number: null,
    tracking_url: null,
    item_count: null,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("orders schema rejects a non-ISO currency (raw symbol leaked in)", () => {
  assert.equal(ordersSchema.safeParse({ ...ORDER_RECORD, currency: "$" }).success, false);
});

test("orders schema rejects a negative total_cents", () => {
  assert.equal(ordersSchema.safeParse({ ...ORDER_RECORD, total_cents: -100 }).success, false);
});

test("orders schema rejects a non-URL tracking_url", () => {
  assert.equal(ordersSchema.safeParse({ ...ORDER_RECORD, tracking_url: "see email" }).success, false);
});

test("validateRecord routes orders and passes unknown streams through", () => {
  assert.equal(validateRecord("orders", ORDER_RECORD).ok, true);
  assert.equal(validateRecord("line_items", { id: "x" }).ok, true);
});
