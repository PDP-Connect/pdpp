// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the H-E-B connector's collect()-layer helpers.
 *
 * These tests don't spin up a browser. They stub `Page`'s minimal surface
 * (goto/waitForSelector/content/url) and drive the real exported functions
 * from index.ts, using `makeRecordingEmit(validateRecord)` so every emitted
 * record runs through the connector's real zod schema.
 *
 * Written to close the review report's confirmed P1/P2 gaps that a fixture
 * or schema test alone cannot exercise:
 *   - malformed order dates still classify into detail coverage (#2)
 *   - old pending detail gaps are drained via the recovery API before any
 *     forward scan (#3)
 *   - a mid-run logout via a password-form response (not just a URL
 *     redirect) latches sessionRepairRequired (#4)
 *   - a transient detail-navigation failure retries before being reported
 *     exhausted (#5)
 *   - a pagination-boundary repeat is only processed once per run (#13)
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import type { Page } from "playwright";
import type { BrowserCollectContext } from "../../src/connector-runtime.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import {
  buildOrdersStateCursor,
  classifyEmptyListPage,
  classifyHebDetailFailure,
  type EmitDeps,
  emitOrderItemsCoverage,
  emitOrdersCoverage,
  fetchOrderDetail,
  HEB_HYDRATION_WAIT_MAX_MS,
  HEB_HYDRATION_WAIT_MIN_MS,
  MAX_LIST_PAGES as HEB_MAX_LIST_PAGES,
  HEB_REPAIR_RETRY_DELAY_MAX_MS,
  HEB_REPAIR_RETRY_DELAY_MIN_MS,
  hebAllowsInteractiveAuthRepair,
  newOrderItemsCoverage,
  newOrdersCoverage,
  type OrderItemsCoverage,
  type OrdersCoverage,
  priorOrdersEvidenceFromState,
  processListOrder,
  type RepairDeps,
  type RunFlags,
  reasonForDetailFailure,
  recordDetailOutcome,
  recoverPendingOrderItemDetailGaps,
  recoverPendingOrderItemDetailGapsBeforeForwardRun,
  resolveOrderDetail,
  runForwardScan,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { ListPageDiagnostics, ListPageOrder } from "./types.ts";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

type DetailGap = Extract<EmittedMessage, { type: "DETAIL_GAP" }>;
type DetailGapRecovered = Extract<EmittedMessage, { type: "DETAIL_GAP_RECOVERED" }>;
type DetailCoverage = Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }>;

function findDetailGaps(messages: EmittedMessage[]): DetailGap[] {
  return messages.filter((m): m is DetailGap => m.type === "DETAIL_GAP");
}

function findDetailGapRecovered(messages: EmittedMessage[]): DetailGapRecovered[] {
  return messages.filter((m): m is DetailGapRecovered => m.type === "DETAIL_GAP_RECOVERED");
}

function findDetailCoverage(messages: EmittedMessage[]): DetailCoverage | undefined {
  return messages.find((m): m is DetailCoverage => m.type === "DETAIL_COVERAGE");
}

interface RecordingDeps {
  deps: EmitDeps;
  emitted: ReturnType<typeof makeRecordingEmit>["emitted"];
  protocolMessages: EmittedMessage[];
}

function noopSendInteraction(): ReturnType<BrowserCollectContext["sendInteraction"]> {
  throw new Error("sendInteraction should not be called in this test");
}

const immediateWait = (): Promise<void> => Promise.resolve();

function makeRecordingDeps(overrides: Partial<EmitDeps> = {}): RecordingDeps {
  const harness = makeRecordingEmit(validateRecord);
  const deps: EmitDeps = {
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: "2026-07-14T12:00:00.000Z",
    orderItemsCoverage: undefined,
    ordersCoverage: undefined,
    ordersFingerprintCursor: undefined,
    progress: (): Promise<void> => Promise.resolve(),
    sendInteraction: noopSendInteraction,
    waitForHydration: immediateWait,
    wantsItems: true,
    wantsOrders: true,
    ...overrides,
  };
  return { deps, emitted: harness.emitted, protocolMessages: harness.protocolMessages };
}

function makeRunFlags(overrides: Partial<RunFlags> = {}): RunFlags {
  return {
    detailAttempts: 0,
    isManualRun: false,
    manualRepairAttempted: false,
    sessionRepairRequired: false,
    ...overrides,
  };
}

function makeListOrder(overrides: Partial<ListPageOrder> = {}): ListPageOrder {
  return {
    orderId: "HEB1000000001",
    orderDateRaw: "July 14, 2026",
    fulfillmentMethod: "curbside",
    fulfillmentLocation: "H-E-B plus! Austin Mueller",
    status: "Delivered",
    statusCode: null,
    storeName: null,
    timeslotStart: null,
    timeslotEnd: null,
    total: "$42.00",
    itemCount: 3,
    source: "dom",
    unfulfilledCount: null,
    ...overrides,
  };
}

const DETAIL_HTML = `<html><body><main><ul>
  <li data-qe-id="itemRow">
    <div><a tabindex="-1" aria-hidden="true" href="/product-detail/widget/500"><img alt="Widget"></a></div>
    <div>
      <a data-qe-id="itemRowDetailsName" href="/product-detail/widget/500">Widget</a>
      <span data-qe-id="checkoutItemPrice">$10.00</span>
      <span data-qe-id="orderItemQty">Qty: 1</span>
    </div>
  </li>
</ul></main></body></html>`;

const NO_DETAIL_HTML = "<html><body><main>no items here</main></body></html>";

const PASSWORD_FORM_HTML = `<html><body><main>
  <form><input type="password" name="password" /></form>
</main></body></html>`;

/** A minimal Page stub backing fetchOrderDetail/processListOrder: goto always
 *  resolves (or throws once per `throwsNTimes` to exercise the retry path),
 *  content()/url() return fixed values. Any other page access throws loudly. */
function makePageStub(opts: {
  content: string;
  goto?: (url: string) => void;
  throwsNTimes?: number;
  url?: string;
}): Page {
  let gotoCalls = 0;
  const url = opts.url ?? "https://www.heb.com/my-account/order-history/HEB1000000001";
  return new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (prop === "goto") {
          return (navUrl: string): Promise<null> => {
            gotoCalls += 1;
            opts.goto?.(navUrl);
            if (opts.throwsNTimes && gotoCalls <= opts.throwsNTimes) {
              return Promise.reject(new Error("net::ERR_CONNECTION_TIMED_OUT"));
            }
            return Promise.resolve(null);
          };
        }
        if (prop === "waitForSelector") {
          return (): Promise<null> => Promise.resolve(null);
        }
        if (prop === "content") {
          return (): Promise<string> => Promise.resolve(opts.content);
        }
        if (prop === "url") {
          return (): string => url;
        }
        throw new Error(`unexpected page.${String(prop)} in test stub`);
      },
    }
  ) as Page;
}

const NEVER_CALLED_PAGE = new Proxy(
  {},
  {
    get(): never {
      throw new Error("page must not be touched in this test");
    },
  }
) as Page;

const ORDERS_URL = "https://www.heb.com/my-account/your-orders";
const LIVE_ORDERS_HTML = '<html><body><main><div data-qe-id="orderResults"></div></main></body></html>';
const STILL_DEAD_HTML = '<html><body><main><form><input type="password"></form></main></body></html>';

/**
 * A Page stub that also supports the extra surface `probeHebSession`
 * (auto-login/heb.ts's `inspectAuthSurface` → `page.locator("form").count()`)
 * and `manualAction` (browser-handoff.ts, which degrades to a no-CDP-target
 * no-op when PDPP_RUN_ID/PDPP_REFERENCE_BASE_URL aren't set — true in a test
 * process — so it never actually touches the page beyond
 * `readManualActionPageMetadata`, which only calls `.url()`/`.title()`).
 * `htmlSequence` is consumed one entry per goto()+content() cycle so a test
 * can script "session still dead after repair" vs "session recovered".
 */
function makeSessionRepairPageStub(opts: { detailHtmlAfterRepair?: string; htmlSequence: string[] }): Page {
  const htmlSequence = [...opts.htmlSequence];
  let currentHtml = STILL_DEAD_HTML;
  let currentUrl = ORDERS_URL;
  return new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (prop === "goto") {
          return (navUrl: string): Promise<null> => {
            currentUrl = navUrl.startsWith("http") ? navUrl : ORDERS_URL;
            const next = htmlSequence.shift();
            if (next !== undefined) {
              currentHtml = next;
            } else if (navUrl.includes("order-history") && opts.detailHtmlAfterRepair) {
              currentHtml = opts.detailHtmlAfterRepair;
            }
            return Promise.resolve(null);
          };
        }
        if (prop === "waitForSelector" || prop === "waitForTimeout") {
          return (): Promise<null> => Promise.resolve(null);
        }
        if (prop === "content") {
          return (): Promise<string> => Promise.resolve(currentHtml);
        }
        if (prop === "url") {
          return (): string => currentUrl;
        }
        if (prop === "title") {
          return (): Promise<string> => Promise.resolve("");
        }
        if (prop === "locator") {
          return (): {
            count: () => Promise<number>;
          } => ({
            count: () => Promise.resolve(0),
          });
        }
        throw new Error(`unexpected page.${String(prop)} in session-repair test stub`);
      },
    }
  ) as Page;
}

// ─── #2: malformed order dates still classify into detail coverage ───────

