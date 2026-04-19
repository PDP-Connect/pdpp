#!/usr/bin/env node
/**
 * PDPP Anthropic/Claude Connector (v0.1.0) — SCAFFOLDED.
 *
 * Session-based via shared Playwright profile.
 * Prior art: ~/code/data-connectors/anthropic/ (594 LOC).
 *
 * Claude.ai uses /api/organizations/{org_uuid}/chat_conversations and
 * /api/organizations/{org_uuid}/chat_conversations/{uuid} with full tree.
 * Tonight: verify session; wire endpoints on the owner's return (org UUID must be
 * fetched at run-time — path doc'd in data-connectors prior art).
 */
import { runBrowserScraper } from '../../src/browser-scraper-runtime.js';

runBrowserScraper({
  name: 'anthropic',
  async probeSession(ctx) {
    const cookies = await ctx.cookies('https://claude.ai/');
    return cookies.some((c) => /sessionKey|__Secure-next-auth.session-token/.test(c.name) && c.value);
  },
  async scrape({ page, emit, sleep }) {
    await page.goto('https://claude.ai/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(3000);
    emit({
      type: 'SKIP_RESULT',
      stream: 'conversations',
      reason: 'claude_api_wiring_pending',
      message: 'Claude session reachable. Org UUID discovery + conversation/message endpoint wiring deferred to live session.',
    });
  },
});
