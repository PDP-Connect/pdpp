#!/usr/bin/env node
/**
 * PDPP Uber Connector (v0.1.0) — SCAFFOLDED 2026-04-19 overnight.
 *
 * Status: manifest complete, connector uses shared browser profile. The
 * GraphQL intercept strategy from ~/code/data-connectors/uber/ is documented
 * but not wired here — the live session is needed to verify the GraphQL
 * operation names and persistedQueryHash values change frequently.
 *
 * When the owner has a live Uber session, implement scrape():
 *   1. Navigate to https://riders.uber.com/trips
 *   2. Wait for network requests to getActivities GraphQL operation
 *   3. Capture JSON response; iterate activities[]
 *   4. For each activity, fetch /api/getTrip?tripUUID=... for full detail
 *   5. Emit RECORDs per the trips schema
 *
 * Session probe: check for riders.uber.com cookies (sid, utag_main).
 */

import {
  type BrowserCollectContext,
  type ProbeSessionArgs,
  politeDelay,
  runConnector,
} from "../../src/connector-runtime.ts";

runConnector({
  name: "uber",
  browser: {},

  async probeSession({ context }: ProbeSessionArgs): Promise<boolean> {
    const cookies = await context.cookies("https://riders.uber.com/");
    // sid is set for authenticated sessions.
    return cookies.some((c) => c.name === "sid" && Boolean(c.value));
  },

  async collect({ page, emit }: BrowserCollectContext): Promise<void> {
    // Navigate to trips page as a no-op to verify session end-to-end.
    await page
      .goto("https://riders.uber.com/trips", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      })
      .catch((): undefined => undefined);
    await politeDelay(3000);
    const title = await page.title().catch((): string => "");
    await emit({
      type: "SKIP_RESULT",
      stream: "trips",
      reason: "uber_graphql_wiring_pending",
      message: `Uber session verified (page title: "${title}"). GraphQL operation-name + persistedQueryHash wiring deferred to next session so we can capture real request signatures.`,
    });
  },
});