test("processListOrder: a malformed order date records a 'gap' coverage outcome backed by DETAIL_GAP when order_items is in scope", async () => {
  const coverage = newOrderItemsCoverage();
  const { deps, emitted, protocolMessages } = makeRecordingDeps({ orderItemsCoverage: coverage });
  const listOrder = makeListOrder({ orderDateRaw: "not a real date" });

  await processListOrder(NEVER_CALLED_PAGE, deps, makeRunFlags(), listOrder);

  assert.deepEqual(coverage.required, ["HEB1000000001"], "the order must still join the required denominator");
  assert.deepEqual(coverage.gap, ["HEB1000000001"], "parse failure is an actionable gap");
  assert.deepEqual(coverage.hydrated, []);
  assert.equal(emitted.length, 0, "no order/item record can emit without a parsed order_date");
  assert.ok(
    protocolMessages.some((m) => m.type === "SKIP_RESULT" && m.reason === "unparseable_order_date"),
    "the SKIP_RESULT diagnostic at the order level fires"
  );
  const gaps = protocolMessages.filter((m) => m.type === "DETAIL_GAP");
  assert.equal(gaps.length, 1, "a DETAIL_GAP backs the coverage gap");
  assert.equal(gaps[0]?.stream, "order_items");
  assert.equal(gaps[0]?.last_error?.class, "transient_no_progress");
});

test("processListOrder: a malformed order date emits no DETAIL_GAP when order_items is out of scope (wantsItems: false)", async () => {
  const coverage = newOrderItemsCoverage();
  const { deps, protocolMessages } = makeRecordingDeps({
    orderItemsCoverage: coverage,
    wantsItems: false,
    wantsOrders: true,
  });
  const listOrder = makeListOrder({ orderDateRaw: "not a real date" });

  await processListOrder(NEVER_CALLED_PAGE, deps, makeRunFlags(), listOrder);

  assert.deepEqual(coverage.required, [], "orderItemsCoverage is not written when wantsItems: false");
  assert.deepEqual(coverage.gap, []);
  assert.deepEqual(coverage.hydrated, []);
  assert.ok(
    protocolMessages.some((m) => m.type === "SKIP_RESULT" && m.reason === "unparseable_order_date"),
    "the SKIP_RESULT diagnostic at the order level still fires"
  );
  const gaps = protocolMessages.filter((m) => m.type === "DETAIL_GAP");
  assert.equal(gaps.length, 0, "no DETAIL_GAP when order_items is out of scope");
});

test("emitOrderItemsCoverage: gap marks an actionable degradation (not optional skip)", async () => {
  const { deps, protocolMessages } = makeRecordingDeps();
  const coverage: OrderItemsCoverage = { required: ["a", "b"], hydrated: ["a"], gap: ["b"] };
  await emitOrderItemsCoverage(deps, coverage);

  const msg = findDetailCoverage(protocolMessages);
  assert.ok(msg);
  assert.deepEqual(msg.required_keys, ["a", "b"]);
  assert.deepEqual(msg.gap_keys, ["b"]);
  assert.equal(msg.considered, 2);
  assert.equal(msg.covered, 1, "only hydrated counts as covered");
});

// ─── orders list-stream coverage evidence ─────────────────────────────────
//
// The manifest declares `orders` coverage_strategy: checkpoint_window, but
// prior to this fix the connector never emitted DETAIL_COVERAGE for the
// `orders` stream itself — only for `order_items` (the detail child), the
// same gap class documented in design-notes/heb-connector-manifest-design-
// 2026-07-14.md as affecting heb (pre-redesign), doordash, and wholefoods.
// A run scoped to `orders` only (wantsItems: false — H-E-B usage is often
// genuinely light) left the orders list stream permanently unmeasured even
// though real orders were being collected.

test("processListOrder: a normal order counts as considered+covered in ordersCoverage", async () => {
  const ordersCoverage = newOrdersCoverage();
  const { deps, emitted } = makeRecordingDeps({ ordersCoverage });
  const listOrder = makeListOrder({ orderId: "HEB1000000001" });

  await processListOrder(makePageStub({ content: NO_DETAIL_HTML }), deps, makeRunFlags(), listOrder);

  assert.deepEqual(ordersCoverage.considered, ["HEB1000000001"]);
  assert.deepEqual(ordersCoverage.covered, ["HEB1000000001"]);
  assert.deepEqual(ordersCoverage.dateDropped, []);
  assert.ok(
    emitted.some((r) => r.stream === "orders"),
    "the orders record itself still emits"
  );
});

test("processListOrder: records orders coverage even when order_items is out of scope (wantsItems: false)", async () => {
  const ordersCoverage = newOrdersCoverage();
  const { deps, emitted } = makeRecordingDeps({ ordersCoverage, wantsItems: false, wantsOrders: true });
  const listOrder = makeListOrder({ orderId: "HEB1000000001" });

  await processListOrder(NEVER_CALLED_PAGE, deps, makeRunFlags(), listOrder);

  assert.deepEqual(
    ordersCoverage.considered,
    ["HEB1000000001"],
    "orders coverage does not depend on order_items scope"
  );
  assert.deepEqual(ordersCoverage.covered, ["HEB1000000001"]);
  assert.ok(emitted.some((r) => r.stream === "orders"));
  assert.ok(
    !emitted.some((r) => r.stream === "order_items"),
    "order_items stays out of scope and never touches the browser"
  );
});

test("processListOrder: nothing recorded in ordersCoverage when orders is out of scope (wantsOrders: false)", async () => {
  const ordersCoverage = newOrdersCoverage();
  const { deps } = makeRecordingDeps({ ordersCoverage, wantsOrders: false, wantsItems: true });
  const listOrder = makeListOrder({ orderId: "HEB1000000001" });

  await processListOrder(makePageStub({ content: NO_DETAIL_HTML }), deps, makeRunFlags(), listOrder);

  assert.deepEqual(ordersCoverage.considered, [], "orders out of scope means no orders-coverage accounting at all");
  assert.deepEqual(ordersCoverage.covered, []);
});

test("processListOrder: a malformed order date is considered but not covered in ordersCoverage", async () => {
  const ordersCoverage = newOrdersCoverage();
  const { deps } = makeRecordingDeps({ ordersCoverage });
  const listOrder = makeListOrder({ orderDateRaw: "not a real date" });

  await processListOrder(NEVER_CALLED_PAGE, deps, makeRunFlags(), listOrder);

  assert.deepEqual(ordersCoverage.considered, ["HEB1000000001"], "the list scan still enumerated this order");
  assert.deepEqual(ordersCoverage.covered, [], "no accounting decision was made for its orders record");
  assert.deepEqual(ordersCoverage.dateDropped, ["HEB1000000001"]);
});

test("emitOrdersCoverage: reports considered/covered self-referentially on the orders stream", async () => {
  const { deps, protocolMessages } = makeRecordingDeps();
  const coverage: OrdersCoverage = { considered: ["a", "b"], covered: ["a", "b"], dateDropped: [] };
  await emitOrdersCoverage(deps, coverage);

  const msg = findDetailCoverage(protocolMessages);
  assert.ok(msg, "expected a DETAIL_COVERAGE message");
  assert.equal(msg.stream, "orders", "orders reports on itself — no separate detail-hydration phase");
  assert.equal(msg.state_stream, "orders");
  assert.deepEqual(msg.required_keys, []);
  assert.deepEqual(msg.hydrated_keys, []);
  assert.equal(msg.considered, 2);
  assert.equal(msg.covered, 2);
});

test("emitOrdersCoverage: a steady-state run with zero considered orders still emits considered 0 / covered 0", async () => {
  // H-E-B usage is genuinely light (the residual-evidence audit found live
  // accounts with as few as 2 orders); a run with nothing new to consider
  // must still read as measured, not unknown.
  const { deps, protocolMessages } = makeRecordingDeps();
  await emitOrdersCoverage(deps, newOrdersCoverage());

  const msg = findDetailCoverage(protocolMessages);
  assert.ok(msg, "a zero-considered run still emits DETAIL_COVERAGE");
  assert.equal(msg.stream, "orders");
  assert.equal(msg.considered, 0);
  assert.equal(msg.covered, 0);
});

test("collect-path regression guard: orders scoped alone (order_items out of scope) still emits an orders DETAIL_COVERAGE", async () => {
  // Regression guard for the real production gap: a run requesting only
  // `orders` (no order_items) must still measure and report orders coverage.
  // Drives processListOrder directly (the exported entry point collect()
  // calls per order) followed by emitOrdersCoverage, matching the exact
  // sequence collect() runs.
  const ordersCoverage = newOrdersCoverage();
  const { deps, protocolMessages } = makeRecordingDeps({ ordersCoverage, wantsItems: false, wantsOrders: true });

  await processListOrder(NEVER_CALLED_PAGE, deps, makeRunFlags(), makeListOrder({ orderId: "HEB1000000001" }));
  await processListOrder(NEVER_CALLED_PAGE, deps, makeRunFlags(), makeListOrder({ orderId: "HEB1000000002" }));
  await emitOrdersCoverage(deps, ordersCoverage);

  const coverageMessages = protocolMessages.filter((m): m is DetailCoverage => m.type === "DETAIL_COVERAGE");
  const ordersMsg = coverageMessages.find((m) => m.stream === "orders");
  assert.ok(ordersMsg, "orders-scoped-only run must still emit an orders DETAIL_COVERAGE");
  assert.equal(ordersMsg?.considered, 2);
  assert.equal(ordersMsg?.covered, 2);
  assert.ok(
    !coverageMessages.some((m) => m.stream === "order_items"),
    "order_items coverage is out of scope and must not appear"
  );
});

// ─── #4: mid-run logout via password-form response (not just URL) ────────

test("fetchOrderDetail: a password-form response at a non-sign-in URL classifies session_repair_required", async () => {
  const page = makePageStub({ content: PASSWORD_FORM_HTML });
  const result = await fetchOrderDetail(page, "HEB1000000001", { waitForHydration: immediateWait });
  assert.equal(result.status, "failed");
  assert.equal(result.failureKind, "session_repair_required");
});

