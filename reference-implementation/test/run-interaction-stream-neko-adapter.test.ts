// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createDefaultStreamingCompanionFactory as createStreamingBackendCompanionFactory } from "../server/streaming/companion-factory.ts";
import {
  buildCopySelectionExpression as buildCopySelectionExpressionUntyped,
  createDefaultStreamingCompanionFactory as createDefaultNekoStreamingCompanionFactoryUntyped,
  createNekoCompanion as createNekoCompanionUntyped,
} from "../server/streaming/neko-adapter.ts";

/**
 * `server/streaming/neko-adapter.js` is untyped JS (allowJs, checkJs:false)
 * under server/**, forbidden to touch. Its options object accepts a very
 * wide, loosely-validated set of ad hoc fields (env/target/options merged via
 * an internal `choose()` helper), so a permissive `Record<string, unknown>`
 * intersected with the specific fields these tests actually assert against is
 * the honest shape here — not a suppression, since there is no real narrower
 * contract to model from the untyped source.
 */
interface NekoCompanionEvent {
  kind: string;
  [key: string]: unknown;
}

interface NekoFrame {
  data: unknown;
  metadata: unknown;
  sessionId: unknown;
}

interface NekoCompanion {
  _internal: {
    isStarted: () => boolean;
    isClosed: () => boolean;
    isAuthenticated?: () => boolean;
    browserOwnerMode?: () => string;
    stealthMode?: () => string;
  };
  ackFrame: (sessionId?: number) => Promise<void>;
  backend: string;
  browser_session_id: string;
  dispatch: (event: Record<string, unknown>) => Promise<void>;
  getNekoProxyTarget?: () => unknown;
  onEvent: (handler: (event: NekoCompanionEvent) => void) => () => void;
  onFrame: (handler: (frame: NekoFrame) => void) => () => void;
  queryNekoStatus?: () => Promise<unknown>;
  start: (viewport?: Record<string, unknown>) => Promise<void>;
  stop: () => Promise<void>;
}

type NekoCompanionOptions = Record<string, unknown>;

type NekoStreamingCompanionFactory = (args: {
  run_id?: string;
  interaction_id?: string;
  browser_session_id?: string;
}) => NekoCompanion | null;

const buildCopySelectionExpression = buildCopySelectionExpressionUntyped as unknown as () => string;
const createNekoCompanion = createNekoCompanionUntyped as unknown as (opts: NekoCompanionOptions) => NekoCompanion;
const createDefaultStreamingCompanionFactory = createDefaultNekoStreamingCompanionFactoryUntyped as unknown as (
  opts?: NekoCompanionOptions
) => NekoStreamingCompanionFactory | null;

interface FakeResponse {
  arrayBuffer: () => Promise<ArrayBuffer>;
  headers: { get: (name: string) => string | null; getSetCookie: () => string[] };
  json: () => Promise<unknown>;
  ok: boolean;
  status: number;
}

function makeResponse({
  status = 200,
  body = "",
  headers = {},
  json,
}: {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  json?: unknown;
} = {}): FakeResponse {
  const headerMap = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const bodyBytes = Buffer.from(body);
  return {
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async arrayBuffer() {
      return bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength);
    },
    headers: {
      get(name: string) {
        return headerMap.get(String(name).toLowerCase()) || null;
      },
      getSetCookie() {
        const value = headerMap.get("set-cookie");
        return value ? [value] : [];
      },
    },
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async json() {
      if (json !== undefined) {
        return json;
      }
      throw new Error("no json body");
    },
    ok: status >= 200 && status < 300,
    status,
  };
}

interface FetchCall {
  init: { method?: string; headers?: Record<string, string>; body?: string };
  url: string;
}

interface FetchRoute {
  method?: string;
  response:
    | FakeResponse
    | ((args: { url: string; init: FetchCall["init"]; calls: FetchCall[] }) => FakeResponse | Promise<FakeResponse>);
  url: string | RegExp;
}

type FakeFetch = ((url: string, init?: FetchCall["init"]) => Promise<FakeResponse>) & { calls: FetchCall[] };

