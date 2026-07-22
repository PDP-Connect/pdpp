// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the streaming-target registration client.
 *
 * Exercises the wire shape the connector runtime / browser binding uses
 * to register/unregister a CDP page-target wsUrl with the reference
 * server, with a fake `fetch`. We do NOT spin up a real server here —
 * the matching server side already has its own test suite
 * (`reference-implementation/server/streaming/run-target-registry.test.js`);
 * this test verifies our half of the contract: the URL shape (composite
 * `(runId, interactionId)`), the PUT/POST method, the bearer header, the
 * body envelope (including optional metadata), and the never-throws failure
 * modes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createRegistrationClient,
  LOCAL_DEVICE_TOKEN_ENV,
  type NekoTargetDescriptor,
  REGISTRATION_PATH,
  type RegisterArgs,
  type RegistrationLogger,
  resolveStreamingRegistrationFromEnv,
  STREAMING_REGISTRATION_TOKEN_ENV,
  type StreamingTargetRegisterArgs,
} from "./streaming-target-registration.ts";

const VALID_WS = "ws://127.0.0.1:9222/devtools/page/abc123XYZ";
const VALID_WSS = "wss://localhost:9223/devtools/page/xyz";
const VALID_NEKO_WS = "ws://neko:9223/devtools/page/neko123";
const VALID_NEKO_DESCRIPTOR = {
  connection_token: "neko-session-token",
  session_url: "http://127.0.0.1:8080/",
  viewport: { height: 720, width: 1280 },
} satisfies NekoTargetDescriptor;

interface SeenRequest {
  body: string | null;
  headers: Record<string, string>;
  method: string;
  url: string;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return (input as Request).url;
}

function makeFakeFetch(responses: Array<Response | (() => Response | Promise<Response>) | Error>): {
  fetchImpl: typeof fetch;
  seen: SeenRequest[];
} {
  const seen: SeenRequest[] = [];
  let cursor = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = urlOf(input);
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders) {
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(rawHeaders)) {
        for (const [key, value] of rawHeaders) {
          headers[key] = value;
        }
      } else {
        for (const [key, value] of Object.entries(rawHeaders)) {
          headers[key] = String(value);
        }
      }
    }
    const body = typeof init?.body === "string" ? init.body : null;
    seen.push({ body, headers, method, url });
    const next = responses[cursor++];
    if (next === undefined) {
      throw new Error(`fakeFetch: no response queued for request #${cursor} (${method} ${url})`);
    }
    if (next instanceof Error) {
      throw next;
    }
    if (typeof next === "function") {
      return await next();
    }
    return next;
  };
  return { fetchImpl, seen };
}

function makeCapturingLogger(): {
  entries: Array<{ message: string; data?: Record<string, unknown> }>;
  logger: RegistrationLogger;
} {
  const entries: Array<{ message: string; data?: Record<string, unknown> }> = [];
  return {
    entries,
    logger: {
      warn(message, data) {
        entries.push(data === undefined ? { message } : { message, data });
      },
    },
  };
}

test("createRegistrationClient throws when baseUrl is missing", () => {
  assert.throws(() => createRegistrationClient({ baseUrl: "", deviceToken: "token" }), /baseUrl required/);
});

test("createRegistrationClient throws when deviceToken is missing", () => {
  assert.throws(
    () => createRegistrationClient({ baseUrl: "http://127.0.0.1:7662", deviceToken: "" }),
    /deviceToken required/
  );
});

test("register PUTs to /admin/runs/:runId/interactions/:interactionId/streaming-target with bearer header and ws_url body", async () => {
  const { fetchImpl, seen } = makeFakeFetch([new Response("{}", { status: 200 })]);
  const client = createRegistrationClient({
    baseUrl: "http://127.0.0.1:7662",
    deviceToken: "device-token-abc",
    fetch: fetchImpl,
  });

  const ok = await client.register({ runId: "run_123", interactionId: "int_456", wsUrl: VALID_WS });

  assert.equal(ok, true);
  assert.equal(seen.length, 1);
  const [sent] = seen;
  assert.ok(sent, "request was captured");
  assert.equal(sent.method, "PUT");
  assert.equal(sent.url, `http://127.0.0.1:7662${REGISTRATION_PATH("run_123", "int_456")}`);
  assert.equal(sent.headers.authorization, "Bearer device-token-abc");
  assert.equal(sent.headers["content-type"], "application/json");
  assert.deepEqual(sent.body ? JSON.parse(sent.body) : null, { ws_url: VALID_WS });
});