test("processListOrder: a password-form detail response latches sessionRepairRequired and prevents a second detail navigation", async () => {
  const coverage = newOrderItemsCoverage();
  const { deps, protocolMessages } = makeRecordingDeps({ orderItemsCoverage: coverage });
  const flags = makeRunFlags();
  const page = makePageStub({ content: PASSWORD_FORM_HTML });

  await processListOrder(page, deps, flags, makeListOrder({ orderId: "HEB1000000001" }));
  assert.equal(flags.sessionRepairRequired, true, "a password-form response latches the run into session repair");

  // The second order must NOT touch the browser at all — NEVER_CALLED_PAGE
  // throws on any access, proving the latch prevents a second navigation.
  await processListOrder(NEVER_CALLED_PAGE, deps, flags, makeListOrder({ orderId: "HEB1000000002" }));

  const gaps = findDetailGaps(protocolMessages);
  assert.equal(gaps.length, 2, "both orders still carry a durable pending gap");
  assert.deepEqual(
    gaps.map((g) => g.last_error?.class),
    ["owner_repair_required", "owner_repair_required"]
  );
});

// ─── detail fetch touches only the order-detail page, once ────────────────
// `makePageStub` only implements goto/waitForSelector/content/url and throws
// on any other property access, so a regression that attached a response
// observer (page.on/page.off) or navigated anywhere beyond the one
// order-detail URL would fail these tests immediately.

test("fetchOrderDetail: a normal detail fetch navigates to exactly one URL and never touches page.on/page.off", async () => {
  const gotoUrls: string[] = [];
  const page = makePageStub({ content: DETAIL_HTML, goto: (url) => gotoUrls.push(url) });
  const result = await fetchOrderDetail(page, "HEB1000000001", { waitForHydration: immediateWait });
  assert.equal(result.status, "hydrated");
  assert.deepEqual(
    gotoUrls,
    ["https://www.heb.com/my-account/order-history/HEB1000000001"],
    "exactly one navigation — no separate product-page navigation"
  );
});

test("processListOrder: a full order+item run never calls page.on/page.off across list, detail, and coverage handling", async () => {
  const coverage = newOrderItemsCoverage();
  const { deps } = makeRecordingDeps({ orderItemsCoverage: coverage });
  const flags = makeRunFlags();
  const page = makePageStub({ content: DETAIL_HTML });

  await processListOrder(page, deps, flags, makeListOrder({ orderId: "HEB1000000001" }));

  assert.equal(coverage.hydrated.length, 1);
  assert.equal(coverage.gap.length, 0);
});

// ─── #5: bounded retry before navigation_retry_exhausted ──────────────────

test("fetchOrderDetail: a single transient navigation failure retries and then succeeds (not immediately exhausted)", async () => {
  const page = makePageStub({ content: DETAIL_HTML, throwsNTimes: 1 });
  const result = await fetchOrderDetail(page, "HEB1000000001", { waitForHydration: immediateWait });
  assert.equal(result.status, "hydrated", "one transient failure must not be reported as exhausted");
});

test("fetchOrderDetail: navigation_retry_exhausted is only reported once the retry budget is actually exhausted", async () => {
  // throwsNTimes is larger than the retry budget (retries: 2 => 3 total
  // attempts), so every attempt fails and the budget is genuinely exhausted.
  const page = makePageStub({ content: DETAIL_HTML, throwsNTimes: 10 });
  const result = await fetchOrderDetail(page, "HEB1000000001", { waitForHydration: immediateWait });
  assert.equal(result.status, "failed");
  assert.equal(result.failureKind, "navigation_retry_exhausted");
});

test("fetchOrderDetail: a non-retryable navigation error (e.g. page closed) is not mislabeled navigation_retry_exhausted and makes exactly one attempt", async () => {
  let gotoCalls = 0;
  const page = new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (prop === "goto") {
          return (): Promise<null> => {
            gotoCalls += 1;
            return Promise.reject(new Error("page closed"));
          };
        }
        if (prop === "waitForSelector") {
          return (): Promise<null> => Promise.resolve(null);
        }
        if (prop === "content") {
          return (): Promise<string> => Promise.resolve(DETAIL_HTML);
        }
        if (prop === "url") {
          return (): string => "https://www.heb.com/my-account/order-history/HEB1000000001";
        }
        throw new Error(`unexpected page.${String(prop)} in non-retryable-error test stub`);
      },
    }
  ) as Page;

  const result = await fetchOrderDetail(page, "HEB1000000001", { waitForHydration: immediateWait });

  assert.equal(gotoCalls, 1, "a non-retryable error must not consume the retry budget");
  assert.equal(result.status, "failed");
  assert.notEqual(
    result.failureKind,
    "navigation_retry_exhausted",
    "a non-retryable failure after one attempt is not a retry-exhaustion outcome"
  );
  assert.equal(result.failureKind, "navigation_failed_non_retryable");
});

test("classifyHebDetailFailure: a non-retryable navigation failure classifies as connector_defect, not a retryable class", () => {
  assert.equal(classifyHebDetailFailure("navigation_failed_non_retryable"), "connector_defect");
});

// ─── design.md Decision 4: owner-started manual repair vs unattended latch ─

test("hebAllowsInteractiveAuthRepair: true when PDPP_RUN_TRIGGER_KIND is 'manual'", () => {
  assert.equal(hebAllowsInteractiveAuthRepair({ PDPP_RUN_TRIGGER_KIND: "manual" }), true);
});

test("hebAllowsInteractiveAuthRepair: false for a scheduled/retry/webhook trigger kind", () => {
  assert.equal(hebAllowsInteractiveAuthRepair({ PDPP_RUN_TRIGGER_KIND: "scheduled" }), false);
  assert.equal(hebAllowsInteractiveAuthRepair({ PDPP_RUN_TRIGGER_KIND: "retry" }), false);
  assert.equal(hebAllowsInteractiveAuthRepair({ PDPP_RUN_TRIGGER_KIND: "webhook" }), false);
});

test("hebAllowsInteractiveAuthRepair: defaults to true when the trigger-kind metadata is absent", () => {
  assert.equal(hebAllowsInteractiveAuthRepair({}), true);
});

function fakeSendInteraction(
  response: Partial<import("../../src/connector-runtime.ts").InteractionResponse> = {}
): BrowserCollectContext["sendInteraction"] {
  return () =>
    Promise.resolve({
      request_id: "test-request",
      status: "success",
      type: "INTERACTION_RESPONSE",
      ...response,
    });
}

function immediateRepairDeps(
  sendInteraction: BrowserCollectContext["sendInteraction"] = fakeSendInteraction()
): RepairDeps {
  return {
    sendInteraction,
    waitForHydration: immediateWait,
    waitForRepairRetry: immediateWait,
  };
}

test("HEB post-repair delay defaults remain the polite production range", () => {
  assert.equal(HEB_HYDRATION_WAIT_MIN_MS, 1500);
  assert.equal(HEB_HYDRATION_WAIT_MAX_MS, 2500);
  assert.equal(HEB_REPAIR_RETRY_DELAY_MIN_MS, 1500);
  assert.equal(HEB_REPAIR_RETRY_DELAY_MAX_MS, 2500);
});

test("resolveOrderDetail: unattended run — sessionRepairRequired latches immediately with zero interaction, no repair spent", async () => {
  const flags: RunFlags = {
    detailAttempts: 0,
    isManualRun: false,
    manualRepairAttempted: false,
    sessionRepairRequired: true,
  };
  const repairDeps = immediateRepairDeps();
  const result = await resolveOrderDetail(NEVER_CALLED_PAGE, flags, "HEB1000000001", repairDeps);
  assert.equal(result.status, "deferred");
  assert.equal(result.failureKind, "session_repair_required");
  assert.equal(flags.manualRepairAttempted, false, "an unattended run must never spend the repair attempt");
  assert.equal(flags.sessionRepairRequired, true, "the latch stays set for the rest of the run");
});

test("resolveOrderDetail: unattended run never calls manualAction even when repairDeps are supplied (page is never touched)", async () => {
  // NEVER_CALLED_PAGE throws on any property access — if the unattended path
  // accidentally called manualAction/probeHebSession, this test would fail
  // with a page-touched error instead of the expected deferred result.
  const flags: RunFlags = {
    detailAttempts: 0,
    isManualRun: false,
    manualRepairAttempted: false,
    sessionRepairRequired: true,
  };
  const repairDeps = immediateRepairDeps();
  const result = await resolveOrderDetail(NEVER_CALLED_PAGE, flags, "HEB1000000001", repairDeps);
  assert.equal(result.status, "deferred");
});

test("resolveOrderDetail: owner-started manual run — successful repair retries the affected detail once and succeeds", async () => {
  const flags: RunFlags = {
    detailAttempts: 0,
    isManualRun: true,
    manualRepairAttempted: false,
    sessionRepairRequired: true,
  };
  const page = makeSessionRepairPageStub({
    htmlSequence: [LIVE_ORDERS_HTML],
    detailHtmlAfterRepair: DETAIL_HTML,
  });
  let repairRetryWaits = 0;
  const repairDeps = immediateRepairDeps();
  repairDeps.waitForRepairRetry = () => {
    repairRetryWaits += 1;
    return Promise.resolve();
  };
  const result = await resolveOrderDetail(page, flags, "HEB1000000001", repairDeps);
  assert.equal(flags.manualRepairAttempted, true, "the one shared attempt is now spent");
  assert.equal(result.status, "hydrated", "the retried detail fetch must succeed after a recovered session");
  assert.equal(flags.sessionRepairRequired, false, "a successful repair+retry clears the latch");
  assert.equal(repairRetryWaits, 1, "the repair retry waits exactly once after a recovered session");
});

test("resolveOrderDetail: owner-started manual run — manualAction itself fails (sendInteraction errors) latches and defers", async () => {
  const flags: RunFlags = {
    detailAttempts: 0,
    isManualRun: true,
    manualRepairAttempted: false,
    sessionRepairRequired: true,
  };
  const failingSendInteraction: BrowserCollectContext["sendInteraction"] = () =>
    Promise.reject(new Error("owner cancelled"));
  const result = await resolveOrderDetail(NEVER_CALLED_PAGE, flags, "HEB1000000001", {
    sendInteraction: failingSendInteraction,
  });
  assert.equal(flags.manualRepairAttempted, true, "the attempt is consumed even though it failed");
  assert.equal(result.status, "deferred");
  assert.equal(result.failureKind, "session_repair_required");
  assert.equal(flags.sessionRepairRequired, true, "latches after a failed repair, same as the unattended path");
});

