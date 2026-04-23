/**
 * Integration tests for the Amazon connector's `collect()` layer —
 * specifically the per-order emit orchestration.
 *
 * These tests DON'T spin up a browser. They construct a fake `EmitDeps`
 * that captures every (stream, data) pair pushed through `emitRecord`,
 * then assert on the sequence: order emitted before items, items in
 * dedup+merge order, stream-scope respected, cursor timing preserved.
 *
 * Imports from ./collect-helpers.ts (not ./index.ts) so that
 * `runConnector({...})` doesn't fire at module load and keep the test
 * runner's event loop alive.
 *
 * Why bother: unit tests on pure parsers prove record *shapes* are
 * correct. Integration tests on emitOrderAndItems prove the invariants
 * that consumers actually observe: "emit parent record before children",
 * "scope.streams filters what flows without breaking sibling streams",
 * "the same order doesn't double-emit if the list and detail both
 * reference the same ASIN". Regressing any of these is a data-corruption
 * bug, and nothing else in the test suite catches it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type EmitDeps, emitOrderAndItems } from "./collect-helpers.ts";
import type { DetailItem, ListPageOrder, OrderDetail } from "./types.ts";

interface EmittedRecord {
  data: Record<string, unknown>;
  stream: string;
}

interface RecordingDeps {
  deps: EmitDeps;
  emitted: EmittedRecord[];
}

/** Build an EmitDeps that records every emitRecord() call. emit() is a
 *  no-op (emitOrderAndItems doesn't call emit() — only diagnostic paths do).
 *  capture is null since fixture capture is orthogonal to emit ordering. */
function makeRecordingDeps(overrides: Partial<EmitDeps> = {}): RecordingDeps {
  const emitted: EmittedRecord[] = [];
  const deps: EmitDeps = {
    capture: null,
    emit: (): Promise<void> => Promise.resolve(),
    emitRecord: (stream: string, data: Record<string, unknown>): Promise<void> => {
      emitted.push({ stream, data });
      return Promise.resolve();
    },
    emittedAt: "2026-04-22T12:00:00.000Z",
    skipDetail: false,
    wantsItems: true,
    wantsOrders: true,
    ...overrides,
  };
  return { deps, emitted };
}

function makeListOrder(overrides: Partial<ListPageOrder> = {}): ListPageOrder {
  return {
    orderId: "111-1234567-8901234",
    orderDateRaw: "January 5, 2026",
    orderTotal: "$42.99",
    deliveryStatus: "Delivered",
    items: [{ asin: "B01ABCDEFG", name: "Widget", url: "https://amazon.com/dp/B01ABCDEFG" }],
    ...overrides,
  };
}

function makeDetailItem(overrides: Partial<DetailItem> = {}): DetailItem {
  return {
    asin: null,
    name: "Widget",
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
    grand_total: "$42.99",
    recipient_name: "Fake Name",
    shipping_address_summary: "123 Fake St",
    payment_method_summary: "Visa ending in 0000",
    status_detail: null,
    gift_order: false,
    digital_order: false,
    items: [makeDetailItem({ asin: "B01ABCDEFG", name: "Widget", unit_price: "$39.99" })],
    ...overrides,
  };
}

// ─── Invariant 1: ordering (parent before children) ──────────────────────

test("emitOrderAndItems: emits 'orders' record BEFORE any 'order_items' records", async () => {
  const { deps, emitted } = makeRecordingDeps();
  const listOrder = makeListOrder();
  await emitOrderAndItems(deps, listOrder, makeDetail(), "2026-01-05");

  const orderIdx = emitted.findIndex((r) => r.stream === "orders");
  const firstItemIdx = emitted.findIndex((r) => r.stream === "order_items");
  assert.notEqual(orderIdx, -1, "expected an 'orders' record");
  assert.notEqual(firstItemIdx, -1, "expected at least one 'order_items' record");
  assert.ok(orderIdx < firstItemIdx, "order record must precede item records in emit sequence");
});

test("emitOrderAndItems: emits exactly one order record per call", async () => {
  const { deps, emitted } = makeRecordingDeps();
  await emitOrderAndItems(deps, makeListOrder(), makeDetail(), "2026-01-05");
  const orderRecords = emitted.filter((r) => r.stream === "orders");
  assert.equal(orderRecords.length, 1);
});

// ─── Invariant 2: merge order (list items first, then detail-only) ───────