function makeFetch(routes: FetchRoute[]): FakeFetch {
  const calls: FetchCall[] = [];
  // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
  const fetchImpl = async (url: string, init: FetchCall["init"] = {}) => {
    calls.push({ init, url });
    const route = routes.find((candidate) => {
      if (candidate.method && candidate.method !== init.method) {
        return false;
      }
      return typeof candidate.url === "string" ? url === candidate.url : candidate.url.test(url);
    });
    if (!route && init.method === "GET" && url === "https://neko.test/api/room/screen") {
      return makeResponse({ json: { height: 720, rate: 30, width: 1280 } });
    }
    if (!route) {
      throw new Error(`unexpected fetch: ${init.method || "GET"} ${url}`);
    }
    return typeof route.response === "function" ? route.response({ calls, init, url }) : route.response;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function evaluateCopySelectionExpression(document: unknown): unknown {
  return runInNewContext(buildCopySelectionExpression(), { document });
}

test("n.eko copy selection expression reads active text-input selections", () => {
  assert.equal(
    evaluateCopySelectionExpression({
      activeElement: {
        selectionEnd: 12,
        selectionStart: 6,
        tagName: "INPUT",
        type: "text",
        value: "hello remote",
      },
      getSelection: () => ({ toString: () => "" }),
    }),
    "remote"
  );
});

test("n.eko copy selection expression falls back to page selections and excludes passwords", () => {
  assert.equal(
    evaluateCopySelectionExpression({
      activeElement: {
        selectionEnd: 11,
        selectionStart: 0,
        tagName: "INPUT",
        type: "password",
        value: "supersecret",
      },
      getSelection: () => ({ toString: () => "" }),
    }),
    ""
  );
  assert.equal(
    evaluateCopySelectionExpression({
      activeElement: { tagName: "BODY" },
      getSelection: () => ({ toString: () => "page selection" }),
    }),
    "page selection"
  );
});

interface SleepCall {
  ms: number;
  signal: AbortSignal | undefined;
}

type AbortableSleep = ((ms: number, signal?: AbortSignal) => Promise<void>) & { calls: SleepCall[] };

function makeAbortableSleep(): AbortableSleep {
  const calls: SleepCall[] = [];
  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      calls.push({ ms, signal });
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  sleep.calls = calls;
  return sleep;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
    await Promise.resolve();
  }
  assert.ok(predicate(), "condition was not met");
}

interface BrowserClientCall {
  name?: string;
  op: string;
  source?: string;
  text?: string;
  url?: string;
  viewport?: { width: number; height: number };
  [key: string]: unknown;
}

interface FakeBrowserClient {
  addInitScript: (source: string) => Promise<void>;
  calls: BrowserClientCall[];
  close: () => Promise<void>;
  connect: () => Promise<FakeBrowserClient>;
  emitBinding: (name: string, payload: unknown) => void;
  evaluate: (source: string) => Promise<string | undefined>;
  exposeBinding: (name: string, handler: (source: unknown, payload: string) => void) => Promise<void>;
  goto: (url: string) => Promise<void>;
  keyboard: { insertText: (text: string) => Promise<void> };
  setViewportSize: (viewport: { width: number; height: number }) => Promise<void>;
}

function makeFakeBrowserClient({
  copyText = "copied remote text",
  statuses = [],
}: {
  copyText?: string;
  statuses?: unknown[];
} = {}): FakeBrowserClient {
  const calls: BrowserClientCall[] = [];
  const bindings = new Map<string, (source: unknown, payload: string) => void>();
  const client: FakeBrowserClient = {
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async addInitScript(source) {
      calls.push({ op: "addInitScript", source });
    },
    calls,
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async close() {
      calls.push({ op: "close" });
    },
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async connect() {
      calls.push({ op: "connect" });
      return client;
    },
    emitBinding(name, payload) {
      const handler = bindings.get(name);
      assert.equal(typeof handler, "function", `missing binding ${name}`);
      handler?.({}, JSON.stringify(payload));
    },
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async evaluate(source) {
      calls.push({ op: "evaluate", source });
      const expression = String(source || "");
      if (expression.includes("selectionStart") && expression.includes("document.getSelection")) {
        return copyText;
      }
      return expression.includes("__pdppPlaygroundEvents") || expression.includes("screenWidth")
        ? JSON.stringify(statuses.length > 0 ? statuses.shift() : {})
        : undefined;
    },
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async exposeBinding(name, handler) {
      calls.push({ name, op: "exposeBinding" });
      bindings.set(name, handler);
    },
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async goto(url) {
      calls.push({ op: "goto", url });
    },
    keyboard: {
      // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
      async insertText(text) {
        calls.push({ op: "insertText", text });
      },
    },
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async setViewportSize(viewport) {
      calls.push({ op: "setViewportSize", viewport: { ...viewport } });
    },
  };
  return client;
}

test("n.eko adapter logs in, applies configured viewport endpoint, and emits base64 JPEG frames", async () => {
  const jpeg = "jpeg-frame-1";
  const fetchImpl = makeFetch([
    {
      method: "POST",
      response: makeResponse({ headers: { "set-cookie": "NEKO_SESSION=session-1; Path=/; HttpOnly" } }),
      url: "https://neko.test/api/login",
    },
    {
      method: "POST",
      response: makeResponse({ status: 204 }),
      url: "https://neko.test/api/room/screen",
    },
    {
      method: "GET",
      response: makeResponse({ body: jpeg }),
      url: "https://neko.test/api/room/screen/cast.jpg",
    },
  ]);
  const sleep = makeAbortableSleep();
  const companion = createNekoCompanion({
    browser_session_id: "bs_neko_1",
    fetchImpl,
    now: () => 1234,
    origin: "https://neko.test",
    password: "secret",
    screenEndpoint: "/api/room/screen",
    sleep,
    username: "operator",
  });
  const frames: NekoFrame[] = [];

  assert.equal(companion.backend, "neko");
  assert.equal(companion.browser_session_id, "bs_neko_1");
  companion.onFrame((frame) => frames.push(frame));

  await companion.start({ deviceScaleFactor: 2, height: 600, width: 800 });
  await waitFor(() => frames.length === 1);

  const [frame1] = frames;
  assert.ok(frame1, "expected a captured frame");
  assert.equal(frame1.sessionId, 1);
  assert.equal(frame1.data, Buffer.from(jpeg).toString("base64"));
  assert.deepEqual(frame1.metadata, {
    device_height: 600,
    device_width: 800,
    offset_top: 0,
    page_scale_factor: 2,
    scroll_offset_x: 0,
    scroll_offset_y: 0,
    timestamp: 1234,
  });

  const login = fetchImpl.calls.find((call) => call.url.endsWith("/api/login"));
  assert.ok(login, "expected a matching fetch call for login");
  assert.equal(login.init.method, "POST");
  assert.deepEqual(JSON.parse(login.init.body ?? ""), { password: "secret", username: "operator" });

  const viewport = fetchImpl.calls.find((call) => call.init.method === "POST" && call.url.endsWith("/api/room/screen"));
  assert.ok(viewport, "expected a matching fetch call for viewport");
  assert.equal(viewport.init.method, "POST");
  assert.deepEqual(JSON.parse(viewport.init.body ?? ""), {
    deviceScaleFactor: 2,
    height: 600,
    screen: "800x600@30",
    width: 800,
  });

  const screenshot = fetchImpl.calls.find((call) => call.url.endsWith("/cast.jpg"));
  assert.ok(screenshot, "expected a matching fetch call for screenshot");
  assert.equal(screenshot.init.headers?.Cookie, "NEKO_SESSION=session-1");
  await waitFor(() => sleep.calls.length === 1);
  const [firstSleepCall] = sleep.calls;
  assert.ok(firstSleepCall, "expected a sleep call");
  assert.equal(firstSleepCall.ms, 250);

  await companion.stop();
  assert.equal(companion._internal.isClosed(), true);
});

test("n.eko adapter logs in with an empty body for noauth n.eko providers", async () => {
  const jpeg = "jpeg-noauth";
  const fetchImpl = makeFetch([
    {
      method: "POST",
      response: makeResponse({ json: { token: "noauth-token" } }),
      url: "https://neko.test/api/login",
    },
    {
      method: "GET",
      response: makeResponse({ body: jpeg }),
      url: "https://neko.test/api/room/screen/cast.jpg",
    },
  ]);
  const companion = createNekoCompanion({
    fetchImpl,
    origin: "https://neko.test",
    sleep: makeAbortableSleep(),
  });
  const frames: NekoFrame[] = [];
  companion.onFrame((frame) => frames.push(frame));

  await companion.start();
  await waitFor(() => frames.length === 1);

  const login = fetchImpl.calls.find((call) => call.url.endsWith("/api/login"));
  assert.ok(login, "expected a matching fetch call for login");
  assert.equal(login.init.method, "POST");
  assert.deepEqual(JSON.parse(login.init.body ?? ""), {});
  const castCall = fetchImpl.calls.find((call) => call.url.endsWith("/cast.jpg"));
  assert.ok(castCall, "expected a matching fetch call for cast.jpg");
  assert.equal(castCall.init.headers?.Authorization, "Bearer noauth-token");
  const [frame2] = frames;
  assert.ok(frame2, "expected a captured frame");
  assert.equal(frame2.data, Buffer.from(jpeg).toString("base64"));

  await companion.stop();
});

test("n.eko adapter prefers control/admin credentials from env over viewer credentials", async () => {
  const fetchImpl = makeFetch([
    {
      method: "POST",
      response: makeResponse({ headers: { "set-cookie": "NEKO_SESSION=admin-session; Path=/; HttpOnly" } }),
      url: "https://neko.test/api/login",
    },
    {
      method: "GET",
      response: makeResponse({ body: "jpeg-admin" }),
      url: "https://neko.test/api/room/screen/cast.jpg",
    },
  ]);
  const companion = createNekoCompanion({
    env: {
      NEKO_CONTROL_PASSWORD: "admin-pass",
      NEKO_CONTROL_USERNAME: "admin",
      NEKO_PASSWORD: "viewer-pass",
      NEKO_USERNAME: "operator",
    },
    fetchImpl,
    origin: "https://neko.test",
    sleep: makeAbortableSleep(),
  });

  await companion.start();
  await waitFor(() => fetchImpl.calls.length === 2);

  const login = fetchImpl.calls.find((call) => call.url.endsWith("/api/login"));
  assert.ok(login, "expected a matching fetch call for login");
  assert.deepEqual(JSON.parse(login.init.body ?? ""), { password: "admin-pass", username: "admin" });

  await companion.stop();
});

test("n.eko adapter frame metadata follows the applied desktop screen preset", async () => {
  const jpeg = "jpeg-frame-desktop";
  const fetchImpl = makeFetch([
    {
      method: "POST",
      response: makeResponse({ headers: { "set-cookie": "NEKO_SESSION=session-1; Path=/; HttpOnly" } }),
      url: "https://neko.test/api/login",
    },
    {
      method: "GET",
      response: makeResponse({
        json: [
          { height: 1024, rate: 30, width: 1280 },
          { height: 1200, rate: 30, width: 1600 },
        ],
      }),
      url: "https://neko.test/api/room/screen/configurations",
    },
    {
      method: "POST",
      response: makeResponse({ json: { height: 1024, rate: 30, width: 1280 } }),
      url: "https://neko.test/api/room/screen",
    },
    {
      method: "GET",
      response: makeResponse({ body: jpeg }),
      url: "https://neko.test/api/room/screen/cast.jpg",
    },
  ]);
  const sleep = makeAbortableSleep();
  const companion = createNekoCompanion({
    fetchImpl,
    now: () => 4321,
    origin: "https://neko.test",
    password: "secret",
    screenConfigurationsEndpoint: "/api/room/screen/configurations",
    screenEndpoint: "/api/room/screen",
    sleep,
    username: "operator",
  });
  const frames: NekoFrame[] = [];
  companion.onFrame((frame) => frames.push(frame));

  await companion.start({ deviceScaleFactor: 1.15, height: 1123, width: 1117 });
  await waitFor(() => frames.length === 1);

  const screenPost = fetchImpl.calls.find(
    (call) => call.init.method === "POST" && call.url === "https://neko.test/api/room/screen"
  );
  assert.ok(screenPost, "expected a matching fetch call for screenPost");
  assert.deepEqual(JSON.parse(screenPost.init.body ?? ""), { height: 1024, rate: 30, width: 1280 });
  const [frame3] = frames;
  assert.ok(frame3, "expected a captured frame");
  assert.deepEqual(frame3.metadata, {
    device_height: 1024,
    device_width: 1280,
    offset_top: 0,
    page_scale_factor: 1.15,
    scroll_offset_x: 0,
    scroll_offset_y: 0,
    timestamp: 4321,
  });

  await companion.stop();
});

test("n.eko adapter uses bearer auth and falls back from screencast to screenshot endpoint", async () => {
  const jpeg = "fallback-jpeg";
  const fetchImpl = makeFetch([
    {
      method: "GET",
      response: makeResponse({ status: 400 }),
      url: "https://neko.test/api/room/screen/cast.jpg",
    },
    {
      method: "GET",
      response: makeResponse({ body: jpeg }),
      url: "https://neko.test/api/room/screen/shot.jpg",
    },
  ]);
  const companion = createNekoCompanion({
    bearerToken: "token-1",
    fetchImpl,
    origin: "https://neko.test",
    sleep: makeAbortableSleep(),
  });
  const frames: NekoFrame[] = [];
  companion.onFrame((frame) => frames.push(frame));

  await companion.start();
  await waitFor(() => frames.length === 1);

  const [frame4] = frames;
  assert.ok(frame4, "expected a captured frame");
  assert.equal(frame4.data, Buffer.from(jpeg).toString("base64"));
  assert.equal(
    fetchImpl.calls.some((call) => call.url.endsWith("/api/login")),
    false
  );
  const [firstCall, secondCall] = fetchImpl.calls;
  assert.ok(firstCall, "expected a first fetch call");
  assert.ok(secondCall, "expected a second fetch call");
  assert.equal(firstCall.init.headers?.Authorization, "Bearer token-1");
  assert.equal(secondCall.init.headers?.Authorization, "Bearer token-1");

  await companion.stop();
});

test("n.eko adapter keeps default API paths under a configured path prefix", async () => {
  const fetchImpl = makeFetch([
    {
      method: "GET",
      response: makeResponse({ body: "prefixed-jpeg" }),
      url: "https://neko.test/neko/api/room/screen/cast.jpg",
    },
  ]);
  const companion = createNekoCompanion({
    bearerToken: "token-1",
    fetchImpl,
    origin: "https://neko.test/neko",
    sleep: makeAbortableSleep(),
  });

  await companion.start();
  await waitFor(() => fetchImpl.calls.length === 1);

  const [prefixedCall] = fetchImpl.calls;
  assert.ok(prefixedCall, "expected a fetch call");
  assert.equal(prefixedCall.url, "https://neko.test/neko/api/room/screen/cast.jpg");

  await companion.stop();
});

test("n.eko adapter dispatch posts input only when an endpoint is configured and ackFrame is a no-op", async () => {
  const fetchImpl = makeFetch([
    {
      method: "POST",
      response: makeResponse({ status: 204 }),
      url: "https://neko.test/api/input",
    },
    {
      method: "POST",
      response: makeResponse({ status: 204 }),
      url: "https://neko.test/api/viewport",
    },
  ]);
  const companion = createNekoCompanion({
    bearerToken: "token-2",
    fetchImpl,
    inputEndpoint: "/api/input",
    origin: "https://neko.test",
    viewportEndpoint: "/api/viewport",
  });
  const offEvent = companion.onEvent(() => {
    throw new Error("n.eko adapter should not emit out-of-band events yet");
  });
  offEvent();

  await companion.dispatch({ action: "click", type: "mouse", x: 1, y: 2 });
  await companion.dispatch({ height: 844, mobile: true, type: "viewport", width: 390 });
  await companion.ackFrame(123);

  assert.equal(fetchImpl.calls.length, 2);
  const [inputCall, viewportCall] = fetchImpl.calls;
  assert.ok(inputCall, "expected an input fetch call");
  assert.ok(viewportCall, "expected a viewport fetch call");
  assert.equal(inputCall.url, "https://neko.test/api/input");
  assert.deepEqual(JSON.parse(inputCall.init.body ?? ""), { action: "click", type: "mouse", x: 1, y: 2 });
  assert.equal(viewportCall.url, "https://neko.test/api/viewport");
  assert.deepEqual(JSON.parse(viewportCall.init.body ?? ""), {
    height: 844,
    mobile: true,
    screen: "390x844@30",
    width: 390,
  });
});

test("n.eko adapter applies RBS-style viewport, paste, and copy control through the browser client", async () => {
  const fetchImpl = makeFetch([
    {
      method: "GET",
      response: makeResponse({
        json: [
          { height: 844, rate: 30, width: 390 },
          { height: 844, rate: 30, width: 392 },
          { height: 844, rate: 30, width: 400 },
          { height: 720, rate: 30, width: 1280 },
        ],
      }),
      url: "https://neko.test/api/room/screen/configurations",
    },
    {
      method: "POST",
      response: makeResponse({ json: { height: 844, rate: 30, width: 392 } }),
      url: "https://neko.test/api/room/screen",
    },
    {
      method: "GET",
      response: makeResponse({ json: { height: 844, rate: 30, width: 392 } }),
      url: "https://neko.test/api/room/screen",
    },
  ]);
  const browserClient = makeFakeBrowserClient({
    statuses: [
      {
        devicePixelRatio: 3,
        hasTouch: true,
        innerHeight: 844,
        innerWidth: 392,
        screenHeight: 844,
        screenWidth: 392,
        userAgent: "Mobile Safari test UA",
      },
    ],
  });
  const companion = createNekoCompanion({
    bearerToken: "token-3",
    browserClient,
    cdpHttpUrl: "http://127.0.0.1:9222",
    fetchImpl,
    origin: "https://neko.test",
    screenConfigurationsEndpoint: "/api/room/screen/configurations",
    screenEndpoint: "/api/room/screen",
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
    sleep: async () => {},
    stealthMode: "assistive",
  });
  const events: NekoCompanionEvent[] = [];
  companion.onEvent((event) => events.push(event));

  await companion.dispatch({
    deviceScaleFactor: 3,
    hasTouch: true,
    height: 844,
    mobile: true,
    type: "viewport",
    userAgent: "Mobile Safari test UA",
    width: 390,
  });
  await companion.dispatch({ text: "one-time code 123456", type: "paste" });
  await companion.dispatch({ type: "copy" });
  const status = await companion.queryNekoStatus?.();

  const screenPost = fetchImpl.calls.find(
    (call) => call.init.method === "POST" && call.url === "https://neko.test/api/room/screen"
  );
  assert.ok(screenPost, "expected a matching fetch call for screenPost");
  assert.deepEqual(JSON.parse(screenPost.init.body ?? ""), { height: 844, rate: 30, width: 392 });

  assert.ok(browserClient.calls.some((call) => call.op === "connect"));
  assert.ok(
    browserClient.calls.some(
      (call) => call.op === "setViewportSize" && call.viewport?.width === 392 && call.viewport?.height === 844
    )
  );
  assert.ok(browserClient.calls.some((call) => call.op === "insertText" && call.text === "one-time code 123456"));
  assert.ok(
    browserClient.calls.some(
      (call) =>
        call.op === "evaluate" &&
        call.source?.includes("selectionStart") &&
        call.source?.includes("document.getSelection")
    )
  );
  assert.deepEqual(
    events.filter((event) => event.kind === "clipboard"),
    [{ kind: "clipboard", text: "copied remote text" }]
  );
  assert.deepEqual(status, {
    page: {
      devicePixelRatio: 3,
      hasTouch: true,
      innerHeight: 844,
      innerWidth: 392,
      screenHeight: 844,
      screenWidth: 392,
      userAgent: "Mobile Safari test UA",
    },
    page_cdp_available: true,
    screen: { height: 844, rate: 30, width: 392 },
    window_skipped: {
      browser_owner_mode: "neko-owned",
      stealth_mode: "assistive",
    },
  });

  await companion.stop();
});

test("n.eko adapter keeps CSS viewport separate from high-DPR screen capture dimensions", async () => {
  const fetchImpl = makeFetch([
    {
      method: "GET",
      response: makeResponse({
        json: [
          { height: 915, rate: 29, width: 500 },
          { height: 916, rate: 30, width: 448 },
          { height: 1840, rate: 30, width: 1008 },
          { height: 1920, rate: 30, width: 1080 },
          { height: 720, rate: 30, width: 1280 },
        ],
      }),
      url: "https://neko.test/api/room/screen/configurations",
    },
    {
      method: "POST",
      response: makeResponse({ json: { height: 1840, rate: 30, width: 1008 } }),
      url: "https://neko.test/api/room/screen",
    },
  ]);
  const browserClient = makeFakeBrowserClient();
  const companion = createNekoCompanion({
    bearerToken: "token-hidpi",
    browserClient,
    cdpHttpUrl: "http://127.0.0.1:9222",
    fetchImpl,
    origin: "https://neko.test",
    screenConfigurationsEndpoint: "/api/room/screen/configurations",
    screenEndpoint: "/api/room/screen",
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
    sleep: async () => {},
    stealthMode: "assistive",
  });

  await companion.dispatch({
    deviceScaleFactor: 2.25,
    hasTouch: true,
    height: 819,
    mobile: true,
    screenHeight: 1840,
    screenWidth: 1008,
    type: "viewport",
    width: 448,
  });

  const screenPost = fetchImpl.calls.find(
    (call) => call.init.method === "POST" && call.url === "https://neko.test/api/room/screen"
  );
  assert.ok(screenPost, "expected a matching fetch call for screenPost");
  assert.deepEqual(JSON.parse(screenPost.init.body ?? ""), { height: 1840, rate: 30, width: 1008 });

  assert.ok(browserClient.calls.some((call) => call.op === "setViewportSize"));
  const viewportCall = browserClient.calls.find((call) => call.op === "setViewportSize");
  assert.ok(viewportCall, "expected a setViewportSize call");
  assert.deepEqual(viewportCall.viewport, {
    height: 819,
    width: 448,
  });

  await companion.stop();
});

test("n.eko adapter selects exact Android visible-height portrait capture when exposed", async () => {
  const fetchImpl = makeFetch([
    {
      method: "GET",
      response: makeResponse({
        json: [
          { height: 1920, rate: 30, width: 1080 },
          { height: 1736, rate: 30, width: 1008 },
          { height: 1840, rate: 30, width: 1008 },
          { height: 2000, rate: 30, width: 904 },
        ],
      }),
      url: "https://neko.test/api/room/screen/configurations",
    },
    {
      method: "POST",
      response: ({ init }) => makeResponse({ json: JSON.parse(init.body ?? "") }),
      url: "https://neko.test/api/room/screen",
    },
  ]);
  const companion = createNekoCompanion({
    bearerToken: "token-visible-height",
    fetchImpl,
    origin: "https://neko.test",
    screenConfigurationsEndpoint: "/api/room/screen/configurations",
    screenEndpoint: "/api/room/screen",
  });

  await companion.dispatch({
    deviceScaleFactor: 2.25,
    hasTouch: true,
    height: 771,
    mobile: true,
    screenHeight: 1736,
    screenWidth: 1008,
    type: "viewport",
    width: 448,
  });

  const screenPost = fetchImpl.calls.find(
    (call) => call.init.method === "POST" && call.url === "https://neko.test/api/room/screen"
  );
  assert.ok(screenPost, "expected POST to /api/room/screen");
  assert.deepEqual(JSON.parse(screenPost.init.body ?? ""), { height: 1736, rate: 30, width: 1008 });

  await companion.stop();
});

test("n.eko adapter passes the configured CDP HTTP URL to the browser-client factory", async () => {
  const fetchImpl = makeFetch([
    {
      method: "POST",
      response: makeResponse({ json: { token: "noauth-token" } }),
      url: "https://neko.test/api/login",
    },
  ]);
  const browserClient = makeFakeBrowserClient();
  const factoryCalls: Record<string, unknown>[] = [];
  const companion = createNekoCompanion({
    cdpHttpUrl: "http://neko:9223",
    createBrowserClient(args: Record<string, unknown>) {
      factoryCalls.push(args);
      return browserClient;
    },
    fetchImpl,
    origin: "https://neko.test",
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
    sleep: async () => {},
    stealthMode: "assistive",
  });

  await companion.dispatch({ deviceScaleFactor: 1, height: 600, type: "viewport", width: 800 });

  assert.equal(factoryCalls.length, 1);
  const [factoryCall] = factoryCalls;
  assert.ok(factoryCall, "expected a browser-client factory call");
  assert.equal(factoryCall.cdpHttpUrl, "http://neko:9223/");
  const setViewportCall = browserClient.calls.find((call) => call.op === "setViewportSize");
  assert.ok(setViewportCall, "expected a setViewportSize call");
  assert.deepEqual(setViewportCall.viewport, {
    height: 600,
    width: 800,
  });

  await companion.stop();
});

test("n.eko adapter prefers the least-cropped landscape screen preset", async () => {
  const fetchImpl = makeFetch([
    {
      method: "GET",
      response: makeResponse({
        json: [
          { height: 540, rate: 60, width: 960 },
          { height: 432, rate: 29, width: 936 },
          { height: 412, rate: 29, width: 920 },
        ],
      }),
      url: "https://neko.test/api/room/screen/configurations",
    },
    {
      method: "POST",
      response: makeResponse({ json: { height: 432, rate: 29, width: 936 } }),
      url: "https://neko.test/api/room/screen",
    },
  ]);
  const companion = createNekoCompanion({
    bearerToken: "token-4",
    fetchImpl,
    origin: "https://neko.test",
    screenConfigurationsEndpoint: "/api/room/screen/configurations",
    screenEndpoint: "/api/room/screen",
  });

  await companion.dispatch({ hasTouch: true, height: 448, mobile: true, type: "viewport", width: 916 });

  const screenPost = fetchImpl.calls.find(
    (call) => call.init.method === "POST" && call.url === "https://neko.test/api/room/screen"
  );
  assert.ok(screenPost, "expected a matching fetch call for screenPost");
  assert.deepEqual(JSON.parse(screenPost.init.body ?? ""), { height: 432, rate: 29, width: 936 });
});

test("n.eko adapter selects a high-DPR shallow landscape preset for Android landscape capture (regression: 920x412 fallback)", async () => {
  // Telemetry from viewer 4831e726-fd41-43bc-8283-bec8c4ac14c7: Android Chrome
  // rotated landscape requested viewport=947x364 CSS @ dpr=2.25 ->
  // screenWidth=2128, screenHeight=816 capture target. With only the legacy
  // landscape modelines (920x412, 936x432, etc.) the encoder produced
  // 920x412 frames into a cover-fit box sized for 2128x816, yielding
  // ~13% non-uniform vertical stretch and 2x physical-pixel upscale.
  // After adding shallow-DPR landscape modelines (1840x704, 1920x736,
  // 2000x768, 2112x816, 2128x816, 2176x832, 2208x848) the picker must
  // choose the cleanest fit (2128x816) and never fall back to 920x412.
  const fetchImpl = makeFetch([
    {
      method: "GET",
      response: makeResponse({
        json: [
          // Legacy landscape modes that previously won this race.
          { height: 412, rate: 30, width: 920 },
          { height: 432, rate: 30, width: 936 },
          { height: 720, rate: 30, width: 1280 },
          { height: 1080, rate: 30, width: 1920 },
          // Newly exposed shallow high-DPR landscape modes.
          { height: 704, rate: 30, width: 1840 },
          { height: 736, rate: 30, width: 1920 },
          { height: 768, rate: 30, width: 2000 },
          { height: 816, rate: 30, width: 2112 },
          { height: 816, rate: 30, width: 2128 },
          { height: 832, rate: 30, width: 2176 },
          { height: 848, rate: 30, width: 2208 },
          // Portrait decoys to confirm orientation-correct selection.
          { height: 1920, rate: 30, width: 1080 },
          { height: 2176, rate: 30, width: 1008 },
        ],
      }),
      url: "https://neko.test/api/room/screen/configurations",
    },
    {
      method: "POST",
      response: ({ init }) => makeResponse({ json: JSON.parse(init.body ?? "") }),
      url: "https://neko.test/api/room/screen",
    },
  ]);
  const companion = createNekoCompanion({
    bearerToken: "token-landscape-dpr",
    fetchImpl,
    origin: "https://neko.test",
    screenConfigurationsEndpoint: "/api/room/screen/configurations",
    screenEndpoint: "/api/room/screen",
  });

  await companion.dispatch({
    deviceScaleFactor: 2.25,
    hasTouch: true,
    height: 364,
    mobile: true,
    screenHeight: 816,
    screenWidth: 2128,
    type: "viewport",
    width: 947,
  });

  const screenPost = fetchImpl.calls.find(
    (call) => call.init.method === "POST" && call.url === "https://neko.test/api/room/screen"
  );
  assert.ok(screenPost, "expected POST to /api/room/screen");
  const applied = JSON.parse(screenPost.init.body ?? "");
  assert.deepEqual(
    applied,
    { height: 816, rate: 30, width: 2128 },
    `expected 2128x816 preset, got ${JSON.stringify(applied)}`
  );
  assert.notDeepStrictEqual(
    applied,
    { height: 412, rate: 30, width: 920 },
    "must not fall back to 920x412 landscape preset"
  );
  assert.notEqual(applied.width, 920, "must not fall back to 920-wide landscape preset");
});

test("n.eko adapter selects near-exact 1x portrait preset for native n.eko input alignment", async () => {
  const fetchImpl = makeFetch([
    {
      method: "GET",
      response: makeResponse({
        json: [
          { height: 916, rate: 30, width: 448 },
          { height: 915, rate: 30, width: 496 },
          { height: 915, rate: 30, width: 500 },
          { height: 820, rate: 30, width: 448 },
          { height: 1920, rate: 30, width: 1080 },
        ],
      }),
      url: "https://neko.test/api/room/screen/configurations",
    },
    {
      method: "POST",
      response: ({ init }) => makeResponse({ json: JSON.parse(init.body ?? "") }),
      url: "https://neko.test/api/room/screen",
    },
  ]);
  const companion = createNekoCompanion({
    bearerToken: "token-native-portrait",
    fetchImpl,
    origin: "https://neko.test",
    screenConfigurationsEndpoint: "/api/room/screen/configurations",
    screenEndpoint: "/api/room/screen",
  });

  await companion.dispatch({
    deviceScaleFactor: 1,
    hasTouch: true,
    height: 819,
    mobile: true,
    screenHeight: 819,
    screenWidth: 448,
    type: "viewport",
    width: 448,
  });

  const screenPost = fetchImpl.calls.find(
    (call) => call.init.method === "POST" && call.url === "https://neko.test/api/room/screen"
  );
  assert.ok(screenPost, "expected POST to /api/room/screen");
  const applied = JSON.parse(screenPost.init.body ?? "");
  assert.deepEqual(applied, { height: 820, rate: 30, width: 448 });
});

test("n.eko adapter emits explicit screen-configuration telemetry for mobile viewport updates", async () => {
  const fetchImpl = makeFetch([
    {
      method: "GET",
      response: makeResponse({
        json: [
          { height: 900, rate: 30, width: 1440 },
          { height: 820, rate: 30, width: 448 },
        ],
      }),
      url: "https://neko.test/api/room/screen/configurations",
    },
    {
      method: "POST",
      response: ({ init }) => makeResponse({ json: JSON.parse(init.body ?? "") }),
      url: "https://neko.test/api/room/screen",
    },
  ]);
  const companion = createNekoCompanion({
    bearerToken: "token-mobile-telemetry",
    fetchImpl,
    origin: "https://neko.test",
    screenConfigurationsEndpoint: "/api/room/screen/configurations",
    screenEndpoint: "/api/room/screen",
  });
  const events: NekoCompanionEvent[] = [];
  companion.onEvent((event) => events.push(event));

  await companion.dispatch({
    deviceScaleFactor: 1,
    hasTouch: true,
    height: 819,
    mobile: true,
    screenHeight: 819,
    screenWidth: 448,
    type: "viewport",
    width: 448,
  });

  const telemetryScreenPost = fetchImpl.calls.find(
    (call) => call.init.method === "POST" && call.url === "https://neko.test/api/room/screen"
  );
  assert.ok(telemetryScreenPost, "expected a matching fetch call for screenPost");
  assert.deepEqual(JSON.parse(telemetryScreenPost.init.body ?? ""), {
    height: 820,
    rate: 30,
    width: 448,
  });
  assert.deepEqual(events, [
    {
      applied: { height: 820, rate: 30, width: 448 },
      kind: "screen_configuration",
      requested: { height: 819, width: 448 },
      selected: { height: 820, rate: 30, width: 448 },
    },
  ]);
});

test("n.eko adapter selects near-exact 1x landscape preset for native n.eko input alignment", async () => {
  const fetchImpl = makeFetch([
    {
      method: "GET",
      response: makeResponse({
        json: [
          { height: 412, rate: 30, width: 920 },
          { height: 432, rate: 30, width: 936 },
          { height: 364, rate: 30, width: 952 },
          { height: 704, rate: 30, width: 1840 },
          { height: 816, rate: 30, width: 2128 },
        ],
      }),
      url: "https://neko.test/api/room/screen/configurations",
    },
    {
      method: "POST",
      response: ({ init }) => makeResponse({ json: JSON.parse(init.body ?? "") }),
      url: "https://neko.test/api/room/screen",
    },
  ]);
  const companion = createNekoCompanion({
    bearerToken: "token-native-landscape",
    fetchImpl,
    origin: "https://neko.test",
    screenConfigurationsEndpoint: "/api/room/screen/configurations",
    screenEndpoint: "/api/room/screen",
  });

  await companion.dispatch({
    deviceScaleFactor: 1,
    hasTouch: true,
    height: 364,
    mobile: true,
    screenHeight: 364,
    screenWidth: 947,
    type: "viewport",
    width: 947,
  });

  const screenPost = fetchImpl.calls.find(
    (call) => call.init.method === "POST" && call.url === "https://neko.test/api/room/screen"
  );
  assert.ok(screenPost, "expected POST to /api/room/screen");
  const applied = JSON.parse(screenPost.init.body ?? "");
  assert.deepEqual(applied, { height: 364, rate: 30, width: 952 });
});

test("n.eko adapter targets the actual capture-pixel paint surface so the X mode matches Emulation, not the larger fallback screen mode (regression: Brave Android white borders)", async () => {
  // Telemetry from viewer 8934a152-fe7b-48b1-9176-c493d0e1954c: Brave on
  // Android Chrome 147 portrait — viewport=448x771 CSS @ dpr=2.25. Chromium
  // emulation paints 448*2.25 = 1008 by 771*2.25 = 1734.75 ~ 1735 device
  // pixels. If the picker selects a larger X mode (1080x1920 was the only
  // fitting candidate before owner added the 1008x1736 modeline), Chromium
  // top-left-anchors the 1008x1735 bitmap inside the larger window and the
  // captured frame contains a strip of X-server desktop on the right
  // (1080-1008=72 native px) and bottom (1920-1735=185 native px). The
  // user-visible result is "tiny / pinned left / huge white borders".
  //
  // The adapter must target the posted capture surface (`screenWidth` ×
  // `screenHeight`), which the viewer has already aligned to the available
  // device-pixel target. This test pins that contract.
  const fetchImpl = makeFetch([
    {
      method: "GET",
      response: makeResponse({
        json: [
          // Legacy modes the picker had to fall back to before the 1008x1736
          // modeline was exposed. 1080x1920 was the closest fitting cover.
          { height: 1920, rate: 30, width: 1080 },
          { height: 720, rate: 30, width: 1280 },
          { height: 1080, rate: 30, width: 1920 },
          // The exact paint-surface match. Picker must choose this one.
          { height: 1736, rate: 30, width: 1008 },
          // Other 1008-wide neighbours that could be confused for the match.
          { height: 1840, rate: 30, width: 1008 },
          { height: 2176, rate: 30, width: 1008 },
        ],
      }),
      url: "https://neko.test/api/room/screen/configurations",
    },
    {
      method: "POST",
      response: ({ init }) => makeResponse({ json: JSON.parse(init.body ?? "") }),
      url: "https://neko.test/api/room/screen",
    },
  ]);
  const companion = createNekoCompanion({
    bearerToken: "token-brave-portrait",
    fetchImpl,
    origin: "https://neko.test",
    screenConfigurationsEndpoint: "/api/room/screen/configurations",
    screenEndpoint: "/api/room/screen",
  });

  await companion.dispatch({
    deviceScaleFactor: 2.25,
    hasTouch: true,
    height: 771,
    mobile: true,
    screenHeight: 1736,
    screenWidth: 1008,
    type: "viewport",
    width: 448,
  });

  const screenPost = fetchImpl.calls.find(
    (call) => call.init.method === "POST" && call.url === "https://neko.test/api/room/screen"
  );
  assert.ok(screenPost, "expected POST to /api/room/screen");
  const applied = JSON.parse(screenPost.init.body ?? "");
  assert.deepEqual(
    applied,
    { height: 1736, rate: 30, width: 1008 },
    `expected the exact paint-surface 1008x1736 mode, got ${JSON.stringify(applied)}`
  );
  assert.notEqual(
    applied.width,
    1080,
    "must not pick the wider 1080x1920 mode that leaks X desktop into the captured frame"
  );
  assert.notEqual(
    applied.height,
    1840,
    "must not pick the taller 1008x1840 neighbour when the exact paint-height mode is available"
  );
});

test("n.eko adapter still selects 920x412 for low-DPR landscape viewports when no high-DPR mode fits (legacy preservation)", async () => {
  // Without the shallow high-DPR modes available (e.g. low-DPR desktop
  // landscape viewer requesting roughly 920x440), ranking must continue to
  // pick the closest legacy landscape preset — 920x412 is still the
  // best-effort choice. Guards against an over-eager bias toward shallow
  // high-DPR modes when the target genuinely is small.
  const fetchImpl = makeFetch([
    {
      method: "GET",
      response: makeResponse({
        json: [
          { height: 412, rate: 30, width: 920 },
          { height: 432, rate: 30, width: 936 },
          { height: 720, rate: 30, width: 1280 },
          { height: 1080, rate: 30, width: 1920 },
          { height: 1920, rate: 30, width: 1080 },
        ],
      }),
      url: "https://neko.test/api/room/screen/configurations",
    },
    {
      method: "POST",
      response: ({ init }) => makeResponse({ json: JSON.parse(init.body ?? "") }),
      url: "https://neko.test/api/room/screen",
    },
  ]);
  const companion = createNekoCompanion({
    bearerToken: "token-landscape-low",
    fetchImpl,
    origin: "https://neko.test",
    screenConfigurationsEndpoint: "/api/room/screen/configurations",
    screenEndpoint: "/api/room/screen",
  });

  await companion.dispatch({
    deviceScaleFactor: 1,
    hasTouch: false,
    height: 412,
    mobile: false,
    screenHeight: 412,
    screenWidth: 916,
    type: "viewport",
    width: 916,
  });

  const screenPost = fetchImpl.calls.find(
    (call) => call.init.method === "POST" && call.url === "https://neko.test/api/room/screen"
  );
  assert.ok(screenPost, "expected a matching fetch call for screenPost");
  const applied = JSON.parse(screenPost.init.body ?? "");
  assert.equal(applied.width, 920, `expected legacy 920-wide landscape preset, got ${JSON.stringify(applied)}`);
});

test("n.eko adapter navigates an explicit start URL through the browser client in assistive mode", async () => {
  const fetchImpl = makeFetch([
    {
      method: "GET",
      response: makeResponse({ body: "jpeg" }),
      url: "https://neko.test/api/room/screen/cast.jpg",
    },
  ]);
  const browserClient = makeFakeBrowserClient();
  const companion = createNekoCompanion({
    bearerToken: "token-5",
    browserClient,
    cdpHttpUrl: "http://127.0.0.1:9222",
    fetchImpl,
    origin: "https://neko.test",
    sleep: makeAbortableSleep(),
    startUrl: "data:text/html,<h1>playground</h1>",
    stealthMode: "balanced",
  });

  await companion.start({ deviceScaleFactor: 2, height: 600, width: 800 });

  assert.equal(companion._internal.stealthMode?.(), "assistive");
  assert.deepEqual(
    browserClient.calls.map((call) => call.op),
    ["connect", "setViewportSize", "exposeBinding", "addInitScript", "evaluate", "goto"]
  );
  const setViewportCall = browserClient.calls.find((call) => call.op === "setViewportSize");
  assert.ok(setViewportCall, "expected a setViewportSize call");
  assert.deepEqual(setViewportCall.viewport, {
    height: 600,
    width: 800,
  });
  const gotoCall = browserClient.calls.find((call) => call.op === "goto");
  assert.ok(gotoCall, "expected a goto call");
  assert.equal(gotoCall.url, "data:text/html,<h1>playground</h1>");

  await companion.stop();
});

test("n.eko adapter treats initial navigation as best-effort when CDP control is unavailable", async () => {
  const fetchImpl = makeFetch([
    {
      method: "GET",
      response: makeResponse({ body: "jpeg" }),
      url: "https://neko.test/api/room/screen/cast.jpg",
    },
  ]);
  const logs: { msg?: string; [key: string]: unknown }[] = [];
  const companion = createNekoCompanion({
    bearerToken: "token-no-cdp",
    fetchImpl,
    logger: { warn: (entry: { msg?: string; [key: string]: unknown }) => logs.push(entry) },
    origin: "https://neko.test",
    sleep: makeAbortableSleep(),
    startUrl: "https://www.reddit.com/login/",
  });
  const frames: NekoFrame[] = [];
  companion.onFrame((frame) => frames.push(frame));

  await companion.start({ deviceScaleFactor: 2, height: 600, width: 800 });
  await waitFor(() => frames.length === 1);

  assert.ok(logs.some((entry) => entry.msg === "neko_initial_navigation_skipped"));
  assert.equal(
    fetchImpl.calls.some((call) => String(call.url).includes("/json")),
    false
  );

  await companion.stop();
});

test("n.eko adapter emits remote editable focus events through the browser-client binding", async () => {
  const fetchImpl = makeFetch([
    {
      method: "GET",
      response: makeResponse({ body: "jpeg" }),
      url: "https://neko.test/api/room/screen/cast.jpg",
    },
  ]);
  const browserClient = makeFakeBrowserClient();
  const companion = createNekoCompanion({
    bearerToken: "token-6",
    browserClient,
    cdpHttpUrl: "http://127.0.0.1:9222",
    fetchImpl,
    origin: "https://neko.test",
    sleep: makeAbortableSleep(),
    stealthMode: "balanced",
  });
  const events: NekoCompanionEvent[] = [];
  companion.onEvent((event) => events.push(event));

  await companion.start({ height: 844, width: 390 });
  await waitFor(() => browserClient.calls.some((call) => call.op === "exposeBinding"));

  browserClient.emitBinding("__pdppNekoFocusChanged", {
    height: 44,
    inputType: "text",
    tagName: "INPUT",
    type: "focus",
    width: 200,
    x: 12,
    y: 34,
  });
  browserClient.emitBinding("__pdppNekoFocusChanged", { type: "blur" });

  assert.deepEqual(events, [
    {
      element: {
        height: 44,
        inputType: "text",
        tagName: "INPUT",
        type: "focus",
        width: 200,
        x: 12,
        y: 34,
      },
      focused: true,
      kind: "keyboard_focus",
    },
    {
      element: { type: "blur" },
      focused: false,
      kind: "keyboard_focus",
    },
  ]);

  await companion.stop();
});

test("n.eko adapter strict browser-owner mode keeps CDP assistive helpers off", async () => {
  const fetchImpl = makeFetch([
    {
      method: "GET",
      response: makeResponse({
        json: [
          { height: 844, rate: 30, width: 390 },
          { height: 844, rate: 30, width: 400 },
        ],
      }),
      url: "https://neko.test/api/room/screen/configurations",
    },
    {
      method: "POST",
      response: makeResponse({ json: { height: 844, rate: 30, width: 400 } }),
      url: "https://neko.test/api/room/screen",
    },
    {
      method: "GET",
      response: makeResponse({ json: { height: 844, rate: 30, width: 400 } }),
      url: "https://neko.test/api/room/screen",
    },
  ]);
  let browserClientFactoryCalls = 0;
  const companion = createNekoCompanion({
    bearerToken: "token-4",
    browserOwnerMode: "browser-owner",
    cdpHttpUrl: "http://127.0.0.1:9222",
    createBrowserClient() {
      browserClientFactoryCalls += 1;
      return makeFakeBrowserClient();
    },
    fetchImpl,
    origin: "https://neko.test",
    screenConfigurationsEndpoint: "/api/room/screen/configurations",
    screenEndpoint: "/api/room/screen",
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
    sleep: async () => {},
  });
  const events: NekoCompanionEvent[] = [];
  companion.onEvent((event) => events.push(event));

  assert.equal(companion._internal.browserOwnerMode?.(), "browser-owner");
  assert.equal(companion._internal.stealthMode?.(), "strict");

  await companion.dispatch({
    deviceScaleFactor: 3,
    hasTouch: true,
    height: 844,
    mobile: true,
    type: "viewport",
    userAgent: "Mobile Safari test UA",
    width: 390,
  });
  await companion.dispatch({ text: "one-time code 123456", type: "paste" });
  await companion.dispatch({ type: "copy" });
  const status = await companion.queryNekoStatus?.();

  const screenPost = fetchImpl.calls.find(
    (call) => call.init.method === "POST" && call.url === "https://neko.test/api/room/screen"
  );
  assert.ok(screenPost, "expected a matching fetch call for screenPost");
  assert.deepEqual(JSON.parse(screenPost.init.body ?? ""), { height: 844, rate: 30, width: 400 });
  assert.equal(browserClientFactoryCalls, 0);
  assert.deepEqual(events, [
    {
      applied: { height: 844, rate: 30, width: 400 },
      kind: "screen_configuration",
      requested: { height: 844, width: 390 },
      selected: { height: 844, rate: 30, width: 400 },
    },
  ]);
  assert.deepEqual(status, {
    page_cdp_available: false,
    page_cdp_skipped: {
      browser_owner_mode: "browser-owner",
      stealth_mode: "strict",
    },
    screen: { height: 844, rate: 30, width: 400 },
    window_skipped: {
      browser_owner_mode: "browser-owner",
      stealth_mode: "strict",
    },
  });

  await companion.stop();
});

test("n.eko presentation captures one baseline across reconnects and restores it on terminal stop", async () => {
  const lifecycle: { captured: unknown[]; restored: unknown[] } = { captured: [], restored: [] };
  const fetchImpl = makeFetch([
    {
      method: "GET",
      response: makeResponse({ json: { height: 720, rate: 30, width: 1280 } }),
      url: "https://neko.test/api/room/screen",
    },
    {
      method: "GET",
      response: makeResponse({ json: [{ height: 844, rate: 30, width: 390 }] }),
      url: "https://neko.test/api/room/screen/configurations",
    },
    {
      method: "POST",
      response: ({ init }) => makeResponse({ json: JSON.parse(init.body ?? "") }),
      url: "https://neko.test/api/room/screen",
    },
  ]);
  const companion = createNekoCompanion({
    bearerToken: "test-token",
    fetchImpl,
    origin: "https://neko.test",
    presentationLifecycle: {
      captureBaseline: ({ baseline }: { baseline: unknown }) => lifecycle.captured.push(baseline),
      markRestored: ({ baseline }: { baseline: unknown }) => lifecycle.restored.push(baseline),
    },
    screenConfigurationsEndpoint: "/api/room/screen/configurations",
    screenEndpoint: "/api/room/screen",
    sleep: makeAbortableSleep(),
  });

  await companion.start({ deviceScaleFactor: 1, height: 844, width: 390 });
  // An SSE reconnect reuses the started companion and must not read a new
  // baseline or mutate the shared presentation a second time.
  await companion.start({ deviceScaleFactor: 1, height: 844, width: 390 });
  await companion.dispatch({ deviceScaleFactor: 1, height: 844, type: "viewport", width: 390 });
  await companion.stop();

  const screenCalls = fetchImpl.calls.filter((call) => call.url === "https://neko.test/api/room/screen");
  assert.equal(screenCalls.filter((call) => call.init.method === "GET").length, 1);
  assert.equal(lifecycle.captured.length, 1);
  assert.equal(lifecycle.restored.length, 1);
  const lastScreenCall = screenCalls.at(-1);
  assert.ok(lastScreenCall, "expected at least one screen fetch call");
  assert.deepEqual(JSON.parse(lastScreenCall.init.body ?? ""), { height: 720, rate: 30, width: 1280 });
});

test("n.eko presentation keeps terminal restore pending until the baseline window has settled", async () => {
  const lifecycle: { restored: unknown[] } = { restored: [] };
  let releaseBaselineSettle: () => void = () => {
    throw new Error("releaseBaselineSettle not yet assigned");
  };
  const baselineSettle = new Promise<void>((resolve) => {
    releaseBaselineSettle = resolve;
  });
  const fetchImpl = makeFetch([
    {
      method: "GET",
      response: makeResponse({ json: { height: 720, rate: 30, width: 1280 } }),
      url: "https://neko.test/api/room/screen",
    },
    {
      method: "GET",
      response: makeResponse({ json: [{ height: 844, rate: 30, width: 390 }] }),
      url: "https://neko.test/api/room/screen/configurations",
    },
    {
      method: "POST",
      response: ({ init }) => makeResponse({ json: JSON.parse(init.body ?? "") }),
      url: "https://neko.test/api/room/screen",
    },
    {
      method: "GET",
      response: async ({ url }) => {
        const requested = new URL(url);
        if (requested.searchParams.get("width") === "1280") {
          await baselineSettle;
        }
        return makeResponse({
          json: {
            height: Number(requested.searchParams.get("height")),
            settled: true,
            width: Number(requested.searchParams.get("width")),
          },
        });
      },
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
      url: /https:\/\/neko\.test\/pdpp\/window-settle/,
    },
  ]);
  const companion = createNekoCompanion({
    bearerToken: "test-token",
    fetchImpl,
    origin: "https://neko.test",
    presentationLifecycle: { markRestored: ({ baseline }: { baseline: unknown }) => lifecycle.restored.push(baseline) },
    screenConfigurationsEndpoint: "/api/room/screen/configurations",
    screenEndpoint: "/api/room/screen",
    sleep: makeAbortableSleep(),
    target: {
      origin: "https://neko.test",
      surface_id: "surface_dynamic_1",
      window_settle_endpoint: "/pdpp/window-settle",
    },
  });

  await companion.start({ height: 844, width: 390 });
  const stopping = companion.stop();
  await waitFor(() => fetchImpl.calls.some((call) => call.url.includes("width=1280")));
  assert.equal(lifecycle.restored.length, 0);

  releaseBaselineSettle();
  await stopping;
  assert.equal(lifecycle.restored.length, 1);
});

test("n.eko refuses a managed surface whose settle endpoint is absent", () => {
  assert.throws(
    () =>
      createNekoCompanion({
        fetchImpl: async () => makeResponse(),
        target: { origin: "https://neko.test", surface_id: "surface_dynamic_1" },
      }),
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
    (error: Error & { code?: string }) => error?.code === "neko_window_settle_endpoint_required"
  );
});

test("n.eko presentation serializes viewport epochs and discards a stale queued rotation before restore", async () => {
  let releaseFirstApply: () => void = () => {
    throw new Error("releaseFirstApply not yet assigned");
  };
  const firstApply = new Promise<void>((resolve) => {
    releaseFirstApply = resolve;
  });
  const posted: Record<string, unknown>[] = [];
  const fetchImpl = makeFetch([
    {
      method: "GET",
      response: makeResponse({ json: { height: 720, rate: 30, width: 1280 } }),
      url: "https://neko.test/api/room/screen",
    },
    {
      method: "GET",
      response: makeResponse({
        json: [
          { height: 844, rate: 30, width: 390 },
          { height: 390, rate: 30, width: 844 },
        ],
      }),
      url: "https://neko.test/api/room/screen/configurations",
    },
    {
      method: "POST",
      response: async ({ init }) => {
        const body = JSON.parse(init.body ?? "");
        posted.push(body);
        if (body.width === 390) {
          await firstApply;
        }
        return makeResponse({ json: body });
      },
      url: "https://neko.test/api/room/screen",
    },
  ]);
  const companion = createNekoCompanion({
    bearerToken: "test-token",
    fetchImpl,
    origin: "https://neko.test",
    screenConfigurationsEndpoint: "/api/room/screen/configurations",
    screenEndpoint: "/api/room/screen",
    sleep: makeAbortableSleep(),
  });
  await companion.start();

  const portrait = companion.dispatch({ deviceScaleFactor: 1, height: 844, type: "viewport", width: 390 });
  await waitFor(() => posted.length === 1);
  const landscape = companion.dispatch({ deviceScaleFactor: 1, height: 390, type: "viewport", width: 844 });
  const stopped = companion.stop();
  releaseFirstApply();
  await Promise.all([portrait, landscape, stopped]);

  assert.deepEqual(posted, [
    { height: 844, rate: 30, width: 390 },
    { height: 720, rate: 30, width: 1280 },
  ]);
});

test("n.eko resolver-backed factory defers target lookup until start", async () => {
  let resolved = false;
  const fetchImpl = makeFetch([
    {
      method: "POST",
      response: makeResponse({ json: { token: "noauth-token" } }),
      url: "https://neko.test/api/login",
    },
    {
      method: "GET",
      response: makeResponse({ body: "jpeg" }),
      url: "https://neko.test/api/room/screen/cast.jpg",
    },
  ]);
  const factory = createDefaultStreamingCompanionFactory({
    fetchImpl,
    resolveTargetForInteraction(runId: string, interactionId: string) {
      resolved = true;
      assert.equal(runId, "run_1");
      assert.equal(interactionId, "int_1");
      return { origin: "https://neko.test" };
    },
    sleep: makeAbortableSleep(),
  });

  assert.equal(createDefaultStreamingCompanionFactory({ env: {} }), null);
  assert.ok(factory, "expected a factory to be created");
  assert.equal(factory({ browser_session_id: "bs", run_id: "run_1" }), null);

  const companion = factory({ browser_session_id: "bs", interaction_id: "int_1", run_id: "run_1" });
  assert.ok(companion, "expected a companion to be created");
  assert.equal(companion.backend, "neko");
  assert.equal(resolved, false);

  await companion.start();
  await waitFor(() => fetchImpl.calls.length === 2);
  assert.equal(resolved, true);

  await companion.stop();
});

test("n.eko resolver-backed factory applies nested n.eko defaults", async () => {
  const fetchImpl = makeFetch([
    {
      method: "POST",
      response: makeResponse({ json: { token: "token-nested" } }),
      url: "https://neko.test/api/login",
    },
    {
      method: "GET",
      response: makeResponse({ json: [{ height: 844, rate: 30, width: 400 }] }),
      url: "https://neko.test/api/room/screen/configurations",
    },
    {
      method: "POST",
      response: makeResponse({ json: { height: 844, rate: 30, width: 400 } }),
      url: "https://neko.test/api/room/screen",
    },
    {
      method: "GET",
      response: makeResponse({
        json: [
          {
            id: "page-1",
            type: "page",
            url: "data:text/html,<body></body>",
            webSocketDebuggerUrl: "ws://localhost:9222/devtools/page/page-1",
          },
        ],
      }),
      url: "http://127.0.0.1:9222/json",
    },
    {
      method: "GET",
      response: makeResponse({
        json: { webSocketDebuggerUrl: "ws://localhost:9222/devtools/browser/browser-1" },
      }),
      url: "http://127.0.0.1:9222/json/version",
    },
    {
      method: "GET",
      response: makeResponse({ body: "jpeg" }),
      url: "https://neko.test/api/room/screen/cast.jpg",
    },
  ]);
  const browserClient = makeFakeBrowserClient();
  const browserClientFactoryCalls: Record<string, unknown>[] = [];
  const factory = createDefaultStreamingCompanionFactory({
    fetchImpl,
    neko: {
      cdpHttpUrl: "http://127.0.0.1:9222",
      createBrowserClient(args: Record<string, unknown>) {
        browserClientFactoryCalls.push(args);
        return browserClient;
      },
      screenConfigurationsEndpoint: "/api/room/screen/configurations",
      screenEndpoint: "/api/room/screen",
    },
    resolveTargetForInteraction() {
      return { backend: "neko", base_url: "https://neko.test" };
    },
    sleep: makeAbortableSleep(),
  });
  assert.ok(factory, "expected a factory to be created");

  const companion = factory({ browser_session_id: "bs", interaction_id: "int_1", run_id: "run_1" });
  assert.ok(companion, "expected a companion to be created");
  await companion.start({ deviceScaleFactor: 3, hasTouch: true, height: 844, mobile: true, width: 390 });
  await companion.stop();

  assert.ok(fetchImpl.calls.some((call) => call.url === "https://neko.test/api/room/screen/configurations"));
  assert.equal(browserClientFactoryCalls.length, 1);
  const [browserClientFactoryCall] = browserClientFactoryCalls;
  assert.ok(browserClientFactoryCall, "expected a browser-client factory call");
  assert.equal(browserClientFactoryCall.cdpHttpUrl, "http://127.0.0.1:9222/");
  const setViewportCall = browserClient.calls.find((call) => call.op === "setViewportSize");
  assert.ok(setViewportCall, "expected a setViewportSize call");
  assert.deepEqual(setViewportCall.viewport, {
    height: 844,
    width: 400,
  });
  const screenPost = fetchImpl.calls.find(
    (call) => call.init.method === "POST" && call.url === "https://neko.test/api/room/screen"
  );
  assert.ok(screenPost, "expected a matching fetch call for screenPost");
  assert.deepEqual(JSON.parse(screenPost.init.body ?? ""), { height: 844, rate: 30, width: 400 });
});

test("multi-backend streaming factory selects n.eko descriptors and exposes proxy target", async () => {
  const fetchImpl = makeFetch([
    {
      method: "POST",
      response: makeResponse({ json: { token: "noauth-token" } }),
      url: "https://neko.test/api/login",
    },
    {
      method: "GET",
      response: makeResponse({ body: "jpeg" }),
      url: "https://neko.test/api/room/screen/cast.jpg",
    },
  ]);
  const factory = createStreamingBackendCompanionFactory({
    fetchImpl,
    resolveTargetForInteraction(runId: unknown, interactionId: unknown) {
      assert.equal(runId, "run_1");
      assert.equal(interactionId, "int_1");
      return { backend: "neko", base_url: "https://neko.test" };
    },
  });
  assert.ok(factory, "expected a factory to be created");

  const companion = factory({ browser_session_id: "bs", interaction_id: "int_1", run_id: "run_1" });
  assert.ok(companion, "expected a companion to be created");
  try {
    await companion.start(undefined);
    await waitFor(() => fetchImpl.calls.length === 2);
    assert.equal(companion.backend, "neko");
    assert.deepEqual(companion.getNekoProxyTarget?.(), { origin: "https://neko.test/" });
  } finally {
    await companion.stop();
  }
});
