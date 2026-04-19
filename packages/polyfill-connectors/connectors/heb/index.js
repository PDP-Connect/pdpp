#!/usr/bin/env node
import { runBrowserScraper } from '../../src/browser-scraper-runtime.js';

runBrowserScraper({
  name: 'heb',
  async probeSession(ctx) {
    const cookies = await ctx.cookies('https://www.heb.com/');
    return cookies.some((c) => /session|hebuser|heb-session/.test(c.name) && c.value);
  },
  async scrape({ page, emit, sleep }) {
    await page.goto('https://www.heb.com/my-account/order-history', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(3000);
    emit({
      type: 'SKIP_RESULT',
      stream: 'orders',
      reason: 'heb_dom_wiring_pending',
      message: 'H-E-B session reachable. Per-order detail DOM selectors deferred to live session.',
    });
  },
});
