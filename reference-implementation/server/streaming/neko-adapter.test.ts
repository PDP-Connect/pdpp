// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  createNekoCompanion,
  type NekoCompanionOptions,
  type NekoEvent,
  type NekoFetch,
  type NekoRequest,
  type NekoScreenConfiguration,
} from "./neko-adapter.ts";
import { createNekoBrowserClient, type NekoBrowserClient } from "./neko-browser-client.ts";

type UnknownRecord = Record<string, unknown>;
interface RecordedRequest {
  body: string | null;
  method: string;
  url: string;
}
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
interface Call extends UnknownRecord {
  op: string;
  source?: unknown;
  text?: string;
  url?: string;
  viewport?: { height: number; width: number };
}

function required<T>(value: T | null | undefined, message = "required test fixture value is missing"): T {
  assert.ok(value, message);
  return value;
}

function requiredRecord(value: unknown): UnknownRecord {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "expected an object record");
  return Object.fromEntries(Object.entries(value));
}

function requiredScreenDimensions(value: unknown): { height: number; width: number } {
  const record = requiredRecord(value);
  const width = Number(record.width);
  const height = Number(record.height);
  assert.ok(Number.isFinite(width) && Number.isFinite(height), "expected numeric screen dimensions");
  return { height, width };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function frameResponse() {
  return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {
    /* initialized by Promise executor */
  };
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function isNekoRequest(url: string, request: Pick<NekoRequest, "method">, path: string, method: string): boolean {
  return url.endsWith(path) && request.method === method;
}

function responseForNekoRequest(
  url: string,
  request: NekoRequest,
  screenConfigurations: readonly NekoScreenConfiguration[],
  baselineScreen: NekoScreenConfiguration
): Response {
  const routes = [
    {
      matches: () => url.endsWith("/api/room/screen/configurations"),
      response: () => jsonResponse(screenConfigurations),
    },
    {
      matches: () => isNekoRequest(url, request, "/api/room/screen", "POST"),
      response: () => jsonResponse(JSON.parse(request.body || "{}")),
    },
    {
      matches: () => isNekoRequest(url, request, "/api/room/screen", "GET"),
      response: () => jsonResponse(baselineScreen),
    },
    {
      matches: () => url.includes("/pdpp/window-settle"),
      response: () => {
        const expected = new URL(url);
        return jsonResponse({
          height: Number(expected.searchParams.get("height")) || required(screenConfigurations[0]).height,
          settled: true,
          width: Number(expected.searchParams.get("width")) || required(screenConfigurations[0]).width,
        });
      },
    },
    {
      matches: () => url.endsWith("/api/room/screen/cast.jpg") || url.endsWith("/api/room/screen/shot.jpg"),
      response: frameResponse,
    },
  ];
  return routes.find((route) => route.matches())?.response() || jsonResponse({});
}

function createFetchMock({
  screenConfigurations = [{ height: 816, rate: 30, width: 2128 }],
  baselineScreen = { height: 816, rate: 30, width: 2128 },
}: {
  baselineScreen?: NekoScreenConfiguration;
  screenConfigurations?: NekoScreenConfiguration[];
} = {}): NekoFetch & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl = Object.assign(
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async (url: string, request: NekoRequest = {}) => {
      requests.push({ body: request.body || null, method: request.method || "GET", url });
      return responseForNekoRequest(url, request, screenConfigurations, baselineScreen);
    },
    { requests }
  );
  return fetchImpl;
}

function testSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms === 50) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

function createFakeBrowserClient({
  copyText = "",
  statuses = [],
}: {
  copyText?: string;
  statuses?: UnknownRecord[];
} = {}) {
  const calls: Call[] = [];
  const bindings = new Map<string, (_source: unknown, payload: unknown) => void>();
  const client = {
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async addInitScript(source: unknown) {
      calls.push({ op: "addInitScript", source });
    },
    bindings,
    calls,
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async close() {
      calls.push({ op: "close" });
    },
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async connect() {
      calls.push({ op: "connect" });
      return client;
    },
    emitFocus(payload: UnknownRecord) {
      const handler = bindings.get("__pdppNekoFocusChanged");
      assert.equal(typeof handler, "function");
      required(handler)({}, JSON.stringify(payload));
    },
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async evaluate(source: unknown) {
      calls.push({ op: "evaluate", source });
      return evaluationResult(source, statuses, copyText);
    },
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async exposeBinding(name: string, handler: (_source: unknown, payload: unknown) => void) {
      calls.push({ name, op: "exposeBinding" });
      bindings.set(name, handler);
    },
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async getPage() {
      calls.push({ op: "getPage" });
      return {};
    },
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async goto(url: string) {
      calls.push({ op: "goto", url });
    },
    keyboard: {
      // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
      async insertText(text: string) {
        calls.push({ op: "insertText", text });
      },
    },
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async setViewportSize(viewport: { height: number; width: number }) {
      calls.push({ op: "setViewportSize", viewport: { ...viewport } });
    },
  };
  return client;
}

