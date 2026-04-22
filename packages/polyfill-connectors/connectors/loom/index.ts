#!/usr/bin/env node
import {
  type BrowserCollectContext,
  type ProbeSessionArgs,
  politeDelay,
  runConnector,
} from "../../src/connector-runtime.ts";

const SESSION_COOKIE = /connect.sid|loom_session/;

runConnector({
  name: "loom",
  browser: {},
  async probeSession({ context }: ProbeSessionArgs): Promise<boolean> {
    const cookies = await context.cookies("https://www.loom.com/");
    return cookies.some((c) => SESSION_COOKIE.test(c.name) && Boolean(c.value));
  },
  async collect({ page, emit }: BrowserCollectContext): Promise<void> {
    await page
      .goto("https://www.loom.com/my-videos", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      })
      .catch((): undefined => undefined);
    await politeDelay(3000);
    await emit({
      type: "SKIP_RESULT",
      stream: "videos",
      reason: "loom_apollo_wiring_pending",
      message:
        "Loom session reachable. Apollo cache extraction + transcript endpoint wiring deferred to live session.",
    });
  },
});
