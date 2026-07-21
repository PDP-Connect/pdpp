// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  jitteredExponentialDelayMs,
  parseRetryAfterMs,
  RetryExhaustedError,
  retryAfterMsFromHeaders,
  retryHttp,
  TerminalHttpStatusError,
} from "./http-retry.ts";

test("parseRetryAfterMs: accepts delta seconds and HTTP dates", () => {
  assert.equal(parseRetryAfterMs("12"), 12_000);
  assert.equal(parseRetryAfterMs("0.25"), 250);
  assert.equal(parseRetryAfterMs("Wed, 13 May 2026 12:00:10 GMT", Date.parse("2026-05-13T12:00:00Z")), 10_000);
  assert.equal(parseRetryAfterMs("not a date"), null);
});

test("retryAfterMsFromHeaders: reads retry-after case-insensitively", () => {
  assert.equal(retryAfterMsFromHeaders({ "retry-after": "3" }), 3000);
  assert.equal(retryAfterMsFromHeaders({ "Retry-After": "4" }), 4000);
  assert.equal(retryAfterMsFromHeaders({ "RETRY-AFTER": "5" }), 5000);
});

test("retryHttp: respects Retry-After before retrying a recoverable response", async () => {
  const sleeps: number[] = [];
  const statuses = [429, 200];

  const result = await retryHttp({
    baseDelayMs: 1000,
    maxAttempts: 4,
    maxDelayMs: 10_000,
    maxRetryAfterMs: 60_000,
    request: () => ({
      status: statuses.shift() ?? 200,
      headers: { "retry-after": "7" },
    }),
    sleep: (ms) => {
      sleeps.push(ms);
    },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(sleeps, [7000]);
});

test("retryHttp: uses bounded jittered exponential delay when Retry-After is absent", async () => {
  const sleeps: number[] = [];
  const statuses = [429, 503, 200];

  await retryHttp({
    baseDelayMs: 1000,
    maxAttempts: 5,
    maxDelayMs: 10_000,
    maxRetryAfterMs: 60_000,
    random: () => 0.5,
    request: () => ({ status: statuses.shift() ?? 200 }),
    sleep: (ms) => {
      sleeps.push(ms);
    },
  });

  assert.deepEqual(sleeps, [1000, 2000]);
});

test("retryHttp: default retryable set includes 408 and all 5xx", async () => {
  const sleeps: number[] = [];
  const statuses = [408, 500, 599, 200];

  const result = await retryHttp({
    baseDelayMs: 1000,
    maxAttempts: 5,
    maxDelayMs: 10_000,
    maxRetryAfterMs: 60_000,
    random: () => 0.5,
    request: () => ({ status: statuses.shift() ?? 200 }),
    sleep: (ms) => {
      sleeps.push(ms);
    },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
});

test("retryHttp: caps jittered exponential delay after applying jitter", () => {
  assert.equal(jitteredExponentialDelayMs({ attempt: 10, baseDelayMs: 1000, maxDelayMs: 5000, random: () => 1 }), 5000);
});

test("retryHttp: caps large Retry-After values", async () => {
  const sleeps: number[] = [];
  const statuses = [429, 200];

  await retryHttp({
    baseDelayMs: 1000,
    maxAttempts: 3,
    maxDelayMs: 10_000,
    maxRetryAfterMs: 30_000,
    request: () => ({
      status: statuses.shift() ?? 200,
      headers: { "retry-after": "120" },
    }),
    sleep: (ms) => {
      sleeps.push(ms);
    },
  });

  assert.deepEqual(sleeps, [30_000]);
});

test("retryHttp: terminal statuses are not retried", async () => {
  const sleeps: number[] = [];
  let calls = 0;

  await assert.rejects(
    retryHttp({
      baseDelayMs: 1000,
      maxAttempts: 3,
      maxDelayMs: 10_000,
      maxRetryAfterMs: 60_000,
      request: () => {
        calls += 1;
        return { status: 401 };
      },
      shouldAbort: (response) => response.status === 401 || response.status === 403,
      sleep: (ms) => {
        sleeps.push(ms);
      },
    }),
    TerminalHttpStatusError
  );

  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});

test("retryHttp: non-retryable 4xx responses return without sleeping", async () => {
  const sleeps: number[] = [];
  const result = await retryHttp({
    baseDelayMs: 1000,
    maxAttempts: 3,
    maxDelayMs: 10_000,
    maxRetryAfterMs: 60_000,
    request: () => ({ status: 404 }),
    sleep: (ms) => {
      sleeps.push(ms);
    },
  });

  assert.equal(result.status, 404);
  assert.deepEqual(sleeps, []);
});

test("retryHttp: beforeAttempt gates every provider attempt and propagates without retry sleep", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  let calls = 0;
  const gateError = new Error("provider gate closed");

  await assert.rejects(
    retryHttp({
      baseDelayMs: 1000,
      beforeAttempt: () => {
        attempts += 1;
        if (attempts === 2) {
          throw gateError;
        }
      },
      maxAttempts: 4,
      maxDelayMs: 10_000,
      maxRetryAfterMs: 60_000,
      random: () => 0.5,
      request: () => {
        calls += 1;
        return { status: 429 };
      },
      sleep: (ms) => {
        sleeps.push(ms);
      },
    }),
    (err: unknown) => err === gateError
  );

  assert.equal(calls, 1, "closed gate prevents the second provider call");
  assert.equal(attempts, 2, "gate is checked for the initial attempt and retry attempt");
  assert.deepEqual(sleeps, [1000], "only the retry backoff already earned by the first 429 is slept");
});

test("retryHttp: throws when retry budget is exhausted", async () => {
  const sleeps: number[] = [];

  await assert.rejects(
    retryHttp({
      baseDelayMs: 1000,
      maxAttempts: 3,
      maxDelayMs: 10_000,
      maxRetryAfterMs: 60_000,
      random: () => 0.5,
      request: () => ({ status: 429 }),
      sleep: (ms) => {
        sleeps.push(ms);
      },
    }),
    RetryExhaustedError
  );

  assert.deepEqual(sleeps, [1000, 2000]);
});

test("retryHttp: shouldKeepRetrying can stop early before exhausting the budget", async () => {
  const sleeps: number[] = [];
  const seen: Array<{ attempt: number; maxAttempts: number; retryAfterMs: number | null; status: number }> = [];
  let calls = 0;

  // A bare-429 source-pressure policy: keep retrying for the first two attempts,
  // then fast-open even though maxAttempts is far higher.
  await assert.rejects(
    retryHttp({
      baseDelayMs: 1000,
      maxAttempts: 12,
      maxDelayMs: 10_000,
      maxRetryAfterMs: 60_000,
      random: () => 0.5,
      request: () => {
        calls += 1;
        return { status: 429 };
      },
      shouldKeepRetrying: ({ attempt, maxAttempts, response, retryAfterMs }) => {
        seen.push({ attempt, maxAttempts, retryAfterMs, status: response.status });
        return attempt < 3;
      },
      sleep: (ms) => {
        sleeps.push(ms);
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof RetryExhaustedError);
      assert.equal(err.attempts, 3, "exhaustion records the attempt the policy stopped on");
      assert.equal(
        (err.originalCause as { status: number }).status,
        429,
        "cause is the offending response, same as budget exhaustion"
      );
      assert.match(err.message, /source-pressure policy stopped retrying/);
      return true;
    }
  );

  // Stopped at attempt 3 (one initial + two retries), NOT the full 12-attempt budget.
  assert.equal(calls, 3, "request runs only until the policy fast-opens");
  assert.deepEqual(sleeps, [1000, 2000], "only the two pre-fast-open backoffs are paid");
  assert.deepEqual(seen, [
    { attempt: 1, maxAttempts: 12, retryAfterMs: null, status: 429 },
    { attempt: 2, maxAttempts: 12, retryAfterMs: null, status: 429 },
    { attempt: 3, maxAttempts: 12, retryAfterMs: null, status: 429 },
  ]);
});

test("retryHttp: shouldKeepRetrying sees the parsed Retry-After so policy can keep honest waits", async () => {
  const sleeps: number[] = [];
  const seenRetryAfter: Array<number | null> = [];
  const statuses = [429, 200];

  const result = await retryHttp({
    baseDelayMs: 1000,
    maxAttempts: 12,
    maxDelayMs: 10_000,
    maxRetryAfterMs: 60_000,
    request: () => ({ status: statuses.shift() ?? 200, headers: { "retry-after": "5" } }),
    shouldKeepRetrying: ({ retryAfterMs }) => {
      seenRetryAfter.push(retryAfterMs);
      // Policy: a 429 WITH Retry-After is an honest bounded wait — keep retrying.
      return true;
    },
    sleep: (ms) => {
      sleeps.push(ms);
    },
  });

  assert.equal(result.status, 200, "honest Retry-After waits still recover");
  assert.deepEqual(seenRetryAfter, [5000], "predicate receives the parsed Retry-After in ms");
  assert.deepEqual(sleeps, [5000]);
});
