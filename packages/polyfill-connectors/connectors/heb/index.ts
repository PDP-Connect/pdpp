#!/usr/bin/env node
import {
  type BrowserCollectContext,
  type ProbeSessionArgs,
  politeDelay,
  runConnector,
} from "../../src/connector-runtime.ts";

const SESSION_COOKIE = /session|hebuser|heb-session/;

runConnector({
  name: "heb",
  browser: {},
  async probeSession({ context }: ProbeSessionArgs): Promise<boolean> {
    const cookies = await context.cookies("https://www.heb.com/");
    return cookies.some((c) => SESSION_COOKIE.test(c.name) && Boolean(c.value));
  },
  async collect({ page, emit }: BrowserCollectContext): Promise<void> {
    await page
      .goto("https://www.heb.com/my-account/order-history", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      })
      .catch((): undefined => undefined);
    await politeDelay(3000);
    await emit({
      type: "SKIP_RESULT",
      stream: "orders",
      reason: "heb_dom_wiring_pending",
      message:
        "H-E-B session reachable. Per-order detail DOM selectors deferred to live session.",
    });
  },
});
