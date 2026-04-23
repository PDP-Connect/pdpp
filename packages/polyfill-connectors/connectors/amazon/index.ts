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
import {
  type BrowserCollectContext,
  nowIso,
  politeDelay,
  type RecordData,
  runConnector,
  type ValidateRecord,
} from "../../src/connector-runtime.ts";
import { listPageOrderShape, validateRecord as validateRecordRaw } from "./schemas.ts";

const validateRecord = validateRecordRaw as ValidateRecord;

// ─── Parsed shapes ──────────────────────────────────────────────────────

interface ListPageItem {
  asin: string | null;
  name: string;
  url: string | null;
}

interface ListPageOrder {
  deliveryStatus: string | null;
  items: ListPageItem[];
  orderDateRaw: string | null;
  orderId: string;
  orderTotal: string | null;
}

interface DetailItem {
  asin: string | null;
  item_image_url: string | null;
  name: string;
  quantity: number;
  refund_status: string | null;
  seller: string | null;
  unit_price: string | null;
  url: string | null;
}

interface OrderDetail {
  digital_order: boolean;
  gift_order: boolean;
  grand_total: string | null;
  items: DetailItem[];
  payment_method_summary: string | null;
  recipient_name: string | null;
  shipping_address_summary: string | null;
  status_detail: string | null;
}

interface MergedItem {
  asin?: string | null;
  item_image_url?: string | null;
  name: string;
  quantity?: number | null;
  refund_status?: string | null;
  seller?: string | null;
  unit_price?: string | null;
  url?: string | null;
}

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

interface ListPageDiagnostics {
  any_card: number;
  any_order_header: number;
  body_preview: string;
  captcha: string;
  no_orders_text: string;
  order_cards: number;
  sign_in_form: boolean;
  title: string;
  url: string;
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
const CURRENCY_CENTS_MULTIPLIER = 100;

// Module-scoped regexes (Biome useTopLevelRegex)
const CURRENCY_NUMBER_RE = /(\d+(?:\.\d+)?)/;
const ITEM_ID_WHITESPACE_RE = /\s+/g;
const RETURNED_RE = /return/i;
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

