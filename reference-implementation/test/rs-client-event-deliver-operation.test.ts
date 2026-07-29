// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import test from "node:test";

import {
  DEFAULT_THROTTLE_SECONDS,
  DELIVERY_CONTENT_TYPE,
  decodeWebhookSecret,
  executeDelivery,
  parseRetryAfterSeconds,
  signEvent,
  verifySignatureHeader,
} from "../operations/rs-client-event-deliver/index.ts";
import type { HttpTransportDeps } from "../server/client-event-delivery-worker.ts";
import { defaultHttpTransport } from "../server/client-event-delivery-worker.ts";

const NOW_MS = Date.parse("2026-05-27T00:00:00.000Z");
const SECRET = `whsec_${randomBytes(32).toString("base64")}`;

// `defaultHttpTransport` is exported with the narrower `HttpTransport` (1-arg)
// type, but its implementation accepts an optional `HttpTransportDeps` second
// argument for test seams (e.g. `dnsLookupImpl`). A 1-arg function type is
// assignable to a 2-arg variable, so this re-typed reference is sound — it
// does not widen or misrepresent the runtime signature.
const defaultHttpTransportWithDeps: (
  req: Parameters<typeof defaultHttpTransport>[0],
  deps: HttpTransportDeps
) => ReturnType<typeof defaultHttpTransport> = defaultHttpTransport;

function fixedDeps(overrides = {}) {
  return {
    nowIso: () => new Date(NOW_MS).toISOString(),
    nowSeconds: () => Math.floor(NOW_MS / 1000),
    randomJitterFactor: () => 1,
    ...overrides,
  };
}

test("Standard Webhooks signing matches the canonical {id}.{ts}.{body} construction", () => {
  const body = '{"hello":"world"}';
  const timestamp = Math.floor(NOW_MS / 1000);
  const eventId = "evt_round_trip";
  const signature = signEvent(SECRET, eventId, timestamp, body);
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(signature, /^v1,[A-Za-z0-9+/=]+$/);
  const expected = `v1,${createHmac("sha256", decodeWebhookSecret(SECRET))
    .update(`${eventId}.${timestamp}.${body}`)
    .digest("base64")}`;
  assert.equal(signature, expected);
  assert.equal(verifySignatureHeader(SECRET, eventId, timestamp, body, signature), true);
  // Rotation: header carrying multiple `v1,` tokens still verifies if any match.
  assert.equal(verifySignatureHeader(SECRET, eventId, timestamp, body, `v1,DEADBEEF ${signature}`), true);
  // Tampered signature is rejected.
  assert.equal(verifySignatureHeader(SECRET, eventId, timestamp, body, "v1,DEADBEEF"), false);
  // Mismatched id changes the signed string and must not verify.
  assert.equal(verifySignatureHeader(SECRET, "evt_other", timestamp, body, signature), false);
});

test("delivery records.changed treats 2xx as delivered", async () => {
  const payloadJson = '{"id":"evt_x"}';
  const result = await executeDelivery(
    {
      attemptCount: 0,
      callbackUrl: "https://callback.example/hook",
      eventId: "evt_x",
      eventType: "pdpp.records.changed",
      payloadJson,
      queueId: 1,
      secret: SECRET,
      subscriptionId: "sub_x",
    },
    {
      ...fixedDeps(),
      // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
      request: async (req) => {
        assert.equal(req.headers["webhook-id"], "evt_x");
        assert.equal(req.headers["webhook-timestamp"], String(Math.floor(NOW_MS / 1000)));
        const webhookSignature = req.headers["webhook-signature"];
        assert.ok(webhookSignature);
        // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
        assert.match(webhookSignature, /^v1,[A-Za-z0-9+/=]+$/);
        assert.equal(req.headers["PDPP-Event-Id"], undefined);
        assert.equal(req.headers["PDPP-Event-Signature"], undefined);
        // CloudEvents JSON structured mode requires the cloudevents+json media type.
        assert.equal(req.headers["content-type"], DELIVERY_CONTENT_TYPE);
        assert.equal(req.headers["content-type"], "application/cloudevents+json; charset=utf-8");
        // The signed `{body}` SHALL be the exact raw bytes the receiver sees.
        assert.equal(req.body, payloadJson);
        assert.equal(
          verifySignatureHeader(SECRET, "evt_x", Math.floor(NOW_MS / 1000), req.body, webhookSignature),
          true,
          "Standard Webhooks signature verifies against the exact raw structured-mode body"
        );
        return { bodyText: "ok", errorMessage: null, latencyMs: 12, statusCode: 200 };
      },
    }
  );
  assert.equal(result.kind, "delivered");
});

