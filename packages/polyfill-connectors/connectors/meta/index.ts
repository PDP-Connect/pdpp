#!/usr/bin/env node
import {
  type BrowserCollectContext,
  type ProbeSessionArgs,
  politeDelay,
  runConnector,
} from "../../src/connector-runtime.ts";

const SESSION_COOKIE = /sessionid|ds_user_id/;

runConnector({
  name: "meta",
  browser: {},
  async probeSession({ context }: ProbeSessionArgs): Promise<boolean> {
    const cookies = await context.cookies("https://www.instagram.com/");
    return cookies.some((c) => SESSION_COOKIE.test(c.name) && Boolean(c.value));
  },
  async collect({ page, emit }: BrowserCollectContext): Promise<void> {
    await page
      .goto("https://www.instagram.com/accounts/edit/", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      })
      .catch((): undefined => undefined);
    await politeDelay(3000);
    await emit({
      type: "SKIP_RESULT",
      stream: "profile",
      reason: "instagram_graphql_wiring_pending",
      message:
        "Instagram session reachable. Polaris GraphQL endpoint wiring deferred to live session (operation names rotate).",
    });
  },
});