test("emitOrderAndItems: items emit in mergeOrderItems order (list first, then detail-only appended)", async () => {
  const { deps, emitted } = makeRecordingDeps();
  const listOrder = makeListOrder({
    items: [{ asin: "B01LIST0001", name: "List Item", url: null }],
  });
  const detail = makeDetail({
    items: [
      makeDetailItem({ asin: "B01LIST0001", name: "List Item", unit_price: "$10" }),
      makeDetailItem({ asin: "B02DETAIL01", name: "Detail-Only Item", unit_price: "$20" }),
    ],
  });
  await emitOrderAndItems(deps, listOrder, detail, "2026-01-05");

  const itemRecords = emitted.filter((r) => r.stream === "order_items");
  assert.equal(itemRecords.length, 2, "expected list item + detail-only item");
  assert.equal(itemRecords[0]?.data.asin, "B01LIST0001", "list-page item emitted first");
  assert.equal(itemRecords[1]?.data.asin, "B02DETAIL01", "detail-only item appended after");
});

// ─── Invariant 3: scope.streams filters cleanly ──────────────────────────

test("emitOrderAndItems: wantsOrders=false suppresses order records but not items", async () => {
  const { deps, emitted } = makeRecordingDeps({ wantsOrders: false });
  await emitOrderAndItems(deps, makeListOrder(), makeDetail(), "2026-01-05");
  assert.equal(emitted.filter((r) => r.stream === "orders").length, 0);
  assert.ok(emitted.filter((r) => r.stream === "order_items").length > 0);
});

test("emitOrderAndItems: wantsItems=false suppresses item records but not the order", async () => {
  const { deps, emitted } = makeRecordingDeps({ wantsItems: false });
  await emitOrderAndItems(deps, makeListOrder(), makeDetail(), "2026-01-05");
  assert.equal(emitted.filter((r) => r.stream === "order_items").length, 0);
  assert.equal(emitted.filter((r) => r.stream === "orders").length, 1);
});

test("emitOrderAndItems: both streams disabled → nothing emitted", async () => {
  const { deps, emitted } = makeRecordingDeps({ wantsOrders: false, wantsItems: false });
  await emitOrderAndItems(deps, makeListOrder(), makeDetail(), "2026-01-05");
  assert.equal(emitted.length, 0);
});

// ─── Invariant 4: detail-null fallback (skipDetail mode) ─────────────────

test("emitOrderAndItems: detail=null — still emits order record + list-page items only", async () => {
  const { deps, emitted } = makeRecordingDeps();
  const listOrder = makeListOrder({
    items: [
      { asin: "B01ONE0000A", name: "One", url: null },
      { asin: "B02TWO0000A", name: "Two", url: null },
    ],
  });
  await emitOrderAndItems(deps, listOrder, null, "2026-01-05");

  const orderRecord = emitted.find((r) => r.stream === "orders");
  assert.ok(orderRecord);
  // List-page fields survive into the order record when detail is absent.
  assert.equal(orderRecord.data.delivery_status, "Delivered");

  const items = emitted.filter((r) => r.stream === "order_items");
  assert.equal(items.length, 2);
  assert.equal(items[0]?.data.asin, "B01ONE0000A");
  assert.equal(items[1]?.data.asin, "B02TWO0000A");
});

// ─── Invariant 5: item-level id stability (merge dedup + itemId) ─────────

test("emitOrderAndItems: duplicate ASINs across list+detail dedupe to one item record", async () => {
  const { deps, emitted } = makeRecordingDeps();
  const listOrder = makeListOrder({
    items: [
      { asin: "B01DUPDUP01", name: "Dup", url: null },
      { asin: "B01DUPDUP01", name: "Dup Again", url: null }, // same ASIN twice on list
    ],
  });
  const detail = makeDetail({
    items: [makeDetailItem({ asin: "B01DUPDUP01", name: "Dup", unit_price: "$5.00" })],
  });
  await emitOrderAndItems(deps, listOrder, detail, "2026-01-05");

  const items = emitted.filter((r) => r.stream === "order_items");
  assert.equal(items.length, 1, "duplicate ASINs must collapse to one emitted item record");
});

// ─── Invariant 6: emittedAt threads into the order record ────────────────

test("emitOrderAndItems: emittedAt propagates into the order record's fetched_at", async () => {
  const frozen = "2026-04-22T09:30:00.000Z";
  const { deps, emitted } = makeRecordingDeps({ emittedAt: frozen });
  await emitOrderAndItems(deps, makeListOrder(), makeDetail(), "2026-01-05");
  const orderRecord = emitted.find((r) => r.stream === "orders");
  assert.ok(orderRecord);
  assert.equal(orderRecord.data.fetched_at, frozen);
});