test("delivery verify event matches challenge → verified", async () => {
  const result = await executeDelivery(
    {
      attemptCount: 0,
      callbackUrl: "https://callback.example/hook",
      eventId: "evt_v",
      eventType: "pdpp.subscription.verify",
      payloadJson: '{"id":"evt_v","data":{"challenge":"abc"}}',
      queueId: 1,
      secret: SECRET,
      subscriptionId: "sub_x",
      verificationChallenge: "abc",
    },
    {
      ...fixedDeps(),
      request: async () => ({ bodyText: '{"challenge":"abc"}', errorMessage: null, latencyMs: 5, statusCode: 200 }),
    }
  );
  assert.equal(result.kind, "verified");
});

test("delivery verify event wrong challenge → retry", async () => {
  const result = await executeDelivery(
    {
      attemptCount: 0,
      callbackUrl: "https://callback.example/hook",
      eventId: "evt_v",
      eventType: "pdpp.subscription.verify",
      payloadJson: "{}",
      queueId: 1,
      secret: SECRET,
      subscriptionId: "sub_x",
      verificationChallenge: "abc",
    },
    {
      ...fixedDeps(),
      request: async () => ({ bodyText: '{"challenge":"WRONG"}', errorMessage: null, latencyMs: 5, statusCode: 200 }),
    }
  );
  assert.equal(result.kind, "retry");
});

test("delivery non-2xx → retry until attempts exhausted, then final_failure", async () => {
  // biome-ignore lint/suspicious/noEvolvingTypes: the accumulator intentionally represents heterogeneous fixture observations.
  // biome-ignore lint/suspicious/noImplicitAnyLet: the test initializes the value from runtime fixture state before its stable type is known.
  let kind;
  let attempts = 0;
  // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
  for (let i = 0; i < 7; i++) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
    const result = await executeDelivery(
      {
        attemptCount: i,
        callbackUrl: "https://callback.example/hook",
        eventId: "evt_x",
        eventType: "pdpp.records.changed",
        payloadJson: "{}",
        queueId: 1,
        secret: SECRET,
        subscriptionId: "sub_x",
      },
      {
        ...fixedDeps(),
        request: async () => ({ bodyText: "oops", errorMessage: null, latencyMs: 5, statusCode: 500 }),
      }
    );
    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    kind = result.kind;
    attempts = i + 1;
    if (kind === "final_failure") {
      break;
    }
  }
  assert.equal(kind, "final_failure");
  assert.ok(attempts >= 6);
});

test("delivery network error → retry with error captured", async () => {
  const result = await executeDelivery(
    {
      attemptCount: 0,
      callbackUrl: "https://callback.example/hook",
      eventId: "evt_x",
      eventType: "pdpp.records.changed",
      payloadJson: "{}",
      queueId: 1,
      secret: SECRET,
      subscriptionId: "sub_x",
    },
    {
      ...fixedDeps(),
      request: async () => ({ bodyText: null, errorMessage: "ECONNREFUSED", latencyMs: 5, statusCode: null }),
    }
  );
  assert.equal(result.kind, "retry");
  assert.equal(result.error, "ECONNREFUSED");
});

// ---------------------------------------------------------------------------
// 410 Gone auto-disable (P3)
// ---------------------------------------------------------------------------

test("delivery 410 Gone → permanent_failure immediately without consuming retry slots", async () => {
  // Even on the first attempt (attemptCount=0), 410 must produce permanent_failure,
  // not retry — the receiver has declared the endpoint gone.
  const result = await executeDelivery(
    {
      attemptCount: 0,
      callbackUrl: "https://callback.example/hook",
      eventId: "evt_x",
      eventType: "pdpp.records.changed",
      payloadJson: "{}",
      queueId: 1,
      secret: SECRET,
      subscriptionId: "sub_x",
    },
    {
      ...fixedDeps(),
      request: async () => ({ bodyText: "Gone", errorMessage: null, latencyMs: 5, statusCode: 410 }),
    }
  );
  assert.equal(result.kind, "permanent_failure");
  assert.equal(result.statusCode, 410);
  // attemptCount must NOT be incremented — we disabled on attempt 0.
  assert.equal(result.attemptCount, 0);
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(result.error, /410/);
});

