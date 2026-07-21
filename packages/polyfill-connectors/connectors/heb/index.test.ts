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
import test from "node:test";
import type { Page } from "playwright";
import type { BrowserCollectContext } from "../../src/connector-runtime.ts";
import type { EmittedMessage } from "../../src/connector-runtime-protocol.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import {
  classifyHebDetailFailure,
  type EmitDeps,
  emitOrderItemsCoverage,
  fetchOrderDetail,
  hebAllowsInteractiveAuthRepair,
  newOrderItemsCoverage,
  type OrderItemsCoverage,
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
import type { ListPageOrder } from "./types.ts";

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

function makeRecordingDeps(overrides: Partial<EmitDeps> = {}): RecordingDeps {
  const harness = makeRecordingEmit(validateRecord);
  const deps: EmitDeps = {
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: "2026-07-14T12:00:00.000Z",
    orderItemsCoverage: undefined,
    ordersFingerprintCursor: undefined,
    progress: (): Promise<void> => Promise.resolve(),
    sendInteraction: noopSendInteraction,
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
            gotoCalls++;
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

test("processListOrder: a malformed order date records a 'skipped' coverage outcome, not silence", async () => {
  const coverage = newOrderItemsCoverage();
  const { deps, emitted, protocolMessages } = makeRecordingDeps({ orderItemsCoverage: coverage });
  const listOrder = makeListOrder({ orderDateRaw: "not a real date" });

  await processListOrder(NEVER_CALLED_PAGE, deps, makeRunFlags(), listOrder);

  assert.deepEqual(coverage.required, ["HEB1000000001"], "the order must still join the required denominator");
  assert.deepEqual(coverage.optionalSkip, ["HEB1000000001"]);
  assert.deepEqual(coverage.hydrated, []);
  assert.deepEqual(coverage.gap, [], "a date-parse failure is a policy skip, not a degraded gap");
  assert.equal(emitted.length, 0, "no order/item record can emit without a parsed order_date");
  assert.ok(
    protocolMessages.some((m) => m.type === "SKIP_RESULT" && m.reason === "unparseable_order_date"),
    "the existing SKIP_RESULT diagnostic must still fire"
  );
});

test("emitOrderItemsCoverage: a skipped order counts toward covered (it's a policy skip, not a gap)", async () => {
  const { deps, protocolMessages } = makeRecordingDeps();
  const coverage: OrderItemsCoverage = { required: ["a", "b"], hydrated: ["a"], gap: [], optionalSkip: ["b"] };
  await emitOrderItemsCoverage(deps, coverage);

  const msg = findDetailCoverage(protocolMessages);
  assert.ok(msg);
  assert.deepEqual(msg.required_keys, ["a", "b"]);
  assert.deepEqual(msg.optional_skip_keys, ["b"]);
  assert.equal(msg.considered, 2);
  assert.equal(msg.covered, 2, "hydrated + optional_skip both count as covered");
  assert.equal(msg.gap_keys, undefined);
});

// ─── #4: mid-run logout via password-form response (not just URL) ────────

test("fetchOrderDetail: a password-form response at a non-sign-in URL classifies session_repair_required", async () => {
  const page = makePageStub({ content: PASSWORD_FORM_HTML });
  const result = await fetchOrderDetail(page, "HEB1000000001");
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
  const result = await fetchOrderDetail(page, "HEB1000000001");
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
  const result = await fetchOrderDetail(page, "HEB1000000001");
  assert.equal(result.status, "hydrated", "one transient failure must not be reported as exhausted");
});

test("fetchOrderDetail: navigation_retry_exhausted is only reported once the retry budget is actually exhausted", async () => {
  // throwsNTimes is larger than the retry budget (retries: 2 => 3 total
  // attempts), so every attempt fails and the budget is genuinely exhausted.
  const page = makePageStub({ content: DETAIL_HTML, throwsNTimes: 10 });
  const result = await fetchOrderDetail(page, "HEB1000000001");
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
            gotoCalls++;
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

  const result = await fetchOrderDetail(page, "HEB1000000001");

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

test("resolveOrderDetail: unattended run — sessionRepairRequired latches immediately with zero interaction, no repair spent", async () => {
  const flags: RunFlags = {
    detailAttempts: 0,
    isManualRun: false,
    manualRepairAttempted: false,
    sessionRepairRequired: true,
  };
  const repairDeps: RepairDeps = { sendInteraction: fakeSendInteraction() };
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
  const repairDeps: RepairDeps = { sendInteraction: fakeSendInteraction() };
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
  const repairDeps: RepairDeps = { sendInteraction: fakeSendInteraction() };
  const result = await resolveOrderDetail(page, flags, "HEB1000000001", repairDeps);
  assert.equal(flags.manualRepairAttempted, true, "the one shared attempt is now spent");
  assert.equal(result.status, "hydrated", "the retried detail fetch must succeed after a recovered session");
  assert.equal(flags.sessionRepairRequired, false, "a successful repair+retry clears the latch");
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
  const repairDeps: RepairDeps = { sendInteraction: fakeSendInteraction() };
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
  const repairDeps: RepairDeps = { sendInteraction: fakeSendInteraction() };
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
  const repairDeps: RepairDeps = { sendInteraction: fakeSendInteraction() };

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
            gotoCount++;
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

  const newestOrderDate = await runForwardScan(page, deps, makeRunFlags(), null);

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

test("recordDetailOutcome: hydrated/gap/skipped each land in the right accumulator set", () => {
  const coverage = newOrderItemsCoverage();
  recordDetailOutcome(coverage, "ord-h", "hydrated");
  recordDetailOutcome(coverage, "ord-g", "gap");
  recordDetailOutcome(coverage, "ord-s", "skipped");
  assert.deepEqual(coverage.required, ["ord-h", "ord-g", "ord-s"]);
  assert.deepEqual(coverage.hydrated, ["ord-h"]);
  assert.deepEqual(coverage.gap, ["ord-g"]);
  assert.deepEqual(coverage.optionalSkip, ["ord-s"]);
});
