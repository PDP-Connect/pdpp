#!/usr/bin/env node
import { runBrowserScraper } from '../../src/browser-scraper-runtime.js';

runBrowserScraper({
  name: 'meta',
  async probeSession(ctx) {
    const cookies = await ctx.cookies('https://www.instagram.com/');
    return cookies.some((c) => /sessionid|ds_user_id/.test(c.name) && c.value);
  },
  async scrape({ page, emit, sleep }) {
    await page.goto('https://www.instagram.com/accounts/edit/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(3000);
    emit({
      type: 'SKIP_RESULT',
      stream: 'profile',
      reason: 'instagram_graphql_wiring_pending',
      message: 'Instagram session reachable. Polaris GraphQL endpoint wiring deferred to live session (operation names rotate).',
    });
  },
});
