#!/usr/bin/env node
/**
 * PDPP Anthropic/Claude Connector (v0.1.0) — SCAFFOLDED.
 *
 * Session-based via the shared Playwright profile. Selectors + API wiring
 * pending a live session. This scaffold verifies session reachability and
 * emits a SKIP_RESULT with the deferral reason.
 *
 * Prior art: ~/code/data-connectors/anthropic/ (594 LOC) —
 * /api/organizations/{org_uuid}/chat_conversations + tree endpoints.
 */

import { runConnector, politeDelay } from '../../src/connector-runtime.js';

runConnector({
  name: 'anthropic',
  browser: {},
  async probeSession({ context }) {
    const cookies = await context.cookies('https://claude.ai/');
    return cookies.some((c) => /sessionKey|__Secure-next-auth.session-token/.test(c.name) && c.value);
  },
  async collect({ page, emit }) {
    await page.goto('https://claude.ai/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await politeDelay(3000);
    emit({
      type: 'SKIP_RESULT',
      stream: 'conversations',
      reason: 'claude_api_wiring_pending',
      message: 'Claude session reachable. Org UUID discovery + conversation/message endpoint wiring deferred to live session.',
    });
  },
});