test("delivery 410 Gone on later attempt → permanent_failure (not final_failure exhaustion)", async () => {
  // Verify the 410 path fires regardless of attempt depth.
  const result = await executeDelivery(
    {
      attemptCount: 3,
      callbackUrl: "https://callback.example/hook",
      eventId: "evt_x",
      eventType: "pdpp.records.changed",
      payloadJson: "{}",
      queueId: 1,
      secret: SECRET,
      subscriptionId: "sub_x",
    },
    {
      ...fixedDeps(),
      request: async () => ({ bodyText: "Gone", errorMessage: null, latencyMs: 5, statusCode: 410 }),
    }
  );
  assert.equal(result.kind, "permanent_failure");
  // attemptCount preserved, not incremented.
  assert.equal(result.attemptCount, 3);
});

// ---------------------------------------------------------------------------
// 429 / 502 / 504 throttle differentiation (P3) + retry-after inspection
// ---------------------------------------------------------------------------

test("parseRetryAfterSeconds: delay-seconds form", () => {
  const nowMs = Date.parse("2026-05-27T00:00:00.000Z");
  assert.equal(parseRetryAfterSeconds("120", nowMs), 120);
  assert.equal(parseRetryAfterSeconds("0", nowMs), 1); // clamped to min 1
  assert.equal(parseRetryAfterSeconds("999999", nowMs), 86_400); // clamped to max
});

test("parseRetryAfterSeconds: HTTP-date form", () => {
  const nowMs = Date.parse("2026-05-27T00:00:00.000Z");
  const futureDate = new Date(nowMs + 300_000).toUTCString(); // +5 minutes
  const secs = parseRetryAfterSeconds(futureDate, nowMs);
  assert.ok(secs !== null && secs >= 299 && secs <= 301, `expected ~300, got ${secs}`);
});

test("parseRetryAfterSeconds: absent / garbage → null", () => {
  const nowMs = Date.parse("2026-05-27T00:00:00.000Z");
  assert.equal(parseRetryAfterSeconds(null, nowMs), null);
  assert.equal(parseRetryAfterSeconds("", nowMs), null);
  assert.equal(parseRetryAfterSeconds("not-a-date", nowMs), null);
});

test("delivery 429 → throttle outcome, attempt_count unchanged, nextAttemptIso uses retry-after", async () => {
  const before = Date.now();
  const result = await executeDelivery(
    {
      attemptCount: 2,
      callbackUrl: "https://callback.example/hook",
      eventId: "evt_x",
      eventType: "pdpp.records.changed",
      payloadJson: "{}",
      queueId: 1,
      secret: SECRET,
      subscriptionId: "sub_x",
    },
    {
      ...fixedDeps(),
      request: async () => ({
        bodyText: "Too Many Requests",
        errorMessage: null,
        latencyMs: 5,
        responseHeaders: { "retry-after": "90" },
        statusCode: 429,
      }),
    }
  );
  const after = Date.now();
  assert.equal(result.kind, "throttle");
  assert.equal(result.statusCode, 429);
  // Attempt count must NOT be incremented.
  assert.equal(result.attemptCount, 2);
  // nextAttemptIso must be ~90 seconds from now (within a generous 2s wall-clock window).
  const scheduled = Date.parse(result.nextAttemptIso);
  assert.ok(
    scheduled >= before + 89_000 && scheduled <= after + 91_000,
    `expected ~90s from now, got ${scheduled - before}ms from before`
  );
});

