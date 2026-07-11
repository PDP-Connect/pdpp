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

function isNekoRequest(url, request, path, method) {
  return url.endsWith(path) && request.method === method;
}

function responseForNekoRequest(url, request, screenConfigurations) {
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
      response: () => jsonResponse({ width: 2128, height: 816 }),
    },
    {
      matches: () => url.endsWith('/api/room/screen/cast.jpg') || url.endsWith('/api/room/screen/shot.jpg'),
      response: frameResponse,
    },
  ];
  return routes.find((route) => route.matches())?.response() || jsonResponse({});
}

function createFetchMock({ screenConfigurations = [{ width: 2128, height: 816, rate: 30 }] } = {}) {
  const requests = [];
  const fetchImpl = async (url, request = {}) => {
    requests.push({ body: request.body || null, method: request.method || 'GET', url });
    return responseForNekoRequest(url, request, screenConfigurations);
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
