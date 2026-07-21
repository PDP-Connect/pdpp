import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { createNekoCompanion } from './neko-adapter.js';
import { createNekoBrowserClient } from './neko-browser-client.ts';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

function frameResponse() {
  return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function isNekoRequest(url, request, path, method) {
  return url.endsWith(path) && request.method === method;
}

function responseForNekoRequest(url, request, screenConfigurations, baselineScreen) {
  const routes = [
    {
      matches: () => url.endsWith('/api/room/screen/configurations'),
      response: () => jsonResponse(screenConfigurations),
    },
    {
      matches: () => isNekoRequest(url, request, '/api/room/screen', 'POST'),
      response: () => jsonResponse(JSON.parse(request.body)),
    },
    {
      matches: () => isNekoRequest(url, request, '/api/room/screen', 'GET'),
      response: () => jsonResponse(baselineScreen),
    },
    {
      matches: () => url.includes('/pdpp/window-settle'),
      response: () => {
        const expected = new URL(url);
        return jsonResponse({
          settled: true,
          width: Number(expected.searchParams.get('width')) || screenConfigurations[0].width,
          height: Number(expected.searchParams.get('height')) || screenConfigurations[0].height,
        });
      },
    },
    {
      matches: () => url.endsWith('/api/room/screen/cast.jpg') || url.endsWith('/api/room/screen/shot.jpg'),
      response: frameResponse,
    },
  ];
  return routes.find((route) => route.matches())?.response() || jsonResponse({});
}

function createFetchMock({
  screenConfigurations = [{ width: 2128, height: 816, rate: 30 }],
  baselineScreen = { width: 2128, height: 816, rate: 30 },
} = {}) {
  const requests = [];
  const fetchImpl = async (url, request = {}) => {
    requests.push({ body: request.body || null, method: request.method || 'GET', url });
    return responseForNekoRequest(url, request, screenConfigurations, baselineScreen);
  };
  fetchImpl.requests = requests;
  return fetchImpl;
}

function testSleep(ms, signal) {
  if (ms === 50) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    signal?.addEventListener('abort', resolve, { once: true });
  });
}

function createFakeBrowserClient({ copyText = '', statuses = [] } = {}) {
  const calls = [];
  const bindings = new Map();
  const client = {
    calls,
    bindings,
    keyboard: {
      async insertText(text) {
        calls.push({ op: 'insertText', text });
      },
    },
    async connect() {
      calls.push({ op: 'connect' });
      return client;
    },
    async getPage() {
      calls.push({ op: 'getPage' });
      return {};
    },
    async setViewportSize(viewport) {
      calls.push({ op: 'setViewportSize', viewport: { ...viewport } });
    },
    async goto(url) {
      calls.push({ op: 'goto', url });
    },
    async addInitScript(source) {
      calls.push({ op: 'addInitScript', source });
    },
    async exposeBinding(name, handler) {
      calls.push({ op: 'exposeBinding', name });
      bindings.set(name, handler);
    },
    async evaluate(source) {
      calls.push({ op: 'evaluate', source });
      return evaluationResult(source, statuses, copyText);
    },
    async close() {
      calls.push({ op: 'close' });
    },
    emitFocus(payload) {
      const handler = bindings.get('__pdppNekoFocusChanged');
      assert.equal(typeof handler, 'function');
      handler({}, JSON.stringify(payload));
    },
  };
  return client;
}

function evaluationResult(source, statuses, copyText) {
  if (String(source).includes('__pdppPlaygroundEvents')) return JSON.stringify(statuses.length > 0 ? statuses.shift() : {});
  if (String(source).includes('document.getSelection')) return copyText;
  return undefined;
}

