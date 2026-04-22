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

import {
  type BrowserCollectContext,
  type ProbeSessionArgs,
  politeDelay,
  runConnector,
} from "../../src/connector-runtime.ts";

const SESSION_COOKIE = /sessionKey|__Secure-next-auth.session-token/;

runConnector({
  name: "anthropic",
  browser: {},
  async probeSession({ context }: ProbeSessionArgs): Promise<boolean> {
    const cookies = await context.cookies("https://claude.ai/");
    return cookies.some((c) => SESSION_COOKIE.test(c.name) && Boolean(c.value));
  },
  async collect({ page, emit }: BrowserCollectContext): Promise<void> {
    await page
      .goto("https://claude.ai/", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      })
      .catch((): undefined => undefined);
    await politeDelay(3000);
    await emit({
      type: "SKIP_RESULT",
      stream: "conversations",
      reason: "claude_api_wiring_pending",
      message:
        "Claude session reachable. Org UUID discovery + conversation/message endpoint wiring deferred to live session.",
    });
  },
});