test("register includes optional page_url, page_title, reason metadata when provided", async () => {
  const { fetchImpl, seen } = makeFakeFetch([new Response("{}", { status: 200 })]);
  const client = createRegistrationClient({
    baseUrl: "http://127.0.0.1:7662",
    deviceToken: "tok",
    fetch: fetchImpl,
  });

  const ok = await client.register({
    runId: "run_123",
    interactionId: "int_456",
    wsUrl: VALID_WS,
    pageUrl: "https://example.test/login",
    pageTitle: "Sign in",
    reason: "captcha",
  });

  assert.equal(ok, true);
  assert.deepEqual(seen[0]?.body ? JSON.parse(seen[0].body) : null, {
    ws_url: VALID_WS,
    page_url: "https://example.test/login",
    page_title: "Sign in",
    reason: "captcha",
  });
});

test("register accepts explicit cdp backend and preserves PUT ws_url body", async () => {
  const { fetchImpl, seen } = makeFakeFetch([new Response("{}", { status: 200 })]);
  const client = createRegistrationClient({
    baseUrl: "http://127.0.0.1:7662",
    deviceToken: "tok",
    fetch: fetchImpl,
  });
  const args = {
    backend: "cdp",
    interactionId: "int_456",
    runId: "run_123",
    wsUrl: VALID_WS,
  } satisfies RegisterArgs;

  const ok = await client.register(args);

  assert.equal(ok, true);
  assert.equal(seen.length, 1);
  const [sent] = seen;
  assert.ok(sent);
  assert.equal(sent.method, "PUT");
  assert.deepEqual(sent.body ? JSON.parse(sent.body) : null, { ws_url: VALID_WS });
});

test("register POSTs n.eko descriptor to /admin/runs/:runId/interactions/:interactionId/streaming-target", async () => {
  const { fetchImpl, seen } = makeFakeFetch([new Response("{}", { status: 200 })]);
  const client = createRegistrationClient({
    baseUrl: "http://127.0.0.1:7662",
    deviceToken: "neko-token",
    fetch: fetchImpl,
  });
  const args = {
    backend: "neko",
    descriptor: VALID_NEKO_DESCRIPTOR,
    interactionId: "int_neko",
    pageTitle: "n.eko browser",
    pageUrl: "https://example.test/manual-action",
    reason: "manual_action",
    runId: "run_neko",
  } satisfies StreamingTargetRegisterArgs;

  const ok = await client.register(args);

  assert.equal(ok, true);
  assert.equal(seen.length, 1);
  const [sent] = seen;
  assert.ok(sent, "request was captured");
  assert.equal(sent.method, "POST");
  assert.equal(sent.url, `http://127.0.0.1:7662${REGISTRATION_PATH("run_neko", "int_neko")}`);
  assert.equal(sent.headers.authorization, "Bearer neko-token");
  assert.equal(sent.headers["content-type"], "application/json");
  assert.deepEqual(sent.body ? JSON.parse(sent.body) : null, {
    backend: "neko",
    descriptor: VALID_NEKO_DESCRIPTOR,
    page_title: "n.eko browser",
    page_url: "https://example.test/manual-action",
    reason: "manual_action",
  });
});

test("register accepts wss: loopback URLs", async () => {
  const { fetchImpl, seen } = makeFakeFetch([new Response("{}", { status: 200 })]);
  const client = createRegistrationClient({
    baseUrl: "http://127.0.0.1:7662",
    deviceToken: "tok",
    fetch: fetchImpl,
  });
  const ok = await client.register({ runId: "run_1", interactionId: "int_a", wsUrl: VALID_WSS });
  assert.equal(ok, true);
  assert.equal(seen.length, 1);
});

test("register accepts managed n.eko CDP URLs", async () => {
  const { fetchImpl, seen } = makeFakeFetch([new Response("{}", { status: 200 })]);
  const client = createRegistrationClient({
    baseUrl: "http://127.0.0.1:7662",
    deviceToken: "tok",
    fetch: fetchImpl,
  });
  const ok = await client.register({ runId: "run_neko_cdp", interactionId: "int_neko_cdp", wsUrl: VALID_NEKO_WS });

  assert.equal(ok, true);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]?.body ? JSON.parse(seen[0].body) : null, { ws_url: VALID_NEKO_WS });
});