test("resolveOrderDetail: owner-started manual run — re-probe still finds a dead session (failed re-probe) latches and defers", async () => {
  const flags: RunFlags = {
    detailAttempts: 0,
    isManualRun: true,
    manualRepairAttempted: false,
    sessionRepairRequired: true,
  };
  const page = makeSessionRepairPageStub({ htmlSequence: [STILL_DEAD_HTML] });
  const repairDeps = immediateRepairDeps();
  const result = await resolveOrderDetail(page, flags, "HEB1000000001", repairDeps);
  assert.equal(flags.manualRepairAttempted, true);
  assert.equal(result.status, "deferred");
  assert.equal(result.failureKind, "session_repair_required");
  assert.equal(flags.sessionRepairRequired, true);
});

test("resolveOrderDetail: owner-started manual run — retry of the affected detail fails after a successful re-probe latches and defers", async () => {
  const flags: RunFlags = {
    detailAttempts: 0,
    isManualRun: true,
    manualRepairAttempted: false,
    sessionRepairRequired: true,
  };
  // Re-probe (goto ORDERS_URL) sees a live session, but the SUBSEQUENT detail
  // retry goto() lands back on a signed-out/challenge surface.
  const page = makeSessionRepairPageStub({
    htmlSequence: [LIVE_ORDERS_HTML, STILL_DEAD_HTML],
  });
  const repairDeps = immediateRepairDeps();
  const result = await resolveOrderDetail(page, flags, "HEB1000000001", repairDeps);
  assert.equal(flags.manualRepairAttempted, true);
  assert.equal(result.status, "failed");
  assert.equal(result.failureKind, "session_repair_required");
  assert.equal(
    flags.sessionRepairRequired,
    true,
    "a second challenge right after repair re-latches for the rest of the run"
  );
});

test("resolveOrderDetail: owner-started manual run — the one shared attempt is spent only once across repeated failures", async () => {
  const flags: RunFlags = {
    detailAttempts: 0,
    isManualRun: true,
    manualRepairAttempted: false,
    sessionRepairRequired: true,
  };
  const page = makeSessionRepairPageStub({ htmlSequence: [STILL_DEAD_HTML] });
  const repairDeps = immediateRepairDeps();

  const first = await resolveOrderDetail(page, flags, "HEB1000000001", repairDeps);
  assert.equal(first.status, "deferred");
  assert.equal(flags.manualRepairAttempted, true);

  // A second failure in the same run must NOT spend a second attempt — it
  // must behave exactly like the unattended path from here on (immediate
  // defer, page never touched again).
  const second = await resolveOrderDetail(NEVER_CALLED_PAGE, flags, "HEB1000000002", repairDeps);
  assert.equal(second.status, "deferred");
  assert.equal(second.failureKind, "session_repair_required");
});

test("resolveOrderDetail: without repairDeps, an owner-started manual run still latches and defers (repairDeps is optional)", async () => {
  const flags: RunFlags = {
    detailAttempts: 0,
    isManualRun: true,
    manualRepairAttempted: false,
    sessionRepairRequired: true,
  };
  const result = await resolveOrderDetail(NEVER_CALLED_PAGE, flags, "HEB1000000001");
  assert.equal(result.status, "deferred");
  assert.equal(flags.manualRepairAttempted, false, "no repairDeps means no attempt can be spent");
});

test("resolveOrderDetail: no owner-credential persistence — manualAction's message never references a stored password", async () => {
  const flags: RunFlags = {
    detailAttempts: 0,
    isManualRun: true,
    manualRepairAttempted: false,
    sessionRepairRequired: true,
  };
  const page = makeSessionRepairPageStub({ htmlSequence: [LIVE_ORDERS_HTML], detailHtmlAfterRepair: DETAIL_HTML });
  let observedMessage: string | undefined;
  const repairDeps: RepairDeps = {
    sendInteraction: (req) => {
      observedMessage = req.message;
      return Promise.resolve({
        request_id: req.request_id ?? "test-request",
        status: "success",
        type: "INTERACTION_RESPONSE",
      });
    },
    waitForHydration: immediateWait,
    waitForRepairRetry: immediateWait,
  };
  await resolveOrderDetail(page, flags, "HEB1000000001", repairDeps);
  assert.ok(observedMessage);
  assert.doesNotMatch(observedMessage ?? "", /password/i);
});

// ─── #13: cross-page dedup (pagination-boundary repeat) ───────────────────

test("runForwardScan: an order id repeated across two list pages is only processed once", async () => {
  const { deps, emitted } = makeRecordingDeps({ wantsItems: false });
  // maxPage advertised as 2 (matching reality: only pages 1-2 have orders) so
  // the walk completes honestly at page 2 without ever requesting page 3 —
  // under the maxPage-bounded completion contract, an empty page 3 would
  // otherwise be an error (empty at-or-before an advertised maxPage), not a
  // terminal signal; this test's purpose is dedup, not empty-page handling.
  const paginationNav = `<nav aria-label="Pagination"><a href="?page=1">1</a><a href="?page=2">2</a></nav>`;
  const pages: Record<number, string> = {
    1: `<html><body><main>
      <a href="/my-account/order-history/HEB1000000002">July 14, 2026 $10.00, 1 items</a>
      <a href="/my-account/order-history/HEB1000000001">July 13, 2026 $20.00, 2 items</a>
      ${paginationNav}
    </main></body></html>`,
    2: `<html><body><main>
      <a href="/my-account/order-history/HEB1000000001">July 13, 2026 $20.00, 2 items</a>
      <a href="/my-account/order-history/HEB1000000000">July 12, 2026 $30.00, 3 items</a>
      ${paginationNav}
    </main></body></html>`,
  };
  let currentPage = 1;
  const page = new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (prop === "goto") {
          return (url: string): Promise<null> => {
            const m = /page=(\d+)/.exec(url);
            currentPage = m?.[1] ? Number(m[1]) : 1;
            return Promise.resolve(null);
          };
        }
        if (prop === "waitForSelector") {
          return (): Promise<null> => Promise.resolve(null);
        }
        if (prop === "content") {
          return (): Promise<string> => Promise.resolve(pages[currentPage] ?? "");
        }
        if (prop === "url") {
          return (): string => `https://www.heb.com/my-account/your-orders?page=${currentPage}`;
        }
        throw new Error(`unexpected page.${String(prop)} in dedup test stub`);
      },
    }
  ) as Page;

  await runForwardScan(page, deps, makeRunFlags(), null);

  const orderIds = emitted.filter((r) => r.stream === "orders").map((r) => r.data.id);
  assert.deepEqual(
    orderIds.sort(),
    ["HEB1000000000", "HEB1000000001", "HEB1000000002"],
    "each distinct order id emits exactly once even though HEB1000000001 appears on both pages"
  );
});

test("runForwardScan: item-enriched scan (wantsItems: true) still fetches page 2 and dedupes the boundary repeat", async () => {
  // Regression test for review2's P1: pagination must be read from the LIST
  // page's own HTML, captured before any order-detail navigation. A stub
  // that overwrites page.content() with detail HTML on every order-detail
  // goto() reproduces the bug directly — if pagination is (re-)read from
  // page.content() after the per-order loop runs, it sees detail HTML (no
  // pagination nav), resolveMaxPage resolves "absent" (fails closed) instead
  // of the real maxPage, and the scan would incorrectly stop or error after
  // page 1.
  const { deps, emitted } = makeRecordingDeps({ wantsItems: true, wantsOrders: true });
  // maxPage advertised as 2 — see the sibling dedup test's comment above for
  // why an empty page 3 is no longer a valid terminal signal under the
  // maxPage-bounded completion contract.
  const paginationNav = `<nav aria-label="Pagination"><a href="?page=1">1</a><a href="?page=2">2</a></nav>`;
  const listPages: Record<number, string> = {
    1: `<html><body><main>
      <a href="/my-account/order-history/HEB1000000002">July 14, 2026 $10.00, 1 items</a>
      <a href="/my-account/order-history/HEB1000000001">July 13, 2026 $20.00, 2 items</a>
      ${paginationNav}
    </main></body></html>`,
    2: `<html><body><main>
      <a href="/my-account/order-history/HEB1000000001">July 13, 2026 $20.00, 2 items</a>
      <a href="/my-account/order-history/HEB1000000000">July 12, 2026 $30.00, 3 items</a>
      ${paginationNav}
    </main></body></html>`,
  };
  let lastContent = "";
  const page = new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (prop === "goto") {
          return (url: string): Promise<null> => {
            const listMatch = /your-orders\?page=(\d+)/.exec(url);
            if (listMatch?.[1]) {
              lastContent = listPages[Number(listMatch[1])] ?? "";
              return Promise.resolve(null);
            }
            // Any order-detail navigation overwrites the shared page's
            // content with detail HTML — exactly what a real browser does,
            // and what silently truncated the buggy pre-fix scan.
            lastContent = DETAIL_HTML;
            return Promise.resolve(null);
          };
        }
        if (prop === "waitForSelector") {
          return (): Promise<null> => Promise.resolve(null);
        }
        if (prop === "content") {
          return (): Promise<string> => Promise.resolve(lastContent);
        }
        if (prop === "url") {
          return (): string => "https://www.heb.com/my-account/order-history/current";
        }
        throw new Error(`unexpected page.${String(prop)} in item-enriched pagination test stub`);
      },
    }
  ) as Page;

  await runForwardScan(page, deps, makeRunFlags(), null);

  const orderIds = emitted.filter((r) => r.stream === "orders").map((r) => r.data.id);
  assert.deepEqual(
    orderIds.sort(),
    ["HEB1000000000", "HEB1000000001", "HEB1000000002"],
    "page 2 must be fetched in the item-enriched journey, and the boundary-repeated order emits exactly once"
  );
  const itemOrderIds = emitted.filter((r) => r.stream === "order_items").map((r) => r.data.order_id);
  assert.deepEqual(
    itemOrderIds.sort(),
    ["HEB1000000000", "HEB1000000001", "HEB1000000002"],
    "each distinct order's items are hydrated exactly once, including the boundary-repeated order"
  );
});

