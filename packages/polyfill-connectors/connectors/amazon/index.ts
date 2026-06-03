#!/usr/bin/env node
/**
 * PDPP Amazon Connector (v0.1.0) — scaffolded 2026-04-19, BLOCKED on 2FA.
 *
 * Uses the shared Playwright persistent profile. Two-level session probe:
 * (1) nav greeting check, (2) deep check by navigating to /your-orders.
 *
 * Port of selectors from ~/code/data-connectors/amazon/amazon-playwright.js
 * (492 lines), cleaned to PDPP semantics:
 *   - No global `page` coupling
 *   - Emits RECORDs per Collection Profile (orders + order_items streams)
 *   - State per year (year-freezing incremental strategy)
 *   - Sequential, humanlike pacing (2s between navigations)
 *
 * Auth: relies on the bootstrapped profile (the owner logs in once via bootstrap).
 * On session expiry, emits INTERACTION kind=manual_action with sign-in URL.
 */

import pRetry, { AbortError } from "p-retry";
import type { Page } from "playwright";
import { ensureAmazonSession } from "../../src/auto-login/amazon.ts";
import { type BrowserCollectContext, nowIso, politeDelay, runConnector } from "../../src/connector-runtime.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import {
  buildOrderItemRecord,
  buildOrderRecord,
  mergeOrderItems,
  parseOrderDate,
  parseOrderDetailDom,
  parseOrdersListDom,
} from "./parsers.ts";
import { listPageOrderShape, validateRecord } from "./schemas.ts";
import type { ListPageDiagnostics, ListPageOrder, OrderDetail } from "./types.ts";

interface YearState {
  frozen: boolean;
  last_scraped: string;
  order_count: number;
}

interface YearsCursor {
  [year: string]: YearState | undefined;
}

interface OrdersStateShape {
  years?: YearsCursor;
}

type EmptyListPageAction = "abort" | "terminal";

interface EmptyListPageClassification {
  action: EmptyListPageAction;
  reason: string;
}

// Navigation timeouts + pacing knobs
const NAV_TIMEOUT_MS = 30_000;
const DEEP_PROBE_WAIT_MS = 15_000;
const DETAIL_WAIT_MS = 15_000;
const LIST_PAGE_WAIT_MS = 10_000;
const PAGE_LIMIT = 50;
const START_INDEX_STEP = 10;
const POLITE_DELAY_MS = 800;
const RETRY_MIN_TIMEOUT_MS = 1500;
const RETRY_FACTOR = 2;
const RETRY_COUNT = 2;
// Module-scoped regexes (Biome useTopLevelRegex)
const RETRYABLE_ERROR_RE = /timeout|ECONN|ETIMEDOUT|net::|5\d\d/i;
const SIGNIN_URL_RE = /\/ap\/(signin|challenge|mfa)/;
const ORDERS_URL_RE = /\/your-orders|\/order-history/;
const YEAR_VALUE_RE = /year-(\d{4})/;

// ─── Session probes ──────────────────────────────────────────────────────

async function deepSessionCheck(page: Page): Promise<boolean> {
  await page.goto("https://www.amazon.com/your-orders/orders", {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT_MS,
  });
  // Wait for either the orders page to render or a sign-in form (both are
  // valid post-nav states; we branch on them).
  await page
    .locator('form[name="signIn"], #orderTypeMenuContainer, #yourOrdersHeader, [data-component="orderCardList"]')
    .first()
    .waitFor({ state: "attached", timeout: DEEP_PROBE_WAIT_MS })
    .catch((): undefined => undefined);
  const url = page.url();
  if (SIGNIN_URL_RE.test(url)) {
    return false;
  }
  const loginForm = await page
    .locator('form[name="signIn"]')
    .first()
    .isVisible()
    .catch((): boolean => false);
  if (loginForm) {
    return false;
  }
  return ORDERS_URL_RE.test(url);
}

// ─── Year discovery & pagination ─────────────────────────────────────────