function createCompanionWithBrowserClient(browserClient, options = {}) {
  return createNekoCompanion({
    origin: 'http://neko.local/',
    cdpHttpUrl: 'http://cdp.local/',
    fetchImpl: createFetchMock(options.fetchOptions),
    screenEndpoint: 'api/room/screen',
    screenConfigurationsEndpoint: 'api/room/screen/configurations',
    sleep: testSleep,
    browserClient,
    ...options,
  });
}

const landscapeViewport = {
  width: 947,
  height: 364,
  deviceScaleFactor: 2.25,
  hasTouch: true,
  mobile: true,
  screenWidth: 2128,
  screenHeight: 816,
  userAgent: 'Mobile Test UA',
};

test('n.eko browser client seam wraps Patchright operations and disconnects', async () => {
  const calls = [];
  const page = {
    keyboard: {
      async insertText(text) {
        calls.push({ op: 'insertText', text });
      },
    },
    async evaluate(source) {
      calls.push({ op: 'evaluate', source });
      return 'evaluated';
    },
    async goto(url, options) {
      calls.push({ op: 'goto', options, url });
    },
    async setViewportSize(viewport) {
      calls.push({ op: 'setViewportSize', viewport });
    },
  };
  const context = {
    pages: () => [page],
    async addInitScript(source) {
      calls.push({ op: 'addInitScript', source });
    },
    async exposeBinding(name, handler) {
      calls.push({ handlerType: typeof handler, name, op: 'exposeBinding' });
    },
  };
  const browser = {
    contexts: () => [context],
    async disconnect() {
      calls.push({ op: 'disconnect' });
    },
  };
  const chromiumImpl = {
    async connectOverCDP(url) {
      calls.push({ op: 'connectOverCDP', url });
      return browser;
    },
  };

  const client = createNekoBrowserClient({ cdpHttpUrl: 'http://cdp.local/', chromiumImpl });

  await client.connect();
  assert.equal(await client.evaluate('1 + 1'), 'evaluated');
  await client.setViewportSize({ width: 320, height: 240 });
  await client.goto('https://example.test/');
  await client.addInitScript('window.__canary = true');
  await client.exposeBinding('__binding', () => {});
  await client.keyboard.insertText('hello');
  await client.close();

  assert.deepEqual(calls, [
    { op: 'connectOverCDP', url: 'http://cdp.local/' },
    { op: 'evaluate', source: '1 + 1' },
    { op: 'setViewportSize', viewport: { width: 320, height: 240 } },
    { op: 'goto', options: { waitUntil: 'load' }, url: 'https://example.test/' },
    { op: 'addInitScript', source: 'window.__canary = true' },
    { handlerType: 'function', name: '__binding', op: 'exposeBinding' },
    { op: 'insertText', text: 'hello' },
    { op: 'disconnect' },
  ]);
});

test('n.eko assistive mode uses the browser-client seam before navigation', async () => {
  const browserClient = createFakeBrowserClient();
  const loggerMessages = [];
  const companion = createCompanionWithBrowserClient(browserClient, {
    logger: {
      warn(entry) {
        loggerMessages.push(entry);
      },
    },
    startUrl: 'https://example.test/',
    stealthMode: 'balanced',
  });

  await companion.start(landscapeViewport);
  await companion.stop();

  assert.equal(companion._internal.stealthMode(), 'assistive');
  assert.ok(loggerMessages.some((entry) => entry.msg === 'neko_stealth_balanced_normalized'));
  assert.deepEqual(
    browserClient.calls.map((call) => call.op),
    ['connect', 'setViewportSize', 'exposeBinding', 'addInitScript', 'evaluate', 'goto', 'close'],
  );
  assert.deepEqual(browserClient.calls.find((call) => call.op === 'setViewportSize').viewport, {
    width: 947,
    height: 364,
  });
  assert.equal(browserClient.calls.find((call) => call.op === 'goto').url, 'https://example.test/');
  assert.ok(browserClient.calls.find((call) => call.op === 'addInitScript').source.includes('__pdppNekoFocusChanged'));
});

