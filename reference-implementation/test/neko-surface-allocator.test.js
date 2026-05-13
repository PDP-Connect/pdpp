import assert from "node:assert/strict";
import test from "node:test";

import {
  NekoSurfaceAllocatorClient,
  NekoSurfaceAllocatorError,
} from "../runtime/neko-surface-allocator.ts";

const SURFACE = Object.freeze({
  surface_id: "surface_1",
  backend: "neko",
  profile_key: "https://registry.pdpp.org/connectors/chatgpt",
  connector_id: "chatgpt",
  cdp_url: "http://allocator.internal/surfaces/surface_1/cdp",
  stream_base_url: "http://reference.test/_ref/browser-surfaces/surface_1/stream",
  health: "ready",
  created_at: "2026-05-12T12:00:00.000Z",
  last_used_at: "2026-05-12T12:01:00.000Z",
  account_key: "account_1",
  active_lease_id: "lease_1",
  container_id: "container_1",
  allocator_metadata: {
    resource_owner: "pdpp-reference",
  },
});

test("ensures a surface through the allocator HTTP API", async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { surface: SURFACE } }]);
  const allocator = new NekoSurfaceAllocatorClient({ baseUrl: "http://allocator.test/api", fetchImpl });

  const surface = await allocator.ensureSurface({
    surfaceId: "surface_1",
    connectorId: "chatgpt",
    profileKey: "https://registry.pdpp.org/connectors/chatgpt",
    accountKey: "account_1",
  });

  assert.deepEqual(surface, SURFACE);
  assert.equal(calls[0].url, "http://allocator.test/api/surfaces");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    surface_id: "surface_1",
    connector_id: "chatgpt",
    profile_key: "https://registry.pdpp.org/connectors/chatgpt",
    account_key: "account_1",
  });
});

test("gets status, lists surfaces, and stops surfaces", async () => {
  const stopped = { ...SURFACE, health: "stopping", active_lease_id: undefined };
  delete stopped.active_lease_id;
  const { fetchImpl, calls } = fakeFetch([
    { status: 200, body: { surface: SURFACE } },
    { status: 200, body: { surfaces: [SURFACE, { ...SURFACE, surface_id: "surface_2", active_lease_id: undefined }] } },
    { status: 200, body: { surface: stopped } },
    { status: 404, body: { error: "missing" } },
  ]);
  const allocator = new NekoSurfaceAllocatorClient({ baseUrl: "http://allocator.test/api/", fetchImpl });

  assert.deepEqual(await allocator.getSurfaceStatus("surface_1"), SURFACE);
  assert.deepEqual(
    (await allocator.listSurfaces()).map((surface) => surface.surface_id),
    ["surface_1", "surface_2"],
  );
  assert.deepEqual(await allocator.stopSurface({ surfaceId: "surface_1", reason: "idle_ttl" }), stopped);
  assert.equal(await allocator.getSurfaceStatus("missing"), null);

  assert.equal(calls[0].url, "http://allocator.test/api/surfaces/surface_1");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[1].url, "http://allocator.test/api/surfaces");
  assert.equal(calls[2].url, "http://allocator.test/api/surfaces/surface_1");
  assert.equal(calls[2].init.method, "DELETE");
  assert.deepEqual(JSON.parse(calls[2].init.body), { reason: "idle_ttl" });
});

test("rejects bad allocator HTTP responses", async () => {
  const { fetchImpl } = fakeFetch([{ status: 503, body: { error: "unavailable" } }]);
  const allocator = new NekoSurfaceAllocatorClient({ baseUrl: "http://allocator.test", fetchImpl });

  await assert.rejects(
    () => allocator.listSurfaces(),
    (error) =>
      error instanceof NekoSurfaceAllocatorError &&
      error.code === "allocator_http_error" &&
      error.status === 503,
  );
});

test("rejects malformed allocator response shapes", async () => {
  const { fetchImpl } = fakeFetch([{ status: 200, body: { surface: { ...SURFACE, cdp_url: undefined } } }]);
  const allocator = new NekoSurfaceAllocatorClient({ baseUrl: "http://allocator.test", fetchImpl });

  await assert.rejects(
    () => allocator.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "chatgpt" }),
    /malformed n\.eko allocator response: ensure surface response is missing cdp_url/,
  );
});

test("rejects foreign backend responses", async () => {
  const { fetchImpl } = fakeFetch([{ status: 200, body: { surface: { ...SURFACE, backend: "docker" } } }]);
  const allocator = new NekoSurfaceAllocatorClient({ baseUrl: "http://allocator.test", fetchImpl });

  await assert.rejects(
    () => allocator.getSurfaceStatus("surface_1"),
    /malformed n\.eko allocator response: surface status response has unsupported backend/,
  );
});

test("preserves server-only CDP and stream URLs on validated surfaces", async () => {
  const cdpUrl = "http://10.0.0.5:9222/devtools/browser/server-only";
  const streamBaseUrl = "http://neko.internal:8080/surface_1";
  const { fetchImpl } = fakeFetch([{ status: 200, body: { surface: { ...SURFACE, cdp_url: cdpUrl, stream_base_url: streamBaseUrl } } }]);
  const allocator = new NekoSurfaceAllocatorClient({ baseUrl: "http://allocator.test", fetchImpl });

  const surface = await allocator.getSurfaceStatus("surface_1");

  assert.equal(surface?.cdp_url, cdpUrl);
  assert.equal(surface?.stream_base_url, streamBaseUrl);
});

test("aborts allocator fetches after the bounded timeout", async () => {
  let signal;
  const fetchImpl = (_input, init = {}) => {
    signal = init.signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  };
  const allocator = new NekoSurfaceAllocatorClient({ baseUrl: "http://allocator.test", fetchImpl, timeoutMs: 1 });

  await assert.rejects(
    () => allocator.listSurfaces(),
    (error) => error instanceof NekoSurfaceAllocatorError && error.code === "allocator_timeout",
  );
  assert.equal(signal.aborted, true);
});

function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (!response) {
      throw new Error("unexpected fetch call");
    }
    return new Response(JSON.stringify(response.body), { status: response.status });
  };
  return { fetchImpl, calls };
}