// ─── review3 P1: a failed list-page goto() must not look like terminal exhaustion ──

test("runForwardScan: page 2's goto() rejecting must not be classified as terminal exhaustion (false-healthy coverage)", async () => {
  // Regression test for review3's P1: loadListPage() used to swallow every
  // goto() error with `.catch(() => undefined)`. If page 2's navigation
  // actually fails (page closed, ERR_ABORTED, timeout), the shared page keeps
  // whatever HTML it last had. Here that's page 1's list HTML (0 order cards
  // once page 1's cards are already consumed conceptually — we simulate by
  // leaving stale, cardless HTML in place), so extraction finds 0 orders and
  // the old code path would ask classifyEmptyListPage(pageNum=2), which
  // returns terminal purely because pageNum > 1 — a false "end of history".
  const { deps } = makeRecordingDeps({ wantsItems: false });
  const paginationNav = `<nav aria-label="Pagination"><a href="?page=1">1</a><a href="?page=2">2</a></nav>`;
  const page1Html = `<html><body><main>
    <a href="/my-account/order-history/HEB1000000001">July 13, 2026 $20.00, 2 items</a>
    ${paginationNav}
  </main></body></html>`;
  // What the shared page is left showing after page 2's goto() rejects:
  // stale content with no order cards and no "order" class markers, which is
  // exactly what classifyEmptyListPage's terminal branch would accept.
  const staleAfterFailedNav = `<html><body><h3>Order History</h3><nav aria-label="breadcrumb"></nav></body></html>`;
  let lastContent = "";
  const page = new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (prop === "goto") {
          return (url: string): Promise<null> => {
            const m = /your-orders\?page=(\d+)/.exec(url);
            const pageNum = m?.[1] ? Number(m[1]) : 1;
            if (pageNum === 1) {
              lastContent = page1Html;
              return Promise.resolve(null);
            }
            // Page 2's navigation fails; the shared page is left on stale,
            // cardless HTML — never updated to reflect a real page 2.
            lastContent = staleAfterFailedNav;
            return Promise.reject(new Error("page closed"));
          };
        }
        if (prop === "waitForSelector") {
          return (): Promise<null> => Promise.resolve(null);
        }
        if (prop === "content") {
          return (): Promise<string> => Promise.resolve(lastContent);
        }
        if (prop === "url") {
          return (): string => "https://www.heb.com/my-account/your-orders?page=2";
        }
        throw new Error(`unexpected page.${String(prop)} in failed-nav test stub`);
      },
    }
  ) as Page;

  await assert.rejects(
    () => runForwardScan(page, deps, makeRunFlags(), null),
    /heb_empty_list_page_navigation_failed/,
    "a failed list-page goto() followed by zero orders must surface an error, not a normal (false-healthy) return"
  );
});

test("runForwardScan: page 2's failed navigation cannot parse stale order cards or emit progress", async () => {
  const { deps, emitted, protocolMessages } = makeRecordingDeps({ wantsItems: false });
  const paginationNav = `<nav aria-label="Pagination"><a href="?page=1">1</a><a href="?page=2">2</a></nav>`;
  const page1Html = `<html><body><main>
    <a href="/my-account/order-history/HEB1000000001">July 13, 2026 $20.00, 2 items</a>
    ${paginationNav}
  </main></body></html>`;
  const staleCardHtml = `<html><body><main>
    <a href="/my-account/order-history/HEB1000000002">July 12, 2026 $21.00, 1 item</a>
    ${paginationNav}
  </main></body></html>`;
  let lastContent = "";
  const page = new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (prop === "goto") {
          return (url: string): Promise<null> => {
            const pageNum = Number(/your-orders\?page=(\d+)/.exec(url)?.[1] ?? 1);
            if (pageNum === 1) {
              lastContent = page1Html;
              return Promise.resolve(null);
            }
            lastContent = staleCardHtml;
            return Promise.reject(new Error("private provider path and stale page"));
          };
        }
        if (prop === "waitForSelector") {
          return (): Promise<null> => Promise.resolve(null);
        }
        if (prop === "content") {
          return (): Promise<string> => Promise.resolve(lastContent);
        }
        if (prop === "url") {
          return (): string => "https://www.heb.com/my-account/your-orders?page=2";
        }
        throw new Error(`unexpected page.${String(prop)} in stale-card test stub`);
      },
    }
  ) as Page;

  await assert.rejects(() => runForwardScan(page, deps, makeRunFlags(), null), /heb_empty_list_page_navigation_failed/);

  assert.deepEqual(
    emitted.filter((record) => record.stream === "orders").map((record) => record.data.id),
    ["HEB1000000001"],
    "stale page cards must not enter the current run"
  );
  const skip = protocolMessages.find((message) => message.type === "SKIP_RESULT");
  assert.ok(skip);
  assert.equal(skip?.reason, "list_page_navigation_failed");
  assert.equal(
    protocolMessages.some((message) => message.type === "STATE" || message.type === "DETAIL_COVERAGE"),
    false,
    "failed navigation must not advance durable progress or coverage"
  );
  assert.doesNotMatch(JSON.stringify(protocolMessages), /private provider/);
});

test("runForwardScan: a falsy goto rejection cannot parse stale page content", async () => {
  const { deps, emitted, protocolMessages } = makeRecordingDeps({ wantsItems: false });
  const pageHtml = `<html><body><main>
    <a href="/my-account/order-history/HEB1000000001">July 13, 2026 $20.00, 2 items</a>
    <nav aria-label="Pagination"><a href="?page=1">1</a><a href="?page=2">2</a></nav>
  </main></body></html>`;
  let navigations = 0;
  const page = Object.assign({} as Page, {
    goto: (): Promise<null> => {
      navigations += 1;
      return navigations === 1 ? Promise.resolve(null) : Promise.reject(undefined);
    },
    waitForSelector: (): Promise<null> => Promise.resolve(null),
    content: (): Promise<string> => Promise.resolve(pageHtml),
    url: (): string => "https://www.heb.com/my-account/your-orders?page=2",
  });

  await assert.rejects(() => runForwardScan(page, deps, makeRunFlags(), null), /heb_empty_list_page_navigation_failed/);
  assert.deepEqual(
    emitted.filter((record) => record.stream === "orders").map((record) => record.data.id),
    ["HEB1000000001"],
    "a falsy rejected navigation must not re-ingest the prior page"
  );
  assert.equal(
    protocolMessages.some((message) => message.type === "STATE"),
    false
  );
  assert.deepEqual(protocolMessages.find((message) => message.type === "SKIP_RESULT")?.diagnostics, {
    error_class: "unknown",
  });
});

test("runForwardScan: a genuine single-page result (maxPage: 1, affirmatively asserted) completes without requesting page 2", async () => {
  // design.md Decision 3 / Stop Condition #3: an empty page 2 is no longer a
  // possible terminal signal when the source's own pagination metadata
  // advertised a higher maxPage (that combination is now an ERROR — see the
  // "empty page before maxPage" test below). A genuine one-page result is
  // instead proven by page 1's own metadata affirmatively asserting
  // maxPage: 1 (here, a nav with exactly one page=1 link and no higher
  // link) — the walk completes after page 1 and never requests page 2 at all.
  const { deps, emitted } = makeRecordingDeps({ wantsItems: false });
  const singlePageNav = `<nav aria-label="Pagination"><a href="?page=1">1</a></nav>`;
  const page1Html = `<html><body><main>
      <a href="/my-account/order-history/HEB1000000001">July 13, 2026 $20.00, 2 items</a>
      ${singlePageNav}
    </main></body></html>`;
  let gotoCount = 0;
  const page = new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (prop === "goto") {
          return (): Promise<null> => {
            gotoCount += 1;
            return Promise.resolve(null);
          };
        }
        if (prop === "waitForSelector") {
          return (): Promise<null> => Promise.resolve(null);
        }
        if (prop === "content") {
          return (): Promise<string> => Promise.resolve(page1Html);
        }
        if (prop === "url") {
          return (): string => "https://www.heb.com/my-account/your-orders?page=1";
        }
        throw new Error(`unexpected page.${String(prop)} in genuine-single-page test stub`);
      },
    }
  ) as Page;

  const { newestOrderDate } = await runForwardScan(page, deps, makeRunFlags(), null);

  assert.equal(gotoCount, 1, "a genuine single-page result must never request page 2");
  assert.equal(newestOrderDate, "2026-07-13", "page 1's order must still be processed normally");
  const orderIds = emitted.filter((r) => r.stream === "orders").map((r) => r.data.id);
  assert.deepEqual(orderIds, ["HEB1000000001"]);
});

test("runForwardScan: an empty page before the advertised maxPage fails closed (throws), never silently terminal", async () => {
  // The direct replacement for the old (now-rejected) "empty page N>1 is
  // terminal" behavior: page 1 advertises maxPage: 2, but page 2 comes back
  // with zero order cards — this is now an error (Stop Condition #3), not a
  // possible end-of-history signal, because the source itself claimed a
  // second page of orders exists.
  const { deps } = makeRecordingDeps({ wantsItems: false });
  const paginationNav = `<nav aria-label="Pagination"><a href="?page=1">1</a><a href="?page=2">2</a></nav>`;
  const pages: Record<number, string> = {
    1: `<html><body><main>
      <a href="/my-account/order-history/HEB1000000001">July 13, 2026 $20.00, 2 items</a>
      ${paginationNav}
    </main></body></html>`,
    2: `<html><body><h3>Order History</h3><nav aria-label="breadcrumb"></nav><div data-testid="empty"></div></body></html>`,
  };
  let currentPage = 1;
  const page = new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (prop === "goto") {
          return (url: string): Promise<null> => {
            const m = /page=(\d+)/.exec(url);
            currentPage = m?.[1] ? Number(m[1]) : 1;
            return Promise.resolve(null);
          };
        }
        if (prop === "waitForSelector") {
          return (): Promise<null> => Promise.resolve(null);
        }
        if (prop === "content") {
          return (): Promise<string> => Promise.resolve(pages[currentPage] ?? "");
        }
        if (prop === "url") {
          return (): string => `https://www.heb.com/my-account/your-orders?page=${currentPage}`;
        }
        throw new Error(`unexpected page.${String(prop)} in empty-before-maxPage test stub`);
      },
    }
  ) as Page;

  await assert.rejects(
    () => runForwardScan(page, deps, makeRunFlags(), null),
    // Page 2's own HTML has zero order cards AND no pagination nav — so
    // `resolveDomMaxPage` on page 2 resolves "absent" rather than a numeric
    // value, which classifyEmptyListPage also treats as fail-closed (not
    // just "empty before a resolved maxPage"). Either failure reason proves
    // the same point: no reading of page 2 in isolation can be terminal when
    // page 1 advertised more pages exist.
    /heb_empty_list_page_(empty_page_before_max_page|pagination_metadata_absent)/,
    "an empty page at or before the advertised maxPage must fail closed, not be treated as terminal"
  );
});

