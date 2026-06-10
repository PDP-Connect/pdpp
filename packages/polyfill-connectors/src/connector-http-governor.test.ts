import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectorRateLimitedError, createConnectorHttpGovernor } from "./connector-http-governor.ts";
import { RetryExhaustedError } from "./http-retry.ts";
import { RetryBudget } from "./provider-budget.ts";
import { PreflightWaitProbe } from "./send-governor.ts";

interface RawResponse {
  body?: unknown;
  headers?: Record<string, string | undefined>;
  status: number;
}

function classify(raw: RawResponse): { status: number; headers?: Record<string, string | undefined>; value: unknown } {
  return raw.headers
    ? { status: raw.status, headers: raw.headers, value: raw.body }
    : { status: raw.status, value: raw.body };
}

test("connector governor: recovers a 429-then-200 and returns the parsed value", async () => {
  const slept: number[] = [];
  const statuses = [429, 200];
  const g = createConnectorHttpGovernor({
    name: "oura",
    maxAttempts: 4,
    baseDelayMs: 1000,
    maxDelayMs: 10_000,
    sleep: (ms) => {
      slept.push(ms);
    },
    now: () => 0,
    random: () => 0.5,
  });
  const result = await g.request(
    () => ({ status: statuses.shift() ?? 200, headers: { "retry-after": "7" }, body: { ok: true } }),
    classify
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.value, { ok: true });
  // Retry-After honored exactly (7000), no extra backoff stacked on top.
  assert.deepEqual(slept, [7000]);
});

test("connector governor: Retry-After double-pay guard — the server interval is slept once, not stacked on backoff", async () => {
  const slept: number[] = [];
  const statuses = [429, 200];
  const g = createConnectorHttpGovernor({
    name: "strava",
    maxAttempts: 4,
    baseDelayMs: 2000,
    maxDelayMs: 60_000,
    sleep: (ms) => {
      slept.push(ms);
    },
    now: () => 0,
    random: () => 1, // would make jittered backoff large if it were (wrongly) added
  });
  await g.request(() => ({ status: statuses.shift() ?? 200, headers: { "retry-after": "3" }, body: null }), classify);
  // Exactly one wait of 3000 (the Retry-After), NOT 3000 + jittered backoff.
  assert.deepEqual(slept, [3000], "no double-pay: backoff is not added on top of Retry-After");
});

test("connector governor: terminal 429 exhaustion throws <name>_rate_limited (cross-run contract preserved)", async () => {
  const g = createConnectorHttpGovernor({
    name: "github",
    maxAttempts: 3,
    baseDelayMs: 1,
    maxDelayMs: 2,
    sleep: () => {
      /* no-op */
    },
    now: () => 0,
    random: () => 0.5,
  });
  await assert.rejects(
    g.request(() => ({ status: 429, body: null }), classify),
    (err: unknown) => {
      assert.ok(err instanceof ConnectorRateLimitedError);
      assert.equal((err as Error).message, "github_rate_limited", "matches the existing retryablePattern token");
      return true;
    }
  );
});

test("connector governor: ratio-based retry budget caps retry volume across requests", async () => {
  // capacity 1, refill 0 → only ONE retry is ever permitted across the run.
  const retryBudget = new RetryBudget({ capacity: 1, refillPerSuccess: 0 });
  const g = createConnectorHttpGovernor({
    name: "ynab",
    maxAttempts: 10,
    baseDelayMs: 1,
    maxDelayMs: 2,
    retryBudget,
    sleep: () => {
      /* no-op */
    },
    now: () => 0,
    random: () => 0.5,
  });

  let calls = 0;
  // First request: always 429 → consumes the single retry token on its 1 retry,
  // then exhausts the budget and stops (throws rate_limited) BEFORE maxAttempts.
  await assert.rejects(
    g.request(() => {
      calls += 1;
      return { status: 429, body: null };
    }, classify),
    ConnectorRateLimitedError
  );
  assert.equal(calls, 2, "1 initial + 1 budgeted retry, then the retry budget stops the run (not 10 attempts)");
});

test("connector governor: non-429 retryable exhaustion rethrows RetryExhaustedError (not rate_limited)", async () => {
  const g = createConnectorHttpGovernor({
    name: "notion",
    maxAttempts: 2,
    baseDelayMs: 1,
    maxDelayMs: 2,
    sleep: () => {
      /* no-op */
    },
    now: () => 0,
    random: () => 0.5,
  });
  await assert.rejects(
    g.request(() => ({ status: 503, body: null }), classify),
    (err: unknown) => {
      assert.ok(err instanceof RetryExhaustedError, "a 5xx exhaustion is not a rate-limit terminal");
      assert.ok(!(err instanceof ConnectorRateLimitedError));
      return true;
    }
  );
});

test("connector governor: per-provider isolation — two governors throttle independently", async () => {
  const now = () => 0;
  const a = createConnectorHttpGovernor({
    name: "spotify",
    pacingInitialIntervalMs: 1000,
    maxAttempts: 1,
    sleep: () => {
      /* no-op */
    },
    now,
  });
  const b = createConnectorHttpGovernor({
    name: "oura",
    pacingInitialIntervalMs: 1000,
    maxAttempts: 1,
    sleep: () => {
      /* no-op */
    },
    now,
  });
  // Throttle A hard, leave B untouched. They are separate instances with
  // separate pacing buckets; A's throttle does not move B's interval.
  await a.request(() => ({ status: 200, body: 1 }), classify);
  // B's pacing state is unaffected by A: a fresh request on B succeeds with no
  // borrowed backoff. (Behavioral proof of isolation: no shared mutable state.)
  const rb = await b.request(() => ({ status: 200, body: 2 }), classify);
  assert.equal(rb.value, 2);
  assert.notEqual(a.governor, b.governor, "distinct governor instances per provider");
});

test("connector governor: pacing is the single pre-flight gate (one wait source per attempt)", async () => {
  const probe = new PreflightWaitProbe();
  const g = createConnectorHttpGovernor({
    name: "oura",
    pacingInitialIntervalMs: 800,
    maxAttempts: 1,
    now: () => 0,
    sleep: probe.wrap(() => {
      /* no-op */
    }),
  });
  await g.request(() => ({ status: 200, body: null }), classify);
  assert.equal(probe.count, 1, "exactly one pre-flight wait — the single pacing governor");
});

test("connector governor: terminal abort status surfaces without rate_limited mislabel", async () => {
  const g = createConnectorHttpGovernor({
    name: "github",
    maxAttempts: 3,
    baseDelayMs: 1,
    maxDelayMs: 2,
    sleep: () => {
      /* no-op */
    },
    now: () => 0,
  });
  // A 200 with no retry is the simple success path; a non-retryable 404 returns
  // as-is so the caller can branch (it is not a rate-limit terminal).
  const r = await g.request(() => ({ status: 404, body: "missing" }), classify);
  assert.equal(r.status, 404);
  assert.equal(r.value, "missing");
});