function evaluationResult(source: unknown, statuses: UnknownRecord[], copyText: string): string | undefined {
  if (String(source).includes("__pdppPlaygroundEvents")) {
    return JSON.stringify(statuses.length > 0 ? statuses.shift() : {});
  }
  if (String(source).includes("document.getSelection")) {
    return copyText;
  }
  // biome-ignore lint/complexity/noUselessReturn: required by TypeScript noImplicitReturns to make the empty result explicit.
  return;
}

function createCompanionWithBrowserClient(
  browserClient: NekoBrowserClient,
  options: NekoCompanionOptions & {
    fetchOptions?: { baselineScreen?: NekoScreenConfiguration; screenConfigurations?: NekoScreenConfiguration[] };
  } = {}
) {
  return createNekoCompanion({
    browserClient,
    cdpHttpUrl: "http://cdp.local/",
    fetchImpl: createFetchMock(options.fetchOptions),
    origin: "http://neko.local/",
    screenConfigurationsEndpoint: "api/room/screen/configurations",
    screenEndpoint: "api/room/screen",
    sleep: testSleep,
    ...options,
  });
}

const landscapeViewport = {
  deviceScaleFactor: 2.25,
  hasTouch: true,
  height: 364,
  mobile: true,
  screenHeight: 816,
  screenWidth: 2128,
  userAgent: "Mobile Test UA",
  width: 947,
};

test("n.eko browser client seam wraps Patchright operations and disconnects", async () => {
  const calls: Call[] = [];
  const page = {
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async evaluate(source: string) {
      calls.push({ op: "evaluate", source });
      return "evaluated";
    },
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async goto(url: string, options: UnknownRecord) {
      calls.push({ op: "goto", options, url });
    },
    keyboard: {
      // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
      async insertText(text: string) {
        calls.push({ op: "insertText", text });
      },
    },
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async setViewportSize(viewport: { height: number; width: number }) {
      calls.push({ op: "setViewportSize", viewport });
    },
  };
  const context = {
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async addInitScript(source: string) {
      calls.push({ op: "addInitScript", source });
    },
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async exposeBinding(name: string, handler: unknown) {
      calls.push({ handlerType: typeof handler, name, op: "exposeBinding" });
    },
    pages: () => [page],
  };
  const browser = {
    contexts: () => [context],
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async disconnect() {
      calls.push({ op: "disconnect" });
    },
  };
  const chromiumImpl = {
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async connectOverCDP(url: string) {
      calls.push({ op: "connectOverCDP", url });
      return browser;
    },
  };

  const client = createNekoBrowserClient({ cdpHttpUrl: "http://cdp.local/", chromiumImpl });

  await client.connect();
  assert.equal(await client.evaluate("1 + 1"), "evaluated");
  await client.setViewportSize({ height: 240, width: 320 });
  await client.goto("https://example.test/");
  await client.addInitScript("window.__canary = true");
  // biome-ignore lint/suspicious/noEmptyBlockStatements: The empty handler intentionally absorbs this best-effort cleanup failure.
  await client.exposeBinding("__binding", () => {});
  await client.keyboard.insertText("hello");
  await client.close();

  assert.deepEqual(calls, [
    { op: "connectOverCDP", url: "http://cdp.local/" },
    { op: "evaluate", source: "1 + 1" },
    { op: "setViewportSize", viewport: { height: 240, width: 320 } },
    { op: "goto", options: { waitUntil: "load" }, url: "https://example.test/" },
    { op: "addInitScript", source: "window.__canary = true" },
    { handlerType: "function", name: "__binding", op: "exposeBinding" },
    { op: "insertText", text: "hello" },
    { op: "disconnect" },
  ]);
});