test("runForwardScan: an empty page whose OWN pagination nav still agrees maxPage=2 hits empty_page_before_max_page exactly", async () => {
  // Narrower companion to the test above: here page 2 itself still carries
  // the same pagination nav (so resolveDomMaxPage on page 2 resolves to 2,
  // not "absent"), isolating the empty_page_before_max_page branch
  // specifically from the pagination_metadata_absent branch.
  const { deps } = makeRecordingDeps({ wantsItems: false });
  const paginationNav = `<nav aria-label="Pagination"><a href="?page=1">1</a><a href="?page=2">2</a></nav>`;
  const pages: Record<number, string> = {
    1: `<html><body><main>
      <a href="/my-account/order-history/HEB1000000001">July 13, 2026 $20.00, 2 items</a>
      ${paginationNav}
    </main></body></html>`,
    2: `<html><body><main>${paginationNav}</main></body></html>`,
  };
  let currentPage = 1;
  const page = new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (prop === "goto") {
          return (url: string): Promise<null> => {
            const m = /page=(\d+)/.exec(url);
            currentPage = m?.[1] ? Number(m[1]) : 1;
            return Promise.resolve(null);
          };
        }
        if (prop === "waitForSelector") {
          return (): Promise<null> => Promise.resolve(null);
        }
        if (prop === "content") {
          return (): Promise<string> => Promise.resolve(pages[currentPage] ?? "");
        }
        if (prop === "url") {
          return (): string => `https://www.heb.com/my-account/your-orders?page=${currentPage}`;
        }
        throw new Error(`unexpected page.${String(prop)} in empty-before-maxPage-with-nav test stub`);
      },
    }
  ) as Page;

  await assert.rejects(
    () => runForwardScan(page, deps, makeRunFlags(), null),
    /heb_empty_list_page_empty_page_before_max_page/,
    "an empty page whose own metadata still resolves a maxPage must classify as empty_page_before_max_page, not absent"
  );
});

// ─── Source-authored empty state ──────────────────────────────────────────

test("runForwardScan: H-E-B's real 'No past orders' page completes the scan instead of aborting as selector_drift", async () => {
  // Fail-before/pass-after oracle for the real defect. `orders-list-no-past-
  // orders.html` is a live capture (2026-08-21, in-container, connector's own
  // authenticated profile): a 272 KB served page titled "Your orders |
  // HEB.com" with no Imperva markers, showing H-E-B's own "No past orders"
  // empty state.
  //
  // Without the empty_state branch this page aborts as `selector_drift`,
  // because the empty-state component's own CSS-module class names supply all
  // four `class*="order"` matches (`order_cards: 0, any_card: 4`). That
  // diagnosis blames H-E-B's markup and sends recovery at a selector rewrite
  // that cannot succeed. Note this page also has no pagination nav, so it
  // would otherwise fall to `pagination_metadata_absent` — the assertion below
  // is that it aborts for NEITHER reason.
  const ordersCoverage = newOrdersCoverage();
  const { deps, protocolMessages } = makeRecordingDeps({ ordersCoverage, wantsItems: false, wantsOrders: true });
  const html = readFileSync(join(FIXTURES_DIR, "orders-list-no-past-orders.html"), "utf8");
  const page = makePageStub({ content: html, url: "https://www.heb.com/my-account/your-orders?page=1" });

  const { newestOrderDate: newest } = await runForwardScan(page, deps, makeRunFlags(), null);

  assert.equal(newest, null, "an empty history yields no newest order date");
  // The scan must reach a clean terminal, not throw. Before the fix this call
  // rejected with heb_empty_list_page_selector_drift.
  const skips = protocolMessages.filter((m) => m.type === "SKIP_RESULT");
  assert.deepEqual(
    skips.map((m) => (m as { reason: string }).reason),
    [],
    "a source-reported empty history is proven terminal and must emit no SKIP_RESULT"
  );

  // Completing the scan is what lets coverage be emitted at all: the throwing
  // path left the `orders` stream permanently unmeasured. Zero considered /
  // zero covered is an honest proven-empty claim here, because H-E-B scopes
  // order history to the ACCOUNT, not the selected store (verified against
  // stored records: one scrape of a single connection returned orders from
  // four different H-E-B stores).
  await emitOrdersCoverage(deps, ordersCoverage);
  const coverage = findDetailCoverage(protocolMessages);
  assert.ok(coverage, "the orders stream must still report coverage on an empty run");
  assert.equal(coverage.considered, 0);
  assert.equal(coverage.covered, 0);
});

test("runForwardScan: an empty page WITHOUT the empty-state marker still aborts as selector_drift", async () => {
  // The fail-closed half. Genuine drift — order cards gone but other
  // `class*="order"` elements still present, and no empty-state component to
  // vouch for it — must keep aborting exactly as before. This is what stops
  // the new branch from becoming a blanket "zero orders is fine" escape.
  const { deps } = makeRecordingDeps({ wantsItems: false });
  const html = `<html><body><main>
    <div data-qe-id="orderResults"><div class="OrderCard_wrapper__x1"></div></div>
  </main></body></html>`;
  const page = makePageStub({ content: html, url: "https://www.heb.com/my-account/your-orders?page=1" });

  await assert.rejects(
    () => runForwardScan(page, deps, makeRunFlags(), null),
    /heb_empty_list_page_selector_drift/,
    "an empty page with no source-authored empty state is still unproven"
  );
});

test("runForwardScan: an Imperva block is never laundered into a proven-empty result", async () => {
  // Ordering guard. The block check runs before the empty_state check, so a
  // challenge page can never be reported as a proven-empty history even if a
  // future block shape were to carry empty-state-looking markup.
  const { deps } = makeRecordingDeps({ wantsItems: false });
  const blockWithEmptyStateMarkup = `<html><body>{ "incidentId" : "0-0", "hostName" : "www.heb.com", "errorCode" : "15" }<div data-qe-id="orderResults"><div class="Empty_box__qxVTd"></div></div></body></html>`;
  const page = makePageStub({
    content: blockWithEmptyStateMarkup,
    url: "https://www.heb.com/my-account/your-orders?page=1",
  });

  await assert.rejects(
    () => runForwardScan(page, deps, makeRunFlags(), null),
    /heb_empty_list_page_source_auth_or_challenge/,
    "bot protection must outrank the empty-state marker"
  );
});

// ─── Proven-empty regression guard (prior-orders evidence) ────────────────
//
// A connection that has already collected orders must never be able to
// complete a run as "proven empty". The source-authored empty state is
// trustworthy for an account that never had orders; for an account we have
// already measured, the same page is a contradiction, not a result.

const EMPTY_STATE_DIAG: ListPageDiagnostics = {
  any_card: 4,
  body_preview: "",
  empty_state: true,
  incapsula_block: false,
  order_cards: 0,
  password_form: false,
  title: "",
  url: "",
};

const RESOLVED_MAX_PAGE = { kind: "resolved", source: "dom", value: 1 } as const;

test("classifyEmptyListPage: source-reported empty on a connection with NO prior orders stays proven-empty", () => {
  // Preserves efc601bb7. A first-ever run on a genuinely empty account is the
  // one case where zero coverage is an honest measurement.
  assert.deepEqual(classifyEmptyListPage(EMPTY_STATE_DIAG, 1, RESOLVED_MAX_PAGE, { hasPriorOrders: false }), {
    action: "terminal",
    reason: "source_reported_empty",
  });
});

test("classifyEmptyListPage: the prior-orders argument defaults to absent, so callers cannot silently opt in", () => {
  assert.deepEqual(classifyEmptyListPage(EMPTY_STATE_DIAG, 1, RESOLVED_MAX_PAGE), {
    action: "terminal",
    reason: "source_reported_empty",
  });
});

test("classifyEmptyListPage: source-reported empty on a connection WITH prior orders aborts instead of proving zero", () => {
  // The defect this guard closes: without it, this exact input returned
  // {action:"terminal", reason:"source_reported_empty"}, letting a connection
  // holding 41 orders commit covered:0/considered:0 as a measured result.
  assert.deepEqual(classifyEmptyListPage(EMPTY_STATE_DIAG, 1, RESOLVED_MAX_PAGE, { hasPriorOrders: true }), {
    action: "abort",
    reason: "heb_empty_history_after_prior_orders",
  });
});

test("classifyEmptyListPage: an auth/challenge page keeps its own reason even when prior orders exist", () => {
  // Ordering guard, upper half. The block check stays ABOVE the new branch:
  // when a challenge is actually established, that is the more specific and
  // more actionable diagnosis, and it must not be relabelled.
  assert.deepEqual(
    classifyEmptyListPage({ ...EMPTY_STATE_DIAG, incapsula_block: true }, 1, RESOLVED_MAX_PAGE, {
      hasPriorOrders: true,
    }),
    { action: "abort", reason: "source_auth_or_challenge" }
  );
  assert.deepEqual(
    classifyEmptyListPage({ ...EMPTY_STATE_DIAG, password_form: true }, 1, RESOLVED_MAX_PAGE, {
      hasPriorOrders: true,
    }),
    { action: "abort", reason: "source_auth_or_challenge" }
  );
});

