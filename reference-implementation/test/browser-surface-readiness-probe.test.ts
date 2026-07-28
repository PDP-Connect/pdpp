// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

// biome-ignore lint/correctness/noUnresolvedImports: localized test assertion preserves its explicit contract.
import type { BrowserSurface } from "@opendatalabs/remote-surface/leases";
import {
  BROWSER_SURFACE_READINESS_PROBE_CODES,
  type BrowserSurfaceReadinessProbeFailure,
  type BrowserSurfaceReadinessProbeResult,
  type BrowserSurfaceReadinessProbeSuccess,
  type BrowserSurfaceReadinessWebSocketFactory,
  type BrowserSurfaceReadinessWebSocketLike,
  createDefaultBrowserSurfaceReadinessProbe,
  createMidWaitSurfaceLossDetector,
  probeBrowserSurfaceReadinessOverHttp,
} from "../runtime/browser-surface-readiness.ts";

function assertFailure(
  result: BrowserSurfaceReadinessProbeResult
): asserts result is BrowserSurfaceReadinessProbeFailure {
  assert.equal(result.ok, false);
}

function assertSuccess(
  result: BrowserSurfaceReadinessProbeResult
): asserts result is BrowserSurfaceReadinessProbeSuccess {
  assert.equal(result.ok, true);
}

const READY_SURFACE: BrowserSurface = Object.freeze({
  backend: "neko",
  cdp_url: "http://neko.local:9222",
  connector_id: "connector_1",
  created_at: "2026-01-01T00:00:00.000Z",
  health: "ready",
  last_used_at: "2026-01-01T00:00:00.000Z",
  profile_key: "profile_1",
  stream_base_url: "https://neko.local/stream",
  surface_id: "srf_1",
});

const TIMEOUT = 50;

function pageTarget(id = "T1", webSocketDebuggerUrl = `ws://neko/${id}`) {
  return { id, type: "page", url: "https://example.com", webSocketDebuggerUrl };
}

interface RouteSpec {
  readonly json?: unknown;
  readonly malformed?: boolean;
  readonly status?: number;
  readonly throw?: unknown;
}

interface FetchCall {
  readonly init: RequestInit;
  readonly url: string;
}

function makeFetchSpy(routes: Record<string, RouteSpec>) {
  const calls: FetchCall[] = [];
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = async (url: string | Request | URL, init: RequestInit = {}): Promise<Response> => {
    const requestUrl = String(url);
    calls.push({ init, url: requestUrl });
    for (const [needle, spec] of Object.entries(routes)) {
      if (requestUrl.includes(needle)) {
        if (spec.throw) {
          throw spec.throw;
        }
        const status = spec.status ?? 200;
        return {
          // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
          json: async () => {
            if (spec.malformed) {
              throw new SyntaxError("Unexpected token");
            }
            return spec.json;
          },
          ok: status >= 200 && status < 300,
          status,
        } as Response;
      }
    }
    return { json: async () => ({}), ok: false, status: 404 } as Response;
  };
  return { calls, fetch };
}

type FakeWebSocketListenerName = "open" | "message" | "error" | "close";
type FakeWebSocketListener = (event: {
  readonly data?: unknown;
  readonly error?: unknown;
  readonly message?: string;
}) => void;

interface FakeWebSocketPeer {
  deliver: (data: unknown) => void;
  readonly messages: { __answered?: boolean; id?: unknown; method?: string }[];
  open: () => void;
  triggerClose: () => void;
  triggerError: (error?: Error) => void;
}

interface FakeWebSocketEntry {
  readonly peer: FakeWebSocketPeer;
  readonly socket: BrowserSurfaceReadinessWebSocketLike;
  readonly url: string;
}

function makeFakeWebSocketCtor(): {
  FakeWebSocket: BrowserSurfaceReadinessWebSocketFactory;
  sockets: FakeWebSocketEntry[];
} {
  const sockets: FakeWebSocketEntry[] = [];

  function FakeWebSocket(url: string): BrowserSurfaceReadinessWebSocketLike {
    const listeners: Record<FakeWebSocketListenerName, FakeWebSocketListener[]> = {
      close: [],
      error: [],
      message: [],
      open: [],
    };
    let readyState = 0;
    const peer: FakeWebSocketPeer = {
      deliver(data) {
        const payload = typeof data === "string" ? data : JSON.stringify(data);
        for (const fn of listeners.message) {
          fn({ data: payload });
        }
      },
      messages: [],
      open() {
        if (readyState !== 0) {
          return;
        }
        readyState = 1;
        for (const fn of listeners.open) {
          fn({});
        }
      },
      triggerClose() {
        if (readyState === 3) {
          return;
        }
        readyState = 3;
        for (const fn of listeners.close) {
          fn({});
        }
      },
      triggerError(error = new Error("fake_error")) {
        for (const fn of listeners.error) {
          fn({ error, message: error?.message || "fake_error" });
        }
      },
    };
    const socket: BrowserSurfaceReadinessWebSocketLike = {
      addEventListener(name, handler) {
        listeners[name].push(handler);
      },
      close() {
        peer.triggerClose();
      },
      send(data) {
        peer.messages.push(typeof data === "string" ? JSON.parse(data) : data);
      },
    };
    sockets.push({ peer, socket, url });
    queueMicrotask(() => peer.open());
    return socket;
  }

  return { FakeWebSocket, sockets };
}

