#!/usr/bin/env node
import { runBrowserScraper } from '../../src/browser-scraper-runtime.js';

runBrowserScraper({
  name: 'loom',
  async probeSession(ctx) {
    const cookies = await ctx.cookies('https://www.loom.com/');
    return cookies.some((c) => /connect.sid|loom_session/.test(c.name) && c.value);
  },
  async scrape({ page, emit, sleep }) {
    await page.goto('https://www.loom.com/my-videos', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(3000);
    emit({
      type: 'SKIP_RESULT',
      stream: 'videos',
      reason: 'loom_apollo_wiring_pending',
      message: 'Loom session reachable. Apollo cache extraction + transcript endpoint wiring deferred to live session.',
    });
  },
});