test('n.eko strict mode never creates or connects a browser client', async () => {
  let factoryCalls = 0;
  const companion = createNekoCompanion({
    origin: 'http://neko.local/',
    cdpHttpUrl: 'http://cdp.local/',
    fetchImpl: createFetchMock(),
    screenEndpoint: 'api/room/screen',
    screenConfigurationsEndpoint: 'api/room/screen/configurations',
    sleep: testSleep,
    createBrowserClient() {
      factoryCalls += 1;
      return createFakeBrowserClient();
    },
    stealthMode: 'strict',
  });

  await companion.start(landscapeViewport);
  const status = await companion.queryNekoStatus();
  await companion.stop();

  assert.equal(factoryCalls, 0);
  assert.equal(status.page_cdp_available, false);
  assert.deepEqual(status.page_cdp_skipped, {
    browser_owner_mode: 'neko-owned',
    stealth_mode: 'strict',
  });
});

test('n.eko cover-fit selection chooses CSS-sized phone modes before rotation and restores the baseline on stop', async () => {
  const fetchImpl = createFetchMock({
    screenConfigurations: [
      { width: 1440, height: 900, rate: 30 },
      { width: 412, height: 915, rate: 30 },
      { width: 915, height: 412, rate: 29 },
    ],
    baselineScreen: { width: 1440, height: 900, rate: 30 },
  });
  const companion = createNekoCompanion({
    origin: 'http://neko.local/',
    fetchImpl,
    screenEndpoint: 'api/room/screen',
    screenConfigurationsEndpoint: 'api/room/screen/configurations',
    sleep: testSleep,
    stealthMode: 'strict',
  });

  await companion.start({ width: 412, height: 915, screenWidth: 412, screenHeight: 915 });
  await companion.dispatch({ type: 'viewport', width: 915, height: 412, screenWidth: 915, screenHeight: 412 });

  const selectionPostsBeforeStop = fetchImpl.requests
    .filter((request) => isNekoRequest(request.url, request, '/api/room/screen', 'POST'))
    .map((request) => JSON.parse(request.body));
  assert.deepEqual(selectionPostsBeforeStop, [
    { width: 412, height: 915, rate: 30 },
    { width: 915, height: 412, rate: 29 },
  ]);

  await companion.stop();

  const screenPostsIncludingRestore = fetchImpl.requests
    .filter((request) => isNekoRequest(request.url, request, '/api/room/screen', 'POST'))
    .map((request) => JSON.parse(request.body));
  assert.deepEqual(screenPostsIncludingRestore, [
    ...selectionPostsBeforeStop,
    { width: 1440, height: 900, rate: 30 },
  ]);
});

test('n.eko does not promote a phone frame before the window-size acknowledgement', async () => {
  const resizeBlocked = deferred();
  const resizeAcknowledged = deferred();
  const fetchImpl = createFetchMock({
    screenConfigurations: [{ width: 412, height: 915, rate: 30 }],
    baselineScreen: { width: 1440, height: 900, rate: 30 },
  });
  const originalFetch = fetchImpl;
  const blockedFetch = async (url, request = {}) => {
    if (url.includes('/pdpp/window-settle')) {
      resizeBlocked.resolve();
      await resizeAcknowledged.promise;
      const requested = new URL(url);
      return jsonResponse({
        settled: true,
        width: Number(requested.searchParams.get('width')),
        height: Number(requested.searchParams.get('height')),
      });
    }
    return originalFetch(url, request);
  };
  blockedFetch.requests = fetchImpl.requests;
  const companion = createNekoCompanion({
    origin: 'http://neko.local/',
    cdpHttpUrl: 'http://cdp.local/',
    windowSettleEndpoint: 'http://cdp.local/pdpp/window-settle',
    fetchImpl: blockedFetch,
    screenEndpoint: 'api/room/screen',
    screenConfigurationsEndpoint: 'api/room/screen/configurations',
    sleep: testSleep,
    stealthMode: 'strict',
  });
  const frames = [];
  companion.onFrame((frame) => frames.push(frame));

  const starting = companion.start({ width: 412, height: 915, screenWidth: 412, screenHeight: 915 });
  await resizeBlocked.promise;

  assert.equal(frames.length, 0);
  assert.equal(
    blockedFetch.requests.filter((request) => request.url.endsWith('/api/room/screen/cast.jpg')).length,
    0,
  );

  resizeAcknowledged.resolve();
  await starting;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(frames.length, 1);
  await companion.stop();
});

