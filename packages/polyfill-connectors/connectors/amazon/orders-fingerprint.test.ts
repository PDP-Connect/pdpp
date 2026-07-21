// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-order fingerprint behavior for the Amazon `orders` stream.
 *
 * Before this gate, `emitOrderAndItems` appended a fresh version of every
 * re-scraped order on every run because the record body carried a run-clock
 * `fetched_at: deps.emittedAt`. Year-freezing already caps the blast radius
 * to the current (unfrozen) year, but every order in that window was
 * re-emitted each run with a fresh `fetched_at` even when nothing moved. An
 * order's identity (id = order id) is immutable and its total is fixed once
 * placed; the only field that moved between byte-identical runs was
 * `fetched_at`.
 *
 * `order_items` carries NO `fetched_at`, so a re-scraped item is
 * byte-identical and the storage byte-equivalence backstop already
 * suppresses it — only `orders` needs this gate.
 *
 * These tests pin:
 *
 *   1. Re-scraping the same order (only fetched_at differs) is fully
 *      suppressed on the second run.
 *   2. A genuinely-new order still emits.
 *   3. A real field move (delivery_status transitioning while the order
 *      ships) re-emits.
 *   4. NO prune: an order in a year not scraped this run keeps its
 *      fingerprint — the partial-scan (year-freeze) invariant.
 *   5. Legacy callers without a cursor emit unconditionally.
 *   6. `order_items` is unaffected by the orders gate.
 *   7. Connector fingerprint (excludes fetched_at) == compaction fingerprint
 *      over the stored body with excludeKeys ['fetched_at'].
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type FingerprintCursor, openFingerprintCursor, recordFingerprint } from "../../src/fingerprint-cursor.ts";
import { type EmittedRecord, makeRecordingEmit } from "../../src/test-harness.ts";
import { type EmitDeps, emitOrderAndItems } from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { ListPageOrder, OrderDetail } from "./types.ts";

const RUN1_AT = "2026-06-01T10:00:00.000Z";
const RUN2_AT = "2026-06-02T10:00:00.000Z";

function makeDeps(
  emittedAt: string,
  ordersFingerprintCursor?: FingerprintCursor
): { deps: EmitDeps; emitted: EmittedRecord[] } {
  const harness = makeRecordingEmit(validateRecord);
  const deps: EmitDeps = {
    capture: null,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt,
    ordersFingerprintCursor,
    progress: (): Promise<void> => Promise.resolve(),
    skipDetail: false,
    wantsItems: true,
    wantsOrders: true,
  };
  return { deps, emitted: harness.emitted };
}

function makeListOrder(overrides: Partial<ListPageOrder> = {}): ListPageOrder {
  return {
    orderId: "111-1234567-8901234",
    orderDateRaw: "January 5, 2026",
    orderTotal: "$42.99",
    deliveryStatus: "Shipping",
    items: [{ asin: "B01ABCDEFG", name: "Widget", url: "https://amazon.com/dp/B01ABCDEFG" }],
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
    items: [
      {
        asin: "B01ABCDEFG",
        name: "Widget",
        url: null,
        unit_price: "$39.99",
        quantity: 1,
        seller: null,
        item_image_url: null,
        refund_status: null,
      },
    ],
    ...overrides,
  };
}

function ordersOf(emitted: EmittedRecord[]): EmittedRecord[] {
  return emitted.filter((r) => r.stream === "orders");
}

test("orders: re-scraping the same order (only fetched_at differs) is fully suppressed", async () => {
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  const run1 = makeDeps(RUN1_AT, cursor1);
  await emitOrderAndItems(run1.deps, makeListOrder(), makeDetail(), "2026-01-05");
  assert.equal(ordersOf(run1.emitted).length, 1, "first run emits the order once");

  // Carry the cursor forward (as the orders STATE would) and re-scrape.
  const cursor2 = openFingerprintCursor(
    { fingerprints: cursor1.toState() },
    { excludeFromFingerprint: ["fetched_at"] }
  );
  const run2 = makeDeps(RUN2_AT, cursor2);
  await emitOrderAndItems(run2.deps, makeListOrder(), makeDetail(), "2026-01-05");
  assert.equal(ordersOf(run2.emitted).length, 0, "re-scraped unchanged order fully suppressed despite new fetched_at");
});

test("orders: a genuinely-new order still emits", async () => {
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  const run1 = makeDeps(RUN1_AT, cursor1);
  await emitOrderAndItems(run1.deps, makeListOrder({ orderId: "ORDER-A" }), makeDetail(), "2026-01-05");

  const cursor2 = openFingerprintCursor(
    { fingerprints: cursor1.toState() },
    { excludeFromFingerprint: ["fetched_at"] }
  );
  const run2 = makeDeps(RUN2_AT, cursor2);
  // Re-scrape the known order (suppressed) + a new order (emits).
  await emitOrderAndItems(run2.deps, makeListOrder({ orderId: "ORDER-A" }), makeDetail(), "2026-01-05");
  await emitOrderAndItems(run2.deps, makeListOrder({ orderId: "ORDER-B" }), makeDetail(), "2026-01-06");
  const orders = ordersOf(run2.emitted);
  assert.equal(orders.length, 1, "only the new order emits");
  assert.equal(orders[0]?.data.id, "ORDER-B");
});