async function waitForMessage(peer: FakeWebSocketPeer, method: string, timeoutMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = peer.messages.find((entry) => !entry.__answered && entry.method === method);
    if (message) {
      return message;
    }
    // eslint-disable-next-line no-await-in-loop
    // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for CDP method ${method}`);
}

async function waitForSocket(sockets: FakeWebSocketEntry[], timeoutMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sockets[0]) {
      return sockets[0];
    }
    // eslint-disable-next-line no-await-in-loop
    // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
    await Promise.resolve();
  }
  throw new Error("timed out waiting for websocket open");
}

function happyRoutes(over: Record<string, RouteSpec> = {}): Record<string, RouteSpec> {
  return {
    "json/list": { json: [pageTarget("T1"), pageTarget("T2")] },
    "json/version": { json: { Browser: "Chrome/120", webSocketDebuggerUrl: "ws://neko/browser" } },
    "pdpp/window-settle": { json: { height: 900, settled: true, width: 1440 } },
    ...over,
  };
}

test("readiness returns a non-secret hash of exact CDP generation evidence", async () => {
  const first = makeFakeWebSocketCtor();
  const firstProbePromise = probeBrowserSurfaceReadinessOverHttp(
    READY_SURFACE,
    makeFetchSpy(happyRoutes()).fetch,
    first.FakeWebSocket,
    TIMEOUT
  );
  const firstSocket = await waitForSocket(first.sockets);
  const firstMessage = await waitForMessage(firstSocket.peer, "Page.getFrameTree");
  firstSocket.peer.deliver({ id: firstMessage.id, result: { frameTree: { frame: { id: "root" } } } });
  const firstProbe = await firstProbePromise;
  const second = makeFakeWebSocketCtor();
  const secondProbePromise = probeBrowserSurfaceReadinessOverHttp(
    READY_SURFACE,
    makeFetchSpy(
      happyRoutes({
        "json/version": { json: { Browser: "Chrome/120", webSocketDebuggerUrl: "ws://neko/browser-restarted" } },
      })
    ).fetch,
    second.FakeWebSocket,
    TIMEOUT
  );
  const secondSocket = await waitForSocket(second.sockets);
  const secondMessage = await waitForMessage(secondSocket.peer, "Page.getFrameTree");
  secondSocket.peer.deliver({ id: secondMessage.id, result: { frameTree: { frame: { id: "root" } } } });
  const secondProbe = await secondProbePromise;

  assertSuccess(firstProbe);
  assertSuccess(secondProbe);
  assert.notEqual(firstProbe.browserGenerationHash, secondProbe.browserGenerationHash);
  assert.equal("webSocketDebuggerUrl" in firstProbe, false);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(firstProbe.browserGenerationHash ?? "", /^[a-f0-9]{64}$/);
});

test("surface health other than ready → browser_surface_not_ready without any fetch or ws", async () => {
  const { calls, fetch } = makeFetchSpy({});
  const { sockets, FakeWebSocket } = makeFakeWebSocketCtor();
  const r = await probeBrowserSurfaceReadinessOverHttp(
    { ...READY_SURFACE, health: "starting" },
    fetch,
    FakeWebSocket,
    TIMEOUT
  );
  assertFailure(r);
  assert.equal(r.code, "browser_surface_not_ready");
  assert.equal(calls.length, 0, "a not-ready surface must not be probed over HTTP");
  assert.equal(sockets.length, 0, "a not-ready surface must not open a websocket");
});