test('n.eko waits for the capture-aligned root after applying a quantized phone mode', async () => {
  const fetchImpl = createFetchMock({
    screenConfigurations: [{ width: 500, height: 932, rate: 30 }],
    baselineScreen: { width: 1440, height: 900, rate: 30 },
  });
  const originalFetch = fetchImpl;
  let captureSurfaceSettled = false;
  let actualRoot = { width: 1440, height: 900 };
  const settledFetch = async (url, request = {}) => {
    if (isNekoRequest(url, request, '/api/room/screen', 'POST')) {
      const response = await originalFetch(url, request);
      const nominalScreen = JSON.parse(request.body);
      actualRoot = nominalScreen.width === 500 && nominalScreen.height === 932
        ? { width: 496, height: 932 }
        : nominalScreen;
      return response;
    }
    if (url.includes('/pdpp/window-settle')) {
      // n.eko acknowledges the selected 500x932 mode, but its X root and
      // RemoteBrowserApp converge to its 8-pixel JPEG capture surface.
      fetchImpl.requests.push({ body: request.body || null, method: request.method || 'GET', url });
      const requested = new URL(url);
      const settled = Number(requested.searchParams.get('width')) === actualRoot.width
        && Number(requested.searchParams.get('height')) === actualRoot.height;
      captureSurfaceSettled ||= settled;
      return jsonResponse({
        settled,
        ...actualRoot,
      });
    }
    return originalFetch(url, request);
  };
  settledFetch.requests = fetchImpl.requests;
  const companion = createNekoCompanion({
    origin: 'http://neko.local/',
    cdpHttpUrl: 'http://cdp.local/',
    windowSettleEndpoint: 'http://cdp.local/pdpp/window-settle',
    fetchImpl: settledFetch,
    screenEndpoint: 'api/room/screen',
    screenConfigurationsEndpoint: 'api/room/screen/configurations',
    windowSettleTimeoutMs: 0,
    sleep: testSleep,
    stealthMode: 'strict',
  });
  const frames = [];
  companion.onFrame((frame) => {
    assert.equal(captureSurfaceSettled, true, 'a frame must not emit before the capture surface settles');
    frames.push(frame);
  });

  await companion.start({ width: 430, height: 820, screenWidth: 430, screenHeight: 820 });
  await new Promise((resolve) => setImmediate(resolve));

  const appliedScreen = settledFetch.requests.find((request) =>
    isNekoRequest(request.url, request, '/api/room/screen', 'POST'),
  );
  assert.deepEqual(JSON.parse(appliedScreen.body), { width: 500, height: 932, rate: 30 });
  const settleRequest = settledFetch.requests.find((request) =>
    request.url.includes('/pdpp/window-settle') && new URL(request.url).searchParams.get('height') === '932',
  );
  assert.equal(new URL(settleRequest.url).searchParams.get('width'), '496');
  assert.equal(new URL(settleRequest.url).searchParams.get('height'), '932');
  assert.equal(frames.length, 1, 'the first frame is emitted only after the capture-aligned root settles');

  await companion.stop();
});

