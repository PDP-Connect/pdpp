#!/usr/bin/env node
import { runConnector, politeDelay } from '../../src/connector-runtime.js';

runConnector({
  name: 'loom',
  browser: {},
  async probeSession({ context }) {
    const cookies = await context.cookies('https://www.loom.com/');
    return cookies.some((c) => /connect.sid|loom_session/.test(c.name) && c.value);
  },
  async collect({ page, emit }) {
    await page.goto('https://www.loom.com/my-videos', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await politeDelay(3000);
    emit({
      type: 'SKIP_RESULT',
      stream: 'videos',
      reason: 'loom_apollo_wiring_pending',
      message: 'Loom session reachable. Apollo cache extraction + transcript endpoint wiring deferred to live session.',
    });
  },
});