test("missing or non-http cdp_url → browser_surface_not_ready", async () => {
  const { fetch, calls } = makeFetchSpy({});
  const { FakeWebSocket } = makeFakeWebSocketCtor();
  const noUrl = await probeBrowserSurfaceReadinessOverHttp(
    { ...READY_SURFACE, cdp_url: "" },
    fetch,
    FakeWebSocket,
    TIMEOUT
  );
  assertFailure(noUrl);
  assert.equal(noUrl.code, "browser_surface_not_ready");
  assert.equal(calls.length, 0);

  const wsScheme = await probeBrowserSurfaceReadinessOverHttp(
    { ...READY_SURFACE, cdp_url: "ws://neko.local:9222" },
    fetch,
    FakeWebSocket,
    TIMEOUT
  );
  assertFailure(wsScheme);
  assert.equal(wsScheme.code, "browser_surface_not_ready", "a ws:// scheme is not an http CDP base");

  const garbage = await probeBrowserSurfaceReadinessOverHttp(
    { ...READY_SURFACE, cdp_url: "not a url" },
    fetch,
    FakeWebSocket,
    TIMEOUT
  );
  assertFailure(garbage);
  assert.equal(garbage.code, "browser_surface_not_ready", "an unparseable url is not-ready");
});

test("all stages succeed → ok with page-target count and browser version", async () => {
  const { calls, fetch } = makeFetchSpy(happyRoutes());
  const { FakeWebSocket, sockets } = makeFakeWebSocketCtor();
  const resultPromise = probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  const socket = await waitForSocket(sockets);
  const message = await waitForMessage(socket.peer, "Page.getFrameTree");
  message.__answered = true;
  socket.peer.deliver({ id: message.id, result: { frameTree: { frame: { id: "root" } } } });
  const result = await resultPromise;
  assertSuccess(result);
  assert.equal(result.pageTargetCount, 2, "counts only the /json/list page targets");
  assert.equal(result.browserVersion, "Chrome/120");
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "http://neko.local:9222/json/version",
      "http://neko.local:9222/json/list",
      "http://neko.local:9222/pdpp/window-settle",
    ]
  );
  assert.equal(socket.peer.messages.length, 1, "only the semantic command is sent");
  const [firstMessage] = socket.peer.messages;
  assert.ok(firstMessage);
  assert.equal(firstMessage.method, "Page.getFrameTree");
});

test("missing window-settle behavior is a typed readiness failure before connector use", async () => {
  const { fetch } = makeFetchSpy(happyRoutes({ "pdpp/window-settle": { json: {}, status: 404 } }));
  const { FakeWebSocket } = makeFakeWebSocketCtor();
  const result = await probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  assert.deepEqual(result, {
    code: "browser_surface_window_settle_unavailable",
    detail: "GET http://neko.local:9222/pdpp/window-settle returned HTTP 404",
    ok: false,
  });
});

test("an unsettled window-settle response is a typed readiness failure before connector use", async () => {
  const { fetch } = makeFetchSpy(
    happyRoutes({ "pdpp/window-settle": { json: { height: 900, settled: false, width: 1440 } } })
  );
  const { FakeWebSocket } = makeFakeWebSocketCtor();
  const result = await probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  assertFailure(result);
  assert.equal(result.code, "browser_surface_window_settle_unavailable");
});

test("window-settle capability probe preserves the current screen geometry exactly", async () => {
  const before = { height: 915, width: 412 };
  let currentScreen = { ...before };
  const requests: URL[] = [];
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = async (url: string | Request | URL): Promise<Response> => {
    const requestUrl = new URL(String(url));
    requests.push(requestUrl);
    if (requestUrl.pathname === "/json/version") {
      return {
        json: async () => ({ Browser: "Chrome/120", webSocketDebuggerUrl: "ws://neko/browser" }),
        ok: true,
        status: 200,
      } as Response;
    }
    if (requestUrl.pathname === "/json/list") {
      return { json: async () => [pageTarget("T1")], ok: true, status: 200 } as Response;
    }
    if (requestUrl.pathname === "/pdpp/window-settle") {
      // A query to this endpoint is presentation-affecting in this hostile
      // fake. The readiness probe must make no such request.
      if (requestUrl.searchParams.has("width") || requestUrl.searchParams.has("height")) {
        currentScreen = {
          height: Number(requestUrl.searchParams.get("height")),
          width: Number(requestUrl.searchParams.get("width")),
        };
      }
      return { json: async () => ({ settled: true, ...currentScreen }), ok: true, status: 200 } as Response;
    }
    return { json: async () => ({}), ok: false, status: 404 } as Response;
  };
  const { FakeWebSocket, sockets } = makeFakeWebSocketCtor();
  const resultPromise = probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  const socket = await waitForSocket(sockets);
  const message = await waitForMessage(socket.peer, "Page.getFrameTree");
  socket.peer.deliver({ id: message.id, result: { frameTree: { frame: { id: "root" } } } });
  assert.equal((await resultPromise).ok, true);
  assert.deepEqual(currentScreen, before, "capability probing must preserve the exact current presentation geometry");
  const capabilityRequests = requests.filter((request) => request.pathname === "/pdpp/window-settle");
  assert.deepEqual(
    capabilityRequests.map((request) => `${request.pathname}${request.search}`),
    ["/pdpp/window-settle"]
  );
});