test('first frame is promoted after oscillating phone presentation acknowledgements', async () => {
  const screenshotRequested = deferred();
  const screenshotReady = deferred();
  const replacementRequested = deferred();
  const firstPresentationScreenApplied = deferred();
  const firstUnsettledAcknowledgement = deferred();
  const releaseFirstUnsettledAcknowledgement = deferred();
  let screenPostCount = 0;
  let screenshotFetchCount = 0;
  let settleRequestCount = 0;
  let settleSleepCount = 0;
  const fetchImpl = createFetchMock({
    screenConfigurations: [
      { width: 412, height: 915, rate: 30 },
      { width: 915, height: 412, rate: 30 },
    ],
    baselineScreen: { width: 1440, height: 900, rate: 30 },
  });
  const originalFetch = fetchImpl;
  const oscillatingFetch = async (url, request = {}) => {
    if (url.endsWith('/api/room/screen/cast.jpg')) {
      screenshotFetchCount += 1;
      screenshotRequested.resolve();
      if (screenshotFetchCount === 1) return await screenshotReady.promise;
      replacementRequested.resolve();
      return frameResponse();
    }
    if (isNekoRequest(url, request, '/api/room/screen', 'POST')) {
      screenPostCount += 1;
      if (screenPostCount === 2) firstPresentationScreenApplied.resolve();
    }
    if (url.includes('/pdpp/window-settle')) {
      settleRequestCount += 1;
      const requested = new URL(url);
      const settled = settleRequestCount !== 2 && settleRequestCount !== 4;
      if (!settled && settleRequestCount === 2) firstUnsettledAcknowledgement.resolve();
      return jsonResponse({
        settled,
        width: Number(requested.searchParams.get('width')),
        height: Number(requested.searchParams.get('height')),
      });
    }
    return originalFetch(url, request);
  };
  oscillatingFetch.requests = fetchImpl.requests;
  const companion = createNekoCompanion({
    origin: 'http://neko.local/',
    fetchImpl: oscillatingFetch,
    pollIntervalMs: 1,
    screenEndpoint: 'api/room/screen',
    screenConfigurationsEndpoint: 'api/room/screen/configurations',
    sleep(ms, signal) {
      if (ms === 50) {
        settleSleepCount += 1;
        return settleSleepCount === 1 ? releaseFirstUnsettledAcknowledgement.promise : Promise.resolve();
      }
      return new Promise((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener('abort', resolve, { once: true });
      });
    },
    stealthMode: 'strict',
    windowSettleEndpoint: 'http://cdp.local/pdpp/window-settle',
    windowSettlePollIntervalMs: 50,
  });
  const frames = [];
  companion.onFrame((frame) => frames.push(frame));

  try {
    await companion.start({ width: 412, height: 915, screenWidth: 412, screenHeight: 915 });
    await screenshotRequested.promise;

    const rotate = companion.dispatch({ type: 'viewport', width: 915, height: 412, screenWidth: 915, screenHeight: 412 });
    await firstPresentationScreenApplied.promise;
    await new Promise((resolve) => setImmediate(resolve));
    if (settleRequestCount > 0) await firstUnsettledAcknowledgement.promise;

    const returnToPortrait = companion.dispatch({ type: 'viewport', width: 412, height: 915, screenWidth: 412, screenHeight: 915 });
    screenshotReady.resolve(frameResponse());
    releaseFirstUnsettledAcknowledgement.resolve();
    await Promise.all([rotate, returnToPortrait]);
    await replacementRequested.promise;
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(frames.length, 1, 'the replacement frame must be promoted after the latest acknowledgement settles');
    assert.equal(
      screenshotFetchCount,
      2,
      'a stale frame is replaced immediately instead of waiting for the next poll',
    );
  } finally {
    screenshotReady.resolve(frameResponse());
    releaseFirstUnsettledAcknowledgement.resolve();
    await companion.stop();
  }
});