async function discoverYears(page: Page): Promise<number[]> {
  // Try select#time-filter first, then link patterns.
  const fromSelect = await page
    .evaluate((): string[] => {
      const sel =
        document.querySelector<HTMLSelectElement>("select#time-filter") ||
        document.querySelector<HTMLSelectElement>('select[name="timeFilter"]');
      if (!sel) {
        return [];
      }
      return [...sel.options].map((o) => o.value).filter(Boolean);
    })
    .catch((): string[] => []);
  const fromLinks = await page
    .evaluate((): string[] => {
      const links = [...document.querySelectorAll('a[href*="timeFilter=year-"]')];
      return links.map((a) => a.getAttribute("href")).filter((v): v is string => Boolean(v));
    })
    .catch((): string[] => []);
  const years = new Set<number>();
  for (const v of [...fromSelect, ...fromLinks]) {
    const m = YEAR_VALUE_RE.exec(v);
    if (m?.[1]) {
      years.add(Number(m[1]));
    }
  }
  const current = new Date().getFullYear();
  if (years.size === 0) {
    years.add(current);
  }
  return [...years].sort((a, b) => b - a); // newest first
}

// ─── Per-order detail fetch ──────────────────────────────────────────────
// Scrapes /gp/your-account/order-details?orderID=<ID> using Amazon's own
// `data-component` attributes (English-in-code on every locale) rather
// than regexing concatenated innerText. See docs/connector-authoring-guide.md
// §2 for why structure > text.
//
// DOM contract used (stable on Amazon across layouts since ≥2023):
//   [data-component="shippingAddress"]          → recipient + address (clean <ul><li>)
//   [data-component="viewPaymentPlanSummaryWidget"] → payment method
//   [data-component="chargeSummary"]            → Order Summary incl. Grand Total
//   [data-component="purchasedItemsRightGrid"]  → one per item; wraps itemTitle/orderedMerchant/unitPrice
//   [data-component="itemTitle"]                → product name (no cruft)
//   [data-component="orderedMerchant"]          → "Sold by: <seller>"
//   [data-component="unitPrice"]                → "$15.54 $15.54" (accessibility double)
//   [data-component="cancelled"]                → present+non-empty only on cancelled orders
//   .od-item-view-qty span                      → quantity (present only when qty>1)
//   [data-component="itemConnections"]          → cross-sell buttons (EXCLUDED from names)
//
// Fallback path: if no [data-component] attributes exist (hypothetical
// older layouts or post-A/B rollback), return null — the list-page
// record stands alone rather than risking corrupt structural-less parse.
//
// Cancelled orders have [data-component="cancelled"] with "This order has
// been cancelled" text and NO other structural fields. We detect and
// emit status_detail only.
async function fetchOrderDetail(page: Page, orderId: string): Promise<OrderDetail | null> {
  const url = `https://www.amazon.com/gp/your-account/order-details?orderID=${orderId}`;

  // Retry transient navigation failures (network, timeout, 5xx) with
  // exponential backoff. AbortError bypasses retries — we use it for the
  // "Amazon redirected us to a non-detail URL" signal (e.g. Amazon Fresh
  // orders that redirect to /uff/... with no #orderDetails), which retrying
  // won't fix.
  try {
    await pRetry(
      async (): Promise<void> => {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: NAV_TIMEOUT_MS,
        });
        // Wait for #orderDetails to appear OR for the cancellation/redirect
        // page signature. waitForSelector replaces `await sleep(800)` —
        // real sync primitive instead of a pacing guess.
        await page.waitForSelector('#orderDetails, [data-component="cancelled"]', {
          timeout: DETAIL_WAIT_MS,
          state: "attached",
        });
      },
      {
        retries: RETRY_COUNT,
        minTimeout: RETRY_MIN_TIMEOUT_MS,
        factor: RETRY_FACTOR,
        shouldRetry: ({ error }): boolean => !(error instanceof AbortError) && RETRYABLE_ERROR_RE.test(error.message),
      }
    );
  } catch {
    return null;
  }

  try {
    const html = await page.content();
    return parseOrderDetailDom(html);
  } catch {
    return null;
  }
}

