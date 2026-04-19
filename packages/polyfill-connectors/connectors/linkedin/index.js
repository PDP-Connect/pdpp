#!/usr/bin/env node
import { runBrowserScraper } from '../../src/browser-scraper-runtime.js';

runBrowserScraper({
  name: 'linkedin',
  async probeSession(ctx) {
    const cookies = await ctx.cookies('https://www.linkedin.com/');
    return cookies.some((c) => /li_at|JSESSIONID/.test(c.name) && c.value);
  },
  async scrape({ page, emit, sleep }) {
    await page.goto('https://www.linkedin.com/in/me/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(3000);
    emit({
      type: 'SKIP_RESULT',
      stream: 'profile',
      reason: 'linkedin_voyager_wiring_pending',
      message: 'LinkedIn session reachable. Voyager API endpoint wiring deferred to live session (hostile anti-bot; conservative approach).',
    });
  },
});