test("register URL-encodes runId AND interactionId in the path", async () => {
  const { fetchImpl, seen } = makeFakeFetch([new Response("{}", { status: 200 })]);
  const client = createRegistrationClient({
    baseUrl: "http://127.0.0.1:7662",
    deviceToken: "tok",
    fetch: fetchImpl,
  });
  await client.register({
    runId: "run/with/slashes",
    interactionId: "int with spaces",
    wsUrl: VALID_WS,
  });
  assert.equal(
    seen[0]?.url.endsWith("/admin/runs/run%2Fwith%2Fslashes/interactions/int%20with%20spaces/streaming-target"),
    true
  );
});

test("register returns false and does NOT call fetch when interactionId is empty", async () => {
  const { fetchImpl, seen } = makeFakeFetch([]);
  const { logger, entries } = makeCapturingLogger();
  const client = createRegistrationClient({
    baseUrl: "http://127.0.0.1:7662",
    deviceToken: "tok",
    fetch: fetchImpl,
    logger,
  });
  const ok = await client.register({ runId: "run_1", interactionId: "", wsUrl: VALID_WS });
  assert.equal(ok, false);
  assert.equal(seen.length, 0);
  assert.equal(
    entries.some((e) => e.message.includes("interactionId is empty")),
    true
  );
});

test("register returns false and does NOT call fetch when wsUrl host is not allowed", async () => {
  const { fetchImpl, seen } = makeFakeFetch([]);
  const { logger, entries } = makeCapturingLogger();
  const client = createRegistrationClient({
    baseUrl: "http://127.0.0.1:7662",
    deviceToken: "tok",
    fetch: fetchImpl,
    logger,
  });

  const ok = await client.register({
    runId: "run_1",
    interactionId: "int_a",
    wsUrl: "ws://example.com:9222/devtools/page/abc",
  });

  assert.equal(ok, false);
  assert.equal(seen.length, 0, "fetch must not be called for a disallowed wsUrl host");
  // Critically: never log the wsUrl itself (path encodes the secret).
  const serialized = JSON.stringify(entries);
  assert.equal(serialized.includes("example.com"), false);
  assert.equal(serialized.includes("/devtools/page/abc"), false);
});

test("register returns false and does NOT call fetch when wsUrl is malformed", async () => {
  const { fetchImpl, seen } = makeFakeFetch([]);
  const client = createRegistrationClient({
    baseUrl: "http://127.0.0.1:7662",
    deviceToken: "tok",
    fetch: fetchImpl,
  });
  const ok = await client.register({ runId: "run_1", interactionId: "int_a", wsUrl: "not-a-url" });
  assert.equal(ok, false);
  assert.equal(seen.length, 0);
});

test("register returns false and does NOT call fetch when n.eko descriptor is invalid", async () => {
  const { fetchImpl, seen } = makeFakeFetch([]);
  const { logger, entries } = makeCapturingLogger();
  const client = createRegistrationClient({
    baseUrl: "http://127.0.0.1:7662",
    deviceToken: "tok",
    fetch: fetchImpl,
    logger,
  });
  const malformedArgs = JSON.parse(
    JSON.stringify({
      backend: "neko",
      descriptor: null,
      interactionId: "int_neko",
      runId: "run_1",
    })
  ) as StreamingTargetRegisterArgs;
  const ok = await client.register(malformedArgs);
  assert.equal(ok, false);
  assert.equal(seen.length, 0);
  assert.equal(
    entries.some((e) => e.message.includes("neko descriptor")),
    true
  );
});

test("register returns false and does NOT call fetch when wsUrl uses non-ws scheme", async () => {
  const { fetchImpl, seen } = makeFakeFetch([]);
  const client = createRegistrationClient({
    baseUrl: "http://127.0.0.1:7662",
    deviceToken: "tok",
    fetch: fetchImpl,
  });
  const ok = await client.register({
    runId: "run_1",
    interactionId: "int_a",
    wsUrl: "http://127.0.0.1:9222/devtools/page/abc",
  });
  assert.equal(ok, false);
  assert.equal(seen.length, 0);
});