  return page
    .evaluate((): OrderDetail | null => {
      // biome-ignore-start lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.
      const WHITESPACE_RE = /\s+/g;
      const CANCELLED_RE = /has been cancelled/i;
      const PAY_PREFIX_RE = /^Payment method\s*/i;
      const PAY_SUFFIX_RE = /\s*View related transactions.*$/i;
      const CARD_PATCH_RE =
        /(Visa|Mastercard|Amex|Discover|Diners|Unknown Credit Card|Credit Card|Debit Card)ending in/gi;
      const CARD_ONLY_RE =
        /((?:Visa|Mastercard|Amex|Discover|Diners|Unknown Credit Card|Credit Card|Debit Card) ending in \d{3,5})/i;
      const UNABLE_RE = /Unable to display payment details/i;
      const GRAND_TOTAL_RE = /Grand Total:?\s*\$([\d,]+\.\d{2})/i;
      const ASIN_RE = /\/(?:gp\/product|dp)\/([A-Z0-9]{10})/;
      const SOLD_BY_RE = /^Sold by:?\s*(.+)$/i;
      const DOLLAR_RE = /\$([\d,]+\.\d{2})/;
      const INT_RE = /^\d+$/;
      // biome-ignore-end lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.

      interface El {
        getAttribute: (name: string) => string | null;
        innerText?: string;
        parentElement: El | null;
        querySelector: (sel: string) => El | null;
        querySelectorAll: (sel: string) => El[];
      }

      const od = document.querySelector("#orderDetails") as El | null;
      if (!od) {
        return null;
      }

      const cancelledEl = od.querySelector('[data-component="cancelled"]');
      const cancelledText = (cancelledEl?.innerText || "").replace(WHITESPACE_RE, " ").trim();
      const isCancelled = CANCELLED_RE.test(cancelledText);

      // ── Shipping address (structural) ──────────────────────────────────
      const shipEl = od.querySelector('[data-component="shippingAddress"]');
      let recipient_name: string | null = null;
      let shipping_address_summary: string | null = null;
      if (shipEl) {
        const lines = [...shipEl.querySelectorAll("ul li span.a-list-item, ul li")]
          .map((li) => (li.innerText || "").replace(WHITESPACE_RE, " ").trim())
          .filter(Boolean);
        const first = lines[0];
        if (first && first.length < 80) {
          recipient_name = first;
        }
        if (lines.length) {
          shipping_address_summary = lines.join(", ").slice(0, 240);
        }
      }

      // ── Payment method (structural, with cleanup) ───────────────────────
      const payEl = od.querySelector('[data-component="viewPaymentPlanSummaryWidget"]');
      let payment_method_summary: string | null = null;
      if (payEl) {
        let raw = (payEl.innerText || "").replace(WHITESPACE_RE, " ").trim();
        raw = raw.replace(PAY_PREFIX_RE, "").replace(PAY_SUFFIX_RE, "").replace(CARD_PATCH_RE, "$1 ending in").trim();
        const cardOnly = raw.match(CARD_ONLY_RE);
        if (cardOnly?.[1]) {
          payment_method_summary = cardOnly[1];
        } else if (raw && !UNABLE_RE.test(raw)) {
          payment_method_summary = raw.slice(0, 200);
        }
      }

      // ── Grand total (structural) ───────────────────────────────────────
      let grand_total: string | null = null;
      const chargeEl = od.querySelector('[data-component="chargeSummary"]');
      if (chargeEl) {
        const rows = [...chargeEl.querySelectorAll("li, .od-line-item-row")];
        for (const r of rows) {
          const t = (r.innerText || "").replace(WHITESPACE_RE, " ");
          const m = t.match(GRAND_TOTAL_RE);
          if (m?.[1]) {
            grand_total = `$${m[1]}`;
            break;
          }
        }
        if (!grand_total) {
          const m = (chargeEl.innerText || "").replace(WHITESPACE_RE, " ").match(GRAND_TOTAL_RE);
          if (m?.[1]) {
            grand_total = `$${m[1]}`;
          }
        }
      }

      // ── Status detail (status banner only; delivery phrasing needs text) ─
      let status_detail: string | null = null;
      if (isCancelled) {
        status_detail = "This order has been cancelled";
      } else {
        const alertsEl = od.querySelector('[data-component="alerts"]');
        const alertText = (alertsEl?.innerText || "").replace(WHITESPACE_RE, " ").trim();
        if (alertText && alertText.length < 180) {
          status_detail = alertText;
        }
      }

      // ── Gift / digital flags ───────────────────────────────────────────
      const giftEl = od.querySelector(
        '[data-component="giftMessage"], [data-component="giftcardsSender"], [data-component="giftCardDetails"]'
      );
      const gift_order = Boolean(giftEl && (giftEl.innerText || "").trim());
      const digital_order = false;

      if (isCancelled) {
        return {
          status_detail,
          recipient_name: null,
          shipping_address_summary: null,
          payment_method_summary: null,
          grand_total: null,
          gift_order: false,
          digital_order: false,
          items: [],
        };
      }

      // ── Items (structural) ─────────────────────────────────────────────
      const itemContainers = [...od.querySelectorAll('[data-component="purchasedItemsRightGrid"]')];
      const items: DetailItem[] = [];
      for (const rightGrid of itemContainers) {
        let rowRoot: El | null = rightGrid;
        for (let i = 0; i < 5 && rowRoot; i++) {
          if (rowRoot.querySelector('[data-component="purchasedItemsLeftGrid"]')) {
            break;
          }
          rowRoot = rowRoot.parentElement;
        }
        const scanRoot: El = rowRoot || rightGrid;

        const titleEl = rightGrid.querySelector('[data-component="itemTitle"]');
        const titleLink = titleEl?.querySelector("a") ?? null;
        const name = (titleLink?.innerText || titleEl?.innerText || "").replace(WHITESPACE_RE, " ").trim();
        const href = titleLink?.getAttribute("href") || "";
        const asinM = href.match(ASIN_RE);
        const absoluteHref = href.startsWith("/") ? `https://www.amazon.com${href}` : href || null;

        const merchantEl = rightGrid.querySelector('[data-component="orderedMerchant"]');
        let seller: string | null = null;
        if (merchantEl) {
          const t = (merchantEl.innerText || "").replace(WHITESPACE_RE, " ").trim();
          const sm = t.match(SOLD_BY_RE);
          seller = sm?.[1] ? sm[1].trim().slice(0, 120) : t.slice(0, 120) || null;
        }

        const priceEl = rightGrid.querySelector('[data-component="unitPrice"]');
        let unit_price: string | null = null;
        if (priceEl) {
          const pt = (priceEl.innerText || "").replace(WHITESPACE_RE, " ").trim();
          const pm = pt.match(DOLLAR_RE);
          unit_price = pm?.[1] ? `$${pm[1]}` : null;
        }

        const qtyOverlayEl = scanRoot.querySelector(".od-item-view-qty span, .od-item-view-qty");
        const qtyOverlayText = (qtyOverlayEl?.innerText || "").trim();
        const quantity = INT_RE.test(qtyOverlayText) ? Number(qtyOverlayText) : 1;

        const img = scanRoot.querySelector(
          '[data-component="itemImage"] img, [data-component="purchasedItemsLeftGrid"] img'
        );
        const item_image_url = img?.getAttribute("src") || null;

        let refund_status: string | null = null;
        const returnEl = rightGrid.querySelector('[data-component="itemReturnEligibility"]');
        const returnText = (returnEl?.innerText || "").replace(WHITESPACE_RE, " ").trim();
        if (returnText && returnText.length < 180) {
          refund_status = returnText;
        }

        if (!(asinM?.[1] && name)) {
          continue;
        }

        items.push({
          asin: asinM[1],
          name: name.slice(0, 240),
          url: absoluteHref,
          unit_price,
          quantity,
          seller,
          item_image_url,
          refund_status,
        });
      }

      return {
        status_detail,
        recipient_name,
        shipping_address_summary,
        payment_method_summary,
        grand_total,
        gift_order,
        digital_order,
        items,
      };
    })
    .catch((): OrderDetail | null => null);
}

