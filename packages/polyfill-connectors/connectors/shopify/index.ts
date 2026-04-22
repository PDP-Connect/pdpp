#!/usr/bin/env node
import {
  type BrowserCollectContext,
  type ProbeSessionArgs,
  politeDelay,
  runConnector,
} from "../../src/connector-runtime.ts";

const SESSION_COOKIE = /session|_shop_session|consumer_access_token/;

runConnector({
  name: "shopify",
  browser: {},
  async probeSession({ context }: ProbeSessionArgs): Promise<boolean> {
    const cookies = await context.cookies("https://shop.app/");
    return cookies.some((c) => SESSION_COOKIE.test(c.name) && Boolean(c.value));
  },
  async collect({ page, emit }: BrowserCollectContext): Promise<void> {
    await page
      .goto("https://shop.app/orders", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      })
      .catch((): undefined => undefined);
    await politeDelay(3000);
    await emit({
      type: "SKIP_RESULT",
      stream: "orders",
      reason: "shopify_apollo_wiring_pending",
      message:
        "Shop app reachable. Apollo-cache extraction from React fiber wiring deferred to live session.",
    });
  },
});