test("classifyEmptyListPage: prior orders do not relabel a page that never claimed to be empty", () => {
  // Ordering guard, lower half. The new branch is gated on `empty_state`, so
  // real selector drift keeps reporting as drift regardless of prior orders —
  // the guard adds a failure mode, it does not swallow the existing ones.
  assert.deepEqual(
    classifyEmptyListPage({ ...EMPTY_STATE_DIAG, empty_state: false }, 1, RESOLVED_MAX_PAGE, {
      hasPriorOrders: true,
    }),
    { action: "abort", reason: "selector_drift" }
  );
});

test("priorOrdersEvidenceFromState: a committed orders checkpoint is what arms the guard", () => {
  // Pins the checkpoint-to-evidence link that collect() depends on. Without
  // this test, hardcoding `hasPriorOrders: false` in collect() would disarm
  // the guard for every connection while every other test still passed.
  assert.deepEqual(priorOrdersEvidenceFromState({ checkpoint: "2026-08-17" }), { hasPriorOrders: true });
  // A never-collected connection stores no checkpoint at all. `exactOptional
  // PropertyTypes` makes an explicitly-undefined checkpoint unrepresentable,
  // so the absent-property case is the only "no prior orders" shape there is.
  assert.deepEqual(priorOrdersEvidenceFromState({}), { hasPriorOrders: false });
});

test("runForwardScan: H-E-B's real 'No past orders' page aborts when this connection already collected orders", async () => {
  // Integration half, through the same live 2026-08-21 capture the
  // proven-empty test uses. Same page, same markup, opposite verdict — the
  // only difference is that this connection has a prior orders checkpoint.
  const ordersCoverage = newOrdersCoverage();
  const { deps, protocolMessages } = makeRecordingDeps({ ordersCoverage, wantsItems: false, wantsOrders: true });
  const html = readFileSync(join(FIXTURES_DIR, "orders-list-no-past-orders.html"), "utf8");
  const page = makePageStub({ content: html, url: "https://www.heb.com/my-account/your-orders?page=1" });

  await assert.rejects(
    () => runForwardScan(page, deps, makeRunFlags(), "2026-08-01", { hasPriorOrders: true }),
    /heb_empty_list_page_heb_empty_history_after_prior_orders/,
    "an account with prior orders cannot be proven empty by a page render"
  );

  // The failure must be legible to the owner, and must not blame anything the
  // page does not establish.
  const skip = protocolMessages.find(
    (m) => m.type === "SKIP_RESULT" && (m as { reason: string }).reason === "heb_empty_history_after_prior_orders"
  ) as { message: string; diagnostics: Record<string, unknown> } | undefined;
  assert.ok(skip, "the abort must surface a SKIP_RESULT the owner can read");
  assert.match(skip.message, /previously collected orders/);
  assert.match(skip.message, /retained and untouched/);
  assert.doesNotMatch(skip.message, /selector|drift/i, "selector drift is not established and must not be blamed");
  assert.doesNotMatch(skip.message, /block|bot|captcha/i, "a bot block is not established and must not be blamed");
  assert.equal(skip.diagnostics.empty_state, true);
  assert.equal(skip.diagnostics.has_prior_orders, true);

  // Nothing may be recorded as covered, and no proven-zero coverage may be
  // claimed: the scan threw before any coverage accounting ran.
  assert.equal(ordersCoverage.considered.length, 0);
  assert.equal(ordersCoverage.covered.length, 0);
  assert.equal(findDetailCoverage(protocolMessages), undefined, "an aborted run must claim no coverage at all");
});

test("runForwardScan: the empty-history abort emits no records and no STATE cursor", async () => {
  // Requirement: the guard must not delete, tombstone, or overwrite stored
  // records, and must not advance or clear the orders cursor. The connector's
  // only durable writes are protocol messages, so proving it emitted no
  // RECORD and no STATE proves the stored copy and the prior checkpoint are
  // both untouched.
  const { deps, emitted, protocolMessages } = makeRecordingDeps({ wantsItems: false, wantsOrders: true });
  const html = readFileSync(join(FIXTURES_DIR, "orders-list-no-past-orders.html"), "utf8");
  const page = makePageStub({ content: html, url: "https://www.heb.com/my-account/your-orders?page=1" });

  await assert.rejects(() => runForwardScan(page, deps, makeRunFlags(), "2026-08-01", { hasPriorOrders: true }));

  assert.equal(emitted.length, 0, "no records may be written on a contradicted-empty run");
  assert.equal(
    protocolMessages.filter((m) => m.type === "STATE").length,
    0,
    "the orders cursor must not be advanced or cleared"
  );
  // Deletion needs no assertion: the connector protocol has no delete or
  // tombstone message, so a connector cannot remove a stored record even in
  // principle. The only durable writes available here are RECORD and STATE,
  // and both are asserted absent above.
  assert.deepEqual(
    [...new Set(protocolMessages.map((m) => m.type))].sort(),
    ["SKIP_RESULT"],
    "the abort's only durable output is the owner-facing SKIP_RESULT"
  );
});

// ─── #3: old-gap recovery lane ─────────────────────────────────────────────

function makeGap(orderId: string, orderDate = "2026-07-01"): BrowserCollectContext["detailGaps"][number] {
  return {
    detail_locator: { kind: "heb.order_detail", order_id: orderId, order_date: orderDate },
    gap_id: `gap_${orderId}`,
    record_key: orderId,
    reference_only: true,
    status: "pending",
    stream: "order_items",
  };
}

/** A legacy/pre-fix gap whose locator has no order_date at all (the shape
 *  buildHebDetailGap emitted before it started storing order_date). */
function makeLegacyGapWithoutDate(orderId: string): BrowserCollectContext["detailGaps"][number] {
  return {
    detail_locator: { kind: "heb.order_detail", order_id: orderId },
    gap_id: `gap_${orderId}`,
    record_key: orderId,
    reference_only: true,
    status: "pending",
    stream: "order_items",
  };
}

test("recoverPendingOrderItemDetailGaps: hydrates a pending order_items gap and emits DETAIL_GAP_RECOVERED", async () => {
  const { deps, emitted, protocolMessages } = makeRecordingDeps();
  const flags = makeRunFlags();
  const page = makePageStub({ content: DETAIL_HTML });

  const result = await recoverPendingOrderItemDetailGaps(
    page,
    {
      detailGaps: [makeGap("HEB1000000001")],
      emit: deps.emit,
      emitRecord: deps.emitRecord,
      emittedAt: deps.emittedAt,
      sendInteraction: deps.sendInteraction,
      waitForHydration: deps.waitForHydration,
    },
    flags
  );

  assert.equal(result.recovered, 1);
  assert.equal(result.stoppedWithPending, false);
  assert.ok(
    emitted.some((r) => r.stream === "order_items" && r.data.order_id === "HEB1000000001"),
    "the recovered gap's items must emit as real order_items records"
  );
  const recovered = findDetailGapRecovered(protocolMessages);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.gap_id, "gap_HEB1000000001");
  assert.equal(recovered[0]?.record_key, "HEB1000000001");
  assert.equal(findDetailGaps(protocolMessages).length, 0, "a recovered gap must not re-emit a new pending gap");
});

test("recoverPendingOrderItemDetailGaps: a failed recovery re-emits a pending gap instead of silently dropping it", async () => {
  const { deps, emitted, protocolMessages } = makeRecordingDeps();
  const flags = makeRunFlags();
  const page = makePageStub({ content: NO_DETAIL_HTML });

  const result = await recoverPendingOrderItemDetailGaps(
    page,
    {
      detailGaps: [makeGap("HEB1000000002")],
      emit: deps.emit,
      emitRecord: deps.emitRecord,
      emittedAt: deps.emittedAt,
      sendInteraction: deps.sendInteraction,
      waitForHydration: deps.waitForHydration,
    },
    flags
  );

  assert.equal(result.recovered, 0);
  assert.equal(result.stoppedWithPending, true);
  assert.equal(emitted.length, 0);
  const gaps = findDetailGaps(protocolMessages);
  assert.equal(gaps.length, 1, "the gap must be re-deferred, not dropped");
  assert.equal(gaps[0]?.record_key, "HEB1000000002");
});

test("recoverPendingOrderItemDetailGaps: a session-repair failure stops draining further gaps in the same page", async () => {
  const { deps, protocolMessages } = makeRecordingDeps();
  const flags = makeRunFlags();
  const page = makePageStub({ content: PASSWORD_FORM_HTML });

  const result = await recoverPendingOrderItemDetailGaps(
    page,
    {
      detailGaps: [makeGap("HEB1000000003"), makeGap("HEB1000000004")],
      emit: deps.emit,
      emitRecord: deps.emitRecord,
      emittedAt: deps.emittedAt,
      sendInteraction: deps.sendInteraction,
      waitForHydration: deps.waitForHydration,
    },
    flags
  );

  assert.equal(result.recovered, 0);
  assert.equal(flags.sessionRepairRequired, true);
  const gaps = findDetailGaps(protocolMessages);
  assert.deepEqual(
    gaps.map((g) => [g.record_key, g.last_error?.class]),
    [
      ["HEB1000000003", "owner_repair_required"],
      ["HEB1000000004", "owner_repair_required"],
    ],
    "both gaps re-defer as owner-repair; the browser is only actually touched once"
  );
});

