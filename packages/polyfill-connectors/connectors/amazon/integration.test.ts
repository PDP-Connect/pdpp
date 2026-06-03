/**
 * Integration tests for the Amazon connector's `collect()` layer —
 * specifically the per-order emit orchestration.
 *
 * These tests DON'T spin up a browser. They construct a fake `EmitDeps`
 * backed by `makeRecordingEmit(validateRecord)` — so every emitted
 * record is run through the real zod schema the runtime applies in
 * production. A fixture that would SKIP_RESULT in prod fails the test
 * here rather than silently passing. Captures every (stream, data) pair
 * pushed through `emitRecord`, then asserts on the sequence: order
 * emitted before items, items in dedup+merge order, stream-scope
 * respected, cursor timing preserved.
 *
 * Imports directly from ./index.ts — `runConnector({...})` is guarded by
 * `isMainModule(import.meta.url)` so it only fires when index.ts is the
 * process entry point, not when a test imports it.
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
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type EmittedRecord, makeRecordingEmit } from "../../src/test-harness.ts";
import { type EmitDeps, emitOrderAndItems, planIncrementalYears } from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { DetailItem, ListPageOrder, OrderDetail } from "./types.ts";

const AMAZON_MANIFEST_PATH = new URL("../../manifests/amazon.json", import.meta.url);
const AMAZON_INDEX_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));

interface RecordingDeps {
  deps: EmitDeps;
  emitted: EmittedRecord[];
}

/** Build an EmitDeps that records every emitRecord() call, validating
 *  each record against the connector's real zod schema (so a test that
 *  would silently emit drifted data in production now fails loudly).
 *  emit() is a no-op side-channel (emitOrderAndItems doesn't call emit()
 *  — only diagnostic paths do). capture is null since fixture capture is
 *  orthogonal to emit ordering. */
function makeRecordingDeps(overrides: Partial<EmitDeps> = {}): RecordingDeps {
  const harness = makeRecordingEmit(validateRecord);
  const deps: EmitDeps = {
    capture: null,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: "2026-04-22T12:00:00.000Z",
    progress: (): Promise<void> => Promise.resolve(),
    skipDetail: false,
    wantsItems: true,
    wantsOrders: true,
    ...overrides,
  };
  return { deps, emitted: harness.emitted };
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
  // ASINs must be exactly 10 uppercase alphanumeric (schema/asinSchema);
  // currency strings must be $N.NN (schema/currencyStringSchema). The
  // original fixture used 11-char ASINs ("B01LIST0001") + cents-less
  // prices ("$10") which would have SKIP_RESULT'd in production — the
  // hand-rolled mock let them through silently.
  const listOrder = makeListOrder({
    items: [{ asin: "B01LIST000", name: "List Item", url: null }],
  });
  const detail = makeDetail({
    items: [
      makeDetailItem({ asin: "B01LIST000", name: "List Item", unit_price: "$10.00" }),
      makeDetailItem({ asin: "B02DETAIL0", name: "Detail-Only Item", unit_price: "$20.00" }),
    ],
  });
  await emitOrderAndItems(deps, listOrder, detail, "2026-01-05");

  const itemRecords = emitted.filter((r) => r.stream === "order_items");
  assert.equal(itemRecords.length, 2, "expected list item + detail-only item");
  assert.equal(itemRecords[0]?.data.asin, "B01LIST000", "list-page item emitted first");
  assert.equal(itemRecords[1]?.data.asin, "B02DETAIL0", "detail-only item appended after");
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
      { asin: "B01ONE0000", name: "One", url: null },
      { asin: "B02TWO0000", name: "Two", url: null },
    ],
  });
  await emitOrderAndItems(deps, listOrder, null, "2026-01-05");

  const orderRecord = emitted.find((r) => r.stream === "orders");
  assert.ok(orderRecord);
  // List-page fields survive into the order record when detail is absent.
  assert.equal(orderRecord.data.delivery_status, "Delivered");

  const items = emitted.filter((r) => r.stream === "order_items");
  assert.equal(items.length, 2);
  assert.equal(items[0]?.data.asin, "B01ONE0000");
  assert.equal(items[1]?.data.asin, "B02TWO0000");
});

// ─── Invariant 5: item-level id stability (merge dedup + itemId) ─────────