test("ok without a Browser string omits browserVersion", async () => {
  const { fetch } = makeFetchSpy(
    happyRoutes({ "json/version": { json: { webSocketDebuggerUrl: "ws://neko/browser" } } })
  );
  const { FakeWebSocket, sockets } = makeFakeWebSocketCtor();
  const resultPromise = probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  const socket = await waitForSocket(sockets);
  const message = await waitForMessage(socket.peer, "Page.getFrameTree");
  socket.peer.deliver({ id: message.id, result: { frameTree: { frame: { id: "root" } } } });
  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.ok(!("browserVersion" in result), "no Browser field → no browserVersion key");
});

test("version endpoint HTTP error → browser_surface_cdp_disconnected", async () => {
  const { fetch } = makeFetchSpy(happyRoutes({ "json/version": { json: {}, status: 500 } }));
  const { FakeWebSocket } = makeFakeWebSocketCtor();
  const result = await probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  assertFailure(result);
  assert.equal(result.code, "browser_surface_cdp_disconnected");
});

test("version payload missing webSocketDebuggerUrl → browser_surface_cdp_disconnected", async () => {
  const { fetch } = makeFetchSpy(happyRoutes({ "json/version": { json: { Browser: "Chrome/120" } } }));
  const { FakeWebSocket } = makeFakeWebSocketCtor();
  const result = await probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  assertFailure(result);
  assert.equal(result.code, "browser_surface_cdp_disconnected");
});

test("version network throw (not aborted) → browser_surface_cdp_unreachable", async () => {
  const { fetch } = makeFetchSpy(happyRoutes({ "json/version": { throw: new TypeError("ECONNREFUSED") } }));
  const { FakeWebSocket } = makeFakeWebSocketCtor();
  const result = await probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  assertFailure(result);
  assert.equal(result.code, "browser_surface_cdp_unreachable");
});

test("version malformed JSON → browser_surface_cdp_disconnected", async () => {
  const { fetch } = makeFetchSpy(happyRoutes({ "json/version": { json: {}, malformed: true } }));
  const { FakeWebSocket } = makeFakeWebSocketCtor();
  const result = await probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  assertFailure(result);
  assert.equal(result.code, "browser_surface_cdp_disconnected");
});

test("list not an array → browser_surface_cdp_disconnected", async () => {
  const { fetch } = makeFetchSpy(happyRoutes({ "json/list": { json: { not: "an array" } } }));
  const { FakeWebSocket } = makeFakeWebSocketCtor();
  const result = await probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  assertFailure(result);
  assert.equal(result.code, "browser_surface_cdp_disconnected");
});

test("list empty → browser_surface_page_stale (zero targets)", async () => {
  const { fetch } = makeFetchSpy(happyRoutes({ "json/list": { json: [] } }));
  const { FakeWebSocket } = makeFakeWebSocketCtor();
  const result = await probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  assertFailure(result);
  assert.equal(result.code, "browser_surface_page_stale");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(result.detail, /zero targets/);
});

test("list has targets but none usable → browser_surface_page_stale", async () => {
  const unusable = [
    { id: "x", type: "page", url: "devtools://devtools/inspector.html", webSocketDebuggerUrl: "ws://neko/x" },
    { id: "y", type: "background_page", url: "https://ok", webSocketDebuggerUrl: "ws://neko/y" },
    { id: "", type: "page", url: "https://ok", webSocketDebuggerUrl: "ws://neko/z" },
    { type: "page", url: "https://ok", webSocketDebuggerUrl: "ws://neko/w" },
    { id: "q", type: "page", url: "https://ok" },
  ];
  const { fetch } = makeFetchSpy(happyRoutes({ "json/list": { json: unusable } }));
  const { FakeWebSocket } = makeFakeWebSocketCtor();
  const result = await probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  assertFailure(result);
  assert.equal(result.code, "browser_surface_page_stale");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(result.detail, /none are usable/);
});

test("semantic probe timeout → browser_surface_probe_timeout after the observational settle check", async () => {
  const { calls, fetch } = makeFetchSpy(happyRoutes());
  const { FakeWebSocket } = makeFakeWebSocketCtor();
  const result = await probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, 25);
  assertFailure(result);
  assert.equal(result.code, "browser_surface_probe_timeout");
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "http://neko.local:9222/json/version",
      "http://neko.local:9222/json/list",
      "http://neko.local:9222/pdpp/window-settle",
    ]
  );
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(result.detail, /ws:\/\//);
});

