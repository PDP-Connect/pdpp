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
import type { Page } from "playwright";
import type { BrowserCollectContext } from "../../src/connector-runtime.ts";
import type { EmittedMessage } from "../../src/connector-runtime-protocol.ts";
import { type EmittedRecord, makeRecordingEmit } from "../../src/test-harness.ts";
import {
  AMAZON_NO_ORDERS_TEXT_PATTERN,
  buildOrderDetailGap,
  classifyDetailOutcome,
  classifyEmptyListPageDiagnostics,
  type EmitDeps,
  emitOrderAndItems,
  emitOrderItemsCoverage,
  newOrderItemsCoverage,
  type OrderItemsCoverage,
  planIncrementalYears,
  processListOrder,
  type RunFlags,
  readPageContentWithin,
  reasonForDetailFailure,
  recordDetailOutcome,
  recoverPendingOrderItemDetailGaps,
  recoverPendingOrderItemDetailGapsBeforeForwardRun,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { DetailItem, ListPageDiagnostics, ListPageOrder, OrderDetail } from "./types.ts";

const AMAZON_MANIFEST_PATH = new URL("../../manifests/amazon.json", import.meta.url);
const AMAZON_INDEX_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));
const AMAZON_FOPO_DETAIL_FIXTURE = new URL("./__fixtures__/order-detail-fopo-minimal.html", import.meta.url);
const AMAZON_EMPTY_YEAR_FIXTURE = new URL("./__fixtures__/orders-list-empty-year-with-carousel.html", import.meta.url);

interface RecordingDeps {
  deps: EmitDeps;
  emitted: EmittedRecord[];
  protocolMessages: EmittedMessage[];
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
  return { deps, emitted: harness.emitted, protocolMessages: harness.protocolMessages };
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

/**
 * A minimal but real order-detail page that `parseOrderDetailDom` parses into a
 * non-null `OrderDetail`. The recipient/address/payment strings are synthetic
 * PII that the coverage projection must NOT carry — only the opaque order id
 * may cross into DETAIL_COVERAGE.
 */
function makeDetailHtml(): string {
  return `<!doctype html><html><body><div id="orderDetails">
    <div data-component="shippingAddress"><ul><li>Fake Name</li><li>123 Fake St</li></ul></div>
    <div data-component="viewPaymentPlanSummaryWidget">Visa ending in 0000</div>
    <div data-component="chargeSummary">Grand Total: $42.99</div>
    <div data-component="purchasedItemsRightGrid">
      <div data-component="itemTitle"><a href="/dp/B01ABCDEFG">Widget</a></div>
      <div data-component="unitPrice">$39.99 $39.99</div>
    </div>
  </div></body></html>`;
}

/** Detail page with no `#orderDetails` container → `parseOrderDetailDom`
 *  returns null: the same degraded-gap outcome a layout drift or non-detail
 *  redirect produces, but with no pRetry backoff so the test stays fast. */
const NO_DETAIL_HTML = "<!doctype html><html><body><div>no order details</div></body></html>";

/**
 * Drives `fetchOrderDetail` without a browser. `goto`/`waitForSelector` resolve,
 * and `content()` returns the supplied HTML. A hydrated stub passes
 * `makeDetailHtml()` (parses to a non-null OrderDetail); a degraded-gap stub
 * passes `NO_DETAIL_HTML`.
 */
function makeDetailPageStub(
  html: string,
  url = "https://www.amazon.com/gp/your-account/order-details?orderID=fixture"
): Page {
  // Single assertion through Proxy (matches NEVER_CALLED_PAGE), avoiding a
  // double-cast. Only the methods fetchOrderDetail touches are backed; any
  // other access throws so an unexpected page call is caught loudly.
  return new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (prop === "goto" || prop === "waitForSelector") {
          return (): Promise<null> => Promise.resolve(null);
        }
        if (prop === "content") {
          return (): Promise<string> => Promise.resolve(html);
        }
        if (prop === "url") {
          return (): string => url;
        }
        throw new Error(`unexpected page.${String(prop)} in detail stub`);
      },
    }
  ) as Page;
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

// ─── Unparseable-order-date drop evidence ─────────────────────────────────

// processListOrder with skipDetail:true never touches `page` for a parseable
// date, and for an unparseable date it returns false before any page access.
// A throwing stand-in proves we never reach the browser on the drop path.
const NEVER_CALLED_PAGE = new Proxy(
  {},
  {
    get(): never {
      throw new Error("page must not be touched in this test");
    },
  }
) as Page;

function makeRunFlags(): RunFlags {
  return { detailAttempts: 0, detailCaptured: false, failedDetailCaptured: false, temporaryDetailFailures: 0 };
}

test("processListOrder: unparseable order date returns false (dropped) and emits no records", async () => {
  const { deps, emitted } = makeRecordingDeps({ skipDetail: true });
  const dropped = await processListOrder(
    NEVER_CALLED_PAGE,
    deps,
    makeRunFlags(),
    makeListOrder({ orderDateRaw: "not a real date" })
  );
  assert.equal(dropped, false);
  assert.equal(emitted.length, 0, "a dropped order must emit no records");
});

test("processListOrder: empty/null order date is also a drop", async () => {
  const { deps, emitted } = makeRecordingDeps({ skipDetail: true });
  for (const raw of [null, ""]) {
    const dropped = await processListOrder(
      NEVER_CALLED_PAGE,
      deps,
      makeRunFlags(),
      makeListOrder({ orderDateRaw: raw })
    );
    assert.equal(dropped, false);
  }
  assert.equal(emitted.length, 0);
});

test("processListOrder: parseable order date returns true and emits the order", async () => {
  const { deps, emitted } = makeRecordingDeps({ skipDetail: true });
  const processed = await processListOrder(
    NEVER_CALLED_PAGE,
    deps,
    makeRunFlags(),
    makeListOrder({ orderDateRaw: "January 5, 2026" })
  );
  assert.equal(processed, true);
  assert.ok(
    emitted.some((r) => r.stream === "orders"),
    "a processed order must emit an 'orders' record"
  );
});

