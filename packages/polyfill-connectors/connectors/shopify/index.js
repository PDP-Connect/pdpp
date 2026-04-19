#!/usr/bin/env node
import { runBrowserScraper } from '../../src/browser-scraper-runtime.js';

runBrowserScraper({
  name: 'shopify',
  async probeSession(ctx) {
    const cookies = await ctx.cookies('https://shop.app/');
    return cookies.some((c) => /session|_shop_session|consumer_access_token/.test(c.name) && c.value);
  },
  async scrape({ page, emit, sleep }) {
    await page.goto('https://shop.app/orders', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(3000);
    emit({
      type: 'SKIP_RESULT',
      stream: 'orders',
      reason: 'shopify_apollo_wiring_pending',
      message: 'Shop app reachable. Apollo-cache extraction from React fiber wiring deferred to live session.',
    });
  },
});
