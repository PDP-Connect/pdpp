#!/usr/bin/env node
/**
 * PDPP DoorDash Connector (v0.1.0) — SCAFFOLDED 2026-04-19 overnight.
 *
 * Session-based via shared Playwright profile.
 * Prior-art GraphQL intercept: data-connectors/doordash/ (657 LOC) — uses
 * network capture on /graphql to get OrderHistoryQuery responses.
 *
 * Complete wiring requires live session to capture the current operation
 * name + persisted query hash. This scaffold verifies session + reports
 * SKIP_RESULT; tomorrow we wire the GraphQL capture.
 */

import { runBrowserScraper } from '../../src/browser-scraper-runtime.js';

runBrowserScraper({
  name: 'doordash',

  async probeSession(ctx, _page) {
    const cookies = await ctx.cookies('https://www.doordash.com/');
    return cookies.some((c) => /^(session_id|dd_login|_cfuvid)$/.test(c.name) && c.value);
  },

  async scrape({ page, emit, sleep }) {
    await page.goto('https://www.doordash.com/orders', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(3000);
    const url = page.url();
    emit({
      type: 'SKIP_RESULT',
      stream: 'orders',
      reason: 'doordash_graphql_wiring_pending',
      message: `DoorDash reachable at ${url}. GraphQL OrderHistoryQuery wiring deferred to live session (operation hash captured against real request).`,
    });
  },
});