test("n.eko assistive mode uses the browser-client seam before navigation", async () => {
  const browserClient = createFakeBrowserClient();
  const loggerMessages: UnknownRecord[] = [];
  const companion = createCompanionWithBrowserClient(browserClient, {
    logger: {
      warn(entry: UnknownRecord) {
        loggerMessages.push(entry);
      },
    },
    startUrl: "https://example.test/",
    stealthMode: "balanced",
  });

  await companion.start(landscapeViewport);
  await companion.stop();

  assert.equal(companion._internal.stealthMode(), "assistive");
  assert.ok(loggerMessages.some((entry) => entry.msg === "neko_stealth_balanced_normalized"));
  assert.deepEqual(
    browserClient.calls.map((call) => call.op),
    ["connect", "setViewportSize", "exposeBinding", "addInitScript", "evaluate", "goto", "close"]
  );
  assert.deepEqual(required(browserClient.calls.find((call) => call.op === "setViewportSize")).viewport, {
    height: 364,
    width: 947,
  });
  assert.equal(required(browserClient.calls.find((call) => call.op === "goto")).url, "https://example.test/");
  assert.ok(
    String(required(required(browserClient.calls.find((call) => call.op === "addInitScript")).source)).includes(
      "__pdppNekoFocusChanged"
    )
  );
});

test("n.eko strict mode never creates or connects a browser client", async () => {
  let factoryCalls = 0;
  const companion = createNekoCompanion({
    cdpHttpUrl: "http://cdp.local/",
    createBrowserClient() {
      factoryCalls += 1;
      return createFakeBrowserClient();
    },
    fetchImpl: createFetchMock(),
    origin: "http://neko.local/",
    screenConfigurationsEndpoint: "api/room/screen/configurations",
    screenEndpoint: "api/room/screen",
    sleep: testSleep,
    stealthMode: "strict",
  });

  await companion.start(landscapeViewport);
  const status = requiredRecord(await companion.queryNekoStatus());
  await companion.stop();

  assert.equal(factoryCalls, 0);
  assert.equal(status.page_cdp_available, false);
  assert.deepEqual(status.page_cdp_skipped, {
    browser_owner_mode: "neko-owned",
    stealth_mode: "strict",
  });
});

test("n.eko cover-fit selection chooses CSS-sized phone modes before rotation and restores the baseline on stop", async () => {
  const fetchImpl = createFetchMock({
    baselineScreen: { height: 900, rate: 30, width: 1440 },
    screenConfigurations: [
      { height: 900, rate: 30, width: 1440 },
      { height: 915, rate: 30, width: 412 },
      { height: 412, rate: 29, width: 915 },
    ],
  });
  const companion = createNekoCompanion({
    fetchImpl,
    origin: "http://neko.local/",
    screenConfigurationsEndpoint: "api/room/screen/configurations",
    screenEndpoint: "api/room/screen",
    sleep: testSleep,
    stealthMode: "strict",
  });

  await companion.start({ height: 915, screenHeight: 915, screenWidth: 412, width: 412 });
  await companion.dispatch({ height: 412, screenHeight: 412, screenWidth: 915, type: "viewport", width: 915 });

  const selectionPostsBeforeStop = fetchImpl.requests
    .filter((request) => isNekoRequest(request.url, request, "/api/room/screen", "POST"))
    .map((request) => JSON.parse(required(request.body)));
  assert.deepEqual(selectionPostsBeforeStop, [
    { height: 915, rate: 30, width: 412 },
    { height: 412, rate: 29, width: 915 },
  ]);

  await companion.stop();

  const screenPostsIncludingRestore = fetchImpl.requests
    .filter((request) => isNekoRequest(request.url, request, "/api/room/screen", "POST"))
    .map((request) => JSON.parse(required(request.body)));
  assert.deepEqual(screenPostsIncludingRestore, [...selectionPostsBeforeStop, { height: 900, rate: 30, width: 1440 }]);
});

