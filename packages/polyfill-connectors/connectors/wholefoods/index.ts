#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Whole Foods orders are fulfilled by Amazon and require the Amazon session.
 * Effectively a sub-query of the Amazon connector; piggy-backs on the shared
 * profile. Tonight: verify the session; wire per-item nutrition + store
 * metadata on the owner's return.
 */
import {
  type BrowserCollectContext,
  type ProbeSessionArgs,
  politeDelay,
  runConnector,
} from "../../src/connector-runtime.ts";
import { validateRecord } from "./schemas.ts";

const SESSION_COOKIE = /session|at-main/;

runConnector({
  name: "wholefoods",
  browser: {},
  validateRecord,
  async probeSession({ context }: ProbeSessionArgs): Promise<boolean> {
    const cookies = await context.cookies("https://www.amazon.com/");
    return cookies.some((c) => SESSION_COOKIE.test(c.name) && Boolean(c.value));
  },
  async collect({ page, emit }: BrowserCollectContext): Promise<void> {
    await page
      .goto("https://www.amazon.com/gp/css/order-history", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      })
      .catch((): undefined => undefined);
    await politeDelay(2500);
    await emit({
      type: "SKIP_RESULT",
      stream: "orders",
      reason: "wholefoods_filter_pending",
      message: "Amazon session reachable. Whole Foods filter + USDA nutrition lookup deferred to live session.",
    });
  },
});
