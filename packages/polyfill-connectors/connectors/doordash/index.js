#!/usr/bin/env node
/**
 * PDPP DoorDash Connector (v0.1.0) — SCAFFOLDED 2026-04-19.
 *
 * Session-based via the shared Playwright profile. Prior-art GraphQL
 * intercept (data-connectors/doordash/, 657 LOC) uses network capture on
 * /graphql to read OrderHistoryQuery responses. Wiring requires a live
 * session to capture the current operation name + persisted query hash.
 */

import { runConnector, politeDelay } from '../../src/connector-runtime.js';

runConnector({
  name: 'doordash',
  browser: {},
  async probeSession({ context }) {
    const cookies = await context.cookies('https://www.doordash.com/');
    return cookies.some((c) => /^(session_id|dd_login|_cfuvid)$/.test(c.name) && c.value);
  },
  async collect({ page, emit }) {
    await page.goto('https://www.doordash.com/orders', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await politeDelay(3000);
    emit({
      type: 'SKIP_RESULT',
      stream: 'orders',
      reason: 'doordash_graphql_wiring_pending',
      message: `DoorDash reachable at ${page.url()}. GraphQL OrderHistoryQuery wiring deferred to live session.`,
    });
  },
});