test("n.eko does not promote a phone frame before the window-size acknowledgement", async () => {
  const resizeBlocked = deferred<void>();
  const resizeAcknowledged = deferred<void>();
  const fetchImpl = createFetchMock({
    baselineScreen: { height: 900, rate: 30, width: 1440 },
    screenConfigurations: [{ height: 915, rate: 30, width: 412 }],
  });
  const originalFetch = fetchImpl;
  const blockedFetch = Object.assign(
    async (url: string, request: NekoRequest = {}) => {
      if (url.includes("/pdpp/window-settle")) {
        resizeBlocked.resolve();
        await resizeAcknowledged.promise;
        const requested = new URL(url);
        return jsonResponse({
          height: Number(requested.searchParams.get("height")),
          settled: true,
          width: Number(requested.searchParams.get("width")),
        });
      }
      return originalFetch(url, request);
    },
    { requests: fetchImpl.requests }
  );
  const companion = createNekoCompanion({
    cdpHttpUrl: "http://cdp.local/",
    fetchImpl: blockedFetch,
    origin: "http://neko.local/",
    screenConfigurationsEndpoint: "api/room/screen/configurations",
    screenEndpoint: "api/room/screen",
    sleep: testSleep,
    stealthMode: "strict",
    windowSettleEndpoint: "http://cdp.local/pdpp/window-settle",
  });
  const frames: unknown[] = [];
  companion.onFrame((frame) => frames.push(frame));

  const starting = companion.start({ height: 915, screenHeight: 915, screenWidth: 412, width: 412 });
  await resizeBlocked.promise;

  assert.equal(frames.length, 0);
  assert.equal(blockedFetch.requests.filter((request) => request.url.endsWith("/api/room/screen/cast.jpg")).length, 0);

  resizeAcknowledged.resolve(undefined);
  await starting;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(frames.length, 1);
  await companion.stop();
});

test("n.eko waits for the capture-aligned root after applying a quantized phone mode", async () => {
  const fetchImpl = createFetchMock({
    baselineScreen: { height: 900, rate: 30, width: 1440 },
    screenConfigurations: [{ height: 932, rate: 30, width: 500 }],
  });
  const originalFetch = fetchImpl;
  let captureSurfaceSettled = false;
  let actualRoot = { height: 900, width: 1440 };
  const settledFetch = Object.assign(
    async (url: string, request: NekoRequest = {}) => {
      if (isNekoRequest(url, request, "/api/room/screen", "POST")) {
        const response = await originalFetch(url, request);
        const nominalScreen = requiredScreenDimensions(JSON.parse(required(request.body)));
        actualRoot =
          nominalScreen.width === 500 && nominalScreen.height === 932 ? { height: 932, width: 496 } : nominalScreen;
        return response;
      }
      if (url.includes("/pdpp/window-settle")) {
        // n.eko acknowledges the selected 500x932 mode, but its X root and
        // RemoteBrowserApp converge to its 8-pixel JPEG capture surface.
        fetchImpl.requests.push({ body: request.body || null, method: request.method || "GET", url });
        const requested = new URL(url);
        const settled =
          Number(requested.searchParams.get("width")) === actualRoot.width &&
          Number(requested.searchParams.get("height")) === actualRoot.height;
        captureSurfaceSettled ||= settled;
        return jsonResponse({
          settled,
          ...actualRoot,
        });
      }
      return originalFetch(url, request);
    },
    { requests: fetchImpl.requests }
  );
  const companion = createNekoCompanion({
    cdpHttpUrl: "http://cdp.local/",
    fetchImpl: settledFetch,
    origin: "http://neko.local/",
    screenConfigurationsEndpoint: "api/room/screen/configurations",
    screenEndpoint: "api/room/screen",
    sleep: testSleep,
    stealthMode: "strict",
    windowSettleEndpoint: "http://cdp.local/pdpp/window-settle",
    windowSettleTimeoutMs: 0,
  });
  const frames: unknown[] = [];
  companion.onFrame((frame) => {
    assert.equal(captureSurfaceSettled, true, "a frame must not emit before the capture surface settles");
    frames.push(frame);
  });

  await companion.start({ height: 820, screenHeight: 820, screenWidth: 430, width: 430 });
  await new Promise((resolve) => setImmediate(resolve));

  const appliedScreen = settledFetch.requests.find((request) =>
    isNekoRequest(request.url, request, "/api/room/screen", "POST")
  );
  assert.deepEqual(JSON.parse(required(required(appliedScreen).body)), { height: 932, rate: 30, width: 500 });
  const settleRequest = settledFetch.requests.find(
    (request) =>
      request.url.includes("/pdpp/window-settle") && new URL(request.url).searchParams.get("height") === "932"
  );
  assert.equal(new URL(required(settleRequest).url).searchParams.get("width"), "496");
  assert.equal(new URL(required(settleRequest).url).searchParams.get("height"), "932");
  assert.equal(frames.length, 1, "the first frame is emitted only after the capture-aligned root settles");

  await companion.stop();
});

