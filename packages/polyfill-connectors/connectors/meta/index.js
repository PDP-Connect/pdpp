#!/usr/bin/env node
import { runConnector, politeDelay } from '../../src/connector-runtime.js';

runConnector({
  name: 'meta',
  browser: {},
  async probeSession({ context }) {
    const cookies = await context.cookies('https://www.instagram.com/');
    return cookies.some((c) => /sessionid|ds_user_id/.test(c.name) && c.value);
  },
  async collect({ page, emit }) {
    await page.goto('https://www.instagram.com/accounts/edit/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await politeDelay(3000);
    emit({
      type: 'SKIP_RESULT',
      stream: 'profile',
      reason: 'instagram_graphql_wiring_pending',
      message: 'Instagram session reachable. Polaris GraphQL endpoint wiring deferred to live session (operation names rotate).',
    });
  },
});