test('n.eko coalesces bounded phone presentation churn into one frame replacement', async () => {
  const CHURN_CYCLES = 8;
  const screenshotRequested = deferred();
  const screenshotReady = deferred();
  let screenshotFetchCount = 0;
  const fetchImpl = createFetchMock({
    screenConfigurations: [
      { width: 412, height: 915, rate: 30 },
      { width: 915, height: 412, rate: 30 },
    ],
    baselineScreen: { width: 1440, height: 900, rate: 30 },
  });
  const originalFetch = fetchImpl;
  const churnFetch = async (url, request = {}) => {
    if (url.endsWith('/api/room/screen/cast.jpg')) {
      screenshotFetchCount += 1;
      if (screenshotFetchCount === 1) {
        screenshotRequested.resolve();
        return await screenshotReady.promise;
      }
      return frameResponse();
    }
    if (url.includes('/pdpp/window-settle')) {
      const requested = new URL(url);
      return jsonResponse({
        settled: true,
        width: Number(requested.searchParams.get('width')),
        height: Number(requested.searchParams.get('height')),
      });
    }
    return originalFetch(url, request);
  };
  churnFetch.requests = fetchImpl.requests;
  const companion = createNekoCompanion({
    origin: 'http://neko.local/',
    fetchImpl: churnFetch,
    pollIntervalMs: 1,
    screenEndpoint: 'api/room/screen',
    screenConfigurationsEndpoint: 'api/room/screen/configurations',
    sleep(ms, signal) {
      if (ms === 50) return Promise.resolve();
      return new Promise((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener('abort', resolve, { once: true });
      });
    },
    stealthMode: 'strict',
    windowSettleEndpoint: 'http://cdp.local/pdpp/window-settle',
    windowSettlePollIntervalMs: 50,
  });
  const frames = [];
  companion.onFrame((frame) => frames.push(frame));

  try {
    await companion.start({ width: 412, height: 915, screenWidth: 412, screenHeight: 915 });
    await screenshotRequested.promise;

    for (let cycle = 0; cycle < CHURN_CYCLES; cycle += 1) {
      const landscape = cycle % 2 === 0;
      await companion.dispatch({
        type: 'viewport',
        width: landscape ? 915 : 412,
        height: landscape ? 412 : 915,
        screenWidth: landscape ? 915 : 412,
        screenHeight: landscape ? 412 : 915,
      });
    }

    screenshotReady.resolve(frameResponse());
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(frames.length, 1, 'the newest settled presentation receives a frame');
    assert.equal(screenshotFetchCount, 2, 'one stale frame receives exactly one immediate replacement, independent of churn');
  } finally {
    screenshotReady.resolve(frameResponse());
    await companion.stop();
  }
});

test('n.eko status reapplies browser-client viewport when page dimensions mismatch', async () => {
  const browserClient = createFakeBrowserClient({
    statuses: [
      { innerWidth: 800, innerHeight: 600, screenWidth: 800, screenHeight: 600 },
      { innerWidth: 947, innerHeight: 364, screenWidth: 2128, screenHeight: 816 },
    ],
  });
  const companion = createCompanionWithBrowserClient(browserClient, {
    stealthMode: 'assistive',
  });

  await companion.start(landscapeViewport);
  const setViewportCountBeforeStatus = browserClient.calls.filter((call) => call.op === 'setViewportSize').length;
  const status = await companion.queryNekoStatus();
  await companion.stop();

  const setViewportCalls = browserClient.calls.filter((call) => call.op === 'setViewportSize');
  assert.equal(setViewportCountBeforeStatus, 1);
  assert.equal(setViewportCalls.length, 2);
  assert.equal(status.page_metrics_reapplied, true);
  assert.equal(status.page.innerWidth, 947);
  assert.ok(status.page_metrics_mismatch.innerWidth);
});

