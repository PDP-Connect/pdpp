#!/usr/bin/env node
/**
 * Whole Foods orders are fulfilled by Amazon and require the Amazon session.
 * Effectively a sub-query of the Amazon connector; piggy-backs on the shared
 * profile. Tonight: verify the session; wire per-item nutrition + store
 * metadata on the owner's return.
 */
import { runBrowserScraper } from '../../src/browser-scraper-runtime.js';

runBrowserScraper({
  name: 'wholefoods',
  async probeSession(ctx) {
    const cookies = await ctx.cookies('https://www.amazon.com/');
    return cookies.some((c) => /session|at-main/.test(c.name) && c.value);
  },
  async scrape({ page, emit, sleep }) {
    await page.goto('https://www.amazon.com/gp/css/order-history', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(2500);
    emit({
      type: 'SKIP_RESULT',
      stream: 'orders',
      reason: 'wholefoods_filter_pending',
      message: 'Amazon session reachable. Whole Foods filter + USDA nutrition lookup deferred to live session.',
    });
  },
});
