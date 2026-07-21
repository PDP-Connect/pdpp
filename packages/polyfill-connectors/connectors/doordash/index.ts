#!/usr/bin/env node
/**
 * PDPP DoorDash Connector (v0.1.0) — SCAFFOLDED 2026-04-19.
 *
 * Session-based via the shared Playwright profile. Prior-art GraphQL
 * intercept (data-connectors/doordash/, 657 LOC) uses network capture on
 * /graphql to read OrderHistoryQuery responses. Wiring requires a live
 * session to capture the current operation name + persisted query hash.
 */

import {
  type BrowserCollectContext,
  type ProbeSessionArgs,
  politeDelay,
  runConnector,
} from "../../src/connector-runtime.ts";
import { validateRecord } from "./schemas.ts";

const SESSION_COOKIE = /^(session_id|dd_login|_cfuvid)$/;

runConnector({
  name: "doordash",
  browser: {},
  validateRecord,
  async probeSession({ context }: ProbeSessionArgs): Promise<boolean> {
    const cookies = await context.cookies("https://www.doordash.com/");
    return cookies.some((c) => SESSION_COOKIE.test(c.name) && Boolean(c.value));
  },
  async collect({ page, emit }: BrowserCollectContext): Promise<void> {
    await page
      .goto("https://www.doordash.com/orders", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      })
      .catch((): undefined => undefined);
    await politeDelay(3000);
    await emit({
      type: "SKIP_RESULT",
      stream: "orders",
      reason: "doordash_graphql_wiring_pending",
      message: `DoorDash reachable at ${page.url()}. GraphQL OrderHistoryQuery wiring deferred to live session.`,
    });
  },
});
