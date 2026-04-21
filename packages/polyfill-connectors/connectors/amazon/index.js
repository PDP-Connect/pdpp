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
import { acquireBrowser } from '../../src/browser-profile.js';
import { resourceSet } from '../../src/scope-filters.js';
import { ensureAmazonSession } from '../../src/auto-login/amazon.js';
import { emitToStdout, stringifyForJsonl } from '../../src/safe-emit.js';

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

async function quickSessionCheck(page) {
  await page.goto('https://www.amazon.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);
  const url = page.url();
  if (/\/ap\/(signin|challenge|mfa)/.test(url)) return false;
  const greeting = await page.locator('#nav-link-accountList').first().innerText().catch(() => '');
  return /Hello/i.test(greeting) && !/Sign in/i.test(greeting);
}

async function deepSessionCheck(page) {
  await page.goto('https://www.amazon.com/your-orders/orders', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2500);
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
// PLACEHOLDER. The list-page scrape cannot populate status_detail,
// recipient_name, shipping_address_summary, payment_method_summary,
// gift_order, digital_order, nor per-item unit_price/quantity/seller/
// refund_status. Those live on the order-details page at
// /gp/your-account/order-details?orderID=X. Implementation is intentionally
// deferred until a live DOM probe of the order-details page so selectors
// reflect observed reality, not training-data guesses. The manifest
// declares these fields; for now they're null in the emitted records. See
// `design-notes/amazon.md` Section "Order-details-page streams" for the
// scope note.
async function fetchOrderDetail(_page, _orderId) {
  return null;
}

// ─── Per-page order extraction ────────────────────────────────────────────

async function extractOrdersOnPage(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('div.order-card, div.js-order-card')];
    return cards.map((card) => {
      const text = card.innerText || '';
      const idMatch = text.match(/\d{3}-\d{7}-\d{7}/);
      if (!idMatch) return null;
      const orderId = idMatch[0];

      const dateMatch = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/);
      const orderDateRaw = dateMatch ? dateMatch[0] : null;

      let total = null;
      const totalMatch = text.match(/(?:Total|ORDER TOTAL)[\s\S]{0,20}?(\$[\d,.]+)/i);
      if (totalMatch) total = totalMatch[1];
      if (!total) {
        const anyMoney = text.match(/\$\d+\.\d{2}/);
        if (anyMoney) total = anyMoney[0];
      }

      const statusMatch = text.match(/(?:Delivered|Arriving|Shipped|Out for delivery|Return|Refund|Cancelled)(\s[^\n]*)?/);
      const deliveryStatus = statusMatch ? statusMatch[0].split('\n')[0].trim() : null;

      const itemLinks = [...card.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]')];
      const seen = new Set();
      const items = [];
      for (const a of itemLinks) {
        const name = (a.textContent || '').replace(/\s+/g, ' ').trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        let href = a.getAttribute('href') || '';
        if (href.startsWith('/')) href = 'https://www.amazon.com' + href;
        const asinMatch = href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/);
        items.push({ name, url: href, asin: asinMatch ? asinMatch[1] : null });
      }

      return {
        orderId,
        orderDateRaw,
        orderTotal: total,
        deliveryStatus,
        items,
      };
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
  const yearsState = state.years || {};
  const emittedAt = nowIso();
  let totalEmitted = 0;
  const resFilters = new Map();
  for (const [n, r] of requested) resFilters.set(n, resourceSet(r));
  const emitRecord = async (stream, data) => {
    if (data.id == null) return;
    const rs = resFilters.get(stream);
    if (rs && !rs.has(String(data.id))) return;
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
  try {
    ({ context, release } = await acquireBrowser({ headless }));
  } catch (err) {
    return fail(`could not open browser profile: ${err.message}`, false);
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
    const years = await discoverYears(page);
    emit({ type: 'PROGRESS', message: `Years discovered: ${years.join(', ')}` });

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
        await sleep(2000);
        const orders = await extractOrdersOnPage(page);
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
            await emitRecord('orders', {
              id: o.orderId,
              order_date: orderDate,
              order_total: o.orderTotal || null,
              order_total_cents: parseCurrencyCents(o.orderTotal),
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
        await sleep(1500);
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
    await release().catch(() => {});
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
