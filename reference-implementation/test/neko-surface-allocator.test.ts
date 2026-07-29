const TOP_LEVEL_REGEX_1 = /malformed n\.eko allocator response: ensure surface response is missing cdp_url/;
const TOP_LEVEL_REGEX_2 = /malformed n\.eko allocator response: surface status response has unsupported backend/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { NekoSurfaceAllocatorClient, NekoSurfaceAllocatorError } from "../runtime/neko-surface-allocator.ts";

const SURFACE = Object.freeze({
  account_key: "account_1",
  active_lease_id: "lease_1",
  allocator_metadata: {
    resource_owner: "pdpp-reference",
  },
  backend: "neko",
  cdp_url: "http://allocator.internal/surfaces/surface_1/cdp",
  connector_id: "chatgpt",
  container_id: "container_1",
  created_at: "2026-05-12T12:00:00.000Z",
  health: "ready",
  last_used_at: "2026-05-12T12:01:00.000Z",
  profile_key: "https://registry.pdpp.org/connectors/chatgpt",
  stream_base_url: "http://reference.test/_ref/browser-surfaces/surface_1/stream",
  surface_id: "surface_1",
});

test("ensures a surface through the allocator HTTP API", async () => {
  const { fetchImpl, calls } = fakeFetch([{ body: { surface: SURFACE }, status: 200 }]);
  const allocator = new NekoSurfaceAllocatorClient({ baseUrl: "http://allocator.test/api", fetchImpl });

  const surface = await allocator.ensureSurface({
    accountKey: "account_1",
    connectorId: "chatgpt",
    profileKey: "https://registry.pdpp.org/connectors/chatgpt",
    surfaceId: "surface_1",
  });

  assert.deepEqual(surface, SURFACE);
  // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
  const call = calls[0];
  assert.ok(call, "expected a fetch call to have been recorded");
  assert.equal(call.url, "http://allocator.test/api/surfaces");
  assert.equal(call.init.method, "POST");
  assert.equal(typeof call.init.body, "string");
  assert.deepEqual(JSON.parse(call.init.body as string), {
    account_key: "account_1",
    connector_id: "chatgpt",
    profile_key: "https://registry.pdpp.org/connectors/chatgpt",
    surface_id: "surface_1",
  });
});

test("gets status, lists surfaces, and stops surfaces", async () => {
  const { active_lease_id: _droppedLeaseId, ...stopped } = { ...SURFACE, health: "stopping" };
  const { fetchImpl, calls } = fakeFetch([
    { body: { surface: SURFACE }, status: 200 },
    { body: { surfaces: [SURFACE, { ...SURFACE, active_lease_id: undefined, surface_id: "surface_2" }] }, status: 200 },
    { body: { surface: stopped }, status: 200 },
    { body: { error: "missing" }, status: 404 },
  ]);
  const allocator = new NekoSurfaceAllocatorClient({ baseUrl: "http://allocator.test/api/", fetchImpl });

  assert.deepEqual(await allocator.getSurfaceStatus("surface_1"), SURFACE);
  assert.deepEqual(
    (await allocator.listSurfaces()).map((surface) => surface.surface_id),
    ["surface_1", "surface_2"]
  );
  assert.deepEqual(await allocator.stopSurface({ reason: "idle_ttl", surfaceId: "surface_1" }), stopped);
  assert.equal(await allocator.getSurfaceStatus("missing"), null);

  const [call0, call1, call2] = calls;
  assert.ok(call0, "expected the first fetch call to have been recorded");
  assert.ok(call1, "expected the second fetch call to have been recorded");
  assert.ok(call2, "expected the third fetch call to have been recorded");
  assert.equal(call0.url, "http://allocator.test/api/surfaces/surface_1");
  assert.equal(call0.init.method, "GET");
  assert.equal(call1.url, "http://allocator.test/api/surfaces");
  assert.equal(call2.url, "http://allocator.test/api/surfaces/surface_1");
  assert.equal(call2.init.method, "DELETE");
  assert.equal(typeof call2.init.body, "string");
  assert.deepEqual(JSON.parse(call2.init.body as string), { reason: "idle_ttl" });
});

test("rejects bad allocator HTTP responses", async () => {
  const { fetchImpl } = fakeFetch([{ body: { error: "unavailable" }, status: 503 }]);
  const allocator = new NekoSurfaceAllocatorClient({ baseUrl: "http://allocator.test", fetchImpl });

  await assert.rejects(
    () => allocator.listSurfaces(),
    (error) =>
      error instanceof NekoSurfaceAllocatorError && error.code === "allocator_http_error" && error.status === 503
  );
});

test("rejects malformed allocator response shapes", async () => {
  const { fetchImpl } = fakeFetch([{ body: { surface: { ...SURFACE, cdp_url: undefined } }, status: 200 }]);
  const allocator = new NekoSurfaceAllocatorClient({ baseUrl: "http://allocator.test", fetchImpl });

  await assert.rejects(
    () => allocator.ensureSurface({ connectorId: "chatgpt", profileKey: "chatgpt", surfaceId: "surface_1" }),
    TOP_LEVEL_REGEX_1
  );
});

test("rejects foreign backend responses", async () => {
  const { fetchImpl } = fakeFetch([{ body: { surface: { ...SURFACE, backend: "docker" } }, status: 200 }]);
  const allocator = new NekoSurfaceAllocatorClient({ baseUrl: "http://allocator.test", fetchImpl });

  await assert.rejects(() => allocator.getSurfaceStatus("surface_1"), TOP_LEVEL_REGEX_2);
});

test("preserves server-only CDP and stream URLs on validated surfaces", async () => {
  const cdpUrl = "http://10.0.0.5:9222/devtools/browser/server-only";
  const streamBaseUrl = "http://neko.internal:8080/surface_1";
  const { fetchImpl } = fakeFetch([
    { body: { surface: { ...SURFACE, cdp_url: cdpUrl, stream_base_url: streamBaseUrl } }, status: 200 },
  ]);
  const allocator = new NekoSurfaceAllocatorClient({ baseUrl: "http://allocator.test", fetchImpl });

  const surface = await allocator.getSurfaceStatus("surface_1");

  assert.equal(surface?.cdp_url, cdpUrl);
  assert.equal(surface?.stream_base_url, streamBaseUrl);
});

test("aborts allocator fetches after the bounded timeout", async () => {
  let signal: AbortSignal | undefined;
  const fetchImpl = (_input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    signal = init.signal ?? undefined;
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  };
  const allocator = new NekoSurfaceAllocatorClient({ baseUrl: "http://allocator.test", fetchImpl, timeoutMs: 1 });

  await assert.rejects(
    () => allocator.listSurfaces(),
    (error) => error instanceof NekoSurfaceAllocatorError && error.code === "allocator_timeout"
  );
  assert.ok(signal, "expected the fetch to have been called with an abort signal");
  assert.equal(signal.aborted, true);
});

interface FakeFetchResponse {
  body: unknown;
  status: number;
}

interface FakeFetchCall {
  init: RequestInit;
  url: string;
}

function fakeFetch(responses: FakeFetchResponse[]): {
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  calls: FakeFetchCall[];
} {
  const calls: FakeFetchCall[] = [];
  // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    calls.push({ init, url: String(input) });
    const response = responses.shift();
    if (!response) {
      throw new Error("unexpected fetch call");
    }
    return new Response(JSON.stringify(response.body), { status: response.status });
  };
  return { calls, fetchImpl };
}