test('n.eko status ignores stale touch, DPR, screen, and UA values the adapter no longer owns', async () => {
  const browserClient = createFakeBrowserClient({
    statuses: [
      {
        innerWidth: 2128,
        innerHeight: 816,
        screenWidth: 999,
        screenHeight: 777,
        devicePixelRatio: 3,
        hasTouch: true,
        maxTouchPoints: 10,
        userAgent: 'Unexpected UA',
      },
    ],
  });
  const companion = createCompanionWithBrowserClient(browserClient, {
    stealthMode: 'assistive',
  });

  await companion.start({
    width: 1117,
    height: 1123,
    deviceScaleFactor: 1.15,
    hasTouch: false,
    mobile: false,
  });
  const setViewportCountBeforeStatus = browserClient.calls.filter((call) => call.op === 'setViewportSize').length;
  const status = await companion.queryNekoStatus();
  await companion.stop();

  const setViewportCountAfterStatus = browserClient.calls.filter((call) => call.op === 'setViewportSize').length;
  assert.equal(status.page_metrics_reapplied, undefined);
  assert.equal(status.page_metrics_mismatch, undefined);
  assert.equal(setViewportCountAfterStatus, setViewportCountBeforeStatus);
});

test('n.eko focus, paste, copy, and playground status route through the browser-client seam', async () => {
  const samplePlaygroundEvents = [
    {
      seq: 1,
      type: 'pointerdown',
      atMs: 1_700_000_000_000,
      clientX: 70,
      clientY: 233,
      target: { id: 'counter', tag: 'button' },
    },
  ];
  const browserClient = createFakeBrowserClient({
    copyText: 'remote selection',
    statuses: [
      {
        innerWidth: 947,
        innerHeight: 364,
        screenWidth: 2128,
        screenHeight: 816,
        playgroundEvents: samplePlaygroundEvents,
      },
    ],
  });
  const companion = createCompanionWithBrowserClient(browserClient, {
    stealthMode: 'assistive',
  });
  const events = [];
  companion.onEvent((event) => events.push(event));

  await companion.start(landscapeViewport);
  browserClient.emitFocus({ type: 'focus', tagName: 'INPUT', id: 'otp' });
  await companion.dispatch({ type: 'paste', text: 'one-time code 123456' });
  await companion.dispatch({ type: 'copy' });
  const status = await companion.queryNekoStatus();
  await companion.stop();

  assert.ok(events.some((event) => event.kind === 'keyboard_focus' && event.focused === true));
  assert.ok(events.some((event) => event.kind === 'clipboard' && event.text === 'remote selection'));
  assert.ok(browserClient.calls.some((call) => call.op === 'insertText' && call.text === 'one-time code 123456'));
  assert.deepEqual(status.page.playgroundEvents, samplePlaygroundEvents);
});

test('n.eko adapter source does not contain forbidden raw helper commands', async () => {
  const source = await readFile(new URL('./neko-adapter.js', import.meta.url), 'utf8');
  const forbidden = [
    ['Runtime', 'enable'],
    ['Runtime', 'addBinding'],
    ['Page', 'addScriptToEvaluateOnNewDocument'],
    ['Browser', 'setWindowBounds'],
    ['Emulation', 'setUserAgentOverride'],
    ['Emulation', 'setDeviceMetricsOverride'],
    ['Emulation', 'setTouchEmulationEnabled'],
    ['Emulation', 'setEmitTouchEventsForMouse'],
  ].map(([domain, method]) => `${domain}.${method}`);

  for (const command of forbidden) {
    assert.equal(source.includes(command), false, `${command} must not be sent by the n.eko adapter`);
  }
});

test('buildViewportStatusExpression drains __pdppPlaygroundEvents and includes screenWidth', async () => {
  const adapterSource = await readFile(new URL('./neko-adapter.js', import.meta.url), 'utf8');
  assert.match(adapterSource, /__pdppPlaygroundEvents/, 'adapter drains __pdppPlaygroundEvents');
  assert.match(adapterSource, /playgroundEvents:\s*drained/, 'drained events surface as playgroundEvents');
  assert.match(adapterSource, /screenWidth:\s*window\.screen/, 'expression still reports window.screen.width');
});