// ─── Per-page order extraction ────────────────────────────────────────────
function extractOrdersOnPage(page: Page): Promise<ListPageOrder[]> {
  return page
    .evaluate((): ListPageOrder[] => {
      // biome-ignore-start lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.
      const ORDER_ID_RE = /^\d{3}-\d{7}-\d{7}$/;
      const HEADER_DATE_RE = /^(ORDER PLACED|ORDER DATE|PLACED)$/i;
      const HEADER_TOTAL_RE = /^TOTAL$/i;
      const TOTAL_VALUE_RE = /^\$[\d,]+\.\d{2}$/;
      const ASIN_HREF_RE = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/;
      const WHITESPACE_RE = /\s+/g;
      // biome-ignore-end lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.

      const cards = [...document.querySelectorAll<HTMLElement>(".order-card, .js-order-card")];
      const results: ListPageOrder[] = [];
      for (const card of cards) {
        const orderIdEl = card.querySelector<HTMLElement>(".yohtmlc-order-id");
        const orderId = orderIdEl
          ? [...orderIdEl.querySelectorAll<HTMLElement>("span")]
              .map((s) => (s.innerText || "").trim())
              .find((t) => ORDER_ID_RE.test(t)) || null
          : null;
        if (!orderId) {
          continue;
        }

        const findHeaderValue = (labelPattern: RegExp): string | null => {
          for (const item of card.querySelectorAll<HTMLElement>(".order-header__header-list-item")) {
            const labelEl = item.querySelector<HTMLElement>(".a-color-secondary.a-text-caps");
            const label = (labelEl?.innerText || "").trim();
            if (!labelPattern.test(label)) {
              continue;
            }
            const valueEls = [...item.querySelectorAll<HTMLElement>("span")]
              .filter((s) => s !== labelEl)
              .map((s) => (s.innerText || "").trim())
              .filter(Boolean);
            return valueEls[0] || null;
          }
          return null;
        };

        const orderDateRaw = findHeaderValue(HEADER_DATE_RE);
        const totalRaw = findHeaderValue(HEADER_TOTAL_RE);
        const orderTotal = totalRaw && TOTAL_VALUE_RE.test(totalRaw) ? totalRaw : null;

        const primaryStatusEl = card.querySelector<HTMLElement>(
          ".yohtmlc-shipment-status-primaryText, .delivery-box__primary-text"
        );
        const deliveryStatus = primaryStatusEl
          ? (primaryStatusEl.innerText || "").replace(WHITESPACE_RE, " ").trim() || null
          : null;

        const items: ListPageItem[] = [];
        const seenAsins = new Set<string>();
        for (const titleEl of card.querySelectorAll<HTMLElement>(".yohtmlc-product-title")) {
          const name = (titleEl.innerText || "").replace(WHITESPACE_RE, " ").trim();
          if (!name) {
            continue;
          }
          const itemBox = titleEl.closest<HTMLElement>(".item-box, .a-fixed-left-grid") || titleEl.parentElement;
          const link = itemBox?.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]') || titleEl.querySelector("a");
          const href = link?.getAttribute("href") || "";
          const url = href.startsWith("/") ? `https://www.amazon.com${href}` : href || null;
          const asinMatch = href.match(ASIN_HREF_RE);
          const asin = asinMatch?.[1] ?? null;

          if (asin && seenAsins.has(asin)) {
            continue;
          }
          if (asin) {
            seenAsins.add(asin);
          }
          items.push({ name, url, asin });
        }

        results.push({
          orderId,
          orderDateRaw,
          orderTotal,
          deliveryStatus,
          items,
        });
      }
      return results;
    })
    .catch((): ListPageOrder[] => []);
}