test("runYear emits bounded per-year unparseable-date SKIP_RESULT evidence with no raw order ids", () => {
  const src = readFileSync(AMAZON_INDEX_PATH, "utf8");
  // The count is accumulated from processListOrder's boolean result.
  assert.match(src, /unparseableDateCount\+\+/);
  // One bounded per-year SKIP_RESULT summary, gated on count > 0, count + total only.
  assert.match(src, /type:\s*"SKIP_RESULT"[\s\S]*?stream:\s*"orders"[\s\S]*?reason:\s*"unparseable_order_date"/);
  assert.match(src, /dropped \$\{unparseableDateCount\} order row/);
  assert.match(src, /with unparseable dates \(of \$\{yearOrderCount\} seen\)/);
  assert.match(src, /diagnostics:\s*\{\s*dropped:\s*unparseableDateCount,\s*total_seen:\s*yearOrderCount,\s*year\s*\}/);
  // The summary is tagged to the orders stream for dashboard routing.
  assert.match(src, /stream:\s*"orders"/);
  // It must NOT interpolate any raw order identifier.
  assert.doesNotMatch(src, /unparseable[\s\S]*?\$\{[^}]*orderId[^}]*\}/);
});

test("collect path does not advance a year cursor after unparseable order-date drops", () => {
  const src = readFileSync(AMAZON_INDEX_PATH, "utf8");
  assert.match(
    src,
    /if \(unparseableDateCount === 0\) \{[\s\S]*?last_scraped:\s*nowIso\(\),[\s\S]*?\} else \{[\s\S]*?Not advancing Amazon year \$\{year\} cursor/,
    "last_scraped must only advance on a year with zero required-row drops"
  );
});

test("amazon manifest: successful manual runs have a bounded freshness window", () => {
  const manifest = JSON.parse(readFileSync(AMAZON_MANIFEST_PATH, "utf8")) as {
    capabilities?: { refresh_policy?: { maximum_staleness_seconds?: number; recommended_mode?: string } };
  };
  const policy = manifest.capabilities?.refresh_policy;
  assert.equal(policy?.recommended_mode, "manual");
  assert.equal(policy?.maximum_staleness_seconds, 86_400);
});

// ─── Empty list-page classification ──────────────────────────────────────

function makeEmptyPageDiagnostics(overrides: Partial<ListPageDiagnostics> = {}): ListPageDiagnostics {
  return {
    any_card: 0,
    any_order_header: 0,
    body_preview: "",
    captcha: "false",
    no_orders_text: "false",
    order_cards: 0,
    sign_in_form: false,
    title: "Your Orders",
    url: "https://www.amazon.com/your-orders/orders?timeFilter=year-2024&startIndex=0",
    ...overrides,
  };
}

test("classifyEmptyListPageDiagnostics: captcha/sign-in pages abort cursor advancement", () => {
  assert.deepEqual(classifyEmptyListPageDiagnostics(makeEmptyPageDiagnostics({ captcha: "true" }), 0), {
    action: "abort",
    reason: "source_auth_or_challenge",
  });
  assert.deepEqual(classifyEmptyListPageDiagnostics(makeEmptyPageDiagnostics({ sign_in_form: true }), 0), {
    action: "abort",
    reason: "source_auth_or_challenge",
  });
});

test("classifyEmptyListPageDiagnostics: selector drift aborts cursor advancement", () => {
  assert.deepEqual(classifyEmptyListPageDiagnostics(makeEmptyPageDiagnostics({ any_order_header: 2 }), 0), {
    action: "abort",
    reason: "selector_drift",
  });
});

test("classifyEmptyListPageDiagnostics: only proven terminal empty pages advance the cursor", () => {
  assert.deepEqual(classifyEmptyListPageDiagnostics(makeEmptyPageDiagnostics({ no_orders_text: "true" }), 0), {
    action: "terminal",
    reason: "no_orders_text",
  });
  assert.deepEqual(classifyEmptyListPageDiagnostics(makeEmptyPageDiagnostics(), 10), {
    action: "terminal",
    reason: "pagination_exhausted",
  });
  assert.deepEqual(classifyEmptyListPageDiagnostics(makeEmptyPageDiagnostics(), 0), {
    action: "abort",
    reason: "empty_first_page_without_terminal_signal",
  });
});

test("classifyEmptyListPageDiagnostics: current empty-year copy is terminal despite buy-again carousel sentinel", () => {
  const html = readFileSync(AMAZON_EMPTY_YEAR_FIXTURE, "utf8");
  const visibleText = html.replace(/<[^>]+>/g, " ");
  const noOrdersRe = new RegExp(AMAZON_NO_ORDERS_TEXT_PATTERN, "i");

  assert.match(visibleText, noOrdersRe);
  assert.deepEqual(
    classifyEmptyListPageDiagnostics(
      makeEmptyPageDiagnostics({
        any_card: 1,
        no_orders_text: noOrdersRe.test(visibleText).toString(),
        order_cards: 1,
      }),
      0
    ),
    {
      action: "terminal",
      reason: "no_orders_text",
    }
  );
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

// ─── Progress signal invariants ───────────────────────────────────────────

test("auth-challenge PROGRESS signal: emitted with stream=orders tag on sign-in/CAPTCHA detection", () => {
  const src = readFileSync(AMAZON_INDEX_PATH, "utf8");
  // The PROGRESS emit must exist and reference stream: "orders" so the dashboard
  // can route the signal to the right stream column.
  assert.match(
    src,
    /type:\s*"PROGRESS"[\s\S]{0,200}stream:\s*"orders"[\s\S]{0,200}sign-in or CAPTCHA challenge detected/
  );
  // The challenge message must not interpolate any order ID or user-identifying field.
  assert.doesNotMatch(src, /sign-in or CAPTCHA.*\$\{.*orderId/);
  assert.doesNotMatch(src, /sign-in or CAPTCHA.*\$\{.*recipient_name/);
});

test("PROGRESS messages do not interpolate Amazon order PII (recipient name, address, payment)", () => {
  const src = readFileSync(AMAZON_INDEX_PATH, "utf8");
  // Scan all PROGRESS message template literals for banned field references.
  // SKIP_RESULT messages may carry opaque IDs (order numbers) for diagnostics,
  // but PROGRESS messages are operator-visible and must stay PII-free.
  const progressBlocks = src.matchAll(/type:\s*"PROGRESS"[\s\S]{0,500}?(?=type:|$)/g);
  const banned = /\b(?:recipient_name|shipping_address|payment_method|detail\.gift_order|r\.name|order\.name)\b/;
  for (const block of progressBlocks) {
    assert.doesNotMatch(block[0], banned, `PROGRESS block leaks PII: ${block[0].slice(0, 120)}`);
  }
});

// ─── order_items detail coverage evidence ─────────────────────────────────
//
// Amazon enumerates the full per-year order list BEFORE hydrating any order
// detail page, so the processed-order set is a real "considered" denominator.
// The order_items stream is enriched by the detail page; a detail fetch that
// returns null still emits the list-page items but loses the detail
// enrichment — a degraded gap, not silence. These tests pin that the
// DETAIL_COVERAGE projection reports that honestly (denominator, hydrated
// numerator, gap set, policy-skip set) using the shared emitDetailCoverage
// helper, and that no per-order PII beyond the opaque order id crosses in.

type DetailCoverage = Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }>;
type DetailGap = Extract<EmittedMessage, { type: "DETAIL_GAP" }>;

function findDetailCoverage(messages: EmittedMessage[]): DetailCoverage | undefined {
  return messages.find((m): m is DetailCoverage => m.type === "DETAIL_COVERAGE");
}

function findDetailGaps(messages: EmittedMessage[]): DetailGap[] {
  return messages.filter((m): m is DetailGap => m.type === "DETAIL_GAP");
}

test("classifyDetailOutcome: skip → skipped, null detail → gap, parsed detail → hydrated", () => {
  assert.equal(classifyDetailOutcome(true, null), "skipped", "policy skip wins regardless of detail");
  assert.equal(classifyDetailOutcome(true, makeDetail()), "skipped", "skip never reads as hydrated");
  assert.equal(classifyDetailOutcome(false, null), "gap", "attempted-but-null is a degraded gap");
  assert.equal(classifyDetailOutcome(false, makeDetail()), "hydrated", "a parsed detail is hydrated");
});

test("reasonForDetailFailure: maps precise Amazon detail failures to redacted retry reasons", () => {
  assert.equal(reasonForDetailFailure("navigation_retry_exhausted"), "retry_exhausted");
  assert.equal(reasonForDetailFailure("redirected_non_detail"), "temporary_unavailable");
  assert.equal(reasonForDetailFailure("parse_missing"), "temporary_unavailable");
  assert.equal(reasonForDetailFailure("deferred_budget"), "retry_exhausted");
});

test("readPageContentWithin fails bounded when the renderer stops answering", async () => {
  const page = {
    content: (): Promise<string> => new Promise(() => undefined),
  };

  await assert.rejects(() => readPageContentWithin(page, 5), /page_content_timeout after 5ms/);
});

test("recordDetailOutcome: every recorded order joins required; outcome picks the numerator/skip set", () => {
  const coverage = newOrderItemsCoverage();
  recordDetailOutcome(coverage, "ord-hydrated", "hydrated");
  recordDetailOutcome(coverage, "ord-gap", "gap");
  recordDetailOutcome(coverage, "ord-skipped", "skipped");

  assert.deepEqual(coverage.required, ["ord-hydrated", "ord-gap", "ord-skipped"], "required is the denominator");
  assert.deepEqual(coverage.hydrated, ["ord-hydrated"]);
  assert.deepEqual(coverage.gap, ["ord-gap"]);
  assert.deepEqual(coverage.optionalSkip, ["ord-skipped"]);
});

test("emitOrderItemsCoverage: a fully hydrated run emits required=hydrated, no gap/skip fields", async () => {
  const { deps, protocolMessages } = makeRecordingDeps();
  const coverage: OrderItemsCoverage = {
    required: ["a", "b"],
    hydrated: ["a", "b"],
    gap: [],
    optionalSkip: [],
  };
  await emitOrderItemsCoverage(deps, coverage);

  const msg = findDetailCoverage(protocolMessages);
  assert.ok(msg, "expected a DETAIL_COVERAGE message");
  assert.equal(msg.type, "DETAIL_COVERAGE");
  assert.equal(msg.reference_only, true);
  assert.equal(msg.stream, "order_items", "coverage describes the detail-enriched stream");
  assert.equal(msg.state_stream, "orders", "coverage is anchored by the list/parent stream cursor");
  assert.deepEqual(msg.required_keys, ["a", "b"]);
  assert.deepEqual(msg.hydrated_keys, ["a", "b"]);
  // Empty optional sets are omitted by the shared builder — a clean run carries
  // no gap/skip noise.
  assert.equal(msg.gap_keys, undefined);
  assert.equal(msg.optional_skip_keys, undefined);
});

test("emitOrderItemsCoverage: a partial run reports gap_keys distinct from hydrated", async () => {
  const { deps, protocolMessages } = makeRecordingDeps();
  const coverage: OrderItemsCoverage = {
    required: ["a", "b", "c"],
    hydrated: ["a"],
    gap: ["b", "c"],
    optionalSkip: [],
  };
  await emitOrderItemsCoverage(deps, coverage);

  const msg = findDetailCoverage(protocolMessages);
  assert.ok(msg);
  assert.deepEqual(msg.required_keys, ["a", "b", "c"]);
  assert.deepEqual(msg.hydrated_keys, ["a"]);
  assert.deepEqual(msg.gap_keys, ["b", "c"], "degraded detail fetches surface as a real gap");
  assert.equal(msg.optional_skip_keys, undefined);
});

test("emitOrderItemsCoverage: policy-skipped detail reports optional_skip_keys, not gap", async () => {
  const { deps, protocolMessages } = makeRecordingDeps();
  const coverage: OrderItemsCoverage = {
    required: ["a", "b"],
    hydrated: [],
    gap: [],
    optionalSkip: ["a", "b"],
  };
  await emitOrderItemsCoverage(deps, coverage);

  const msg = findDetailCoverage(protocolMessages);
  assert.ok(msg);
  assert.deepEqual(msg.optional_skip_keys, ["a", "b"], "PDPP_AMAZON_SKIP_DETAIL is a scope choice, not a gap");
  assert.equal(msg.gap_keys, undefined, "a deliberate skip must never read as a degraded gap");
});

test("emitOrderItemsCoverage: an empty run emits nothing rather than a hollow coverage report", async () => {
  const { deps, protocolMessages } = makeRecordingDeps();
  await emitOrderItemsCoverage(deps, newOrderItemsCoverage());
  assert.equal(findDetailCoverage(protocolMessages), undefined, "no considered orders → no coverage message");
});

test("processListOrder: a hydrated detail records the order id in required + hydrated", async () => {
  const coverage = newOrderItemsCoverage();
  const { deps, protocolMessages } = makeRecordingDeps({ orderItemsCoverage: coverage });
  // A fake detail page so fetchOrderDetail-equivalent succeeds. We drive
  // processListOrder through a page stub that returns a parseable detail DOM.
  const page = makeDetailPageStub(makeDetailHtml());
  await processListOrder(page, deps, makeRunFlags(), makeListOrder({ orderId: "ord-1" }));

  assert.deepEqual(coverage.required, ["ord-1"]);
  assert.deepEqual(coverage.hydrated, ["ord-1"], "a parsed detail counts as hydrated");
  assert.deepEqual(coverage.gap, []);
  // A hydration is not a gap — it must emit no DETAIL_GAP.
  assert.equal(findDetailGaps(protocolMessages).length, 0, "a hydrated detail emits no DETAIL_GAP");
});

test("processListOrder: fopo Whole Foods detail URL hydrates instead of becoming a gap", async () => {
  const coverage = newOrderItemsCoverage();
  const { deps, emitted, protocolMessages } = makeRecordingDeps({ orderItemsCoverage: coverage });
  const html = readFileSync(AMAZON_FOPO_DETAIL_FIXTURE, "utf8");
  const page = makeDetailPageStub(
    html,
    "https://www.amazon.com/fopo/order-details/ref=ppx_hzod_rd_dt_b_fresh_fopo_rd?_encoding=UTF8&orderID=fixture"
  );

  await processListOrder(page, deps, makeRunFlags(), makeListOrder({ orderId: "ord-fopo-1" }));

  assert.deepEqual(coverage.required, ["ord-fopo-1"]);
  assert.deepEqual(coverage.hydrated, ["ord-fopo-1"]);
  assert.deepEqual(coverage.gap, []);
  assert.equal(findDetailGaps(protocolMessages).length, 0, "fopo detail pages must not emit degraded detail gaps");
  assert.ok(
    emitted.some((r) => r.stream === "order_items" && r.data.asin === "B01FOPO001"),
    "fopo detail items enrich emitted order_items"
  );
});

test("processListOrder: a null detail (attempted, degraded) records a gap, not a hydration", async () => {
  const coverage = newOrderItemsCoverage();
  const { deps, emitted, protocolMessages } = makeRecordingDeps({ orderItemsCoverage: coverage });
  // The detail page renders without an #orderDetails container, so
  // parseOrderDetailDom returns null — the same degraded outcome a layout
  // drift or non-detail redirect produces. The list-page items still emit.
  const page = makeDetailPageStub(NO_DETAIL_HTML);
  await processListOrder(page, deps, makeRunFlags(), makeListOrder({ orderId: "ord-2" }));

  assert.deepEqual(coverage.required, ["ord-2"]);
  assert.deepEqual(coverage.gap, ["ord-2"], "an attempted-but-failed detail is a degraded gap");
  assert.deepEqual(coverage.hydrated, []);
  // A gap does not suppress collection: list-page items still flow.
  assert.ok(
    emitted.some((r) => r.stream === "order_items"),
    "list-page items emit even when detail enrichment degrades"
  );
  // The degraded gap MUST be backed by a durable pending DETAIL_GAP, or the
  // run's DETAIL_COVERAGE.gap_key has no durable gap and the run fails at
  // state-commit.
  const gaps = findDetailGaps(protocolMessages);
  assert.equal(gaps.length, 1, "exactly one pending DETAIL_GAP per degraded order");
  assert.equal(gaps[0]?.record_key, "ord-2", "the DETAIL_GAP record_key is the gap order id");
  assert.equal(gaps[0]?.stream, "order_items", "the DETAIL_GAP is on the coverage stream");
  assert.equal(gaps[0]?.reason, "temporary_unavailable", "parse-missing detail stays retryable but precise");
  assert.equal(gaps[0]?.detail_locator.order_date, "2026-01-05", "future recovery needs the parsed order date");
});

test("processListOrder: first failed detail captures one failed-detail checkpoint when capture is enabled", async () => {
  const coverage = newOrderItemsCoverage();
  const labels: string[] = [];
  const { deps, protocolMessages } = makeRecordingDeps({
    capture: {
      baseDir: "/tmp/pdpp-test-capture",
      captureDom: (_page, label): Promise<void> => {
        labels.push(label);
        return Promise.resolve();
      },
      captureHttp: (): void => undefined,
      finalize: (): void => undefined,
      keepOnSuccess: true,
      markSucceeded: (): void => undefined,
      recordRecord: (): void => undefined,
      runId: "test-run",
    },
    orderItemsCoverage: coverage,
  });
  const flags = makeRunFlags();
  const page = makeDetailPageStub(NO_DETAIL_HTML);

  await processListOrder(page, deps, flags, makeListOrder({ orderId: "ord-fail-capture-1" }));
  await processListOrder(page, deps, flags, makeListOrder({ orderId: "ord-fail-capture-2" }));

  assert.deepEqual(labels, ["order-detail-failed-parse_missing"], "failed-detail fixture capture is bounded once");
  assert.equal(flags.failedDetailCaptured, true);
  assert.equal(findDetailGaps(protocolMessages).length, 2, "capture does not suppress durable gap reporting");
});

test("processListOrder: parse-missing detail failures do not trip source-pressure deferral", async () => {
  const coverage = newOrderItemsCoverage();
  const { deps, protocolMessages } = makeRecordingDeps({ orderItemsCoverage: coverage });
  const flags = makeRunFlags();
  const page = makeDetailPageStub(NO_DETAIL_HTML);

  await processListOrder(page, deps, flags, makeListOrder({ orderId: "ord-parse-1" }));
  await processListOrder(page, deps, flags, makeListOrder({ orderId: "ord-parse-2" }));
  await processListOrder(page, deps, flags, makeListOrder({ orderId: "ord-parse-3" }));
  await processListOrder(page, deps, flags, makeListOrder({ orderId: "ord-parse-4" }));

  const gaps = findDetailGaps(protocolMessages);
  assert.deepEqual(coverage.gap, ["ord-parse-1", "ord-parse-2", "ord-parse-3", "ord-parse-4"]);
  assert.deepEqual(
    gaps.map((gap) => [gap.record_key, gap.reason]),
    [
      ["ord-parse-1", "temporary_unavailable"],
      ["ord-parse-2", "temporary_unavailable"],
      ["ord-parse-3", "temporary_unavailable"],
      ["ord-parse-4", "temporary_unavailable"],
    ],
    "layout/parser drift stays retryable but does not become source pressure"
  );
  assert.equal(flags.temporaryDetailFailures, 0, "parse-missing details do not count as source-pressure failures");
});

test("processListOrder: repeated retry-exhausted detail failures defer later details as non-pressure gaps", async () => {
  const coverage = newOrderItemsCoverage();
  const { deps, protocolMessages } = makeRecordingDeps({ orderItemsCoverage: coverage });
  const flags = { ...makeRunFlags(), temporaryDetailFailures: 3 };

  await processListOrder(NEVER_CALLED_PAGE, deps, flags, makeListOrder({ orderId: "ord-deferred-4" }));

  assert.deepEqual(coverage.gap, ["ord-deferred-4"]);
  const gaps = findDetailGaps(protocolMessages);
  assert.deepEqual(
    gaps.map((gap) => [gap.record_key, gap.reason]),
    [["ord-deferred-4", "retry_exhausted"]],
    "connector-local detail budget defers the next detail without arming source-pressure cooldown"
  );
  assert.equal(gaps[0]?.last_error?.class, "deferred_budget");
  assert.equal(flags.temporaryDetailFailures, 3, "deferred gaps do not keep ratcheting the temporary failure count");
});

test("processListOrder: total detail-attempt budget defers later details without touching the page", async () => {
  const coverage = newOrderItemsCoverage();
  const { deps, protocolMessages } = makeRecordingDeps({ orderItemsCoverage: coverage });
  const flags = { ...makeRunFlags(), detailAttempts: 999 };

  await processListOrder(NEVER_CALLED_PAGE, deps, flags, makeListOrder({ orderId: "ord-attempt-budget" }));

  assert.deepEqual(coverage.gap, ["ord-attempt-budget"]);
  const gaps = findDetailGaps(protocolMessages);
  assert.deepEqual(
    gaps.map((gap) => [gap.record_key, gap.reason, gap.last_error?.class]),
    [["ord-attempt-budget", "retry_exhausted", "deferred_budget"]],
    "total detail budget uses a non-source-pressure retryable gap"
  );
  assert.equal(flags.detailAttempts, 999, "budget-deferred gaps do not touch the browser or increment attempts");
});

test("recoverPendingOrderItemDetailGaps: hydrates future Amazon order-item gaps and marks recovered", async () => {
  const { deps, emitted, protocolMessages } = makeRecordingDeps();
  const flags = makeRunFlags();
  const orderId = "111-1234567-8901234";
  const result = await recoverPendingOrderItemDetailGaps(
    makeDetailPageStub(makeDetailHtml()),
    {
      capture: null,
      detailGaps: [
        {
          detail_locator: {
            kind: "amazon.order_detail",
            order_date: "2026-01-05",
            order_id: orderId,
          },
          gap_id: "gap_recover_1",
          record_key: orderId,
          reference_only: true,
          status: "pending",
          stream: "order_items",
        },
      ],
      emit: deps.emit,
      emitRecord: deps.emitRecord,
    },
    flags
  );

  assert.deepEqual(result, { recovered: 1, stoppedWithPending: false });
  assert.ok(
    emitted.some((record) => record.stream === "order_items" && record.data.order_id === orderId),
    "recovered detail emits order_items records"
  );
  assert.deepEqual(
    protocolMessages.find((message) => message.type === "DETAIL_GAP_RECOVERED"),
    {
      type: "DETAIL_GAP_RECOVERED",
      reference_only: true,
      gap_id: "gap_recover_1",
      stream: "order_items",
      record_key: orderId,
    }
  );
});

test("recoverPendingOrderItemDetailGaps: keeps paging recovered gaps until pending work is empty", async () => {
  const { deps, protocolMessages } = makeRecordingDeps();
  const pageRequests: number[] = [];
  const secondOrderId = "111-1234567-8901235";
  const pages: BrowserCollectContext["detailGaps"][] = [
    [
      {
        detail_locator: {
          kind: "amazon.order_detail",
          order_date: "2026-01-06",
          order_id: secondOrderId,
        },
        gap_id: "gap_recover_2",
        record_key: secondOrderId,
        reference_only: true,
        status: "pending",
        stream: "order_items",
      },
    ],
    [],
  ];

  const result = await recoverPendingOrderItemDetailGaps(
    makeDetailPageStub(makeDetailHtml()),
    {
      capture: null,
      detailGaps: [
        {
          detail_locator: {
            kind: "amazon.order_detail",
            order_date: "2026-01-05",
            order_id: "111-1234567-8901234",
          },
          gap_id: "gap_recover_1",
          record_key: "111-1234567-8901234",
          reference_only: true,
          status: "pending",
          stream: "order_items",
        },
      ],
      emit: deps.emit,
      emitRecord: deps.emitRecord,
      requestDetailGapPage: () => {
        pageRequests.push(pageRequests.length + 1);
        return Promise.resolve(pages.shift() ?? []);
      },
    },
    makeRunFlags()
  );

  assert.deepEqual(result, { recovered: 2, stoppedWithPending: false });
  assert.deepEqual(pageRequests, [1, 2], "recovery keeps requesting pages until pending work is empty");
  assert.deepEqual(
    protocolMessages.filter((message) => message.type === "DETAIL_GAP_RECOVERED").map((message) => message.record_key),
    ["111-1234567-8901234", secondOrderId]
  );
});

test("recoverPendingOrderItemDetailGaps: under-specified legacy gaps are left pending, not corrupted", async () => {
  const { deps, emitted, protocolMessages } = makeRecordingDeps();
  const result = await recoverPendingOrderItemDetailGaps(
    NEVER_CALLED_PAGE,
    {
      capture: null,
      detailGaps: [
        {
          detail_locator: {
            kind: "amazon.order_detail",
            order_id: "legacy-gap-no-date",
          },
          gap_id: "gap_legacy",
          record_key: "legacy-gap-no-date",
          reference_only: true,
          status: "pending",
          stream: "order_items",
        },
      ],
      emit: deps.emit,
      emitRecord: deps.emitRecord,
    },
    makeRunFlags()
  );

  assert.deepEqual(result, { recovered: 0, stoppedWithPending: true });
  assert.equal(emitted.length, 0, "missing order_date cannot emit valid order_items");
  assert.equal(protocolMessages.length, 0, "legacy gap remains durable instead of being falsely recovered");
});

test("recoverPendingOrderItemDetailGapsBeforeForwardRun: no order_items scope skips recovery and permits forward walk", async () => {
  const { deps } = makeRecordingDeps();
  const result = await recoverPendingOrderItemDetailGapsBeforeForwardRun(
    NEVER_CALLED_PAGE,
    {
      capture: null,
      detailGaps: [
        {
          detail_locator: {
            kind: "amazon.order_detail",
            order_date: "2026-01-05",
            order_id: "111-1234567-8901234",
          },
          gap_id: "gap_recover_1",
          record_key: "111-1234567-8901234",
          reference_only: true,
          status: "pending",
          stream: "order_items",
        },
      ],
      emit: deps.emit,
      emitRecord: deps.emitRecord,
    },
    makeRunFlags(),
    { wantsItems: false }
  );

  assert.deepEqual(result, { recovered: 0, stoppedWithPending: false, suppressForward: false });
});

test("recoverPendingOrderItemDetailGapsBeforeForwardRun: zero-budget legacy stop still permits forward walk", async () => {
  const { deps } = makeRecordingDeps();
  const result = await recoverPendingOrderItemDetailGapsBeforeForwardRun(
    NEVER_CALLED_PAGE,
    {
      capture: null,
      detailGaps: [
        {
          detail_locator: {
            kind: "amazon.order_detail",
            order_id: "legacy-gap-no-date",
          },
          gap_id: "gap_legacy",
          record_key: "legacy-gap-no-date",
          reference_only: true,
          status: "pending",
          stream: "order_items",
        },
      ],
      emit: deps.emit,
      emitRecord: deps.emitRecord,
    },
    makeRunFlags(),
    { wantsItems: true }
  );

  assert.deepEqual(result, { recovered: 0, stoppedWithPending: true, suppressForward: false });
});

test("recoverPendingOrderItemDetailGapsBeforeForwardRun: detail-budget exhaustion suppresses forward walk", async () => {
  const { deps } = makeRecordingDeps();
  const orderId = "111-1234567-8901234";
  const result = await recoverPendingOrderItemDetailGapsBeforeForwardRun(
    NEVER_CALLED_PAGE,
    {
      capture: null,
      detailGaps: [
        {
          detail_locator: {
            kind: "amazon.order_detail",
            order_date: "2026-01-05",
            order_id: orderId,
          },
          gap_id: "gap_deferred",
          record_key: orderId,
          reference_only: true,
          status: "pending",
          stream: "order_items",
        },
      ],
      emit: deps.emit,
      emitRecord: deps.emitRecord,
    },
    { ...makeRunFlags(), detailAttempts: 200 },
    { wantsItems: true }
  );

  assert.deepEqual(result, { recovered: 0, stoppedWithPending: true, suppressForward: true });
});

test("recoverPendingOrderItemDetailGapsBeforeForwardRun: recovery-only suppresses forward walk after clean drain", async () => {
  const { deps, emitted, protocolMessages } = makeRecordingDeps();
  const orderId = "111-1234567-8901234";
  const result = await recoverPendingOrderItemDetailGapsBeforeForwardRun(
    makeDetailPageStub(makeDetailHtml()),
    {
      capture: null,
      detailGaps: [
        {
          detail_locator: {
            kind: "amazon.order_detail",
            order_date: "2026-01-05",
            order_id: orderId,
          },
          gap_id: "gap_recover_1",
          record_key: orderId,
          reference_only: true,
          status: "pending",
          stream: "order_items",
        },
      ],
      emit: deps.emit,
      emitRecord: deps.emitRecord,
    },
    makeRunFlags(),
    { recoveryOnly: true, wantsItems: true }
  );

  assert.deepEqual(result, { recovered: 1, stoppedWithPending: false, suppressForward: true });
  assert.ok(emitted.some((record) => record.stream === "order_items" && record.data.order_id === orderId));
  assert.ok(protocolMessages.some((message) => message.type === "DETAIL_GAP_RECOVERED"));
});

test("processListOrder: skipDetail records an optional_skip, never touching the page", async () => {
  const coverage = newOrderItemsCoverage();
  const { deps, protocolMessages } = makeRecordingDeps({ orderItemsCoverage: coverage, skipDetail: true });
  await processListOrder(NEVER_CALLED_PAGE, deps, makeRunFlags(), makeListOrder({ orderId: "ord-3" }));

  assert.deepEqual(coverage.required, ["ord-3"]);
  assert.deepEqual(coverage.optionalSkip, ["ord-3"], "PDPP_AMAZON_SKIP_DETAIL is a policy skip");
  assert.deepEqual(coverage.gap, []);
  assert.deepEqual(coverage.hydrated, []);
  // A policy skip is a scope choice, not a degraded fetch — it must NOT emit a
  // DETAIL_GAP (an optional_skip_key satisfies coverage on its own).
  assert.equal(findDetailGaps(protocolMessages).length, 0, "a policy skip emits no DETAIL_GAP");
});

test("processListOrder: an unparseable order date is never counted toward order-item coverage", async () => {
  const coverage = newOrderItemsCoverage();
  const { deps } = makeRecordingDeps({ orderItemsCoverage: coverage, skipDetail: true });
  const processed = await processListOrder(
    NEVER_CALLED_PAGE,
    deps,
    makeRunFlags(),
    makeListOrder({ orderId: "ord-bad", orderDateRaw: "not a real date" })
  );
  assert.equal(processed, false, "an unparseable row is dropped before the detail lane");
  assert.deepEqual(coverage.required, [], "a dropped row never enters the denominator");
});

test("DETAIL_COVERAGE for order_items carries only opaque order ids, never recipient/address PII", async () => {
  // The coverage key sets are order ids; recipient/address/payment fields must
  // never appear in the emitted projection. Drive a hydrated order through and
  // assert the serialized message contains the order id and none of the PII the
  // detail page also exposes.
  const coverage = newOrderItemsCoverage();
  const { deps, protocolMessages } = makeRecordingDeps({ orderItemsCoverage: coverage });
  const page = makeDetailPageStub(makeDetailHtml());
  await processListOrder(page, deps, makeRunFlags(), makeListOrder({ orderId: "111-SECRET-0001" }));
  await emitOrderItemsCoverage(deps, coverage);

  const msg = findDetailCoverage(protocolMessages);
  assert.ok(msg);
  assert.ok(msg.required_keys.includes("111-SECRET-0001"), "the opaque order id is the only key");
  const serialized = JSON.stringify(msg);
  assert.doesNotMatch(serialized, /Fake Name|123 Fake St|Visa ending/, "no recipient/address/payment in coverage");
});

// ─── pending DETAIL_GAP backing for coverage gap_keys ─────────────────────
//
// The runtime treats DETAIL_COVERAGE.gap_keys as a projection only: a
// `required` key is satisfied at state-commit by a hydration, an optional skip,
// or a *durable pending DETAIL_GAP* with a matching record_key
// (assertDetailCoverageSatisfiedBeforeCommit). So an otherwise-successful run
// that degraded any order detail fails at commit unless every gap_key is backed
// by a pending DETAIL_GAP. These tests pin that backing, its emission order
// (gaps before the run-level coverage), the reference-only redacted shape, and
// that policy skips / hydrations emit no gap. The polyfill-runtime spec
// ("partially hydrated run carries gap_keys matching emitted DETAIL_GAPs")
// makes this a contract, not just an implementation detail.

test("buildOrderDetailGap: redacted reference-only pending gap on order_items, keyed by the opaque order id", () => {
  const gap = buildOrderDetailGap("111-7654321-0000001");
  assert.equal(gap.type, "DETAIL_GAP");
  assert.equal(gap.stream, "order_items", "the gap is on the same stream the coverage describes");
  assert.equal(gap.parent_stream, "orders", "the list/parent stream is orders");
  assert.equal(gap.record_key, "111-7654321-0000001", "record_key is the opaque order id");
  assert.equal(gap.status, "pending", "a fresh gap is pending recovery");
  assert.equal(gap.retryable, true, "a degraded detail fetch is retryable next run");
  assert.equal(gap.reference_only, true, "DETAIL_GAP is a reference-only projection");
  assert.equal(gap.reason, "temporary_unavailable", "null-detail paths are mixed → temporary, not retry_exhausted");
  assert.equal(gap.detail_locator.kind, "amazon.order_detail", "stable redacted locator kind");
  assert.equal(gap.detail_locator.order_id, "111-7654321-0000001", "locator carries only the opaque order id");
});

test("buildOrderDetailGap: serialized gap carries only the opaque order id, no recipient/address/payment/item text", () => {
  const gap = buildOrderDetailGap("111-SECRET-0002");
  const serialized = JSON.stringify(gap);
  assert.match(serialized, /111-SECRET-0002/, "the opaque order id is present");
  // None of the PII the order-detail page exposes may ride along on the gap.
  assert.doesNotMatch(
    serialized,
    /Fake Name|123 Fake St|Visa ending|Widget|Detail-Only Item/,
    "no recipient/address/payment/item title or text in the DETAIL_GAP"
  );
});

test("every coverage gap_key is backed by exactly one pending DETAIL_GAP with the same record_key", async () => {
  const coverage = newOrderItemsCoverage();
  const { deps, protocolMessages } = makeRecordingDeps({ orderItemsCoverage: coverage });
  // Two degraded orders (null detail) and one hydrated order in the same run.
  const gapPage = makeDetailPageStub(NO_DETAIL_HTML);
  const hydratedPage = makeDetailPageStub(makeDetailHtml());
  await processListOrder(gapPage, deps, makeRunFlags(), makeListOrder({ orderId: "ord-gap-1" }));
  await processListOrder(hydratedPage, deps, makeRunFlags(), makeListOrder({ orderId: "ord-ok-1" }));
  await processListOrder(gapPage, deps, makeRunFlags(), makeListOrder({ orderId: "ord-gap-2" }));
  await emitOrderItemsCoverage(deps, coverage);

  const cov = findDetailCoverage(protocolMessages);
  assert.ok(cov, "expected a run-level DETAIL_COVERAGE");
  assert.deepEqual(cov.gap_keys, ["ord-gap-1", "ord-gap-2"], "coverage reports both degraded orders as gaps");
  assert.deepEqual(cov.hydrated_keys, ["ord-ok-1"], "the hydrated order is not a gap");

  const gaps = findDetailGaps(protocolMessages);
  const gapKeys = gaps.map((g) => g.record_key);
  // The runtime's assertDetailCoverageSatisfiedBeforeCommit matches gap.stream
  // === coverage.stream and gap.record_key against required_keys: every gap_key
  // must have a same-stream pending DETAIL_GAP carrying that record_key.
  const coverageStream = cov.stream;
  for (const key of cov.gap_keys ?? []) {
    const backing: DetailGap[] = gaps.filter(
      (g) => g.record_key === key && g.stream === coverageStream && g.status === "pending"
    );
    assert.equal(
      backing.length,
      1,
      `gap_key ${key} must be backed by exactly one pending DETAIL_GAP on ${coverageStream}`
    );
  }
  assert.deepEqual(gapKeys, ["ord-gap-1", "ord-gap-2"], "no DETAIL_GAP for the hydrated order; one per degraded order");
});

test("DETAIL_GAP messages emit before the run-level DETAIL_COVERAGE (commit-gate ordering)", async () => {
  const coverage = newOrderItemsCoverage();
  const { deps, protocolMessages } = makeRecordingDeps({ orderItemsCoverage: coverage });
  const gapPage = makeDetailPageStub(NO_DETAIL_HTML);
  await processListOrder(gapPage, deps, makeRunFlags(), makeListOrder({ orderId: "ord-gap-early" }));
  await emitOrderItemsCoverage(deps, coverage);

  const gapIdx = protocolMessages.findIndex((m) => m.type === "DETAIL_GAP");
  const covIdx = protocolMessages.findIndex((m) => m.type === "DETAIL_COVERAGE");
  assert.notEqual(gapIdx, -1, "expected a DETAIL_GAP");
  assert.notEqual(covIdx, -1, "expected a DETAIL_COVERAGE");
  assert.ok(gapIdx < covIdx, "the pending DETAIL_GAP must precede the run-level DETAIL_COVERAGE");
});

test("a fully hydrated run emits zero DETAIL_GAP messages", async () => {
  const coverage = newOrderItemsCoverage();
  const { deps, protocolMessages } = makeRecordingDeps({ orderItemsCoverage: coverage });
  const hydratedPage = makeDetailPageStub(makeDetailHtml());
  await processListOrder(hydratedPage, deps, makeRunFlags(), makeListOrder({ orderId: "ord-ok-a" }));
  await processListOrder(hydratedPage, deps, makeRunFlags(), makeListOrder({ orderId: "ord-ok-b" }));
  await emitOrderItemsCoverage(deps, coverage);

  assert.equal(findDetailGaps(protocolMessages).length, 0, "no degraded detail → no DETAIL_GAP");
  const cov = findDetailCoverage(protocolMessages);
  assert.ok(cov);
  assert.equal(cov.gap_keys, undefined, "a clean run carries no gap_keys either");
});

test("a policy-skipped run (PDPP_AMAZON_SKIP_DETAIL) emits optional skips and zero DETAIL_GAP", async () => {
  const coverage = newOrderItemsCoverage();
  const { deps, protocolMessages } = makeRecordingDeps({ orderItemsCoverage: coverage, skipDetail: true });
  await processListOrder(NEVER_CALLED_PAGE, deps, makeRunFlags(), makeListOrder({ orderId: "ord-skip-a" }));
  await processListOrder(NEVER_CALLED_PAGE, deps, makeRunFlags(), makeListOrder({ orderId: "ord-skip-b" }));
  await emitOrderItemsCoverage(deps, coverage);

  assert.equal(findDetailGaps(protocolMessages).length, 0, "a deliberate skip is not a degraded gap");
  const cov = findDetailCoverage(protocolMessages);
  assert.ok(cov);
  assert.deepEqual(cov.optional_skip_keys, ["ord-skip-a", "ord-skip-b"], "skips ride optional_skip_keys, not gap_keys");
  assert.equal(cov.gap_keys, undefined, "a skip-only run carries no gap_keys");
});

test("a run with zero considered orders emits neither DETAIL_COVERAGE nor DETAIL_GAP", async () => {
  const coverage = newOrderItemsCoverage();
  const { deps, protocolMessages } = makeRecordingDeps({ orderItemsCoverage: coverage });
  // No order processed: the accumulator is empty.
  await emitOrderItemsCoverage(deps, coverage);
  assert.equal(findDetailCoverage(protocolMessages), undefined, "no considered orders → no coverage");
  assert.equal(findDetailGaps(protocolMessages).length, 0, "and no gaps either");
});
