#!/usr/bin/env node
// Probe the internal structure of a single .order-card element on the list page.
// Catalogue CSS classes that look like stable field markers, dump their
// innerText so we can see which piece-of-info each holds.

import { chromium } from 'patchright';

const AMAZON_PROFILE_DIR = `${process.env.HOME}/.pdpp/profiles/amazon`;
const year = process.argv[2] || '2025';

const context = await chromium.launchPersistentContext(AMAZON_PROFILE_DIR, {
  headless: true,
  channel: 'chrome',
  viewport: { width: 1280, height: 800 },
  args: ['--disable-features=DownloadBubble,DownloadBubbleV2,DownloadBubbleV3'],
});

const page = await context.newPage();
await page.goto(`https://www.amazon.com/your-orders/orders?timeFilter=year-${year}&startIndex=0`, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.locator('.order-card').first().waitFor({ state: 'attached', timeout: 15000 });

const snap = await page.evaluate(() => {
  const card = document.querySelector('.order-card');
  if (!card) return { error: 'no card' };

  // All descendants with a class attribute, record their class + tag + first-40-chars text.
  const elements = [...card.querySelectorAll('*[class]')]
    .filter((el) => el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE')
    .map((el) => {
      const cls = el.getAttribute('class');
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      return { tag: el.tagName, cls, text: text.slice(0, 80) };
    })
    .filter((e) => e.text.length > 0);

  // Group: distinct classes that appear, each with representative text
  const byClass = {};
  for (const e of elements) {
    const key = e.cls;
    if (!byClass[key]) byClass[key] = { tag: e.tag, samples: [] };
    if (byClass[key].samples.length < 3) byClass[key].samples.push(e.text);
  }

  // Also find the "header" area (usually left-top: date, total, recipient)
  // and the "body" (items). Classes with "order-header" / "order-body" / "shipment" are likely.
  const keyMatches = Object.keys(byClass).filter((k) =>
    /header|summary|info|total|date|status|delivery|ship|address|recipient|item|title|body|left|right|grid|col|column|label|value/i.test(k)
  );

  // Also dump the nav-level / section headings
  const headers = [...card.querySelectorAll('.a-color-secondary, .a-color-base, .a-text-bold, span.a-color-secondary, .yohtmlc-order-level-connections')]
    .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 20);

  return {
    orderCardCls: card.className,
    outerHtmlSnippet: card.outerHTML.replace(/<script[^]*?<\/script>/g, '<!--script-->').slice(0, 4000),
    keyMatchClasses: Object.fromEntries(
      keyMatches.slice(0, 40).map((k) => [k, byClass[k]])
    ),
    allClassesCount: Object.keys(byClass).length,
    sampleHeaders: headers,
  };
});

console.log(JSON.stringify(snap, null, 2));
await page.close();
await context.close();