function parseOrderDate(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d.toISOString().slice(0, 10);
}

function parseCurrencyCents(raw: string | null | undefined): number | null {
  if (!raw) {
    return null;
  }
  const m = String(raw).match(CURRENCY_NUMBER_RE);
  if (!m?.[1]) {
    return null;
  }
  return Math.round(Number(m[1]) * CURRENCY_CENTS_MULTIPLIER);
}

function itemId(orderId: string, it: { asin?: string | null; name?: string }): string {
  const key = it.asin || it.name?.toLowerCase().replace(ITEM_ID_WHITESPACE_RE, " ").trim() || "unknown";
  return `${orderId}|${key}`;
}

function mergeDetailByKey(detailItems: DetailItem[]): {
  byAsin: Map<string, DetailItem>;
  byName: Map<string, DetailItem>;
} {
  const byAsin = new Map<string, DetailItem>();
  const byName = new Map<string, DetailItem>();
  for (const di of detailItems) {
    if (di.asin) {
      byAsin.set(di.asin, di);
    } else if (di.name) {
      byName.set(di.name.trim().toLowerCase(), di);
    }
  }
  return { byAsin, byName };
}

// ─── Main ────────────────────────────────────────────────────────────────

runConnector({
  name: "amazon",
  validateRecord,
  // Amazon's bot detection fingerprints headless Chromium; cold sessions get
  // challenged. Opt into headed mode via PDPP_AMAZON_HEADLESS=0 (first-run,
  // re-auth). Warm sessions can go headless since cookies + TLS fingerprint
  // stay consistent across runs on the persistent profile.
  browser: { profileName: "amazon" },
  async ensureSession({ context, page, sendInteraction }): Promise<void> {
    await ensureAmazonSession({
      context,
      page,
      sendInteraction,
    });
    const deepOk = await deepSessionCheck(page);
    if (!deepOk) {
      throw new Error("amazon_session_required");
    }
  },
  async collect(ctx: BrowserCollectContext): Promise<void> {
    const { scope, state, emitRecord, emit, progress, capture, emittedAt } = ctx;
    const { page } = ctx;
    const requested = new Map((scope?.streams || []).map((s) => [s.name, s]));
    const wantsOrders = requested.has("orders");
    const wantsItems = requested.has("order_items");

    // STATE is stream-keyed per Collection Profile: `state` is
    // { <stream>: <cursor>, ... }. We write STATE stream='orders'
    // cursor={years:{...}}, so reads must go through state.orders.
    const ordersState = (state.orders ?? {}) as OrdersStateShape;
    const legacyYears = (state as { years?: YearsCursor }).years;
    const yearsState: YearsCursor = ordersState.years ?? legacyYears ?? {};

    await progress("Amazon session verified; discovering years");
    let years = await discoverYears(page);
    // Targeted-year override for spot checks and incremental backfills.
    if (process.env.PDPP_AMAZON_YEARS) {
      const filter = new Set(process.env.PDPP_AMAZON_YEARS.split(",").map((y) => Number(y.trim())));
      years = years.filter((y) => filter.has(y));
    }
    await progress(`Years to scrape: ${years.join(", ")}`);

    // Capture fixtures (gated on PDPP_CAPTURE_FIXTURES=1). One orders-list
    // page per year and one order-detail page overall is enough to drive
    // offline parser tests — more just bloats the fixture tree.
    let detailCaptured = false;

    const newYearsState: YearsCursor = { ...yearsState };

    for (const year of years) {
      const prior = yearsState[String(year)];
      // Year-freezing: skip if already frozen
      if (prior?.frozen) {
        await progress(`Skipping year ${year} (frozen)`);
        continue;
      }

      let startIndex = 0;
      let pageCount = 0;
      let yearOrderCount = 0;
      while (pageCount < PAGE_LIMIT) {
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
        const rawOrders = await extractOrdersOnPage(page);

        // Shape-check list-page extraction.
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
        if (orders.length === 0) {
          // Distinguish "no more orders" from "selectors missed the DOM".
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
          if (diag && (diag.any_card > 0 || diag.any_order_header > 0) && diag.order_cards === 0) {
            const shotPath = `/tmp/amazon-drift-${year}-${startIndex}.png`;
            await page.screenshot({ path: shotPath, fullPage: true }).catch((): undefined => undefined);
            await emit({
              type: "SKIP_RESULT",
              stream: "orders",
              reason: "selector_drift",
              message: `Year ${year} startIndex=${startIndex}: order containers visible on page but .order-card/.js-order-card selector matched 0. Screenshot=${shotPath}`,
              diagnostics: diag,
            });
          }
          break;
        }
        yearOrderCount += orders.length;

        for (const o of orders) {
          const orderDate = parseOrderDate(o.orderDateRaw);
          if (!orderDate) {
            continue;
          }

          // Navigate to the order-details page to enrich fields absent
          // from the list page.
          const skipDetail = process.env.PDPP_AMAZON_SKIP_DETAIL === "1";
          const detail: OrderDetail | null = skipDetail ? null : await fetchOrderDetail(page, o.orderId);
          if (capture && !(detailCaptured || skipDetail) && detail) {
            await capture.captureDom(page, `order-detail-${o.orderId}`);
            detailCaptured = true;
          }

          if (wantsOrders) {
            // Prefer detail-page Grand Total (includes tax); fall back to
            // the list-page total.
            const orderTotalRaw = detail?.grand_total || o.orderTotal || null;
            const orderRecord: RecordData = {
              id: o.orderId,
              order_date: orderDate,
              order_total: orderTotalRaw,
              order_total_cents: parseCurrencyCents(orderTotalRaw),
              delivery_status: o.deliveryStatus || null,
              status_detail: detail?.status_detail || null,
              recipient_name: detail?.recipient_name || null,
              shipping_address_summary: detail?.shipping_address_summary || null,
              payment_method_summary: detail?.payment_method_summary || null,
              gift_order: detail?.gift_order ?? false,
              digital_order: detail?.digital_order ?? false,
              item_count: Math.max(o.items.length, detail?.items?.length ?? 0),
              fetched_at: emittedAt,
            };
            await emitRecord("orders", orderRecord);
          }

          if (wantsItems) {
            const detailItems = detail?.items ?? [];
            const { byAsin: detailByAsin, byName: detailByName } = mergeDetailByKey(detailItems);
            const emittedItemIds = new Set<string>();
            const writeItem = async (merged: MergedItem): Promise<void> => {
              const id = itemId(o.orderId, merged);
              if (emittedItemIds.has(id)) {
                return;
              }
              emittedItemIds.add(id);
              await emitRecord("order_items", {
                id,
                order_id: o.orderId,
                order_date: orderDate,
                asin: merged.asin || null,
                name: merged.name,
                url: merged.url || null,
                unit_price: merged.unit_price || null,
                unit_price_cents: parseCurrencyCents(merged.unit_price ?? null),
                quantity: merged.quantity ?? 1,
                seller: merged.seller || null,
                item_image_url: merged.item_image_url || null,
                returned: RETURNED_RE.test(merged.refund_status || ""),
                refund_status: merged.refund_status || null,
              });
            };
            for (const it of o.items) {
              const d: Partial<DetailItem> =
                (it.asin ? detailByAsin.get(it.asin) : undefined) ||
                (it.name ? detailByName.get(it.name.trim().toLowerCase()) : undefined) ||
                {};
              await writeItem({ ...it, ...d });
            }
            // Detail-page items that weren't in the list.
            for (const di of detailItems) {
              const dupByAsin = di.asin && o.items.some((x) => x.asin === di.asin);
              const dupByName =
                di.name && o.items.some((x) => x.name?.trim().toLowerCase() === di.name.trim().toLowerCase());
              if (!(dupByAsin || dupByName)) {
                await writeItem(di);
              }
            }
          }
        }

        pageCount++;
        startIndex += START_INDEX_STEP;
        await politeDelay(POLITE_DELAY_MS);
      }

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