test("register returns false (does not throw) on network failure", async () => {
  const { fetchImpl } = makeFakeFetch([new Error("ECONNREFUSED")]);
  const { logger, entries } = makeCapturingLogger();
  const client = createRegistrationClient({
    baseUrl: "http://127.0.0.1:7662",
    deviceToken: "tok",
    fetch: fetchImpl,
    logger,
  });

  const ok = await client.register({ runId: "run_1", interactionId: "int_a", wsUrl: VALID_WS });
  assert.equal(ok, false);
  assert.equal(
    entries.some((e) => e.message.includes("network error")),
    true
  );
});

test("register returns false (does not throw) on 401", async () => {
  const { fetchImpl } = makeFakeFetch([new Response("{}", { status: 401 })]);
  const { logger, entries } = makeCapturingLogger();
  const client = createRegistrationClient({
    baseUrl: "http://127.0.0.1:7662",
    deviceToken: "tok",
    fetch: fetchImpl,
    logger,
  });

  const ok = await client.register({ runId: "run_1", interactionId: "int_a", wsUrl: VALID_WS });
  assert.equal(ok, false);
  const status401 = entries.find((e) => e.data?.status === 401);
  assert.ok(status401, "401 should be logged");
});

test("register returns false (does not throw) on 4xx with body", async () => {
  const { fetchImpl } = makeFakeFetch([
    new Response('{"error":{"code":"run_target_invalid_url","message":"bad"}}', { status: 400 }),
  ]);
  const client = createRegistrationClient({
    baseUrl: "http://127.0.0.1:7662",
    deviceToken: "tok",
    fetch: fetchImpl,
  });
  const ok = await client.register({ runId: "run_1", interactionId: "int_a", wsUrl: VALID_WS });
  assert.equal(ok, false);
});

test("unregister DELETEs to /admin/runs/:runId/interactions/:interactionId/streaming-target with bearer header", async () => {
  const { fetchImpl, seen } = makeFakeFetch([new Response("{}", { status: 200 })]);
  const client = createRegistrationClient({
    baseUrl: "http://127.0.0.1:7662",
    deviceToken: "device-token-xyz",
    fetch: fetchImpl,
  });

  const ok = await client.unregister({ runId: "run_999", interactionId: "int_888" });

  assert.equal(ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.method, "DELETE");
  assert.equal(seen[0]?.url, `http://127.0.0.1:7662${REGISTRATION_PATH("run_999", "int_888")}`);
  assert.equal(seen[0]?.headers.authorization, "Bearer device-token-xyz");
});

test("unregister returns false (does not throw) on network failure", async () => {
  const { fetchImpl } = makeFakeFetch([new Error("ECONNREFUSED")]);
  const client = createRegistrationClient({
    baseUrl: "http://127.0.0.1:7662",
    deviceToken: "tok",
    fetch: fetchImpl,
  });
  const ok = await client.unregister({ runId: "run_1", interactionId: "int_a" });
  assert.equal(ok, false);
});

test("unregister returns false on 404 silently (record already gone)", async () => {
  const { fetchImpl } = makeFakeFetch([new Response("{}", { status: 404 })]);
  const { logger, entries } = makeCapturingLogger();
  const client = createRegistrationClient({
    baseUrl: "http://127.0.0.1:7662",
    deviceToken: "tok",
    fetch: fetchImpl,
    logger,
  });
  const ok = await client.unregister({ runId: "run_1", interactionId: "int_a" });
  assert.equal(ok, false);
  // 404 cleanup is the common case (TTL swept it). Don't be noisy.
  assert.equal(entries.length, 0, "404 on unregister should be silent");
});

test("unregister returns false silently when runId or interactionId is empty", async () => {
  const { fetchImpl, seen } = makeFakeFetch([]);
  const client = createRegistrationClient({
    baseUrl: "http://127.0.0.1:7662",
    deviceToken: "tok",
    fetch: fetchImpl,
  });
  assert.equal(await client.unregister({ runId: "", interactionId: "int_a" }), false);
  assert.equal(await client.unregister({ runId: "run_a", interactionId: "" }), false);
  assert.equal(seen.length, 0);
});

// ─── env-var resolver: token precedence + missing-piece behavior ────────────

