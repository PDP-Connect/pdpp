#!/usr/bin/env node
import { runConnector, politeDelay } from '../../src/connector-runtime.js';

runConnector({
  name: 'heb',
  browser: {},
  async probeSession({ context }) {
    const cookies = await context.cookies('https://www.heb.com/');
    return cookies.some((c) => /session|hebuser|heb-session/.test(c.name) && c.value);
  },
  async collect({ page, emit }) {
    await page.goto('https://www.heb.com/my-account/order-history', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await politeDelay(3000);
    emit({
      type: 'SKIP_RESULT',
      stream: 'orders',
      reason: 'heb_dom_wiring_pending',
      message: 'H-E-B session reachable. Per-order detail DOM selectors deferred to live session.',
    });
  },
});
