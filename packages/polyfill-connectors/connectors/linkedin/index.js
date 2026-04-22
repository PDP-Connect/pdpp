#!/usr/bin/env node
import { runConnector, politeDelay } from '../../src/connector-runtime.js';

runConnector({
  name: 'linkedin',
  browser: {},
  async probeSession({ context }) {
    const cookies = await context.cookies('https://www.linkedin.com/');
    return cookies.some((c) => /li_at|JSESSIONID/.test(c.name) && c.value);
  },
  async collect({ page, emit }) {
    await page.goto('https://www.linkedin.com/in/me/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await politeDelay(3000);
    emit({
      type: 'SKIP_RESULT',
      stream: 'profile',
      reason: 'linkedin_voyager_wiring_pending',
      message: 'LinkedIn session reachable. Voyager API endpoint wiring deferred to live session (hostile anti-bot; conservative approach).',
    });
  },
});
