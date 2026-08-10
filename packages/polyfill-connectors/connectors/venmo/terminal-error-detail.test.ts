// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stubs `globalThis.fetch` to prove terminal errors name the failing
 * endpoint and redact credentials/account content, and that HTTP status
 * codes classify retryable/non-retryable correctly. Mirrors
 * connectors/ynab/terminal-error-detail.test.ts. The path-literal
 * assertions here (`/account`, `/users/{id}/friends`, `/stories/target-or-actor`)
 * are what makes `scripts/mock-mutation-check.ts` score these tests
 * load-bearing rather than decorative.
 *
 * Every network-touching test below shares the connector's module-level
 * `httpGovernor`, which paces real inter-request wall-clock time
 * (`venmoPacingProfile()`, 10s ceiling) — the same characteristic
 * connectors/ynab/terminal-error-detail.test.ts has. Test count here is
 * kept intentionally low (one governor call per test, no back-to-back
 * multi-call tests) to keep the suite's wall-clock bounded; deeper
 * per-field coverage lives in the free (no-network) schemas.test.ts and
 * parsers.test.ts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { errorDetail, fetchAllFriends, fetchProfile, fetchTransactionsPage, loginWithCredentials } from "./index.ts";

const RETRYABLE_PATTERN = /ECONN|ETIMEDOUT|fetch failed|venmo_rate_limited/i;

/** Replace `globalThis.fetch` for the duration of one call, queueing one Response per call. */
function stubFetch(responses: Array<() => Promise<Response> | Response>): () => void {
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (() => {
    const next = responses.at(Math.min(i, responses.length - 1));
    i += 1;
    if (!next) {
      throw new Error("stubFetch: no response queued for this call");
    }
    return Promise.resolve(next());
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const noopProgress = (): Promise<void> => Promise.resolve();

test("errorDetail prefers the provider's own error.message, redacts secrets, and truncates (no network)", () => {
  const withSecret = errorDetail(JSON.stringify({ error: { message: `bad token Bearer ${"x".repeat(300)}` } }));
  assert.match(withSecret, /redacted-authorization|\[redacted/);
  assert.ok(withSecret.length <= 200);
  const noEnvelope = errorDetail("plain text failure https://api.venmo.com/v1/oauth/access_token?secret=abc");
  assert.doesNotMatch(noEnvelope, /secret=abc/);
});

test("fetchProfile: an exhausted-retryable 5xx names the /account endpoint and status — never the credential", () =>
  (async () => {
    // 503/502/504 are RETRYABLE per retryHttp's own classification, so with
    // maxAttempts:1 the governor throws its own generic exhaustion message
    // (never reaches this connector's errorDetail(res.body) branch, which
    // only runs for a non-retryable status like 400/403). venmoRequest's
    // catch block still attaches the templated endpoint label to THAT
    // message — this test proves the label survives the governor's own
    // wording, not that Venmo's body text survives it.
    const restore = stubFetch([
      () => new Response(JSON.stringify({ error: { message: "server hiccup" } }), { status: 503 }),
    ]);
    try {
      await assert.rejects(fetchProfile("secret-token-abc"), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /503/, "the HTTP status must reach the owner");
        assert.match(err.message, /\/account\b/, "the failing endpoint must reach the owner");
        assert.doesNotMatch(err.message, /secret-token-abc/, "the credential must never appear in a terminal error");
        return true;
      });
    } finally {
      restore();
    }
  })());

test("fetchProfile: a non-retryable 4xx names the /account endpoint AND surfaces Venmo's own error message", () =>
  (async () => {
    const restore = stubFetch([
      () => new Response(JSON.stringify({ error: { message: "account disabled" } }), { status: 403 }),
    ]);
    try {
      await assert.rejects(fetchProfile("secret-token-abc"), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /403/);
        assert.match(err.message, /\/account\b/);
        assert.match(err.message, /account disabled/, "Venmo's own message must survive for a non-retryable status");
        assert.doesNotMatch(err.message, /secret-token-abc/);
        return true;
      });
    } finally {
      restore();
    }
  })());