test("semantic probe error response → browser_surface_cdp_disconnected without leaking raw target URL", async () => {
  const targetUrl = "ws://neko.local:9222/devtools/page/T1?token=secret";
  const { fetch } = makeFetchSpy(
    happyRoutes({
      "json/list": { json: [pageTarget("T1", targetUrl)] },
    })
  );
  const { FakeWebSocket, sockets } = makeFakeWebSocketCtor();
  const resultPromise = probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  const socket = await waitForSocket(sockets);
  const message = await waitForMessage(socket.peer, "Page.getFrameTree");
  socket.peer.deliver({ error: { code: -32_000, message: "cdp boom" }, id: message.id });
  const result = await resultPromise;
  assertFailure(result);
  assert.equal(result.code, "browser_surface_cdp_disconnected");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(result.detail, /secret|ws:\/\//);
});

test("semantic probe early close → browser_surface_cdp_disconnected without leaking raw target URL", async () => {
  const targetUrl = "ws://neko.local:9222/devtools/page/T1?token=secret";
  const { fetch } = makeFetchSpy(
    happyRoutes({
      "json/list": { json: [pageTarget("T1", targetUrl)] },
    })
  );
  const { FakeWebSocket, sockets } = makeFakeWebSocketCtor();
  const resultPromise = probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  const socket = await waitForSocket(sockets);
  await waitForMessage(socket.peer, "Page.getFrameTree");
  socket.peer.triggerClose();
  const result = await resultPromise;
  assertFailure(result);
  assert.equal(result.code, "browser_surface_cdp_disconnected");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(result.detail, /secret|ws:\/\//);
});

test("createDefaultBrowserSurfaceReadinessProbe rejects a non-positive-integer timeout", () => {
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.throws(() => createDefaultBrowserSurfaceReadinessProbe({ timeoutMs: 0 }), /positive integer/);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.throws(() => createDefaultBrowserSurfaceReadinessProbe({ timeoutMs: -5 }), /positive integer/);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.throws(() => createDefaultBrowserSurfaceReadinessProbe({ timeoutMs: 1.5 }), /positive integer/);
  const probe = createDefaultBrowserSurfaceReadinessProbe({
    fetchImpl: makeFetchSpy(happyRoutes()).fetch,
    timeoutMs: 1000,
    webSocketFactory: makeFakeWebSocketCtor().FakeWebSocket,
  });
  assert.equal(typeof probe.probe, "function");
});

test("the injected probe drives the happy path end-to-end", async () => {
  const { fetch } = makeFetchSpy(happyRoutes());
  const { FakeWebSocket, sockets } = makeFakeWebSocketCtor();
  const probe = createDefaultBrowserSurfaceReadinessProbe({
    fetchImpl: fetch,
    timeoutMs: 1000,
    webSocketFactory: FakeWebSocket,
  });
  const resultPromise = probe.probe(READY_SURFACE);
  const socket = await waitForSocket(sockets);
  const message = await waitForMessage(socket.peer, "Page.getFrameTree");
  socket.peer.deliver({ id: message.id, result: { frameTree: { frame: { id: "root" } } } });
  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.equal(result.pageTargetCount, 2);
});

test("BROWSER_SURFACE_READINESS_PROBE_CODES enumerates the documented failure codes", () => {
  assert.deepEqual([...BROWSER_SURFACE_READINESS_PROBE_CODES].sort(), [
    "browser_surface_cdp_disconnected",
    "browser_surface_cdp_unreachable",
    "browser_surface_not_ready",
    "browser_surface_page_stale",
    "browser_surface_probe_timeout",
    "browser_surface_window_settle_unavailable",
  ]);
});

test("mid-wait successful probe invokes the generic observation hook before the next poll", async () => {
  let probeCount = 0;
  let resolveObserved: () => void;
  const observed = new Promise<void>((resolve) => {
    resolveObserved = resolve;
  });
  const detector = createMidWaitSurfaceLossDetector(
    READY_SURFACE,
    {
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      probe: async () => {
        probeCount += 1;
        return { browserGenerationHash: "b".repeat(64), ok: true, pageTargetCount: 1 };
      },
    },
    {
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      onProbeResult: async (result) => {
        assert.equal(result.ok, true);
        assert.equal(probeCount, 1, "the first observation must finish before another poll is scheduled");
        resolveObserved();
      },
      pollIntervalMs: 1,
    }
  );

  await observed;
  detector.cancel();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(probeCount, 1);
});