test("orders: a delivery_status transition (Shipping → Delivered) re-emits", async () => {
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  const run1 = makeDeps(RUN1_AT, cursor1);
  await emitOrderAndItems(run1.deps, makeListOrder({ deliveryStatus: "Shipping" }), makeDetail(), "2026-01-05");

  const cursor2 = openFingerprintCursor(
    { fingerprints: cursor1.toState() },
    { excludeFromFingerprint: ["fetched_at"] }
  );
  const run2 = makeDeps(RUN2_AT, cursor2);
  // The order shipped: delivery_status moved. A real field move re-emits.
  await emitOrderAndItems(run2.deps, makeListOrder({ deliveryStatus: "Delivered" }), makeDetail(), "2026-01-05");
  const orders = ordersOf(run2.emitted);
  assert.equal(orders.length, 1, "a delivery_status move is a fingerprint boundary and re-emits");
  assert.equal(orders[0]?.data.delivery_status, "Delivered", "the re-emitted record carries the new status");
});

test("orders: NO prune — an order in a year not scraped this run keeps its fingerprint", async () => {
  // Run 1: two orders observed (e.g. across two years).
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  const run1 = makeDeps(RUN1_AT, cursor1);
  await emitOrderAndItems(run1.deps, makeListOrder({ orderId: "ORDER-2025" }), makeDetail(), "2025-12-20");
  await emitOrderAndItems(run1.deps, makeListOrder({ orderId: "ORDER-2026" }), makeDetail(), "2026-01-05");

  // Run 2: the 2025 year froze, so only the 2026 order is re-scraped. The
  // cursor is NEVER pruned (no pruneStale call), so ORDER-2025's fingerprint
  // must survive even though it was not observed this run.
  const cursor2 = openFingerprintCursor(
    { fingerprints: cursor1.toState() },
    { excludeFromFingerprint: ["fetched_at"] }
  );
  const run2 = makeDeps(RUN2_AT, cursor2);
  await emitOrderAndItems(run2.deps, makeListOrder({ orderId: "ORDER-2026" }), makeDetail(), "2026-01-05");
  assert.equal(ordersOf(run2.emitted).length, 0, "the re-scraped 2026 order unchanged stays silent");
  assert.ok(cursor2.priorFingerprint("ORDER-2025"), "the un-scraped 2025 order's fingerprint survived (never pruned)");
});

test("orders: legacy callers without a cursor emit unconditionally", async () => {
  const run = makeDeps(RUN1_AT);
  await emitOrderAndItems(run.deps, makeListOrder(), makeDetail(), "2026-01-05");
  await emitOrderAndItems(run.deps, makeListOrder(), makeDetail(), "2026-01-05");
  assert.equal(ordersOf(run.emitted).length, 2, "no cursor → emits every time");
});

test("orders: order_items is unaffected by the orders gate (no fetched_at, never suppressed here)", async () => {
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  const run1 = makeDeps(RUN1_AT, cursor1);
  await emitOrderAndItems(run1.deps, makeListOrder(), makeDetail(), "2026-01-05");
  const items1 = run1.emitted.filter((r) => r.stream === "order_items");
  assert.ok(items1.length >= 1, "items emit on the first run");

  // Re-scrape: the ORDER is suppressed (byte-identical modulo fetched_at) but
  // the orders gate does not touch order_items — they still flow (the storage
  // backstop dedupes them downstream because they carry no fetched_at).
  const cursor2 = openFingerprintCursor(
    { fingerprints: cursor1.toState() },
    { excludeFromFingerprint: ["fetched_at"] }
  );
  const run2 = makeDeps(RUN2_AT, cursor2);
  await emitOrderAndItems(run2.deps, makeListOrder(), makeDetail(), "2026-01-05");
  assert.equal(ordersOf(run2.emitted).length, 0, "order suppressed");
  assert.equal(
    run2.emitted.filter((r) => r.stream === "order_items").length,
    items1.length,
    "items still emit from the orders gate's perspective (no fetched_at to gate on)"
  );
});

test("orders: connector fingerprint (excludes fetched_at) == compaction fingerprint over stored body", () => {
  const body = {
    id: "111-1234567-8901234",
    order_date: "2026-01-05",
    order_total: "$42.99",
    order_total_cents: 4299,
    delivery_status: "Shipping",
    status_detail: null,
    recipient_name: "Fake Name",
    shipping_address_summary: "123 Fake St",
    payment_method_summary: "Visa ending in 0000",
    gift_order: false,
    digital_order: false,
    item_count: 1,
    fetched_at: RUN1_AT,
  };
  const later = { ...body, fetched_at: RUN2_AT };
  const shipped = { ...later, delivery_status: "Delivered" };
  assert.equal(
    recordFingerprint(body, ["fetched_at"]),
    recordFingerprint(later, ["fetched_at"]),
    "fetched_at must not participate; a no-op re-scrape hashes identically"
  );
  assert.notEqual(
    recordFingerprint(body, ["fetched_at"]),
    recordFingerprint(shipped, ["fetched_at"]),
    "a delivery_status move MUST produce a different fingerprint — real order state is never hidden"
  );
});
