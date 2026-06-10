import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectorRateLimitedError, createConnectorHttpGovernor } from "./connector-http-governor.ts";

/**
 * Adoption smoke: every connector that migrated onto the shared send governor
 * must, on terminal rate-limit, throw an error whose message matches that
 * connector's runtime `retryablePattern`. That match is the load-bearing
 * cross-run contract: the runtime sees the error, flags it retryable, and the
 * scheduler arms the source-pressure cooldown — exactly as before the
 * migration. If the terminal string drifts from the pattern, the connector
 * silently stops deferring on rate-limit. This test pins it.
 *
 * Patterns copied from each connector's `runConnector({ retryablePattern })`.
 */
const ADOPTED: Array<{ name: string; retryablePattern: RegExp }> = [
  { name: "github", retryablePattern: /rate_limited|ECONN|fetch failed/ },
  { name: "ynab", retryablePattern: /rate_limited|ECONN|ETIMEDOUT|fetch failed/i },
  { name: "notion", retryablePattern: /ECONN|fetch failed|rate_limited/i },
  { name: "oura", retryablePattern: /rate_limited|ECONN|fetch failed/i },
  { name: "spotify", retryablePattern: /rate_limited|ECONN|fetch failed/i },
  { name: "strava", retryablePattern: /ECONN|fetch failed|rate_limited/i },
];

for (const { name, retryablePattern } of ADOPTED) {
  test(`adoption: ${name} terminal rate-limit throws an error matching its retryablePattern`, async () => {
    const governor = createConnectorHttpGovernor({
      name,
      maxAttempts: 1, // the byte-identical default these connectors ship
      baseDelayMs: 1,
      maxDelayMs: 2,
      now: () => 0,
      sleep: () => {
        /* no-op */
      },
    });
    await assert.rejects(
      governor.request(
        () => ({ status: 429 }),
        (raw: { status: number }) => ({ status: raw.status, value: raw })
      ),
      (err: unknown) => {
        assert.ok(err instanceof ConnectorRateLimitedError, `${name} throws ConnectorRateLimitedError`);
        assert.equal((err as Error).message, `${name}_rate_limited`);
        assert.match(
          (err as Error).message,
          retryablePattern,
          `${name}_rate_limited must match the connector's retryablePattern so cross-run cooldown still arms`
        );
        return true;
      }
    );
  });

  test(`adoption: ${name} with maxAttempts:1 makes exactly ONE provider call on a 429 (byte-identical, no inline retry)`, async () => {
    const governor = createConnectorHttpGovernor({
      name,
      maxAttempts: 1,
      now: () => 0,
      sleep: () => {
        /* no-op */
      },
    });
    let calls = 0;
    await assert.rejects(
      governor.request(
        () => {
          calls += 1;
          return { status: 429 };
        },
        (raw: { status: number }) => ({ status: raw.status, value: raw })
      ),
      ConnectorRateLimitedError
    );
    assert.equal(calls, 1, "the shipped maxAttempts:1 default preserves the immediate-throw behavior");
  });
}
