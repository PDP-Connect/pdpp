/**
 * Unit tests for the browser-surface readiness probe.
 *
 * The probe sits between the lease manager's "leased + surface ready"
 * decision and stamping env into the connector child. It must classify
 * failure modes by typed code so a single failed live OTP run yields
 * actionable evidence:
 *
 *   - browser_surface_not_ready        — bookkeeping says ready, but the
 *                                        surface payload is malformed.
 *   - browser_surface_cdp_unreachable  — fetch failed (network).
 *   - browser_surface_cdp_disconnected — HTTP responded, but not as DevTools.
 *   - browser_surface_page_stale       — DevTools listed zero usable pages.
 *   - browser_surface_probe_timeout    — overall probe budget exceeded.
 *
 * Fakes `fetch` so no real n.eko / Chromium is required.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_SURFACE_READINESS_PROBE_CODES,
  createDefaultBrowserSurfaceReadinessProbe,
  probeBrowserSurfaceReadinessOverHttp,
} from "../runtime/browser-surface-readiness.ts";

function readySurface(overrides = {}) {
  return {
    surface_id: "surface_1",
    backend: "neko",
    profile_key: "chatgpt",
    connector_id: "chatgpt",
    cdp_url: "http://neko:9222",
    stream_base_url: "http://neko:8080",
    health: "ready",
    created_at: "2026-05-12T12:00:00.000Z",
    last_used_at: "2026-05-12T12:00:00.000Z",
    ...overrides,
  };
}

function makeFetch(responsesByUrl) {
  const calls = [];
  async function fakeFetch(url, init) {
    calls.push({ url: String(url), init });
    const responder = responsesByUrl[String(url)];
    if (!responder) {
      throw new Error(`unexpected fetch ${String(url)}`);
    }
    return responder(init);
  }
  return { fakeFetch, calls };
}

function jsonResponse(body, status = 200) {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

const VERSION_OK = {
  Browser: "Chrome/124.0.0.0",
  webSocketDebuggerUrl: "ws://neko:9222/devtools/browser/abcd",
};

const PAGE_TARGET = {
  id: "target_1",
  type: "page",
  url: "https://chase.com",
  webSocketDebuggerUrl: "ws://neko:9222/devtools/page/target_1",
};

test("probe returns ok when DevTools answers and has a usable page target", async () => {
  const { fakeFetch } = makeFetch({
    "http://neko:9222/json/version": jsonResponse(VERSION_OK),
    "http://neko:9222/json/list": jsonResponse([PAGE_TARGET]),
  });
  const result = await probeBrowserSurfaceReadinessOverHttp(readySurface(), fakeFetch, 1000);
  assert.equal(result.ok, true);
  assert.equal(result.pageTargetCount, 1);
  assert.equal(result.browserVersion, "Chrome/124.0.0.0");
});

test("probe normalizes cdp_url without trailing slash", async () => {
  const { fakeFetch, calls } = makeFetch({
    "http://neko:9222/json/version": jsonResponse(VERSION_OK),
    "http://neko:9222/json/list": jsonResponse([PAGE_TARGET]),
  });
  await probeBrowserSurfaceReadinessOverHttp(readySurface({ cdp_url: "http://neko:9222" }), fakeFetch, 1000);
  assert.deepEqual(
    calls.map((c) => c.url),
    ["http://neko:9222/json/version", "http://neko:9222/json/list"],
  );
});

test("probe returns browser_surface_not_ready when surface health is not ready", async () => {
  const { fakeFetch } = makeFetch({});
  const result = await probeBrowserSurfaceReadinessOverHttp(
    readySurface({ health: "starting" }),
    fakeFetch,
    1000,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "browser_surface_not_ready");
  assert.match(result.detail, /health is starting/);
});

test("probe returns browser_surface_not_ready when cdp_url is missing", async () => {
  const { fakeFetch } = makeFetch({});
  const result = await probeBrowserSurfaceReadinessOverHttp(
    readySurface({ cdp_url: "" }),
    fakeFetch,
    1000,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "browser_surface_not_ready");
});

test("probe returns browser_surface_not_ready when cdp_url scheme is unsupported", async () => {
  const { fakeFetch } = makeFetch({});
  const result = await probeBrowserSurfaceReadinessOverHttp(
    readySurface({ cdp_url: "ws://neko:9222" }),
    fakeFetch,
    1000,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "browser_surface_not_ready");
  assert.match(result.detail, /scheme/);
});

test("probe returns browser_surface_cdp_unreachable on fetch error", async () => {
  const fakeFetch = async () => {
    throw new TypeError("fetch failed: ECONNREFUSED");
  };
  const result = await probeBrowserSurfaceReadinessOverHttp(readySurface(), fakeFetch, 1000);
  assert.equal(result.ok, false);
  assert.equal(result.code, "browser_surface_cdp_unreachable");
  assert.match(result.detail, /ECONNREFUSED/);
});

test("probe returns browser_surface_cdp_disconnected on non-200 status", async () => {
  const { fakeFetch } = makeFetch({
    "http://neko:9222/json/version": jsonResponse({ error: "gone" }, 503),
  });
  const result = await probeBrowserSurfaceReadinessOverHttp(readySurface(), fakeFetch, 1000);
  assert.equal(result.ok, false);
  assert.equal(result.code, "browser_surface_cdp_disconnected");
  assert.match(result.detail, /HTTP 503/);
});

test("probe returns browser_surface_cdp_disconnected on malformed version payload", async () => {
  const { fakeFetch } = makeFetch({
    "http://neko:9222/json/version": jsonResponse({ Browser: "Chrome" }),
  });
  const result = await probeBrowserSurfaceReadinessOverHttp(readySurface(), fakeFetch, 1000);
  assert.equal(result.ok, false);
  assert.equal(result.code, "browser_surface_cdp_disconnected");
  assert.match(result.detail, /webSocketDebuggerUrl/);
});

test("probe returns browser_surface_cdp_disconnected on malformed JSON", async () => {
  const fakeFetch = async (url) => {
    if (String(url).endsWith("/json/version")) {
      return new Response("not-json", { status: 200, headers: { "content-type": "text/html" } });
    }
    throw new Error("unexpected");
  };
  const result = await probeBrowserSurfaceReadinessOverHttp(readySurface(), fakeFetch, 1000);
  assert.equal(result.ok, false);
  assert.equal(result.code, "browser_surface_cdp_disconnected");
  assert.match(result.detail, /malformed JSON/);
});

test("probe returns browser_surface_page_stale when target list is empty", async () => {
  const { fakeFetch } = makeFetch({
    "http://neko:9222/json/version": jsonResponse(VERSION_OK),
    "http://neko:9222/json/list": jsonResponse([]),
  });
  const result = await probeBrowserSurfaceReadinessOverHttp(readySurface(), fakeFetch, 1000);
  assert.equal(result.ok, false);
  assert.equal(result.code, "browser_surface_page_stale");
  assert.match(result.detail, /zero targets/);
});

test("probe returns browser_surface_page_stale when only devtools:// internal targets", async () => {
  const { fakeFetch } = makeFetch({
    "http://neko:9222/json/version": jsonResponse(VERSION_OK),
    "http://neko:9222/json/list": jsonResponse([
      {
        id: "target_dev",
        type: "page",
        url: "devtools://devtools/bundled/inspector.html",
        webSocketDebuggerUrl: "ws://neko:9222/devtools/page/target_dev",
      },
    ]),
  });
  const result = await probeBrowserSurfaceReadinessOverHttp(readySurface(), fakeFetch, 1000);
  assert.equal(result.ok, false);
  assert.equal(result.code, "browser_surface_page_stale");
});

test("probe returns browser_surface_page_stale when targets exist but none are 'page' type", async () => {
  const { fakeFetch } = makeFetch({
    "http://neko:9222/json/version": jsonResponse(VERSION_OK),
    "http://neko:9222/json/list": jsonResponse([
      { id: "t", type: "service_worker", url: "https://example", webSocketDebuggerUrl: "ws://x/t" },
    ]),
  });
  const result = await probeBrowserSurfaceReadinessOverHttp(readySurface(), fakeFetch, 1000);
  assert.equal(result.ok, false);
  assert.equal(result.code, "browser_surface_page_stale");
});

test("probe returns browser_surface_probe_timeout when fetch is aborted", async () => {
  const fakeFetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  const result = await probeBrowserSurfaceReadinessOverHttp(readySurface(), fakeFetch, 10);
  assert.equal(result.ok, false);
  assert.equal(result.code, "browser_surface_probe_timeout");
});

test("default factory validates timeoutMs", () => {
  assert.throws(() => createDefaultBrowserSurfaceReadinessProbe({ timeoutMs: 0 }), /positive integer/);
  assert.throws(() => createDefaultBrowserSurfaceReadinessProbe({ timeoutMs: -1 }), /positive integer/);
});

test("BROWSER_SURFACE_READINESS_PROBE_CODES enumerates the documented failure codes", () => {
  assert.deepEqual([...BROWSER_SURFACE_READINESS_PROBE_CODES].sort(), [
    "browser_surface_cdp_disconnected",
    "browser_surface_cdp_unreachable",
    "browser_surface_not_ready",
    "browser_surface_page_stale",
    "browser_surface_probe_timeout",
  ]);
});
