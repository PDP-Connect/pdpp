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

import { createInterface } from 'node:readline';
import pRetry, { AbortError } from 'p-retry';
import { acquireIsolatedBrowser } from '../../src/browser-daemon.js';
import { resourceSet } from '../../src/scope-filters.js';
import { ensureAmazonSession } from '../../src/auto-login/amazon.js';
import { emitToStdout, stringifyForJsonl } from '../../src/safe-emit.js';
import { validateRecord, listPageOrderShape } from './schemas.js';

const rl = createInterface({ input: process.stdin, terminal: false });
// WHY emitToStdout: large RECORDs can exceed the 64 KB Linux pipe buffer and
// a bare process.stdout.write silently truncates when backpressured. See the
// Slack v0.3 crash at 2026-04-21T00:03 for the exact same failure mode.
function emit(msg) { return emitToStdout(msg); }
void stringifyForJsonl;
function flushAndExit(code) {
  if (process.stdout.writableLength > 0) {
    process.stdout.once('drain', () => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  } else process.exit(code);
}
function fail(m, retryable = false) {
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: m, retryable } });
  flushAndExit(1);
}
const nowIso = () => new Date().toISOString();
// Intentionally-named pacing delay for anti-bot-style throttling between
// requests. Distinct from `waitForX` sync primitives which wait for a
// page condition; this one's just polite inter-request slack. Use
// sparingly — prefer real sync primitives where possible.
const politeDelay = (ms) => new Promise((r) => setTimeout(r, ms));
let interactionCounter = 0;
const nextInteractionId = () => `int_${Date.now()}_${++interactionCounter}`;

async function sendInteractionAndWait(msg) {
  emit(msg);
  const reqId = msg.request_id;
  return new Promise((resolve, reject) => {
    const onLine = (line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'INTERACTION_RESPONSE' && parsed.request_id === reqId) {
          rl.off('line', onLine);
          resolve(parsed);
        }
      } catch (err) { reject(err); }
    };
    rl.on('line', onLine);
  });
}

// ─── Session probes ──────────────────────────────────────────────────────