test("recoverPendingOrderItemDetailGaps: a legacy gap with no order_date does NOT fabricate a date — it retains the pending gap", async () => {
  const { deps, emitted, protocolMessages } = makeRecordingDeps();
  const flags = makeRunFlags();
  const page = makePageStub({ content: DETAIL_HTML });

  const result = await recoverPendingOrderItemDetailGaps(
    page,
    {
      detailGaps: [makeLegacyGapWithoutDate("HEB1000000007")],
      emit: deps.emit,
      emitRecord: deps.emitRecord,
      emittedAt: deps.emittedAt,
      sendInteraction: deps.sendInteraction,
      waitForHydration: deps.waitForHydration,
    },
    flags
  );

  assert.equal(result.recovered, 0, "a dateless legacy gap must not count as recovered");
  assert.equal(result.stoppedWithPending, true);
  assert.equal(
    emitted.filter((r) => r.stream === "order_items").length,
    0,
    "no order_items record may be emitted with a fabricated order_date"
  );
  assert.equal(
    findDetailGapRecovered(protocolMessages).length,
    0,
    "a gap that could not be honestly recovered must not emit DETAIL_GAP_RECOVERED"
  );
  const gaps = findDetailGaps(protocolMessages);
  assert.equal(gaps.length, 1, "the gap must be retained (re-emitted as pending), not dropped");
  assert.equal(gaps[0]?.record_key, "HEB1000000007");
});

test("recoverPendingOrderItemDetailGapsBeforeForwardRun: recoveryOnly suppresses the forward walk", async () => {
  const { deps } = makeRecordingDeps();
  const flags = makeRunFlags();
  const page = makePageStub({ content: DETAIL_HTML });

  const result = await recoverPendingOrderItemDetailGapsBeforeForwardRun(
    page,
    {
      detailGaps: [makeGap("HEB1000000005")],
      emit: deps.emit,
      emitRecord: deps.emitRecord,
      emittedAt: deps.emittedAt,
      sendInteraction: deps.sendInteraction,
      waitForHydration: deps.waitForHydration,
    },
    flags,
    { recoveryOnly: true, wantsItems: true }
  );

  assert.equal(result.recovered, 1);
  assert.equal(result.suppressForward, true, "recovery_only must suppress the forward scan even after recovering");
});

test("recoverPendingOrderItemDetailGapsBeforeForwardRun: order_items out of scope skips recovery entirely", async () => {
  const { deps } = makeRecordingDeps();
  const flags = makeRunFlags();

  const result = await recoverPendingOrderItemDetailGapsBeforeForwardRun(
    NEVER_CALLED_PAGE,
    {
      detailGaps: [makeGap("HEB1000000006")],
      emit: deps.emit,
      emitRecord: deps.emitRecord,
      emittedAt: deps.emittedAt,
      sendInteraction: deps.sendInteraction,
      waitForHydration: deps.waitForHydration,
    },
    flags,
    { recoveryOnly: false, wantsItems: false }
  );

  assert.equal(result.recovered, 0);
  assert.equal(result.suppressForward, false, "a plain out-of-scope run must not suppress the forward walk");
});

// ─── #10: exhaustive DetailFailureKind classification sanity ──────────────

test("reasonForDetailFailure and classifyHebDetailFailure cover every current DetailFailureKind", () => {
  const kinds = [
    "deferred_budget",
    "navigation_failed_non_retryable",
    "navigation_retry_exhausted",
    "parse_missing",
    "session_repair_required",
  ] as const;
  for (const kind of kinds) {
    assert.doesNotThrow(() => reasonForDetailFailure(kind));
    assert.doesNotThrow(() => classifyHebDetailFailure(kind));
  }
});

test("recordDetailOutcome: hydrated/gap each land in the right accumulator set", () => {
  const coverage = newOrderItemsCoverage();
  recordDetailOutcome(coverage, "ord-h", "hydrated");
  recordDetailOutcome(coverage, "ord-g", "gap");
  assert.deepEqual(coverage.required, ["ord-h", "ord-g"]);
  assert.deepEqual(coverage.hydrated, ["ord-h"]);
  assert.deepEqual(coverage.gap, ["ord-g"]);
});

// ─── Page-ceiling honesty (MAX_LIST_PAGES) ────────────────────────────────
//
// `runForwardScan` has two distinct exits: an honest completion
// (`pageNum > maxPage` — the walk reached the end H-E-B itself advertised)
// and a blast-radius ceiling (`pageNum <= MAX_LIST_PAGES` going false). The
// ceiling is a legitimate bound, but a run that stops there has NOT seen the
// whole list, and H-E-B's own pagination nav says so. These tests pin that
// the two exits are distinguishable in the owner-facing coverage evidence:
// a truncated walk must never report `covered >= considered`, because
// `covered < considered` is what `evaluateStreamCoherence` turns into
// `boundary_shortfall` -> `partial` instead of `complete`.

/** Build a list-page stub advertising `maxPage` total pages, each holding one
 *  order, with dates descending so no boundary stop fires. */
function makeCeilingPage(advertisedMaxPage: number): { page: Page; pagesFetched: () => number[] } {
  const nav = `<nav aria-label="Pagination"><a href="?page=1">1</a><a href="?page=${advertisedMaxPage}">${advertisedMaxPage}</a></nav>`;
  const fetched: number[] = [];
  let currentPage = 1;
  const htmlFor = (pageNum: number): string => {
    // Descending dates: page 1 newest. Day-of-month stays in range for any
    // page count used here (<= 60 pages -> 2026-06-XX .. 2026-07-XX).
    const day = 60 - pageNum;
    const month = day > 30 ? 7 : 6;
    const dayOfMonth = day > 30 ? day - 30 : day;
    const id = `HEB${String(2_000_000_000 + pageNum)}`;
    return `<html><body><main>
      <a href="/my-account/order-history/${id}">${month === 7 ? "July" : "June"} ${dayOfMonth}, 2026 $10.00, 1 items</a>
      ${nav}
    </main></body></html>`;
  };
  const page = new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (prop === "goto") {
          return (url: string): Promise<null> => {
            const m = /page=(\d+)/.exec(url);
            currentPage = m?.[1] ? Number(m[1]) : 1;
            fetched.push(currentPage);
            return Promise.resolve(null);
          };
        }
        if (prop === "waitForSelector") {
          return (): Promise<null> => Promise.resolve(null);
        }
        if (prop === "content") {
          return (): Promise<string> => Promise.resolve(htmlFor(currentPage));
        }
        if (prop === "url") {
          return (): string => `https://www.heb.com/my-account/your-orders?page=${currentPage}`;
        }
        throw new Error(`unexpected page.${String(prop)} in ceiling test stub`);
      },
    }
  ) as Page;
  return { page, pagesFetched: (): number[] => fetched };
}

test("runForwardScan: hitting MAX_LIST_PAGES does not report the orders stream complete", async () => {
  // H-E-B advertises 60 pages; the connector's blast-radius ceiling is 50.
  // The walk stops 10 pages short of what the provider itself says exists.
  const ordersCoverage = newOrdersCoverage();
  const { deps } = makeRecordingDeps({ ordersCoverage, wantsItems: false });
  const { page, pagesFetched } = makeCeilingPage(60);

  await runForwardScan(page, deps, makeRunFlags(), null);

  assert.equal(pagesFetched().length, HEB_MAX_LIST_PAGES, "the ceiling bounds the walk at MAX_LIST_PAGES pages");

  // The honesty contract: `covered` must fall short of `considered` so the
  // reference implementation derives `partial`, not `complete`.
  assert.ok(
    ordersCoverage.covered.length < ordersCoverage.considered.length,
    "a truncated walk must report covered < considered so coverage reads partial, not complete; " +
      `got considered=${ordersCoverage.considered.length} covered=${ordersCoverage.covered.length}`
  );
});

test("runForwardScan: an honest completion (maxPage under the ceiling) still reports the orders stream complete", async () => {
  // The guard against over-correcting: a walk that genuinely reached the end
  // H-E-B advertised must still read complete (covered >= considered).
  const ordersCoverage = newOrdersCoverage();
  const { deps } = makeRecordingDeps({ ordersCoverage, wantsItems: false });
  const { page, pagesFetched } = makeCeilingPage(3);

  await runForwardScan(page, deps, makeRunFlags(), null);

  assert.equal(pagesFetched().length, 3, "an honest walk fetches exactly the advertised page count");
  assert.ok(
    ordersCoverage.covered.length >= ordersCoverage.considered.length && ordersCoverage.considered.length === 3,
    "an honest completion must still read complete; " +
      `got considered=${ordersCoverage.considered.length} covered=${ordersCoverage.covered.length}`
  );
});

test("runForwardScan: the ceiling exit reports truncated, the honest exit does not", async () => {
  const overCeiling = makeCeilingPage(60);
  const truncatedScan = await runForwardScan(
    overCeiling.page,
    makeRecordingDeps({ wantsItems: false }).deps,
    makeRunFlags(),
    null
  );
  assert.equal(truncatedScan.truncated, true, "stopping at the page ceiling must report truncated");

  const underCeiling = makeCeilingPage(3);
  const honestScan = await runForwardScan(
    underCeiling.page,
    makeRecordingDeps({ wantsItems: false }).deps,
    makeRunFlags(),
    null
  );
  assert.equal(honestScan.truncated, false, "reaching the advertised maxPage must NOT report truncated");
});

test("buildOrdersStateCursor: a truncated scan must not advance the orders checkpoint past unread pages", () => {
  // The permanent-loss case. H-E-B's list is reverse-chronological, so
  // `newestOrderDate` is page 1's date. Committing it after a walk that never
  // read pages 51..60 would claim coverage back to that date; the next run's
  // `resumeBoundary` would then stop the walk long before reaching the
  // untraversed tail, making those orders unreachable by ANY future run.
  const priorState = { checkpoint: "2026-01-01" };

  const truncated = buildOrdersStateCursor("2026-07-14", priorState, undefined, true);
  assert.equal(
    truncated.checkpoint,
    "2026-01-01",
    "a truncated scan holds the prior checkpoint so the unread tail stays reachable next run"
  );

  const honest = buildOrdersStateCursor("2026-07-14", priorState, undefined, false);
  assert.equal(
    honest.checkpoint,
    "2026-07-14",
    "an honest completion still advances the checkpoint — truncation handling must not freeze normal progress"
  );
});