test("delivery 429 without retry-after → throttle with DEFAULT_THROTTLE_SECONDS fallback", async () => {
  const before = Date.now();
  const result = await executeDelivery(
    {
      attemptCount: 1,
      callbackUrl: "https://callback.example/hook",
      eventId: "evt_x",
      eventType: "pdpp.records.changed",
      payloadJson: "{}",
      queueId: 1,
      secret: SECRET,
      subscriptionId: "sub_x",
    },
    {
      ...fixedDeps(),
      request: async () => ({
        bodyText: "Too Many Requests",
        errorMessage: null,
        latencyMs: 5,
        statusCode: 429,
      }),
    }
  );
  const after = Date.now();
  assert.equal(result.kind, "throttle");
  assert.equal(result.attemptCount, 1);
  const scheduled = Date.parse(result.nextAttemptIso);
  assert.ok(
    scheduled >= before + (DEFAULT_THROTTLE_SECONDS - 1) * 1000 &&
      scheduled <= after + (DEFAULT_THROTTLE_SECONDS + 1) * 1000,
    `expected ~${DEFAULT_THROTTLE_SECONDS}s from now, got ${scheduled - before}ms from before`
  );
});

test("delivery 502 → throttle outcome", async () => {
  const result = await executeDelivery(
    {
      attemptCount: 0,
      callbackUrl: "https://callback.example/hook",
      eventId: "evt_x",
      eventType: "pdpp.records.changed",
      payloadJson: "{}",
      queueId: 1,
      secret: SECRET,
      subscriptionId: "sub_x",
    },
    {
      ...fixedDeps(),
      request: async () => ({ bodyText: "Bad Gateway", errorMessage: null, latencyMs: 5, statusCode: 502 }),
    }
  );
  assert.equal(result.kind, "throttle");
  assert.equal(result.statusCode, 502);
  assert.equal(result.attemptCount, 0);
});

test("delivery 504 → throttle outcome", async () => {
  const result = await executeDelivery(
    {
      attemptCount: 0,
      callbackUrl: "https://callback.example/hook",
      eventId: "evt_x",
      eventType: "pdpp.records.changed",
      payloadJson: "{}",
      queueId: 1,
      secret: SECRET,
      subscriptionId: "sub_x",
    },
    {
      ...fixedDeps(),
      request: async () => ({ bodyText: "Gateway Timeout", errorMessage: null, latencyMs: 5, statusCode: 504 }),
    }
  );
  assert.equal(result.kind, "throttle");
  assert.equal(result.statusCode, 504);
  assert.equal(result.attemptCount, 0);
});

test("delivery 500 → retry (not throttle, 5xx other than 502/504 uses standard backoff)", async () => {
  const result = await executeDelivery(
    {
      attemptCount: 0,
      callbackUrl: "https://callback.example/hook",
      eventId: "evt_x",
      eventType: "pdpp.records.changed",
      payloadJson: "{}",
      queueId: 1,
      secret: SECRET,
      subscriptionId: "sub_x",
    },
    {
      ...fixedDeps(),
      request: async () => ({ bodyText: "Internal Server Error", errorMessage: null, latencyMs: 5, statusCode: 500 }),
    }
  );
  assert.equal(result.kind, "retry");
  assert.equal(result.attemptCount, 1);
});

test("delivery 403 → retry (non-410 4xx uses standard backoff)", async () => {
  const result = await executeDelivery(
    {
      attemptCount: 0,
      callbackUrl: "https://callback.example/hook",
      eventId: "evt_x",
      eventType: "pdpp.records.changed",
      payloadJson: "{}",
      queueId: 1,
      secret: SECRET,
      subscriptionId: "sub_x",
    },
    {
      ...fixedDeps(),
      request: async () => ({ bodyText: "Forbidden", errorMessage: null, latencyMs: 5, statusCode: 403 }),
    }
  );
  assert.equal(result.kind, "retry");
  assert.equal(result.attemptCount, 1);
});

test("default transport attaches a bounded response-window abort signal", async () => {
  const originalFetch = globalThis.fetch;
  let sawSignal = false;
  try {
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    globalThis.fetch = async (_url, init = {}) => {
      sawSignal = init.signal instanceof AbortSignal && !init.signal.aborted;
      throw new Error("test transport stop");
    };
    const result = await defaultHttpTransportWithDeps(
      {
        body: "{}",
        headers: {},
        method: "POST",
        url: "https://callback.example/hook",
      },
      // The SSRF guard resolves DNS before fetching; stub it to a public
      // address so this test exercises the abort-signal wiring in isolation,
      // not the (separately covered) SSRF block/allow decision.
      { dnsLookupImpl: async () => [{ address: "93.184.216.34" }] }
    );
    assert.equal(result.statusCode, null);
    assert.equal(result.errorMessage, "test transport stop");
    assert.equal(sawSignal, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