test("first frame is promoted after oscillating phone presentation acknowledgements", async () => {
  const screenshotRequested = deferred<void>();
  const screenshotReady = deferred<Response>();
  const replacementRequested = deferred<void>();
  const firstPresentationScreenApplied = deferred<void>();
  const firstUnsettledAcknowledgement = deferred<void>();
  const releaseFirstUnsettledAcknowledgement = deferred<void>();
  let screenPostCount = 0;
  let screenshotFetchCount = 0;
  let settleRequestCount = 0;
  let settleSleepCount = 0;
  const fetchImpl = createFetchMock({
    baselineScreen: { height: 900, rate: 30, width: 1440 },
    screenConfigurations: [
      { height: 915, rate: 30, width: 412 },
      { height: 412, rate: 30, width: 915 },
    ],
  });
  const originalFetch = fetchImpl;
  const oscillatingFetch = Object.assign(
    async (url: string, request: NekoRequest = {}) => {
      if (url.endsWith("/api/room/screen/cast.jpg")) {
        screenshotFetchCount += 1;
        screenshotRequested.resolve(undefined);
        if (screenshotFetchCount === 1) {
          return await screenshotReady.promise;
        }
        replacementRequested.resolve(undefined);
        return frameResponse();
      }
      if (isNekoRequest(url, request, "/api/room/screen", "POST")) {
        screenPostCount += 1;
        if (screenPostCount === 2) {
          firstPresentationScreenApplied.resolve(undefined);
        }
      }
      if (url.includes("/pdpp/window-settle")) {
        settleRequestCount += 1;
        const requested = new URL(url);
        const settled = settleRequestCount !== 2 && settleRequestCount !== 4;
        if (!settled && settleRequestCount === 2) {
          firstUnsettledAcknowledgement.resolve(undefined);
        }
        return jsonResponse({
          height: Number(requested.searchParams.get("height")),
          settled,
          width: Number(requested.searchParams.get("width")),
        });
      }
      return originalFetch(url, request);
    },
    { requests: fetchImpl.requests }
  );
  const companion = createNekoCompanion({
    fetchImpl: oscillatingFetch,
    origin: "http://neko.local/",
    pollIntervalMs: 1,
    screenConfigurationsEndpoint: "api/room/screen/configurations",
    screenEndpoint: "api/room/screen",
    sleep(ms, signal) {
      if (ms === 50) {
        settleSleepCount += 1;
        return settleSleepCount === 1 ? releaseFirstUnsettledAcknowledgement.promise : Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    stealthMode: "strict",
    windowSettleEndpoint: "http://cdp.local/pdpp/window-settle",
    windowSettlePollIntervalMs: 50,
  });
  // biome-ignore lint/suspicious/noEvolvingTypes: This runtime-untyped boundary requires staged type narrowing.
  const frames = [];
  companion.onFrame((frame) => frames.push(frame));

  try {
    await companion.start({ height: 915, screenHeight: 915, screenWidth: 412, width: 412 });
    await screenshotRequested.promise;

    const rotate = companion.dispatch({
      height: 412,
      screenHeight: 412,
      screenWidth: 915,
      type: "viewport",
      width: 915,
    });
    await firstPresentationScreenApplied.promise;
    await new Promise((resolve) => setImmediate(resolve));
    if (settleRequestCount > 0) {
      await firstUnsettledAcknowledgement.promise;
    }

    const returnToPortrait = companion.dispatch({
      height: 915,
      screenHeight: 915,
      screenWidth: 412,
      type: "viewport",
      width: 412,
    });
    screenshotReady.resolve(frameResponse());
    releaseFirstUnsettledAcknowledgement.resolve(undefined);
    await Promise.all([rotate, returnToPortrait]);
    await replacementRequested.promise;
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(frames.length, 1, "the replacement frame must be promoted after the latest acknowledgement settles");
    assert.equal(screenshotFetchCount, 2, "a stale frame is replaced immediately instead of waiting for the next poll");
  } finally {
    screenshotReady.resolve(frameResponse());
    releaseFirstUnsettledAcknowledgement.resolve(undefined);
    await companion.stop();
  }
});

test("n.eko coalesces bounded phone presentation churn into one frame replacement", async () => {
  const CHURN_CYCLES = 8;
  const screenshotRequested = deferred<void>();
  const screenshotReady = deferred<Response>();
  let screenshotFetchCount = 0;
  const fetchImpl = createFetchMock({
    baselineScreen: { height: 900, rate: 30, width: 1440 },
    screenConfigurations: [
      { height: 915, rate: 30, width: 412 },
      { height: 412, rate: 30, width: 915 },
    ],
  });
  const originalFetch = fetchImpl;
  const churnFetch = Object.assign(
    async (url: string, request: NekoRequest = {}) => {
      if (url.endsWith("/api/room/screen/cast.jpg")) {
        screenshotFetchCount += 1;
        if (screenshotFetchCount === 1) {
          screenshotRequested.resolve(undefined);
          return await screenshotReady.promise;
        }
        return frameResponse();
      }
      if (url.includes("/pdpp/window-settle")) {
        const requested = new URL(url);
        return jsonResponse({
          height: Number(requested.searchParams.get("height")),
          settled: true,
          width: Number(requested.searchParams.get("width")),
        });
      }
      return originalFetch(url, request);
    },
    { requests: fetchImpl.requests }
  );
  const companion = createNekoCompanion({
    fetchImpl: churnFetch,
    origin: "http://neko.local/",
    pollIntervalMs: 1,
    screenConfigurationsEndpoint: "api/room/screen/configurations",
    screenEndpoint: "api/room/screen",
    sleep(ms, signal) {
      if (ms === 50) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    stealthMode: "strict",
    windowSettleEndpoint: "http://cdp.local/pdpp/window-settle",
    windowSettlePollIntervalMs: 50,
  });
  // biome-ignore lint/suspicious/noEvolvingTypes: This runtime-untyped boundary requires staged type narrowing.
  const frames = [];
  companion.onFrame((frame) => frames.push(frame));

  try {
    await companion.start({ height: 915, screenHeight: 915, screenWidth: 412, width: 412 });
    await screenshotRequested.promise;

    for (let cycle = 0; cycle < CHURN_CYCLES; cycle += 1) {
      const landscape = cycle % 2 === 0;
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
      await companion.dispatch({
        height: landscape ? 412 : 915,
        screenHeight: landscape ? 412 : 915,
        screenWidth: landscape ? 915 : 412,
        type: "viewport",
        width: landscape ? 915 : 412,
      });
    }

    screenshotReady.resolve(frameResponse());
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(frames.length, 1, "the newest settled presentation receives a frame");
    assert.equal(
      screenshotFetchCount,
      2,
      "one stale frame receives exactly one immediate replacement, independent of churn"
    );
  } finally {
    screenshotReady.resolve(frameResponse());
    await companion.stop();
  }
});

test("n.eko status reapplies browser-client viewport when page dimensions mismatch", async () => {
  const browserClient = createFakeBrowserClient({
    statuses: [
      { innerHeight: 600, innerWidth: 800, screenHeight: 600, screenWidth: 800 },
      { innerHeight: 364, innerWidth: 947, screenHeight: 816, screenWidth: 2128 },
    ],
  });
  const companion = createCompanionWithBrowserClient(browserClient, {
    stealthMode: "assistive",
  });

  await companion.start(landscapeViewport);
  const setViewportCountBeforeStatus = browserClient.calls.filter((call) => call.op === "setViewportSize").length;
  const status = requiredRecord(await companion.queryNekoStatus());
  await companion.stop();

  const setViewportCalls = browserClient.calls.filter((call) => call.op === "setViewportSize");
  assert.equal(setViewportCountBeforeStatus, 1);
  assert.equal(setViewportCalls.length, 2);
  assert.equal(status.page_metrics_reapplied, true);
  assert.equal(requiredRecord(status.page).innerWidth, 947);
  assert.ok(requiredRecord(status.page_metrics_mismatch).innerWidth);
});

test("n.eko status ignores stale touch, DPR, screen, and UA values the adapter no longer owns", async () => {
  const browserClient = createFakeBrowserClient({
    statuses: [
      {
        devicePixelRatio: 3,
        hasTouch: true,
        innerHeight: 816,
        innerWidth: 2128,
        maxTouchPoints: 10,
        screenHeight: 777,
        screenWidth: 999,
        userAgent: "Unexpected UA",
      },
    ],
  });
  const companion = createCompanionWithBrowserClient(browserClient, {
    stealthMode: "assistive",
  });

  await companion.start({
    deviceScaleFactor: 1.15,
    hasTouch: false,
    height: 1123,
    mobile: false,
    width: 1117,
  });
  const setViewportCountBeforeStatus = browserClient.calls.filter((call) => call.op === "setViewportSize").length;
  const status = requiredRecord(await companion.queryNekoStatus());
  await companion.stop();

  const setViewportCountAfterStatus = browserClient.calls.filter((call) => call.op === "setViewportSize").length;
  assert.equal(status.page_metrics_reapplied, undefined);
  assert.equal(status.page_metrics_mismatch, undefined);
  assert.equal(setViewportCountAfterStatus, setViewportCountBeforeStatus);
});

test("n.eko focus, paste, copy, and playground status route through the browser-client seam", async () => {
  const samplePlaygroundEvents = [
    {
      atMs: 1_700_000_000_000,
      clientX: 70,
      clientY: 233,
      seq: 1,
      target: { id: "counter", tag: "button" },
      type: "pointerdown",
    },
  ];
  const browserClient = createFakeBrowserClient({
    copyText: "remote selection",
    statuses: [
      {
        innerHeight: 364,
        innerWidth: 947,
        playgroundEvents: samplePlaygroundEvents,
        screenHeight: 816,
        screenWidth: 2128,
      },
    ],
  });
  const companion = createCompanionWithBrowserClient(browserClient, {
    stealthMode: "assistive",
  });
  const events: NekoEvent[] = [];
  companion.onEvent((event) => events.push(event));

  await companion.start(landscapeViewport);
  browserClient.emitFocus({ id: "otp", tagName: "INPUT", type: "focus" });
  await companion.dispatch({ text: "one-time code 123456", type: "paste" });
  await companion.dispatch({ type: "copy" });
  const status = requiredRecord(await companion.queryNekoStatus());
  await companion.stop();

  assert.ok(events.some((event) => event.kind === "keyboard_focus" && event.focused === true));
  assert.ok(events.some((event) => event.kind === "clipboard" && event.text === "remote selection"));
  assert.ok(browserClient.calls.some((call) => call.op === "insertText" && call.text === "one-time code 123456"));
  assert.deepEqual(requiredRecord(status.page).playgroundEvents, samplePlaygroundEvents);
});

test("n.eko adapter source does not contain forbidden raw helper commands", async () => {
  const source = await readFile(new URL("./neko-adapter.ts", import.meta.url), "utf8");
  const forbidden = [
    ["Runtime", "enable"],
    ["Runtime", "addBinding"],
    ["Page", "addScriptToEvaluateOnNewDocument"],
    ["Browser", "setWindowBounds"],
    ["Emulation", "setUserAgentOverride"],
    ["Emulation", "setDeviceMetricsOverride"],
    ["Emulation", "setTouchEmulationEnabled"],
    ["Emulation", "setEmitTouchEventsForMouse"],
  ].map(([domain, method]) => `${domain}.${method}`);

  for (const command of forbidden) {
    assert.equal(source.includes(command), false, `${command} must not be sent by the n.eko adapter`);
  }
});

test("buildViewportStatusExpression drains __pdppPlaygroundEvents and includes screenWidth", async () => {
  const adapterSource = await readFile(new URL("./neko-adapter.ts", import.meta.url), "utf8");
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  assert.match(adapterSource, /__pdppPlaygroundEvents/, "adapter drains __pdppPlaygroundEvents");
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  assert.match(adapterSource, /playgroundEvents:\s*drained/, "drained events surface as playgroundEvents");
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  assert.match(adapterSource, /screenWidth:\s*window\.screen/, "expression still reports window.screen.width");
});
