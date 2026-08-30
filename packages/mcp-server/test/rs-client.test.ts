// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { type QueryParams, RsClient } from "../src/rs-client.ts";

const ENCODE_NESTED_QUERY_SHAPES_EXPLICITLY = /encode nested query shapes explicitly/;
const INSUFFICIENT_SCOPE = /insufficient_scope/;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface RecordedCall {
  init: RequestInit | undefined;
  url: string | Request | URL;
}

test("attaches bearer token and forwards query params", async () => {
  const calls: RecordedCall[] = [];
  // biome-ignore lint/suspicious/useAwait: async required to satisfy the Promise<Response>-returning fetch/getJson contract this fixture implements; a synchronous return type is not assignable to the caller's injected dependency.
  const fetch = async (requestUrl: string | Request | URL, init?: RequestInit) => {
    calls.push({ url: requestUrl, init });
    return jsonResponse(200, { ok: true });
  };

  const rs = new RsClient({
    providerUrl: "https://provider.test",
    accessToken: "scoped-abc",
    fetch,
  });

  await rs.getJson("/v1/streams/orders/records", {
    query: { limit: 50, fields: ["id", "amount"], filter: "amount>100" },
  });

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.ok(call, "fetch must be called");
  const url = new URL(call.url as string);
  assert.equal(url.host, "provider.test");
  assert.equal(url.pathname, "/v1/streams/orders/records");
  assert.equal(url.searchParams.get("limit"), "50");
  assert.deepEqual(url.searchParams.getAll("fields"), ["id", "amount"]);
  assert.equal(url.searchParams.get("filter"), "amount>100");
  const headers = call.init?.headers as Record<string, string> | undefined;
  assert.equal(headers?.Authorization, "Bearer scoped-abc");
});

test("rejects object-valued query params instead of JSON-stringifying them", async () => {
  let called = false;
  // biome-ignore lint/suspicious/useAwait: async required to satisfy the Promise<Response>-returning fetch/getJson contract this fixture implements; a synchronous return type is not assignable to the caller's injected dependency.
  const fetch = async () => {
    called = true;
    return jsonResponse(200, { ok: true });
  };

  const rs = new RsClient({
    providerUrl: "https://provider.test",
    accessToken: "scoped-abc",
    fetch,
  });

  // RsClient's own runtime check rejects nested object query values; the
  // production QueryParams type only accepts scalars, so this hostile shape
  // must be cast at the call site to exercise that guard.
  await assert.rejects(
    () =>
      rs.getJson("/v1/streams/orders/records", {
        query: { filter: { amount: { gte: 100 } } } as unknown as QueryParams,
      }),
    ENCODE_NESTED_QUERY_SHAPES_EXPLICITLY
  );
  assert.equal(called, false);
});

test("preserves RS error envelope on 401", async () => {
  const fetch = async () =>
    new Response(JSON.stringify({ error: { type: "authentication", code: "invalid_token", message: "bad" } }), {
      status: 401,
      headers: { "content-type": "application/json", "x-request-id": "req-1" },
    });

  const rs = new RsClient({ providerUrl: "https://x", accessToken: "t", fetch });
  const result = await rs.getJson("/v1/schema");

  assert.equal(result.status, 401);
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected an error envelope");
  }
  assert.equal(result.error.code, "invalid_token");
  assert.equal(result.error.request_id, "req-1");
});

test("synthesizes envelope for plain-text errors", async () => {
  const fetch = async () =>
    new Response("insufficient_scope", {
      status: 403,
      headers: { "content-type": "text/plain" },
    });

  const rs = new RsClient({ providerUrl: "https://x", accessToken: "t", fetch });
  const result = await rs.getJson("/v1/schema");

  assert.equal(result.status, 403);
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected an error envelope");
  }
  assert.equal(result.error.type, "rs_error");
  assert.equal(result.error.code, "http_403");
  assert.match(result.error.message ?? "", INSUFFICIENT_SCOPE);
});

// RsClient is a thin transport adapter: it exposes the raw HTTP status,
// headers, and error envelope for the caller to act on. It does not itself
// schedule retries, perform re-sync, or apply retry/re-sync policy — that
// policy lives in the code that calls RsClient. These tests therefore prove
// exposure/pass-through of transport facts, not retry or re-sync behavior.