// ─── Per-page order extraction ────────────────────────────────────────────
async function extractOrdersOnPage(page: Page): Promise<ListPageOrder[]> {
  try {
    const html = await page.content();
    return parseOrdersListDom(html);
  } catch {
    return [];
  }
}

// ─── collect() helpers ───────────────────────────────────────────────────

export type EmitFn = BrowserCollectContext["emit"];
export type EmitRecordFn = BrowserCollectContext["emitRecord"];
export type CaptureDep = BrowserCollectContext["capture"];

/** Ephemeral per-run flags that cross year boundaries. */
export interface RunFlags {
  detailCaptured: boolean;
}

/** Per-run dependencies threaded through processListOrder → emitOrderAndItems. */
export interface EmitDeps {
  capture: CaptureDep;
  emit: EmitFn;
  emitRecord: EmitRecordFn;
  emittedAt: string;
  progress: BrowserCollectContext["progress"];
  skipDetail: boolean;
  wantsItems: boolean;
  wantsOrders: boolean;
}

/** Emit the order record + per-item records for a single list-page order.
 *
 * The invariants this enforces:
 *   1. The order record emits BEFORE its item records (so downstream
 *      readers see the parent-child relationship in order).
 *   2. Items emit in mergeOrderItems() order — list-page items first,
 *      detail-only items appended — which is the dedup + enrichment
 *      order consumers depend on.
 *   3. Streams disabled via scope (wantsOrders/wantsItems) emit nothing;
 *      the other stream still flows.
 * Regressing any of these is a real bug; integration.test.ts covers them.
 */
export async function emitOrderAndItems(
  deps: EmitDeps,
  listOrder: ListPageOrder,
  detail: OrderDetail | null,
  orderDate: string
): Promise<void> {
  if (deps.wantsOrders) {
    await deps.emitRecord("orders", buildOrderRecord(listOrder, detail, orderDate, deps.emittedAt));
  }
  if (deps.wantsItems) {
    for (const merged of mergeOrderItems(listOrder, detail)) {
      await deps.emitRecord("order_items", buildOrderItemRecord(listOrder.orderId, orderDate, merged));
    }
  }
}

/**
 * Run list-page extraction through the zod shape-check. Orders that fail
 * the shape-check become SKIP_RESULT events; the successful subset is
 * returned in source order.
 */
