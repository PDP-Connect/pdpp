import assert from "node:assert/strict";
import { test } from "node:test";
import {
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
