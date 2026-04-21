#!/usr/bin/env node
// Probe: are yohtmlc-* classes consistently available on .order-card
// elements across 2025, 2015, 2008?

import { chromium } from 'patchright';

const AMAZON_PROFILE_DIR = `${process.env.HOME}/.pdpp/profiles/amazon`;

const context = await chromium.launchPersistentContext(AMAZON_PROFILE_DIR, {
  headless: true,
  channel: 'chrome',
  viewport: { width: 1280, height: 800 },
  args: ['--disable-features=DownloadBubble,DownloadBubbleV2,DownloadBubbleV3'],
});

const years = [2025, 2015, 2008];
const results = {};

for (const year of years) {
  const page = await context.newPage();
  await page.goto(`https://www.amazon.com/your-orders/orders?timeFilter=year-${year}&startIndex=0`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.locator('.order-card').first().waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});

  const snap = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.order-card, .js-order-card')];
    const cardCount = cards.length;
    if (!cardCount) return { cardCount, firstCard: null };

    const card = cards[0];

    // Probe for each field we want to extract
    const getText = (el) => (el?.innerText || '').replace(/\s+/g, ' ').trim();

    // Order ID: .yohtmlc-order-id contains <span>ORDER #</span> <span>id</span>
    const orderIdEl = card.querySelector('.yohtmlc-order-id');
    const orderIdSpans = orderIdEl ? [...orderIdEl.querySelectorAll('span')].map(getText) : [];

    // Order date: the order-header__header-list-item that contains "Order placed"
    const headerItems = [...card.querySelectorAll('.order-header__header-list-item')].map((el) => {
      const label = el.querySelector('.a-color-secondary.a-text-caps');
      const value = el.querySelector('.a-size-base, .a-color-secondary:not(.a-text-caps)');
      return {
        label: getText(label),
        valueNode: getText(value),
        allText: getText(el),
      };
    });

    // Delivery status
    const primaryStatus = getText(card.querySelector('.yohtmlc-shipment-status-primaryText, .delivery-box__primary-text'));
    const secondaryStatus = getText(card.querySelector('.yohtmlc-shipment-status-secondaryText, .delivery-box__secondary-text'));

    // Item titles
    const titles = [...card.querySelectorAll('.yohtmlc-product-title')].map(getText);

    // Item links (for ASIN)
    const links = [...card.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]')]
      .map((a) => a.getAttribute('href'))
      .filter(Boolean);

    // Total: look for a "Total" area. Not always in a yohtmlc-* class.
    // Modern: .yohtmlc-order-total ; older may lack this
    const totalEl = card.querySelector('.yohtmlc-order-total, [class*="order-total" i]');
    const totalText = getText(totalEl);

    return {
      cardCount,
      orderIdFromYohtmlc: orderIdSpans,
      headerItems: headerItems.slice(0, 4),
      primaryStatus,
      secondaryStatus,
      titleCount: titles.length,
      titles: titles.slice(0, 3),
      linkCount: links.length,
      links: links.slice(0, 3),
      totalSelectorFound: !!totalEl,
      totalText,
      // Also dump all classes starting with 'yohtmlc-' found within the card
      yohtmlcClasses: [...new Set(
        [...card.querySelectorAll('*[class*="yohtmlc-"]')].map((el) =>
          (el.className || '').split(/\s+/).filter((c) => c.startsWith('yohtmlc-'))
        ).flat()
      )].sort(),
    };
  });

  results[year] = snap;
  await page.close();
}

await context.close();
console.log(JSON.stringify(results, null, 2));