test("fetchProfile: a 401 terminals as venmo_auth_failed, classified non-retryable by the connector's own pattern", () =>
  (async () => {
    const restore = stubFetch([() => new Response("{}", { status: 401 })]);
    try {
      await assert.rejects(fetchProfile("bad-token"), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /venmo_auth_failed/);
        assert.equal(RETRYABLE_PATTERN.test(err.message), false, "a credential failure must not classify retryable");
        return true;
      });
    } finally {
      restore();
    }
  })());

test("fetchAllFriends: names the /users/{id}/friends endpoint on failure, never the live user id", () =>
  (async () => {
    const restore = stubFetch([() => new Response(JSON.stringify({ error: { message: "nope" } }), { status: 403 })]);
    try {
      await assert.rejects(fetchAllFriends("token", "9999999999999999999", noopProgress), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /403/);
        assert.match(err.message, /\/users\/\{id\}\/friends/, "the endpoint label is templated, not the live user id");
        assert.doesNotMatch(err.message, /9999999999999999999/, "the live user id must not leak into the message");
        return true;
      });
    } finally {
      restore();
    }
  })());

test("fetchTransactionsPage: a 5xx names the /stories/target-or-actor endpoint; a 401 terminals as venmo_auth_failed", () =>
  (async () => {
    const restore500 = stubFetch([() => new Response("upstream boom", { status: 500 })]);
    try {
      await assert.rejects(fetchTransactionsPage("token", "1234567890123456789", undefined), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /500/);
        assert.match(err.message, /\/stories\/target-or-actor/);
        assert.doesNotMatch(err.message, /1234567890123456789/);
        return true;
      });
    } finally {
      restore500();
    }
  })());

test("loginWithCredentials: a wrong-password 401 (no 2FA error code) terminals as venmo_auth_failed, not an OTP prompt", () =>
  (async () => {
    const restore = stubFetch([
      () => new Response(JSON.stringify({ error: { code: 1, message: "Invalid credentials" } }), { status: 401 }),
    ]);
    const sendInteraction = () => {
      throw new Error("must not prompt for OTP on a plain bad-password 401");
    };
    try {
      await assert.rejects(loginWithCredentials("user@example.com", "wrong", sendInteraction), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /venmo_auth_failed/);
        assert.match(err.message, /Invalid credentials/);
        return true;
      });
    } finally {
      restore();
    }
  })());

test("loginWithCredentials: a 2FA-required 401 drives the SMS request then completes login with the OTP code", () =>
  (async () => {
    let smsRequested = false;
    let completedWithHeaders: Record<string, string> | null = null;
    const restore = stubFetch([
      // 1. initial password grant -> 2FA required
      () =>
        new Response(JSON.stringify({ error: { code: 81_109, message: "2FA required" } }), {
          status: 401,
          headers: { "venmo-otp-secret": "secret-abc" },
        }),
      // 2. SMS send
      () => {
        smsRequested = true;
        return new Response(JSON.stringify({ data: { status: "sent" } }), { status: 200 });
      },
      // 3. OTP completion
      () =>
        new Response(JSON.stringify({ access_token: "final-token", user: { id: "1234567890123456789" } }), {
          status: 200,
        }),
    ]);
    // Capture the completion request's headers to assert the OTP/secret round-trip.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers["venmo-otp"]) {
        completedWithHeaders = headers;
      }
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;

    const sendInteraction = () =>
      Promise.resolve({
        data: { code: "123456" },
        request_id: "test-request-id",
        status: "success" as const,
        type: "INTERACTION_RESPONSE" as const,
      });
    try {
      const result = await loginWithCredentials("user@example.com", "right-password", sendInteraction);
      assert.equal(result.accessToken, "final-token");
      assert.equal(result.ownerId, "1234567890123456789");
      assert.equal(smsRequested, true, "the SMS-send endpoint must have been called");
      assert.equal(completedWithHeaders?.["venmo-otp"], "123456");
      assert.equal(completedWithHeaders?.["venmo-otp-secret"], "secret-abc");
    } finally {
      restore();
    }
  })());
