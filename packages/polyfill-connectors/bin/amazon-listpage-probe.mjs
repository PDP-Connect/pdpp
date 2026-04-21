#!/usr/bin/env node
// Catalogue data-component attributes on the Amazon Orders LIST page
// across historical eras. Run against 2025, 2015, 2008 to see how the
// layout has evolved.
//
// Outputs:
//   - unique data-component values found at card-level and inside cards
//   - first-card DOM snippet per year
//   - counts of order-card elements by selector variant

import { chromium } from 'patchright';
import { readFileSync } from 'node:fs';

// Attach to the warm isolated-amazon browser if possible; fall back to
// launching fresh.
const AMAZON_PROFILE_DIR = `${process.env.HOME}/.pdpp/profiles/amazon`;

// We'll use the isolated profile directly rather than CDP attach.
// Simpler; no daemon dependency.

const years = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [2025, 2015, 2008];

const context = await chromium.launchPersistentContext(AMAZON_PROFILE_DIR, {
  headless: true,
  channel: 'chrome',
  viewport: { width: 1280, height: 800 },
  args: ['--disable-features=DownloadBubble,DownloadBubbleV2,DownloadBubbleV3'],
});

const results = {};
for (const year of years) {
  const url = `https://www.amazon.com/your-orders/orders?timeFilter=year-${year}&startIndex=0`;
  console.error(`[probe] ${year}: ${url}`);
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);

  const snap = await page.evaluate(() => {
    const cardSelectors = [
      '.order-card',
      '.js-order-card',
      '[data-component="orderCard"]',
      '[data-component*="order" i]',
    ];
    const counts = {};
    for (const sel of cardSelectors) {
      try { counts[sel] = document.querySelectorAll(sel).length; } catch { counts[sel] = 'err'; }
    }

    // Find the first plausible order-card element
    const firstCard = document.querySelector('.order-card, .js-order-card, [data-component="orderCard"]');

    let firstCardDataComponents = [];
    let firstCardHtml = null;
    if (firstCard) {
      firstCardHtml = firstCard.outerHTML.slice(0, 2500);
      firstCardDataComponents = [...firstCard.querySelectorAll('[data-component]')].map(
        (el) => el.getAttribute('data-component')
      );
    }

    // All data-components on the whole page, grouped
    const allComponents = {};
    for (const el of document.querySelectorAll('[data-component]')) {
      const name = el.getAttribute('data-component');
      allComponents[name] = (allComponents[name] || 0) + 1;
    }

    // Plausible order-id pattern matches in body (sanity: did orders load?)
    const bodyPreview = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 300);
    const orderIdMatches = (document.body?.innerText || '').match(/\d{3}-\d{7}-\d{7}/g) || [];

    return {
      url: location.href,
      title: document.title,
      cardCounts: counts,
      firstCardDataComponents: [...new Set(firstCardDataComponents)].slice(0, 40),
      firstCardHtmlSnippet: firstCardHtml,
      pageLevelComponents: Object.fromEntries(
        Object.entries(allComponents).sort((a, b) => b[1] - a[1]).slice(0, 30)
      ),
      orderIdCount: orderIdMatches.length,
      distinctOrderIds: [...new Set(orderIdMatches)].slice(0, 5),
      bodyPreview,
    };
  });

  results[year] = snap;
  await page.close();
}

await context.close();
console.log(JSON.stringify(results, null, 2));