async function extractAndShapeCheckOrders(page: Page, emit: EmitFn): Promise<ListPageOrder[]> {
  const rawOrders = await extractOrdersOnPage(page);
  const orders: ListPageOrder[] = [];
  for (const r of rawOrders) {
    const parsed = listPageOrderShape.safeParse(r);
    if (parsed.success) {
      orders.push(parsed.data as ListPageOrder);
    } else {
      await emit({
        type: "SKIP_RESULT",
        stream: "orders",
        reason: "list_page_shape_check_failed",
        message: `list card ${r.orderId ?? "<no id>"}: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
        diagnostics: { card: r, issues: parsed.error.issues },
      });
    }
  }
  return orders;
}

/**
 * Empty-page diagnostic branch: distinguish "no more orders" from
 * "our selectors missed the DOM". Emits SKIP_RESULT with drift details
 * + screenshot when the page clearly has order-like elements but our
 * selectors matched nothing.
 */
async function reportEmptyPageDiagnostics(page: Page, year: number, startIndex: number, emit: EmitFn): Promise<void> {
  const diag = await page
    .evaluate((): ListPageDiagnostics => {
      // biome-ignore-start lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.
      const CAPTCHA_RE = /captcha|robot|unusual traffic/i;
      const NO_ORDERS_RE = /you have not placed any orders|no orders found/i;
      const WS = /\s+/g;
      // biome-ignore-end lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.
      return {
        url: location.href,
        title: document.title,
        order_cards: document.querySelectorAll("div.order-card, div.js-order-card").length,
        any_card: document.querySelectorAll('[class*="order" i][class*="card" i]').length,
        any_order_header: document.querySelectorAll('[class*="order" i][class*="header" i]').length,
        sign_in_form: Boolean(document.querySelector('form[name="signIn"]')),
        captcha: CAPTCHA_RE.test(document.body?.innerText || "").toString(),
        no_orders_text: NO_ORDERS_RE.test(document.body?.innerText || "").toString(),
        body_preview: (document.body?.innerText || "").replace(WS, " ").slice(0, 240),
      };
    })
    .catch((): ListPageDiagnostics | null => null);
  const classification = classifyEmptyListPageDiagnostics(diag, startIndex);
  if (classification.action === "terminal") {
    return;
  }
  if (diag && classification.reason === "selector_drift") {
    const shotPath = `/tmp/amazon-drift-${year}-${startIndex}.png`;
    await page.screenshot({ path: shotPath, fullPage: true }).catch((): undefined => undefined);
    await emit({
      type: "SKIP_RESULT",
      stream: "orders",
      reason: "selector_drift",
      message: `Year ${year} startIndex=${startIndex}: order containers visible on page but .order-card/.js-order-card selector matched 0. Screenshot=${shotPath}`,
      diagnostics: diag,
    });
  } else {
    await emit({
      type: "SKIP_RESULT",
      stream: "orders",
      reason: classification.reason,
      message: `Year ${year} startIndex=${startIndex}: empty Amazon list page is not a proven terminal page; refusing to advance the cursor.`,
      diagnostics: diag ?? { missing_diagnostics: true },
    });
  }
  throw new Error(`amazon_empty_list_page_${classification.reason}`);
}

export function classifyEmptyListPageDiagnostics(
  diag: ListPageDiagnostics | null,
  startIndex: number
): EmptyListPageClassification {
  if (!diag) {
    return startIndex > 0
      ? { action: "terminal", reason: "pagination_exhausted" }
      : { action: "abort", reason: "empty_first_page_without_diagnostics" };
  }
  const captcha = diag.captcha === "true";
  if (diag.sign_in_form || captcha || SIGNIN_URL_RE.test(diag.url)) {
    return { action: "abort", reason: "source_auth_or_challenge" };
  }
  if ((diag.any_card > 0 || diag.any_order_header > 0) && diag.order_cards === 0) {
    return { action: "abort", reason: "selector_drift" };
  }
  if (diag.no_orders_text === "true") {
    return { action: "terminal", reason: "no_orders_text" };
  }
  if (startIndex > 0) {
    return { action: "terminal", reason: "pagination_exhausted" };
  }
  return { action: "abort", reason: "empty_first_page_without_terminal_signal" };
}

/**
 * Navigate to one list-page URL for `year` at `startIndex`, wait for the
 * list signal, optionally capture a fixture, and return the shape-checked
 * orders. On zero orders, emits drift diagnostics before returning [].
 */
async function scrapeListPage(
  page: Page,
  capture: CaptureDep,
  year: number,
  startIndex: number,
  emit: EmitFn
): Promise<ListPageOrder[]> {
  const url = `https://www.amazon.com/your-orders/orders?timeFilter=year-${year}&startIndex=${startIndex}`;
  await page
    .goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    })
    .catch((): undefined => undefined);
  // Wait for list-page signal. `.order-card` is the standard container
  // in modern layouts; `#ordersContainer` catches legacy. Either appears
  // when the orders list has rendered.
  await page
    .locator(".order-card, .js-order-card, #ordersContainer, #no-orders")
    .first()
    .waitFor({ state: "attached", timeout: LIST_PAGE_WAIT_MS })
    .catch((): undefined => undefined);
  // Fixture capture: one list-page snapshot per year (page 1 only).
  if (capture && startIndex === 0) {
    await capture.captureDom(page, `orders-list-${year}`);
  }
  const orders = await extractAndShapeCheckOrders(page, emit);
  if (orders.length === 0) {
    await reportEmptyPageDiagnostics(page, year, startIndex, emit);
  }
  return orders;
}

/**
 * Fetch the order detail page (if enabled), capture one detail fixture
 * per run, and emit the order + item records.
 */
async function processListOrder(page: Page, deps: EmitDeps, flags: RunFlags, listOrder: ListPageOrder): Promise<void> {
  const orderDate = parseOrderDate(listOrder.orderDateRaw);
  if (!orderDate) {
    return;
  }
  const detail: OrderDetail | null = deps.skipDetail ? null : await fetchOrderDetail(page, listOrder.orderId);
  if (deps.capture && !(flags.detailCaptured || deps.skipDetail) && detail) {
    await deps.capture.captureDom(page, `order-detail-${listOrder.orderId}`);
    flags.detailCaptured = true;
  }
  await emitOrderAndItems(deps, listOrder, detail, orderDate);
}

/**
 * Scrape every list page for one year and emit records. Returns the total
 * order count seen for the year (used for freeze-once-stable policy).
 */
async function runYear(page: Page, deps: EmitDeps, flags: RunFlags, year: number): Promise<number> {
  let startIndex = 0;
  let pageCount = 0;
  let yearOrderCount = 0;
  while (pageCount < PAGE_LIMIT) {
    await deps.progress(`Amazon year ${year}: scanning page ${pageCount + 1}`, { stream: "orders" });
    const orders = await scrapeListPage(page, deps.capture, year, startIndex, deps.emit);
    if (orders.length === 0) {
      await deps.progress(`Amazon year ${year}: no more orders after ${yearOrderCount} seen`, { stream: "orders" });
      break;
    }
    yearOrderCount += orders.length;
    await deps.progress(`Amazon year ${year}: page ${pageCount + 1} found ${orders.length} orders`, {
      stream: "orders",
    });
    for (const [index, o] of orders.entries()) {
      await deps.progress(
        `Amazon year ${year}: processing order ${index + 1}/${orders.length} on page ${pageCount + 1}`,
        { stream: "orders" }
      );
      await processListOrder(page, deps, flags, o);
    }
    pageCount++;
    startIndex += START_INDEX_STEP;
    await politeDelay(POLITE_DELAY_MS);
  }
  return yearOrderCount;
}

// ─── Incremental year planning ───────────────────────────────────────────

/**
 * Given the full set of discovered years and prior year state, return the
 * subset that should be scraped on this run.
 *
 * Invariants:
 *   - Current year is always included (orders are ongoing).
 *   - Previous year is always included (returns / late-arriving shipments
 *     can post after year-end).
 *   - Any year ≥2 years ago that already has a `last_scraped` timestamp in
 *     prior state is skipped — it was captured on a previous run and
 *     re-scraping it on every incremental run is unbounded behaviour.
 *   - Any year ≥2 years ago with NO prior `last_scraped` (newly discovered)
 *     is included so first-time discovery still works.
 *   - If there is no prior scraped state at all (first run), all years are
 *     returned so the initial backfill completes normally.
 *
 * This function is exported for unit testing. The `currentYear` parameter
 * is injected to keep the function pure (no `new Date()` at call time).
 */
export function planIncrementalYears(
  years: number[],
  yearsState: YearsCursor,
  currentYear: number
): { planned: number[]; skipped: Array<{ year: number; reason: string }> } {
  // If there is no prior scraped state at all, treat this as a first run —
  // return all discovered years so the initial backfill completes normally.
  const hasAnyScrapeHistory = Object.values(yearsState).some((s) => s?.last_scraped);
  if (!hasAnyScrapeHistory) {
    return { planned: [...years], skipped: [] };
  }

  const planned: number[] = [];
  const skipped: Array<{ year: number; reason: string }> = [];
  const prevYear = currentYear - 1;

  for (const year of years) {
    if (year >= prevYear) {
      // Current and previous year are always eligible.
      planned.push(year);
      continue;
    }
    const prior = yearsState[String(year)];
    if (prior?.last_scraped) {
      // Historical year with prior state: skip to prevent unbounded re-scrape.
      skipped.push({ year, reason: `prior state last_scraped=${prior.last_scraped}` });
    } else {
      // Newly discovered historical year (no prior state): include once.
      planned.push(year);
    }
  }

  return { planned, skipped };
}

// ─── Main ────────────────────────────────────────────────────────────────

// Guarded so `import "./index.ts"` in tests doesn't spin up the runtime
// and block the Node event loop on stdin. Only fires when this module
// IS the process entry point (i.e. `tsx connectors/amazon/index.ts`).
if (isMainModule(import.meta.url)) {
  runConnector({
    name: "amazon",
    validateRecord,
    // Amazon's bot detection fingerprints headless Chromium; cold sessions get
    // challenged. Opt into headed mode via PDPP_AMAZON_HEADLESS=0 (first-run,
    // re-auth). Warm sessions can go headless since cookies + TLS fingerprint
    // stay consistent across runs on the persistent profile.
    browser: { profileName: "amazon" },
    async ensureSession({ capture, checkpoint, context, page, sendInteraction }): Promise<void> {
      await ensureAmazonSession({
        ...(capture ? { capture } : {}),
        checkpoint,
        context,
        page,
        sendInteraction,
      });
      await checkpoint("amazon-deep-session-check");
      const deepOk = await deepSessionCheck(page);
      if (!deepOk) {
        throw new Error("amazon_session_required");
      }
    },
    async collect(ctx: BrowserCollectContext): Promise<void> {
      const { scope, state, emitRecord, emit, progress, capture, emittedAt, page } = ctx;
      const requested = new Map((scope?.streams || []).map((s) => [s.name, s]));

      // STATE is stream-keyed per Collection Profile: `state` is
      // { <stream>: <cursor>, ... }. We write STATE stream='orders'
      // cursor={years:{...}}, so reads must go through state.orders.
      const ordersState = (state.orders ?? {}) as OrdersStateShape;
      const legacyYears = (state as { years?: YearsCursor }).years;
      const yearsState: YearsCursor = ordersState.years ?? legacyYears ?? {};

      await progress("Amazon session verified; discovering years");
      const discoveredYears = await discoverYears(page);
      let years: number[];
      // Targeted-year override for spot checks and explicit backfills.
      // Bypasses incremental planning entirely.
      if (process.env.PDPP_AMAZON_YEARS) {
        const filter = new Set(process.env.PDPP_AMAZON_YEARS.split(",").map((y) => Number(y.trim())));
        years = discoveredYears.filter((y) => filter.has(y));
      } else {
        // Incremental planning: bound the year set so historical years with
        // prior scraped state are not re-scraped on every run.
        const currentYear = new Date().getFullYear();
        const { planned, skipped } = planIncrementalYears(discoveredYears, yearsState, currentYear);
        for (const { year, reason } of skipped) {
          await progress(`Skipping year ${year} (incremental: ${reason})`);
        }
        years = planned;
      }
      await progress(`Years to scrape: ${years.join(", ")}`);

      // Capture fixtures (gated on PDPP_CAPTURE_FIXTURES=1). One orders-list
      // page per year and one order-detail page overall is enough to drive
      // offline parser tests — more just bloats the fixture tree.
      const flags: RunFlags = { detailCaptured: false };
      const deps: EmitDeps = {
        capture,
        emit,
        emitRecord,
        emittedAt,
        progress,
        skipDetail: process.env.PDPP_AMAZON_SKIP_DETAIL === "1",
        wantsItems: requested.has("order_items"),
        wantsOrders: requested.has("orders"),
      };

      const newYearsState: YearsCursor = { ...yearsState };

      for (const year of years) {
        const prior = yearsState[String(year)];
        // Year-freezing: skip if already frozen
        if (prior?.frozen) {
          await progress(`Skipping year ${year} (frozen)`);
          continue;
        }

        const yearOrderCount = await runYear(page, deps, flags, year);

        // Year completion state with freeze-once-stable policy
        const stableCount = prior !== undefined && prior.order_count === yearOrderCount;
        newYearsState[String(year)] = {
          order_count: yearOrderCount,
          frozen: year < new Date().getFullYear() && stableCount,
          last_scraped: nowIso(),
        };
        await emit({
          type: "STATE",
          stream: "orders",
          cursor: { years: newYearsState },
        });
      }
    },
  });
}