async function deepSessionCheck(page) {
  await page.goto('https://www.amazon.com/your-orders/orders', { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Wait for either the orders page to render or a sign-in form (both are
  // valid post-nav states; we branch on them).
  await page.locator('form[name="signIn"], #orderTypeMenuContainer, #yourOrdersHeader, [data-component="orderCardList"]')
    .first().waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
  const url = page.url();
  if (/\/ap\/(signin|challenge|mfa)/.test(url)) return false;
  const loginForm = await page.locator('form[name="signIn"]').first().isVisible().catch(() => false);
  if (loginForm) return false;
  return /\/your-orders|\/order-history/.test(url);
}

// ─── Year discovery & pagination ─────────────────────────────────────────

async function discoverYears(page) {
  // Try select#time-filter first, then link patterns.
  const fromSelect = await page.evaluate(() => {
    const sel = document.querySelector('select#time-filter') || document.querySelector('select[name="timeFilter"]');
    if (!sel) return [];
    return [...sel.options].map((o) => o.value).filter(Boolean);
  }).catch(() => []);
  const fromLinks = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href*="timeFilter=year-"]')];
    return links.map((a) => a.getAttribute('href')).filter(Boolean);
  }).catch(() => []);
  const years = new Set();
  for (const v of [...fromSelect, ...fromLinks]) {
    const m = /year-(\d{4})/.exec(v);
    if (m) years.add(Number(m[1]));
  }
  const current = new Date().getFullYear();
  if (!years.size) years.add(current);
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
async function fetchOrderDetail(page, orderId) {
  const url = `https://www.amazon.com/gp/your-account/order-details?orderID=${orderId}`;

  // Retry transient navigation failures (network, timeout, 5xx) with
  // exponential backoff. AbortError bypasses retries — we use it for the
  // "Amazon redirected us to a non-detail URL" signal (e.g. Amazon Fresh
  // orders that redirect to /uff/... with no #orderDetails), which retrying
  // won't fix.
  try {
    await pRetry(async () => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Wait for #orderDetails to appear OR for the cancellation/redirect
      // page signature. waitForSelector replaces `await sleep(800)` —
      // real sync primitive instead of a pacing guess.
      await page.waitForSelector('#orderDetails, [data-component="cancelled"]', {
        timeout: 15000,
        state: 'attached',
      });
    }, {
      retries: 2,
      minTimeout: 1500,
      factor: 2,
      shouldRetry: (err) => !(err instanceof AbortError) && /timeout|ECONN|ETIMEDOUT|net::|5\d\d/i.test(err.message),
    });
  } catch {
    return null;
  }

  return page.evaluate(() => {
    const od = document.querySelector('#orderDetails');
    if (!od) return null;

    // ── Cancellation detection ──────────────────────────────────────────
    // data-component="cancelled" is always present, but only has content
    // on cancelled orders. Also check breadcrumb text as a fallback.
    const cancelledEl = od.querySelector('[data-component="cancelled"]');
    const cancelledText = (cancelledEl?.innerText || '').replace(/\s+/g, ' ').trim();
    const isCancelled = /has been cancelled/i.test(cancelledText);

    // ── Shipping address (structural) ──────────────────────────────────
    // Shape: <div data-component="shippingAddress">
    //          <h5>Ship to</h5>
    //          <ul>
    //            <li><span>Recipient Name</span></li>
    //            <li><span>Street (multi-line via <br>)</span></li>
    //            <li><span>Country</span></li>
    //          </ul>
    //        </div>
    const shipEl = od.querySelector('[data-component="shippingAddress"]');
    let recipient_name = null;
    let shipping_address_summary = null;
    if (shipEl) {
      const lines = [...shipEl.querySelectorAll('ul li span.a-list-item, ul li')]
        .map((li) => (li.innerText || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      if (lines.length >= 1 && lines[0] && lines[0].length < 80) {
        recipient_name = lines[0];
      }
      if (lines.length) {
        shipping_address_summary = lines.join(', ').slice(0, 240);
      }
    }

    // ── Payment method (structural, with cleanup) ───────────────────────
    // Shape: <div data-component="viewPaymentPlanSummaryWidget">
    //          <h5>Payment method</h5>
    //          <div>... Visa ending in 8662 ...</div>
    //        </div>
    // innerText collapses the <script> blob inside, leaving user-facing
    // text only. "Visaending in" without a space is how innerText concats
    // <span>Visa</span>ending in — we patch that.
    const payEl = od.querySelector('[data-component="viewPaymentPlanSummaryWidget"]');
    let payment_method_summary = null;
    if (payEl) {
      let raw = (payEl.innerText || '').replace(/\s+/g, ' ').trim();
      raw = raw
        .replace(/^Payment method\s*/i, '')
        .replace(/\s*View related transactions.*$/i, '')
        .replace(/(Visa|Mastercard|Amex|Discover|Diners|Unknown Credit Card|Credit Card|Debit Card)ending in/gi, '$1 ending in')
        .trim();
      // Prefer the card summary if present (most common case). This drops
      // secondary cruft like "Do not apply equal monthly payments" and
      // "Amazon gift card balance" (unless card is absent, in which case
      // the gift card IS the payment method and we keep it).
      const cardOnly = raw.match(/((?:Visa|Mastercard|Amex|Discover|Diners|Unknown Credit Card|Credit Card|Debit Card) ending in \d{3,5})/i);
      if (cardOnly) {
        payment_method_summary = cardOnly[1];
      } else if (raw && !/Unable to display payment details/i.test(raw)) {
        payment_method_summary = raw.slice(0, 200);
      }
    }

    // ── Grand total (structural) ───────────────────────────────────────
    // chargeSummary contains the full Order Summary; we pick the Grand
    // Total row specifically. The label + amount live in sibling <span>s.
    let grand_total = null;
    const chargeEl = od.querySelector('[data-component="chargeSummary"]');
    if (chargeEl) {
      // Find the row whose label contains "Grand Total". Amazon uses
      // od-line-item-row containers.
      const rows = [...chargeEl.querySelectorAll('li, .od-line-item-row')];
      for (const r of rows) {
        const t = (r.innerText || '').replace(/\s+/g, ' ');
        const m = t.match(/Grand Total:?\s*\$([\d,]+\.\d{2})/i);
        if (m) { grand_total = `$${m[1]}`; break; }
      }
      // Last-resort: regex on the summary innerText
      if (!grand_total) {
        const m = (chargeEl.innerText || '').replace(/\s+/g, ' ').match(/Grand Total:?\s*\$([\d,]+\.\d{2})/i);
        if (m) grand_total = `$${m[1]}`;
      }
    }

    // ── Status detail (status banner only; delivery phrasing needs text) ─
    let status_detail = null;
    if (isCancelled) {
      status_detail = 'This order has been cancelled';
    } else {
      // For non-cancelled orders, delivery/arriving status lives on the
      // list page (already captured in delivery_status). Detail page may
      // carry richer phrasing in future; for now we leave null when there's
      // no cancellation banner.
      const alertsEl = od.querySelector('[data-component="alerts"]');
      const alertText = (alertsEl?.innerText || '').replace(/\s+/g, ' ').trim();
      if (alertText && alertText.length < 180) status_detail = alertText;
    }

    // ── Gift / digital flags ───────────────────────────────────────────
    // data-component="giftMessage" is present+non-empty only on gift orders.
    const giftEl = od.querySelector('[data-component="giftMessage"], [data-component="giftcardsSender"], [data-component="giftCardDetails"]');
    const gift_order = !!(giftEl && (giftEl.innerText || '').trim());
    // Digital orders have distinct surfaces (Kindle, Prime Video, etc.) —
    // we don't have a single data-component for this yet. Leave false as
    // default; future work: probe a known digital order for its markers.
    const digital_order = false;

    // ── Cancelled shortcut: emit status only ───────────────────────────
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
    // Each item is wrapped in [data-component="purchasedItemsRightGrid"]
    // (title, seller, price, quantity live inside as named children).
    // The image lives in the sibling [data-component="purchasedItemsLeftGrid"].
    // Together they're contained in a .a-fixed-left-grid-inner or similar.
    const itemContainers = [...od.querySelectorAll('[data-component="purchasedItemsRightGrid"]')];
    const items = [];
    for (const rightGrid of itemContainers) {
      // Walk up to find the full row (containing both Left and Right grids)
      // so we can reach the image too.
      let rowRoot = rightGrid;
      for (let i = 0; i < 5 && rowRoot; i++) {
        if (rowRoot.querySelector('[data-component="purchasedItemsLeftGrid"]')) break;
        rowRoot = rowRoot.parentElement;
      }
      const scanRoot = rowRoot || rightGrid;

      const titleEl = rightGrid.querySelector('[data-component="itemTitle"]');
      const titleLink = titleEl?.querySelector('a');
      const name = (titleLink?.innerText || titleEl?.innerText || '').replace(/\s+/g, ' ').trim();
      const href = titleLink?.getAttribute('href') || '';
      const asinM = href.match(/\/(?:gp\/product|dp)\/([A-Z0-9]{10})/);
      const absoluteHref = href.startsWith('/') ? 'https://www.amazon.com' + href : (href || null);

      const merchantEl = rightGrid.querySelector('[data-component="orderedMerchant"]');
      let seller = null;
      if (merchantEl) {
        // Shape: "Sold by: <seller>" — strip the prefix.
        const t = (merchantEl.innerText || '').replace(/\s+/g, ' ').trim();
        const sm = t.match(/^Sold by:?\s*(.+)$/i);
        seller = sm ? sm[1].trim().slice(0, 120) : (t.slice(0, 120) || null);
      }

      const priceEl = rightGrid.querySelector('[data-component="unitPrice"]');
      let unit_price = null;
      if (priceEl) {
        // innerText is "$15.54 $15.54" (visible + a-offscreen dup). Take first.
        const pt = (priceEl.innerText || '').replace(/\s+/g, ' ').trim();
        const pm = pt.match(/\$([\d,]+\.\d{2})/);
        unit_price = pm ? `$${pm[1]}` : null;
      }

      // Quantity: the data-component="quantity" element is empty even for
      // multi-qty; qty comes from .od-item-view-qty (image overlay) which
      // lives in the Left grid.
      const qtyOverlayEl = scanRoot.querySelector('.od-item-view-qty span, .od-item-view-qty');
      const qtyOverlayText = (qtyOverlayEl?.innerText || '').trim();
      const quantity = /^\d+$/.test(qtyOverlayText) ? Number(qtyOverlayText) : 1;

      // Image from the Left grid
      const img = scanRoot.querySelector('[data-component="itemImage"] img, [data-component="purchasedItemsLeftGrid"] img');
      const item_image_url = img?.getAttribute('src') || null;

      // Refund status: lives in [data-component="itemReturnEligibility"]
      // when present; otherwise scan rightGrid text for a return/refund
      // phrase. Narrow fallback — only accept a short phrase after "Return"
      // or "Refund" to avoid pulling action-button text.
      let refund_status = null;
      const returnEl = rightGrid.querySelector('[data-component="itemReturnEligibility"]');
      const returnText = (returnEl?.innerText || '').replace(/\s+/g, ' ').trim();
      if (returnText && returnText.length < 180) refund_status = returnText;

      if (!asinM || !name) continue; // shape-check: drop rows with no asin or no name

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
  }).catch(() => null);
}

// ─── Per-page order extraction ────────────────────────────────────────────
// Structural extraction per docs/connector-authoring-guide.md §2. The
// Amazon list page does NOT use `data-component` attributes (that's
// detail-page-only), but it DOES use stable `yohtmlc-*` CSS classes
// (Amazon's internal "Your Orders HTML Component" markers). Verified
// consistent across 2008, 2015, and 2025 via bin/amazon-listcard-yohtmlc-probe.mjs.
//
// Stable selectors used:
//   .yohtmlc-order-id                            — order ID block
//   .yohtmlc-product-title                       — item titles
//   .yohtmlc-shipment-status-primaryText         — delivery status
//   .order-header__header-list-item              — header rows (labeled)
//
// Locale note: we match header-row LABELS by text (ORDER PLACED / TOTAL).
// On non-EN Amazon locales those labels would be translated. For now US/EN
// only, consistent with connector's scoped support. When multi-locale lands,
// replace label regex with structural-position matching (1st header row is
// always date, 2nd is always ID, etc.).
async function extractOrdersOnPage(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('.order-card, .js-order-card')];
    return cards.map((card) => {
      // ── order_id ─────────────────────────────────────────────────────
      // .yohtmlc-order-id contains "<span>ORDER #</span> <span>ID</span>"
      // (and possibly more). Pick the span whose text matches the
      // canonical N-NNNNNNN-NNNNNNN pattern.
      const orderIdEl = card.querySelector('.yohtmlc-order-id');
      const orderId = orderIdEl
        ? [...orderIdEl.querySelectorAll('span')]
            .map((s) => (s.innerText || '').trim())
            .find((t) => /^\d{3}-\d{7}-\d{7}$/.test(t)) || null
        : null;
      if (!orderId) return null;

      // Helper: find a header row by its LABEL, return the VALUE span text.
      // Header rows have shape:
      //   <li class="order-header__header-list-item">
      //     <span class="a-color-secondary a-text-caps">LABEL</span>
      //     <span class="a-size-base ...">VALUE</span>
      //   </li>
      const findHeaderValue = (labelPattern) => {
        for (const item of card.querySelectorAll('.order-header__header-list-item')) {
          const labelEl = item.querySelector('.a-color-secondary.a-text-caps');
          const label = (labelEl?.innerText || '').trim();
          if (!labelPattern.test(label)) continue;
          // Value = first descendant text that ISN'T the label itself.
          // Amazon uses varied class combos; structural "non-label text" is more durable.
          const valueEls = [...item.querySelectorAll('span')]
            .filter((s) => s !== labelEl)
            .map((s) => (s.innerText || '').trim())
            .filter(Boolean);
          return valueEls[0] || null;
        }
        return null;
      };

      // ── order_date ───────────────────────────────────────────────────
      const orderDateRaw = findHeaderValue(/^(ORDER PLACED|ORDER DATE|PLACED)$/i);

      // ── order_total ──────────────────────────────────────────────────
      // Only present on very old (pre-2015) list pages. Modern orders
      // leave this null and the detail-page fetch populates it.
      const totalRaw = findHeaderValue(/^TOTAL$/i);
      const orderTotal = totalRaw && /^\$[\d,]+\.\d{2}$/.test(totalRaw) ? totalRaw : null;

      // ── delivery_status ──────────────────────────────────────────────
      const primaryStatusEl = card.querySelector(
        '.yohtmlc-shipment-status-primaryText, .delivery-box__primary-text'
      );
      const deliveryStatus = primaryStatusEl
        ? (primaryStatusEl.innerText || '').replace(/\s+/g, ' ').trim() || null
        : null;

      // ── items ────────────────────────────────────────────────────────
      // One .yohtmlc-product-title per item. Each sits within an .item-box
      // that also contains the product image link.
      const items = [];
      const seenAsins = new Set();
      for (const titleEl of card.querySelectorAll('.yohtmlc-product-title')) {
        const name = (titleEl.innerText || '').replace(/\s+/g, ' ').trim();
        if (!name) continue;

        // ASIN via the nearest product-link anchor in this item's scope.
        const itemBox = titleEl.closest('.item-box, .a-fixed-left-grid') || titleEl.parentElement;
        const link = itemBox?.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]')
          || titleEl.querySelector('a');
        const href = link?.getAttribute('href') || '';
        const url = href.startsWith('/') ? 'https://www.amazon.com' + href : (href || null);
        const asinMatch = href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/);
        const asin = asinMatch ? asinMatch[1] : null;

        if (asin && seenAsins.has(asin)) continue;
        if (asin) seenAsins.add(asin);
        items.push({ name, url, asin });
      }

      return { orderId, orderDateRaw, orderTotal, deliveryStatus, items };
    }).filter(Boolean);
  }).catch(() => []);
}

function parseOrderDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function parseCurrencyCents(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Math.round(Number(m[1]) * 100);
}

function itemId(orderId, it) {
  const key = it.asin || it.name?.toLowerCase().replace(/\s+/g, ' ').trim() || 'unknown';
  return `${orderId}|${key}`;
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  const startMsg = await new Promise((resolve, reject) => {
    rl.once('line', (line) => { try { resolve(JSON.parse(line)); } catch (e) { reject(e); } });
  });
  if (startMsg.type !== 'START') return fail('Expected START');

  const requested = new Map((startMsg.scope?.streams || []).map((s) => [s.name, s]));
  if (!requested.size) return fail('START.scope.streams is required');

  const wantsOrders = requested.has('orders');
  const wantsItems = requested.has('order_items');

  const state = startMsg.state || {};
  // STATE is stream-keyed per Collection Profile: `state` is
  // { <stream>: <cursor>, ... }. We write STATE stream='orders'
  // cursor={years:{...}}, so reads must go through state.orders.
  const yearsState = state.orders?.years || state.years || {};
  const emittedAt = nowIso();
  let totalEmitted = 0;
  let totalSkipped = 0;
  const resFilters = new Map();
  for (const [n, r] of requested) resFilters.set(n, resourceSet(r));

  // Shape-check per docs/connector-authoring-guide.md §3. Records that
  // fail the Zod schema become SKIP_RESULT instead of poisoning the RS
  // with garbage-that-looks-right. Schemas live in ./schemas.js.
  const emitRecord = async (stream, data) => {
    if (data.id == null) return;
    const rs = resFilters.get(stream);
    if (rs && !rs.has(String(data.id))) return;
    const result = validateRecord(stream, data);
    if (!result.ok) {
      totalSkipped++;
      await emit({
        type: 'SKIP_RESULT',
        stream,
        reason: 'shape_check_failed',
        message: `${data.id}: ${result.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
        diagnostics: { id: data.id, issues: result.issues, record: data },
      });
      return;
    }
    await emit({ type: 'RECORD', stream, key: data.id, data, emitted_at: emittedAt });
    totalEmitted++;
  };

  let context;
  let release = async () => {};
  // Amazon's bot detection fingerprints the headless Chromium build and will
  // challenge/captcha on cold sessions. Opt into headed mode for first-run and
  // re-auth flows via PDPP_AMAZON_HEADLESS=0; subsequent runs on a warm session
  // can go headless since cookies + TLS fingerprint stay consistent through
  // the daemon. Default headless=true to match other connectors' behavior.
  const headless = process.env.PDPP_AMAZON_HEADLESS !== '0';
  // Use the isolated-per-connector browser path (patchright-launched,
  // persistent profile at ~/.pdpp/profiles/amazon/). This:
  //   - gets FULL patchright stealth (launch-side + client-side) because
  //     we import patchright directly in acquireIsolatedBrowser
  //   - persists auth/cookies/trusted-device across runs via the on-disk
  //     profile dir
  //   - enables concurrent runs with other connectors (no shared lock)
  // See docs/connector-authoring-guide.md §2.
  try {
    ({ context, release } = await acquireIsolatedBrowser({ profileName: 'amazon', headless }));
  } catch (err) {
    return fail(`could not open browser profile: ${err.message}`, false);
  }

  // Tracing (Playwright feature). Gated behind PDPP_TRACE=1. Produces a
  // .zip replayable in the Playwright Inspector — invaluable for debugging
  // silent scraper failures where a record goes missing deep in a multi-
  // hour run. See docs/connector-authoring-guide.md §9.
  const tracingEnabled = process.env.PDPP_TRACE === '1';
  if (tracingEnabled) {
    const traceName = `amazon-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await context.tracing.start({
      name: traceName,
      screenshots: true,
      snapshots: true,
      sources: true,
    }).catch(() => {});
    emit({ type: 'PROGRESS', message: `tracing enabled (PDPP_TRACE=1); will write /tmp/${traceName}.zip on exit` });
  }

  try {
    const page = await context.newPage();

    // Automated session management: probe + login with stored creds, OTP via
    // INTERACTION when 2FA is required (ntfy → the owner's phone → forwarded
    // from wife's phone).
    try {
      await ensureAmazonSession({ context, page, sendInteractionAndWait, nextInteractionId });
    } catch (e) {
      return fail(`amazon_session_failed: ${e.message}`, false);
    }

    // Verify post-login with deep check
    const deepOk = await deepSessionCheck(page);
    if (!deepOk) return fail('amazon_session_required', false);

    emit({ type: 'PROGRESS', message: 'Amazon session verified; discovering years' });
    let years = await discoverYears(page);
    // Targeted-year override for spot checks and incremental backfills.
    // Accepts a comma-separated list, e.g. PDPP_AMAZON_YEARS=2025,2024.
    if (process.env.PDPP_AMAZON_YEARS) {
      const filter = new Set(process.env.PDPP_AMAZON_YEARS.split(',').map((y) => Number(y.trim())));
      years = years.filter((y) => filter.has(y));
    }
    emit({ type: 'PROGRESS', message: `Years to scrape: ${years.join(', ')}` });

    const newYearsState = { ...yearsState };

    for (const year of years) {
      const prior = yearsState[String(year)];
      // Year-freezing: skip if already frozen
      if (prior?.frozen) {
        emit({ type: 'PROGRESS', message: `Skipping year ${year} (frozen)` });
        continue;
      }

      let startIndex = 0;
      let pageCount = 0;
      let yearOrderCount = 0;
      while (pageCount < 50) {
        const url = `https://www.amazon.com/your-orders/orders?timeFilter=year-${year}&startIndex=${startIndex}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        // Wait for list-page signal. `.order-card` is the standard container
        // in modern layouts; `#ordersContainer` catches legacy. Either appears
        // when the orders list has rendered.
        await page.locator('.order-card, .js-order-card, #ordersContainer, #no-orders')
          .first().waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
        const rawOrders = await extractOrdersOnPage(page);

        // Shape-check list-page extraction. A selector drift that produces
        // malformed orderId / bad orderDateRaw / missing items would otherwise
        // cascade silently. Drop any card that fails, but emit SKIP_RESULT
        // so the drift is visible.
        const orders = [];
        for (const r of rawOrders) {
          const parsed = listPageOrderShape.safeParse(r);
          if (parsed.success) {
            orders.push(parsed.data);
          } else {
            emit({
              type: 'SKIP_RESULT',
              stream: 'orders',
              reason: 'list_page_shape_check_failed',
              message: `list card ${r.orderId ?? '<no id>'}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
              diagnostics: { card: r, issues: parsed.error.issues },
            });
          }
        }
        if (!orders.length) {
          // Distinguish "no more orders" from "selectors missed the DOM".
          // If Amazon's UI shipped a new order-card class and our regex
          // doesn't match, we'd otherwise silently terminate the year and
          // emit a green DONE with zero records. Probe for any plausible
          // order container to diagnose.
          const diag = await page.evaluate(() => {
            const dom = {
              url: location.href,
              title: document.title,
              order_cards: document.querySelectorAll('div.order-card, div.js-order-card').length,
              any_card: document.querySelectorAll('[class*="order" i][class*="card" i]').length,
              any_order_header: document.querySelectorAll('[class*="order" i][class*="header" i]').length,
              sign_in_form: !!document.querySelector('form[name="signIn"]'),
              captcha: /captcha|robot|unusual traffic/i.test(document.body?.innerText || '').toString(),
              no_orders_text: /you have not placed any orders|no orders found/i.test(document.body?.innerText || '').toString(),
              body_preview: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 240),
            };
            return dom;
          }).catch(() => null);
          if (diag && (diag.any_card > 0 || diag.any_order_header > 0) && diag.order_cards === 0) {
            // Real orders exist but our selectors missed them. This is a
            // drift signal, not end-of-year. Screenshot + emit SKIP_RESULT
            // with diag so the next iteration has evidence.
            const shotPath = `/tmp/amazon-drift-${year}-${startIndex}.png`;
            await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
            emit({
              type: 'SKIP_RESULT',
              stream: 'orders',
              reason: 'selector_drift',
              message: `Year ${year} startIndex=${startIndex}: order containers visible on page but .order-card/.js-order-card selector matched 0. Screenshot=${shotPath}`,
              diagnostics: diag,
            });
          }
          break;
        }
        yearOrderCount += orders.length;

        for (const o of orders) {
          const orderDate = parseOrderDate(o.orderDateRaw);
          if (!orderDate) continue;

          // Navigate to the order-details page to enrich the fields that
          // the list page doesn't expose (payment method, shipping address,
          // per-item unit price + quantity + seller + refund status). Skip
          // the detail fetch entirely when PDPP_AMAZON_SKIP_DETAIL=1 is set
          // (useful for quick partial runs on a big history).
          const skipDetail = process.env.PDPP_AMAZON_SKIP_DETAIL === '1';
          const detail = skipDetail ? null : await fetchOrderDetail(page, o.orderId);

          if (wantsOrders) {
            // Prefer detail-page Grand Total (includes tax); fall back to
            // the list-page total, which sometimes shows pre-tax amount.
            const orderTotalRaw = detail?.grand_total || o.orderTotal || null;
            await emitRecord('orders', {
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
              item_count: Math.max(o.items.length, detail?.items?.length || 0),
              fetched_at: emittedAt,
            });
          }

          if (wantsItems) {
            // Prefer detail-page items when available (they carry price/qty/
            // seller/refund). Fall back to list-page items for coverage.
            const detailItems = detail?.items || [];
            const detailByAsin = new Map();
            const detailByName = new Map();
            for (const di of detailItems) {
              if (di.asin) detailByAsin.set(di.asin, di);
              else if (di.name) detailByName.set(di.name.trim().toLowerCase(), di);
            }
            const emittedItemIds = new Set();
            const writeItem = async (merged) => {
              const id = itemId(o.orderId, merged);
              if (emittedItemIds.has(id)) return;
              emittedItemIds.add(id);
              await emitRecord('order_items', {
                id,
                order_id: o.orderId,
                order_date: orderDate,
                asin: merged.asin || null,
                name: merged.name,
                url: merged.url || null,
                unit_price: merged.unit_price || null,
                unit_price_cents: parseCurrencyCents(merged.unit_price),
                quantity: merged.quantity ?? 1,
                seller: merged.seller || null,
                item_image_url: merged.item_image_url || null,
                returned: /return/i.test(merged.refund_status || ''),
                refund_status: merged.refund_status || null,
              });
            };
            for (const it of o.items) {
              const d = (it.asin && detailByAsin.get(it.asin))
                || (it.name && detailByName.get(it.name.trim().toLowerCase()))
                || {};
              await writeItem({ ...it, ...d });
            }
            // Detail-page items that weren't in the list (rare — Amazon
            // sometimes hides long item lists behind "Show more" on the
            // list page).
            for (const di of detailItems) {
              const dupByAsin = di.asin && o.items.some((x) => x.asin === di.asin);
              const dupByName = di.name && o.items.some((x) => x.name?.trim().toLowerCase() === di.name.trim().toLowerCase());
              if (!dupByAsin && !dupByName) await writeItem(di);
            }
          }
        }

        pageCount++;
        startIndex += 10;
        await politeDelay(800);
      }

      // Year completion state with freeze-once-stable policy
      const stableCount = prior && prior.order_count === yearOrderCount;
      newYearsState[String(year)] = {
        order_count: yearOrderCount,
        frozen: year < new Date().getFullYear() && stableCount,
        last_scraped: nowIso(),
      };
      emit({ type: 'STATE', stream: 'orders', cursor: { years: newYearsState } });
    }
  } finally {
    if (tracingEnabled && context) {
      const tracePath = `/tmp/amazon-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
      try {
        await context.tracing.stop({ path: tracePath });
        emit({ type: 'PROGRESS', message: `trace written to ${tracePath} — replay with: npx playwright show-trace ${tracePath}` });
      } catch (err) {
        emit({ type: 'PROGRESS', message: `failed to write trace: ${err.message}` });
      }
    }
    await release().catch(() => {});
  }

  if (totalSkipped > 0) {
    emit({ type: 'PROGRESS', message: `shape-check skipped ${totalSkipped} record(s); see SKIP_RESULT events above` });
  }
  emit({ type: 'DONE', status: 'succeeded', records_emitted: totalEmitted });
  flushAndExit(0);
}

main().catch((e) => {
  const msg = e && e.message ? e.message : String(e);
  const retryable = /ECONN|ETIMEDOUT|timeout/i.test(msg);
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: msg, retryable } });
  flushAndExit(1);
});
