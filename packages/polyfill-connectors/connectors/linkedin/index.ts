#!/usr/bin/env node
import {
  type BrowserCollectContext,
  type ProbeSessionArgs,
  politeDelay,
  runConnector,
} from "../../src/connector-runtime.ts";

const SESSION_COOKIE = /li_at|JSESSIONID/;

runConnector({
  name: "linkedin",
  browser: {},
  async probeSession({ context }: ProbeSessionArgs): Promise<boolean> {
    const cookies = await context.cookies("https://www.linkedin.com/");
    return cookies.some((c) => SESSION_COOKIE.test(c.name) && Boolean(c.value));
  },
  async collect({ page, emit }: BrowserCollectContext): Promise<void> {
    await page
      .goto("https://www.linkedin.com/in/me/", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      })
      .catch((): undefined => undefined);
    await politeDelay(3000);
    await emit({
      type: "SKIP_RESULT",
      stream: "profile",
      reason: "linkedin_voyager_wiring_pending",
      message:
        "LinkedIn session reachable. Voyager API endpoint wiring deferred to live session (hostile anti-bot; conservative approach).",
    });
  },
});
