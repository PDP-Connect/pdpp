// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeThrownTransportError,
  jitteredExponentialDelayMs,
  parseRetryAfterMs,
  RetryExhaustedError,
  redactTransportDetail,
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

// ─── A THROWN transport fault must survive into the terminal message ────────
//
// Regression for a live YNAB run (run_1786288330250) whose terminal row read
// {"code":null,"message":"HTTP request failed after retry budget was exhausted",
// "retryable":false} — no status, no endpoint, no cause. `fetch` reports every
// transport fault as the same `TypeError: fetch failed` and puts the real fault
// on `.cause`; `RetryExhaustedError` stashed it on `originalCause`, but nothing
// downstream reads that field, so the owner saw only the generic sentence.

test("describeThrownTransportError: unwraps fetch's contentless TypeError to the real transport fault", () => {
  const err = new TypeError("fetch failed");
  err.cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  const described = describeThrownTransportError(err);
  assert.match(described, /fetch failed/, "the outer message is kept for continuity");
  assert.match(described, /ECONNRESET/, "the real transport fault must survive — it is the whole diagnostic");
});

test("describeThrownTransportError: appends a cause code the message does not already state", () => {
  const err = new TypeError("fetch failed");
  err.cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.example.com"), { code: "ENOTFOUND" });
  // The code is already in the message text, so it must not be repeated.
  assert.equal(describeThrownTransportError(err), "fetch failed: getaddrinfo ENOTFOUND api.example.com");

  const timeout = new TypeError("fetch failed");
  timeout.cause = Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" });
  assert.match(describeThrownTransportError(timeout), /UND_ERR_HEADERS_TIMEOUT/);
});

test("describeThrownTransportError: bounds a pathological cause and passes non-Errors through", () => {
  const err = new Error("outer");
  err.cause = new Error("x".repeat(5000));
  const described = describeThrownTransportError(err);
  assert.ok(described.length < 200, `expected a bounded description, got ${described.length}`);
  assert.match(described, /…/);
  assert.equal(describeThrownTransportError("raw string throw"), "raw string throw");
});