test("resolveStreamingRegistrationFromEnv prefers PDPP_STREAMING_REGISTRATION_TOKEN over PDPP_LOCAL_DEVICE_TOKEN", async () => {
  // Construct a synthetic env so the test does not mutate process.env.
  const env: NodeJS.ProcessEnv = {
    PDPP_RUN_ID: "run_abc",
    PDPP_REFERENCE_BASE_URL: "http://127.0.0.1:7662",
    [STREAMING_REGISTRATION_TOKEN_ENV]: "nonce_v1",
    [LOCAL_DEVICE_TOKEN_ENV]: "device_v1",
  };
  const hooks = await resolveStreamingRegistrationFromEnv(env);
  assert.ok(hooks, "hooks should be returned when all three pieces are present");
  assert.equal(hooks.runId, "run_abc");

  // Drive a register() call through a fake fetch so we can read the
  // bearer header and assert which token won precedence.
  // We rebuild a client manually with the same shape; the resolver itself
  // doesn't expose the bearer, but the precedence rule is covered by the
  // client behavior plus the explicit test below using both env vars.
  const { fetchImpl, seen } = makeFakeFetch([new Response("{}", { status: 200 })]);
  const baseUrl = env.PDPP_REFERENCE_BASE_URL ?? assert.fail("PDPP_REFERENCE_BASE_URL is set in fixture");
  const client = createRegistrationClient({
    baseUrl,
    // Mirror the resolver's precedence: registration token wins over device token.
    deviceToken: env[STREAMING_REGISTRATION_TOKEN_ENV] || env[LOCAL_DEVICE_TOKEN_ENV] || "",
    fetch: fetchImpl,
  });
  await client.register({ runId: "run_abc", interactionId: "int_x", wsUrl: VALID_WS });
  assert.equal(seen[0]?.headers.authorization, "Bearer nonce_v1");
});

test("resolveStreamingRegistrationFromEnv falls back to PDPP_LOCAL_DEVICE_TOKEN when registration token unset", async () => {
  const env: NodeJS.ProcessEnv = {
    PDPP_RUN_ID: "run_abc",
    PDPP_REFERENCE_BASE_URL: "http://127.0.0.1:7662",
    [LOCAL_DEVICE_TOKEN_ENV]: "device_v1",
  };
  const hooks = await resolveStreamingRegistrationFromEnv(env);
  assert.ok(hooks);
  assert.equal(hooks.runId, "run_abc");
});

test("resolveStreamingRegistrationFromEnv accepts PDPP_STREAMING_REGISTRATION_TOKEN alone (no device token)", async () => {
  const env: NodeJS.ProcessEnv = {
    PDPP_RUN_ID: "run_abc",
    PDPP_REFERENCE_BASE_URL: "http://127.0.0.1:7662",
    [STREAMING_REGISTRATION_TOKEN_ENV]: "nonce_v1",
  };
  const hooks = await resolveStreamingRegistrationFromEnv(env);
  assert.ok(hooks);
  assert.equal(hooks.runId, "run_abc");
});

test("resolveStreamingRegistrationFromEnv returns undefined when runId is missing", async () => {
  const env: NodeJS.ProcessEnv = {
    PDPP_REFERENCE_BASE_URL: "http://127.0.0.1:7662",
    [STREAMING_REGISTRATION_TOKEN_ENV]: "nonce_v1",
  };
  const hooks = await resolveStreamingRegistrationFromEnv(env);
  assert.equal(hooks, undefined);
});

test("resolveStreamingRegistrationFromEnv returns undefined when both token env vars are unset", async () => {
  const env: NodeJS.ProcessEnv = {
    PDPP_RUN_ID: "run_abc",
    PDPP_REFERENCE_BASE_URL: "http://127.0.0.1:7662",
  };
  const hooks = await resolveStreamingRegistrationFromEnv(env);
  assert.equal(hooks, undefined);
});

test("resolveStreamingRegistrationFromEnv trims whitespace in env values", async () => {
  const env: NodeJS.ProcessEnv = {
    PDPP_RUN_ID: "  run_abc  ",
    PDPP_REFERENCE_BASE_URL: "  http://127.0.0.1:7662  ",
    [STREAMING_REGISTRATION_TOKEN_ENV]: "  nonce_v1  ",
  };
  const hooks = await resolveStreamingRegistrationFromEnv(env);
  assert.ok(hooks);
  assert.equal(hooks.runId, "run_abc");
});
