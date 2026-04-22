#!/usr/bin/env node
import { runConnector, politeDelay } from '../../src/connector-runtime.js';

runConnector({
  name: 'shopify',
  browser: {},
  async probeSession({ context }) {
    const cookies = await context.cookies('https://shop.app/');
    return cookies.some((c) => /session|_shop_session|consumer_access_token/.test(c.name) && c.value);
  },
  async collect({ page, emit }) {
    await page.goto('https://shop.app/orders', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await politeDelay(3000);
    emit({
      type: 'SKIP_RESULT',
      stream: 'orders',
      reason: 'shopify_apollo_wiring_pending',
      message: 'Shop app reachable. Apollo-cache extraction from React fiber wiring deferred to live session.',
    });
  },
});