test("emitOrderAndItems: duplicate ASINs across list+detail dedupe to one item record", async () => {
  const { deps, emitted } = makeRecordingDeps();
  const listOrder = makeListOrder({
    items: [
      { asin: "B01DUPDUP0", name: "Dup", url: null },
      { asin: "B01DUPDUP0", name: "Dup Again", url: null }, // same ASIN twice on list
    ],
  });
  const detail = makeDetail({
    items: [makeDetailItem({ asin: "B01DUPDUP0", name: "Dup", unit_price: "$5.00" })],
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

test("runYear reports non-PII granular progress across list pages and order processing", () => {
  const src = readFileSync(AMAZON_INDEX_PATH, "utf8");
  const progressMessages = [
    /Amazon year \$\{year\}: scanning page \$\{pageCount \+ 1\}/,
    /Amazon year \$\{year\}: no more orders after \$\{yearOrderCount\} seen/,
    /Amazon year \$\{year\}: page \$\{pageCount \+ 1\} found \$\{orders\.length\} orders/,
    /Amazon year \$\{year\}: processing order \$\{index \+ 1\}\/\$\{orders\.length\} on page \$\{pageCount \+ 1\}/,
  ];
  for (const message of progressMessages) {
    assert.match(src, message);
  }
  assert.match(src, /deps\.progress\([\s\S]*?\{ stream: "orders" \}/);
  assert.doesNotMatch(src, /processing order \$\{o\.orderId\}/);
});

test("amazon manifest: successful manual runs have a bounded freshness window", () => {
  const manifest = JSON.parse(readFileSync(AMAZON_MANIFEST_PATH, "utf8")) as {
    capabilities?: { refresh_policy?: { maximum_staleness_seconds?: number; recommended_mode?: string } };
  };
  const policy = manifest.capabilities?.refresh_policy;
  assert.equal(policy?.recommended_mode, "manual");
  assert.equal(policy?.maximum_staleness_seconds, 86_400);
});

// ─── planIncrementalYears ─────────────────────────────────────────────────

test("planIncrementalYears: no prior state → all discovered years planned (initial backfill)", () => {
  const years = [2026, 2025, 2024, 2023, 2022, 2010, 2005];
  const { planned, skipped } = planIncrementalYears(years, {}, 2026);
  assert.deepEqual(planned, years);
  assert.equal(skipped.length, 0);
});

test("planIncrementalYears: with prior state, current and previous year always planned", () => {
  const yearsState = {
    "2025": { frozen: false, last_scraped: "2026-01-01T00:00:00.000Z", order_count: 5 },
    "2024": { frozen: false, last_scraped: "2026-01-01T00:00:00.000Z", order_count: 10 },
    "2020": { frozen: true, last_scraped: "2026-01-01T00:00:00.000Z", order_count: 3 },
  };
  const years = [2026, 2025, 2024, 2023, 2020];
  const { planned } = planIncrementalYears(years, yearsState, 2026);
  assert.ok(planned.includes(2026), "current year must be planned");
  assert.ok(planned.includes(2025), "previous year must be planned");
});

test("planIncrementalYears: historical years with prior last_scraped are skipped", () => {
  const yearsState = {
    "2025": { frozen: false, last_scraped: "2026-01-01T00:00:00.000Z", order_count: 5 },
    "2024": { frozen: false, last_scraped: "2025-06-01T00:00:00.000Z", order_count: 12 },
    "2023": { frozen: false, last_scraped: "2025-06-01T00:00:00.000Z", order_count: 8 },
    "2010": { frozen: false, last_scraped: "2025-01-01T00:00:00.000Z", order_count: 2 },
  };
  const years = [2026, 2025, 2024, 2023, 2010];
  const { planned, skipped } = planIncrementalYears(years, yearsState, 2026);
  // Only current (2026) and previous (2025) should be planned
  assert.deepEqual(planned, [2026, 2025]);
  // 2024, 2023, 2010 have prior last_scraped and are ≥2 years old
  assert.equal(skipped.length, 3);
  assert.ok(skipped.some((s) => s.year === 2024));
  assert.ok(skipped.some((s) => s.year === 2023));
  assert.ok(skipped.some((s) => s.year === 2010));
});

test("planIncrementalYears: newly-discovered historical year (no prior state) is still planned", () => {
  // Scenario: user adds a new Amazon account with orders going back to 2015,
  // but only 2025/2026 have been scraped so far. 2015 has no prior state.
  const yearsState = {
    "2025": { frozen: false, last_scraped: "2026-01-01T00:00:00.000Z", order_count: 5 },
  };
  const years = [2026, 2025, 2015];
  const { planned } = planIncrementalYears(years, yearsState, 2026);
  assert.ok(planned.includes(2015), "newly-discovered year with no prior state must be included");
});

test("planIncrementalYears: full refresh (no prior state) plans all discovered years", () => {
  // Simulates a forced full refresh where state is reset/null.
  const years = [2026, 2025, 2024, 2023, 2015, 2005];
  const { planned, skipped } = planIncrementalYears(years, {}, 2026);
  assert.deepEqual(planned, years, "full refresh with empty state must plan all years");
  assert.equal(skipped.length, 0);
});

test("planIncrementalYears: legacy state shape (flat years object) treated as prior state", () => {
  // Legacy state may store years without last_scraped (order_count=0 first-pass).
  // Only entries WITH last_scraped should trigger skip.
  const yearsState = {
    "2024": { frozen: false, last_scraped: "2025-12-01T00:00:00.000Z", order_count: 3 },
    "2023": { frozen: false, order_count: 0, last_scraped: "" }, // empty last_scraped = no proof of scrape
  };
  const years = [2026, 2025, 2024, 2023];
  const { planned } = planIncrementalYears(years, yearsState, 2026);
  // 2024 has a real last_scraped → skip it. 2023 has empty string → falsy → treat as not scraped
  assert.ok(planned.includes(2026));
  assert.ok(planned.includes(2025));
  assert.ok(!planned.includes(2024), "2024 with real last_scraped should be skipped");
  assert.ok(planned.includes(2023), "2023 with empty last_scraped treated as not-yet-scraped");
});