test("retryHttp: a thrown transport error carries its cause into the exhaustion message", async () => {
  const boom = new TypeError("fetch failed");
  boom.cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  await assert.rejects(
    retryHttp({
      baseDelayMs: 1,
      // maxAttempts: 1 is the shared API-connector convention, so the very first
      // throw is immediately terminal — the exact live YNAB configuration.
      maxAttempts: 1,
      maxDelayMs: 10,
      maxRetryAfterMs: 10,
      request: () => {
        throw boom;
      },
      sleep: () => {
        // No retry is reachable at maxAttempts:1; a real sleep would only slow the test.
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof RetryExhaustedError);
      assert.match(err.message, /ECONNRESET/, "the terminal message must name the transport fault");
      assert.equal(err.originalCause, boom, "the original error is still reachable for callers that want it");
      // Load-bearing beyond legibility: connectors declare a retryablePattern
      // over transport vocabulary and the runtime tests it against THIS message.
      assert.equal(
        /ECONN|ETIMEDOUT|fetch failed/i.test(err.message),
        true,
        "a transport fault must remain classifiable as retryable"
      );
      return true;
    }
  );
});

// ─── Redaction is an ENFORCED invariant, not a documented intention ─────────
//
// A cause link is arbitrary text authored by a transport we do not control, and
// undici/TLS layers routinely embed the request URL — which can carry userinfo,
// an `access_token` query parameter, or a signed-URL signature. The first cut of
// this fix only BOUNDED that text while its doc comment claimed no URL or header
// could reach terminal text. Bounding is not redacting: a 120-char cut through a
// credential leaves a usable prefix behind. These are the counterweights for the
// enforcement (RI owner REVISE, pre-integration).

test("redactTransportDetail: a URL's userinfo, path, and query-string secret cannot survive", () => {
  const redacted = redactTransportDetail(
    "connect ECONNREFUSED to https://user:pass@example.com/path?access_token=SECRETVALUE now"
  );
  assert.doesNotMatch(redacted, /SECRETVALUE/, "a query-string token must not survive");
  assert.doesNotMatch(redacted, /user:pass/, "URL userinfo must not survive");
  assert.doesNotMatch(redacted, /example\.com/, "the host and path must not survive");
  assert.doesNotMatch(redacted, /access_token/);
  assert.match(redacted, /\[redacted-url]/);
  // The whole point of keeping the link: the transport class must stay legible.
  assert.match(redacted, /ECONNREFUSED/, "the safe transport class must remain visible");
});

test("redactTransportDetail: Authorization headers and bare auth schemes cannot survive", () => {
  const header = redactTransportDetail("request failed (Authorization: Bearer abc123SECRETVALUE) ECONNRESET");
  assert.doesNotMatch(header, /abc123SECRETVALUE/);
  assert.match(header, /\[redacted-authorization]/);
  assert.match(header, /ECONNRESET/, "the safe transport code must remain visible");

  const bare = redactTransportDetail("upstream said Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig then ETIMEDOUT");
  assert.doesNotMatch(bare, /eyJhbGciOiJIUzI1NiJ9/);
  assert.doesNotMatch(bare, /Bearer\s+\S/i, "no bare bearer token may remain");
  assert.match(bare, /\[redacted-authorization]/);
  assert.match(bare, /ETIMEDOUT/);
});

test("redactTransportDetail: loose secret key-value forms and emails cannot survive", () => {
  const secrets = redactTransportDetail(
    'ENOTFOUND api_key=AKIAsecretvalue, password: "hunter2", cookie=session=abc, token=t0kenvalue'
  );
  for (const leak of ["AKIAsecretvalue", "hunter2", "t0kenvalue"]) {
    assert.doesNotMatch(secrets, new RegExp(leak), `${leak} must not survive`);
  }
  assert.match(secrets, /ENOTFOUND/, "the safe transport class must remain visible");

  const email = redactTransportDetail("auth failed for owner@example.com UND_ERR_HEADERS_TIMEOUT");
  assert.doesNotMatch(email, /owner@example\.com/);
  assert.match(email, /\[redacted-email]/);
  assert.match(email, /UND_ERR_HEADERS_TIMEOUT/, "the safe transport code must remain visible");
});

test("redactTransportDetail: control characters and newlines collapse to one legible line", () => {
  const messy = redactTransportDetail("line one\n\tline  two\u0000\u0007 ECONNRESET");
  // Asserted by code point rather than a regex character class: the lint rule
  // (correctly) bans control characters inside a regex literal.
  const controlCodePoints = [...messy].map((ch) => ch.codePointAt(0) ?? 0).filter((cp) => cp < 0x20 || cp === 0x7f);
  assert.deepEqual(controlCodePoints, [], "no control chars — including newline and tab — reach the DB row");
  assert.doesNotMatch(messy, / {2}/, "runs of whitespace collapse to one space");
  assert.match(messy, /ECONNRESET/);
});

test("describeThrownTransportError: redacts BEFORE bounding, so no secret survives as a truncated fragment", () => {
  // The URL sits past the 120-char per-link bound: if truncation ran first, the
  // slice would cut through the token and leave a usable prefix behind.
  const err = new TypeError("fetch failed");
  err.cause = Object.assign(
    new Error(`${"padding ".repeat(20)}https://user:pass@example.com/p?access_token=SUPERSECRETVALUE`),
    { code: "ECONNRESET" }
  );
  const described = describeThrownTransportError(err);
  assert.doesNotMatch(described, /SUPERSECRETVALUE/, "no whole secret");
  assert.doesNotMatch(described, /SUPER/, "not even a truncated fragment of the secret");
  assert.doesNotMatch(described, /user:pass/);
  assert.doesNotMatch(described, /example\.com/);
  assert.match(described, /ECONNRESET/, "the transport code still classifies the fault");
  // Bounded chain behavior is preserved.
  assert.ok(described.length < 300, `expected a bounded description, got ${described.length}`);
});

test("describeThrownTransportError: a redacted-to-empty link is dropped rather than emitting stray colons", () => {
  const err = new Error("https://example.com/only-a-url");
  err.cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  const described = describeThrownTransportError(err);
  assert.doesNotMatch(described, /example\.com/);
  assert.doesNotMatch(described, /::/, "no empty segments left behind by redaction");
  assert.match(described, /ECONNRESET/);
});