test("429 status and Retry-After header are both exposed on the error envelope", async () => {
  const fetch = async () =>
    new Response(JSON.stringify({ error: { type: "rate_limit_error", code: "rate_limit_exceeded" } }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "30" },
    });

  const rs = new RsClient({ providerUrl: "https://x", accessToken: "t", fetch });
  const result = await rs.getJson("/v1/streams/orders/records");

  assert.equal(result.status, 429);
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected an error envelope");
  }
  assert.equal(result.retryAfter, "30");
});

test("410 status and cursor_expired code both surface unchanged, regardless of error.type", async () => {
  const fetch = async () =>
    new Response(JSON.stringify({ error: { type: "gone_error", code: "cursor_expired" } }), {
      status: 410,
      headers: { "content-type": "application/json" },
    });

  const rs = new RsClient({ providerUrl: "https://x", accessToken: "t", fetch });
  const result = await rs.getJson("/v1/streams/orders/records", { query: { changes_since: "stale-cursor" } });

  assert.equal(result.status, 410);
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected an error envelope");
  }
  assert.equal(result.error.code, "cursor_expired");
});

test("unknown error code with a recognized status still surfaces the actual status", async () => {
  const fetch = async () =>
    new Response(JSON.stringify({ error: { type: "not_a_real_type", code: "brand_new_future_code" } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });

  const rs = new RsClient({ providerUrl: "https://x", accessToken: "t", fetch });
  const result = await rs.getJson("/v1/streams/orders/records");

  assert.equal(result.status, 403);
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected an error envelope");
  }
  // Unknown type/code must not prevent a client from still branching on the
  // actual status code, and must not cause a parse failure.
  assert.equal(result.error.type, "not_a_real_type");
  assert.equal(result.error.code, "brand_new_future_code");
});

test("unrecognized HTTP status (471) still parses and surfaces the actual status", async () => {
  const fetch = async () =>
    new Response(JSON.stringify({ error: { type: "unheard_of_type", code: "unheard_of_code" } }), {
      status: 471,
      headers: { "content-type": "application/json" },
    });

  const rs = new RsClient({ providerUrl: "https://x", accessToken: "t", fetch });
  const result = await rs.getJson("/v1/streams/orders/records");

  assert.equal(result.status, 471);
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected an error envelope");
  }
  assert.equal(result.error.type, "unheard_of_type");
  assert.equal(result.error.code, "unheard_of_code");
});

test("contradictory error.type on a 403 does not override the forbidden status", async () => {
  // Body claims a rate-limit shape, but the actual status is 403 (forbidden).
  // The status is authoritative; a client must not treat this as retryable
  // rate-limit handling on the strength of the incompatible body type alone.
  const fetch = async () =>
    new Response(JSON.stringify({ error: { type: "rate_limit_error", code: "rate_limit_exceeded" } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });

  const rs = new RsClient({ providerUrl: "https://x", accessToken: "t", fetch });
  const result = await rs.getJson("/v1/streams/orders/records");

  assert.equal(result.status, 403);
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected an error envelope");
  }
  assert.equal(result.retryAfter, null);
});

test("status-incompatible error.type does not override the transport outcome", async () => {
  // Server reports a 200 success but the body carries a stale/incompatible
  // error-shaped type. The actual status code (success) is authoritative;
  // the incompatible `type` MUST NOT flip a successful response into a failure.
  const fetch = async () =>
    new Response(JSON.stringify({ error: { type: "permission_error" }, ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const rs = new RsClient({ providerUrl: "https://x", accessToken: "t", fetch });
  const result = await rs.getJson("/v1/streams/orders/records");

  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
});

test("getRaw returns a Buffer for binary payloads", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const fetch = async () =>
    new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } });

  const rs = new RsClient({ providerUrl: "https://x", accessToken: "t", fetch });
  const result = await rs.getRaw("/v1/blobs/abc");

  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("expected a success envelope");
  }
  assert.ok(Buffer.isBuffer(result.body));
  assert.equal(result.body.length, 4);
  assert.deepEqual([...result.body], [1, 2, 3, 4]);
});
