import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import {
  buildCopySelectionExpression,
  createDefaultStreamingCompanionFactory,
  createNekoCompanion,
} from '../server/streaming/neko-adapter.js';
import {
  createDefaultStreamingCompanionFactory as createStreamingBackendCompanionFactory,
} from '../server/streaming/companion-factory.ts';

function makeResponse({ status = 200, body = '', headers = {}, json } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const bodyBytes = Buffer.from(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return headerMap.get(String(name).toLowerCase()) || null;
      },
      getSetCookie() {
        const value = headerMap.get('set-cookie');
        return value ? [value] : [];
      },
    },
    async arrayBuffer() {
      return bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength);
    },
    async json() {
      if (json !== undefined) return json;
      throw new Error('no json body');
    },
  };
}

function makeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const route = routes.find((candidate) => {
      if (candidate.method && candidate.method !== init.method) return false;
      return typeof candidate.url === 'string' ? url === candidate.url : candidate.url.test(url);
    });
    if (!route) throw new Error(`unexpected fetch: ${init.method || 'GET'} ${url}`);
    return typeof route.response === 'function' ? route.response({ url, init, calls }) : route.response;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function evaluateCopySelectionExpression(document) {
  return runInNewContext(buildCopySelectionExpression(), { document });
}

test('n.eko copy selection expression reads active text-input selections', () => {
  assert.equal(
    evaluateCopySelectionExpression({
      activeElement: {
        selectionEnd: 12,
        selectionStart: 6,
        tagName: 'INPUT',
        type: 'text',
        value: 'hello remote',
      },
      getSelection: () => ({ toString: () => '' }),
    }),
    'remote',
  );
});

test('n.eko copy selection expression falls back to page selections and excludes passwords', () => {
  assert.equal(
    evaluateCopySelectionExpression({
      activeElement: {
        selectionEnd: 11,
        selectionStart: 0,
        tagName: 'INPUT',
        type: 'password',
        value: 'supersecret',
      },
      getSelection: () => ({ toString: () => '' }),
    }),
    '',
  );
  assert.equal(
    evaluateCopySelectionExpression({
      activeElement: { tagName: 'BODY' },
      getSelection: () => ({ toString: () => 'page selection' }),
    }),
    'page selection',
  );
});

function makeAbortableSleep() {
  const calls = [];
  const sleep = (ms, signal) =>
    new Promise((resolve) => {
      calls.push({ ms, signal });
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener('abort', resolve, { once: true });
    });
  sleep.calls = calls;
  return sleep;
}

async function waitFor(predicate) {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.ok(predicate(), 'condition was not met');
}

function makeFakeBrowserClient({ copyText = 'copied remote text', statuses = [] } = {}) {
  const calls = [];
  const bindings = new Map();
  const client = {
    calls,
    async connect() {
      calls.push({ op: 'connect' });
      return client;
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
      const expression = String(source || '');
      if (expression.includes('selectionStart') && expression.includes('document.getSelection')) {
        return copyText;
      }
      if (expression.includes('__pdppPlaygroundEvents') || expression.includes('screenWidth')) {
        const next = statuses.length > 0 ? statuses.shift() : {};
        return JSON.stringify(next);
      }
      return undefined;
    },
    keyboard: {
      async insertText(text) {
        calls.push({ op: 'insertText', text });
      },
    },
    emitBinding(name, payload) {
      const handler = bindings.get(name);
      assert.equal(typeof handler, 'function', `missing binding ${name}`);
      handler({}, JSON.stringify(payload));
    },
    async close() {
      calls.push({ op: 'close' });
    },
  };
  return client;
}

test('n.eko adapter logs in, applies configured viewport endpoint, and emits base64 JPEG frames', async () => {
  const jpeg = 'jpeg-frame-1';
  const fetchImpl = makeFetch([
    {
      method: 'POST',
      url: 'https://neko.test/api/login',
      response: makeResponse({ headers: { 'set-cookie': 'NEKO_SESSION=session-1; Path=/; HttpOnly' } }),
    },
    {
      method: 'POST',
      url: 'https://neko.test/api/room/screen',
      response: makeResponse({ status: 204 }),
    },
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/cast.jpg',
      response: makeResponse({ body: jpeg }),
    },
  ]);
  const sleep = makeAbortableSleep();
  const companion = createNekoCompanion({
    origin: 'https://neko.test',
    username: 'operator',
    password: 'secret',
    browser_session_id: 'bs_neko_1',
    fetchImpl,
    sleep,
    now: () => 1234,
    screenEndpoint: '/api/room/screen',
  });
  const frames = [];

  assert.equal(companion.backend, 'neko');
  assert.equal(companion.browser_session_id, 'bs_neko_1');
  companion.onFrame((frame) => frames.push(frame));

  await companion.start({ width: 800, height: 600, deviceScaleFactor: 2 });
  await waitFor(() => frames.length === 1);

  assert.equal(frames[0].sessionId, 1);
  assert.equal(frames[0].data, Buffer.from(jpeg).toString('base64'));
  assert.deepEqual(frames[0].metadata, {
    device_width: 800,
    device_height: 600,
    offset_top: 0,
    page_scale_factor: 2,
    timestamp: 1234,
    scroll_offset_x: 0,
    scroll_offset_y: 0,
  });

  const login = fetchImpl.calls.find((call) => call.url.endsWith('/api/login'));
  assert.equal(login.init.method, 'POST');
  assert.deepEqual(JSON.parse(login.init.body), { username: 'operator', password: 'secret' });

  const viewport = fetchImpl.calls.find((call) => call.url.endsWith('/api/room/screen'));
  assert.equal(viewport.init.method, 'POST');
  assert.deepEqual(JSON.parse(viewport.init.body), {
    width: 800,
    height: 600,
    screen: '800x600@30',
    deviceScaleFactor: 2,
  });

  const screenshot = fetchImpl.calls.find((call) => call.url.endsWith('/cast.jpg'));
  assert.equal(screenshot.init.headers.Cookie, 'NEKO_SESSION=session-1');
  assert.equal(sleep.calls[0].ms, 250);

  await companion.stop();
  assert.equal(companion._internal.isClosed(), true);
});

test('n.eko adapter logs in with an empty body for noauth n.eko providers', async () => {
  const jpeg = 'jpeg-noauth';
  const fetchImpl = makeFetch([
    {
      method: 'POST',
      url: 'https://neko.test/api/login',
      response: makeResponse({ json: { token: 'noauth-token' } }),
    },
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/cast.jpg',
      response: makeResponse({ body: jpeg }),
    },
  ]);
  const companion = createNekoCompanion({
    origin: 'https://neko.test',
    fetchImpl,
    sleep: makeAbortableSleep(),
  });
  const frames = [];
  companion.onFrame((frame) => frames.push(frame));

  await companion.start();
  await waitFor(() => frames.length === 1);

  const login = fetchImpl.calls.find((call) => call.url.endsWith('/api/login'));
  assert.equal(login.init.method, 'POST');
  assert.deepEqual(JSON.parse(login.init.body), {});
  assert.equal(fetchImpl.calls.find((call) => call.url.endsWith('/cast.jpg')).init.headers.Authorization, 'Bearer noauth-token');
  assert.equal(frames[0].data, Buffer.from(jpeg).toString('base64'));

  await companion.stop();
});

test('n.eko adapter prefers control/admin credentials from env over viewer credentials', async () => {
  const fetchImpl = makeFetch([
    {
      method: 'POST',
      url: 'https://neko.test/api/login',
      response: makeResponse({ headers: { 'set-cookie': 'NEKO_SESSION=admin-session; Path=/; HttpOnly' } }),
    },
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/cast.jpg',
      response: makeResponse({ body: 'jpeg-admin' }),
    },
  ]);
  const companion = createNekoCompanion({
    origin: 'https://neko.test',
    env: {
      NEKO_USERNAME: 'operator',
      NEKO_PASSWORD: 'viewer-pass',
      NEKO_CONTROL_USERNAME: 'admin',
      NEKO_CONTROL_PASSWORD: 'admin-pass',
    },
    fetchImpl,
    sleep: makeAbortableSleep(),
  });

  await companion.start();
  await waitFor(() => fetchImpl.calls.length === 2);

  const login = fetchImpl.calls.find((call) => call.url.endsWith('/api/login'));
  assert.deepEqual(JSON.parse(login.init.body), { username: 'admin', password: 'admin-pass' });

  await companion.stop();
});

test('n.eko adapter frame metadata follows the applied desktop screen preset', async () => {
  const jpeg = 'jpeg-frame-desktop';
  const fetchImpl = makeFetch([
    {
      method: 'POST',
      url: 'https://neko.test/api/login',
      response: makeResponse({ headers: { 'set-cookie': 'NEKO_SESSION=session-1; Path=/; HttpOnly' } }),
    },
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/configurations',
      response: makeResponse({
        json: [
          { width: 1280, height: 1024, rate: 30 },
          { width: 1600, height: 1200, rate: 30 },
        ],
      }),
    },
    {
      method: 'POST',
      url: 'https://neko.test/api/room/screen',
      response: makeResponse({ json: { width: 1280, height: 1024, rate: 30 } }),
    },
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/cast.jpg',
      response: makeResponse({ body: jpeg }),
    },
  ]);
  const sleep = makeAbortableSleep();
  const companion = createNekoCompanion({
    origin: 'https://neko.test',
    username: 'operator',
    password: 'secret',
    fetchImpl,
    sleep,
    now: () => 4321,
    screenConfigurationsEndpoint: '/api/room/screen/configurations',
    screenEndpoint: '/api/room/screen',
  });
  const frames = [];
  companion.onFrame((frame) => frames.push(frame));

  await companion.start({ width: 1117, height: 1123, deviceScaleFactor: 1.15 });
  await waitFor(() => frames.length === 1);

  const screenPost = fetchImpl.calls.find((call) => call.url === 'https://neko.test/api/room/screen');
  assert.deepEqual(JSON.parse(screenPost.init.body), { width: 1280, height: 1024, rate: 30 });
  assert.deepEqual(frames[0].metadata, {
    device_width: 1280,
    device_height: 1024,
    offset_top: 0,
    page_scale_factor: 1.15,
    timestamp: 4321,
    scroll_offset_x: 0,
    scroll_offset_y: 0,
  });

  await companion.stop();
});

test('n.eko adapter uses bearer auth and falls back from screencast to screenshot endpoint', async () => {
  const jpeg = 'fallback-jpeg';
  const fetchImpl = makeFetch([
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/cast.jpg',
      response: makeResponse({ status: 400 }),
    },
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/shot.jpg',
      response: makeResponse({ body: jpeg }),
    },
  ]);
  const companion = createNekoCompanion({
    origin: 'https://neko.test',
    bearerToken: 'token-1',
    fetchImpl,
    sleep: makeAbortableSleep(),
  });
  const frames = [];
  companion.onFrame((frame) => frames.push(frame));

  await companion.start();
  await waitFor(() => frames.length === 1);

  assert.equal(frames[0].data, Buffer.from(jpeg).toString('base64'));
  assert.equal(fetchImpl.calls.some((call) => call.url.endsWith('/api/login')), false);
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer token-1');
  assert.equal(fetchImpl.calls[1].init.headers.Authorization, 'Bearer token-1');

  await companion.stop();
});

test('n.eko adapter keeps default API paths under a configured path prefix', async () => {
  const fetchImpl = makeFetch([
    {
      method: 'GET',
      url: 'https://neko.test/neko/api/room/screen/cast.jpg',
      response: makeResponse({ body: 'prefixed-jpeg' }),
    },
  ]);
  const companion = createNekoCompanion({
    origin: 'https://neko.test/neko',
    bearerToken: 'token-1',
    fetchImpl,
    sleep: makeAbortableSleep(),
  });

  await companion.start();
  await waitFor(() => fetchImpl.calls.length === 1);

  assert.equal(fetchImpl.calls[0].url, 'https://neko.test/neko/api/room/screen/cast.jpg');

  await companion.stop();
});

test('n.eko adapter dispatch posts input only when an endpoint is configured and ackFrame is a no-op', async () => {
  const fetchImpl = makeFetch([
    {
      method: 'POST',
      url: 'https://neko.test/api/input',
      response: makeResponse({ status: 204 }),
    },
    {
      method: 'POST',
      url: 'https://neko.test/api/viewport',
      response: makeResponse({ status: 204 }),
    },
  ]);
  const companion = createNekoCompanion({
    origin: 'https://neko.test',
    bearerToken: 'token-2',
    fetchImpl,
    inputEndpoint: '/api/input',
    viewportEndpoint: '/api/viewport',
  });
  const offEvent = companion.onEvent(() => {
    throw new Error('n.eko adapter should not emit out-of-band events yet');
  });
  offEvent();

  await companion.dispatch({ type: 'mouse', action: 'click', x: 1, y: 2 });
  await companion.dispatch({ type: 'viewport', width: 390, height: 844, mobile: true });
  await companion.ackFrame(123);

  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[0].url, 'https://neko.test/api/input');
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { type: 'mouse', action: 'click', x: 1, y: 2 });
  assert.equal(fetchImpl.calls[1].url, 'https://neko.test/api/viewport');
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].init.body), {
    width: 390,
    height: 844,
    screen: '390x844@30',
    mobile: true,
  });
});

test('n.eko adapter applies RBS-style viewport, paste, and copy control through the browser client', async () => {
  const fetchImpl = makeFetch([
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/configurations',
      response: makeResponse({
        json: [
          { width: 390, height: 844, rate: 30 },
          { width: 392, height: 844, rate: 30 },
          { width: 400, height: 844, rate: 30 },
          { width: 1280, height: 720, rate: 30 },
        ],
      }),
    },
    {
      method: 'POST',
      url: 'https://neko.test/api/room/screen',
      response: makeResponse({ json: { width: 392, height: 844, rate: 30 } }),
    },
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen',
      response: makeResponse({ json: { width: 392, height: 844, rate: 30 } }),
    },
  ]);
  const browserClient = makeFakeBrowserClient({
    statuses: [
      {
        innerWidth: 392,
        innerHeight: 844,
        screenWidth: 392,
        screenHeight: 844,
        devicePixelRatio: 3,
        userAgent: 'Mobile Safari test UA',
        hasTouch: true,
      },
    ],
  });
  const companion = createNekoCompanion({
    origin: 'https://neko.test',
    bearerToken: 'token-3',
    fetchImpl,
    sleep: async () => {},
    browserClient,
    cdpHttpUrl: 'http://127.0.0.1:9222',
    screenConfigurationsEndpoint: '/api/room/screen/configurations',
    screenEndpoint: '/api/room/screen',
    stealthMode: 'assistive',
  });
  const events = [];
  companion.onEvent((event) => events.push(event));

  await companion.dispatch({
    type: 'viewport',
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
    userAgent: 'Mobile Safari test UA',
  });
  await companion.dispatch({ type: 'paste', text: 'one-time code 123456' });
  await companion.dispatch({ type: 'copy' });
  const status = await companion.queryNekoStatus();

  const screenPost = fetchImpl.calls.find((call) => call.url === 'https://neko.test/api/room/screen');
  assert.deepEqual(JSON.parse(screenPost.init.body), { width: 392, height: 844, rate: 30 });

  assert.ok(browserClient.calls.some((call) => call.op === 'connect'));
  assert.ok(
    browserClient.calls.some(
      (call) => call.op === 'setViewportSize' && call.viewport.width === 392 && call.viewport.height === 844,
    ),
  );
  assert.ok(browserClient.calls.some((call) => call.op === 'insertText' && call.text === 'one-time code 123456'));
  assert.ok(
    browserClient.calls.some(
      (call) =>
        call.op === 'evaluate' &&
        call.source.includes('selectionStart') &&
        call.source.includes('document.getSelection'),
    ),
  );
  assert.deepEqual(events.filter((event) => event.kind === 'clipboard'), [
    { kind: 'clipboard', text: 'copied remote text' },
  ]);
  assert.deepEqual(status, {
    screen: { width: 392, height: 844, rate: 30 },
    window_skipped: {
      browser_owner_mode: 'neko-owned',
      stealth_mode: 'assistive',
    },
    page_cdp_available: true,
    page: {
      innerWidth: 392,
      innerHeight: 844,
      screenWidth: 392,
      screenHeight: 844,
      devicePixelRatio: 3,
      userAgent: 'Mobile Safari test UA',
      hasTouch: true,
    },
  });

  await companion.stop();
});

test('n.eko adapter keeps CSS viewport separate from high-DPR screen capture dimensions', async () => {
  const fetchImpl = makeFetch([
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/configurations',
      response: makeResponse({
        json: [
          { width: 500, height: 915, rate: 29 },
          { width: 448, height: 916, rate: 30 },
          { width: 1008, height: 1840, rate: 30 },
          { width: 1080, height: 1920, rate: 30 },
          { width: 1280, height: 720, rate: 30 },
        ],
      }),
    },
    {
      method: 'POST',
      url: 'https://neko.test/api/room/screen',
      response: makeResponse({ json: { width: 1008, height: 1840, rate: 30 } }),
    },
  ]);
  const browserClient = makeFakeBrowserClient();
  const companion = createNekoCompanion({
    origin: 'https://neko.test',
    bearerToken: 'token-hidpi',
    fetchImpl,
    sleep: async () => {},
    browserClient,
    cdpHttpUrl: 'http://127.0.0.1:9222',
    screenConfigurationsEndpoint: '/api/room/screen/configurations',
    screenEndpoint: '/api/room/screen',
    stealthMode: 'assistive',
  });

  await companion.dispatch({
    type: 'viewport',
    width: 448,
    height: 819,
    screenWidth: 1008,
    screenHeight: 1840,
    deviceScaleFactor: 2.25,
    mobile: true,
    hasTouch: true,
  });

  const screenPost = fetchImpl.calls.find((call) => call.url === 'https://neko.test/api/room/screen');
  assert.deepEqual(JSON.parse(screenPost.init.body), { width: 1008, height: 1840, rate: 30 });

  assert.ok(browserClient.calls.some((call) => call.op === 'setViewportSize'));
  assert.deepEqual(browserClient.calls.find((call) => call.op === 'setViewportSize').viewport, {
    width: 448,
    height: 819,
  });

  await companion.stop();
});

test('n.eko adapter selects exact Android visible-height portrait capture when exposed', async () => {
  const fetchImpl = makeFetch([
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/configurations',
      response: makeResponse({
        json: [
          { width: 1080, height: 1920, rate: 30 },
          { width: 1008, height: 1736, rate: 30 },
          { width: 1008, height: 1840, rate: 30 },
          { width: 904, height: 2000, rate: 30 },
        ],
      }),
    },
    {
      method: 'POST',
      url: 'https://neko.test/api/room/screen',
      response: ({ init }) => makeResponse({ json: JSON.parse(init.body) }),
    },
  ]);
  const companion = createNekoCompanion({
    origin: 'https://neko.test',
    bearerToken: 'token-visible-height',
    fetchImpl,
    screenConfigurationsEndpoint: '/api/room/screen/configurations',
    screenEndpoint: '/api/room/screen',
  });

  await companion.dispatch({
    type: 'viewport',
    width: 448,
    height: 771,
    screenWidth: 1008,
    screenHeight: 1736,
    deviceScaleFactor: 2.25,
    mobile: true,
    hasTouch: true,
  });

  const screenPost = fetchImpl.calls.find((call) => call.url === 'https://neko.test/api/room/screen');
  assert.ok(screenPost, 'expected POST to /api/room/screen');
  assert.deepEqual(JSON.parse(screenPost.init.body), { width: 1008, height: 1736, rate: 30 });

  await companion.stop();
});

test('n.eko adapter passes the configured CDP HTTP URL to the browser-client factory', async () => {
  const fetchImpl = makeFetch([
    {
      method: 'POST',
      url: 'https://neko.test/api/login',
      response: makeResponse({ json: { token: 'noauth-token' } }),
    },
  ]);
  const browserClient = makeFakeBrowserClient();
  const factoryCalls = [];
  const companion = createNekoCompanion({
    origin: 'https://neko.test',
    fetchImpl,
    sleep: async () => {},
    createBrowserClient(args) {
      factoryCalls.push(args);
      return browserClient;
    },
    cdpHttpUrl: 'http://neko:9223',
    stealthMode: 'assistive',
  });

  await companion.dispatch({ type: 'viewport', width: 800, height: 600, deviceScaleFactor: 1 });

  assert.equal(factoryCalls.length, 1);
  assert.equal(factoryCalls[0].cdpHttpUrl, 'http://neko:9223/');
  assert.deepEqual(browserClient.calls.find((call) => call.op === 'setViewportSize').viewport, {
    width: 800,
    height: 600,
  });

  await companion.stop();
});

test('n.eko adapter prefers the least-cropped landscape screen preset', async () => {
  const fetchImpl = makeFetch([
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/configurations',
      response: makeResponse({
        json: [
          { width: 960, height: 540, rate: 60 },
          { width: 936, height: 432, rate: 29 },
          { width: 920, height: 412, rate: 29 },
        ],
      }),
    },
    {
      method: 'POST',
      url: 'https://neko.test/api/room/screen',
      response: makeResponse({ json: { width: 936, height: 432, rate: 29 } }),
    },
  ]);
  const companion = createNekoCompanion({
    origin: 'https://neko.test',
    bearerToken: 'token-4',
    fetchImpl,
    screenConfigurationsEndpoint: '/api/room/screen/configurations',
    screenEndpoint: '/api/room/screen',
  });

  await companion.dispatch({ type: 'viewport', width: 916, height: 448, mobile: true, hasTouch: true });

  const screenPost = fetchImpl.calls.find((call) => call.url === 'https://neko.test/api/room/screen');
  assert.deepEqual(JSON.parse(screenPost.init.body), { width: 936, height: 432, rate: 29 });
});

test('n.eko adapter selects a high-DPR shallow landscape preset for Android landscape capture (regression: 920x412 fallback)', async () => {
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
      method: 'GET',
      url: 'https://neko.test/api/room/screen/configurations',
      response: makeResponse({
        json: [
          // Legacy landscape modes that previously won this race.
          { width: 920, height: 412, rate: 30 },
          { width: 936, height: 432, rate: 30 },
          { width: 1280, height: 720, rate: 30 },
          { width: 1920, height: 1080, rate: 30 },
          // Newly exposed shallow high-DPR landscape modes.
          { width: 1840, height: 704, rate: 30 },
          { width: 1920, height: 736, rate: 30 },
          { width: 2000, height: 768, rate: 30 },
          { width: 2112, height: 816, rate: 30 },
          { width: 2128, height: 816, rate: 30 },
          { width: 2176, height: 832, rate: 30 },
          { width: 2208, height: 848, rate: 30 },
          // Portrait decoys to confirm orientation-correct selection.
          { width: 1080, height: 1920, rate: 30 },
          { width: 1008, height: 2176, rate: 30 },
        ],
      }),
    },
    {
      method: 'POST',
      url: 'https://neko.test/api/room/screen',
      response: ({ init }) => makeResponse({ json: JSON.parse(init.body) }),
    },
  ]);
  const companion = createNekoCompanion({
    origin: 'https://neko.test',
    bearerToken: 'token-landscape-dpr',
    fetchImpl,
    screenConfigurationsEndpoint: '/api/room/screen/configurations',
    screenEndpoint: '/api/room/screen',
  });

  await companion.dispatch({
    type: 'viewport',
    width: 947,
    height: 364,
    screenWidth: 2128,
    screenHeight: 816,
    deviceScaleFactor: 2.25,
    mobile: true,
    hasTouch: true,
  });

  const screenPost = fetchImpl.calls.find((call) => call.url === 'https://neko.test/api/room/screen');
  assert.ok(screenPost, 'expected POST to /api/room/screen');
  const applied = JSON.parse(screenPost.init.body);
  assert.deepEqual(
    applied,
    { width: 2128, height: 816, rate: 30 },
    `expected 2128x816 preset, got ${JSON.stringify(applied)}`,
  );
  assert.notDeepStrictEqual(
    applied,
    { width: 920, height: 412, rate: 30 },
    'must not fall back to 920x412 landscape preset',
  );
  assert.notEqual(applied.width, 920, 'must not fall back to 920-wide landscape preset');
});

test('n.eko adapter selects near-exact 1x portrait preset for native n.eko input alignment', async () => {
  const fetchImpl = makeFetch([
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/configurations',
      response: makeResponse({
        json: [
          { width: 448, height: 916, rate: 30 },
          { width: 496, height: 915, rate: 30 },
          { width: 500, height: 915, rate: 30 },
          { width: 448, height: 820, rate: 30 },
          { width: 1080, height: 1920, rate: 30 },
        ],
      }),
    },
    {
      method: 'POST',
      url: 'https://neko.test/api/room/screen',
      response: ({ init }) => makeResponse({ json: JSON.parse(init.body) }),
    },
  ]);
  const companion = createNekoCompanion({
    origin: 'https://neko.test',
    bearerToken: 'token-native-portrait',
    fetchImpl,
    screenConfigurationsEndpoint: '/api/room/screen/configurations',
    screenEndpoint: '/api/room/screen',
  });

  await companion.dispatch({
    type: 'viewport',
    width: 448,
    height: 819,
    screenWidth: 448,
    screenHeight: 819,
    deviceScaleFactor: 1,
    mobile: true,
    hasTouch: true,
  });

  const screenPost = fetchImpl.calls.find((call) => call.url === 'https://neko.test/api/room/screen');
  assert.ok(screenPost, 'expected POST to /api/room/screen');
  const applied = JSON.parse(screenPost.init.body);
  assert.deepEqual(applied, { width: 448, height: 820, rate: 30 });
});

test('n.eko adapter emits explicit screen-configuration telemetry for mobile viewport updates', async () => {
  const fetchImpl = makeFetch([
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/configurations',
      response: makeResponse({
        json: [
          { width: 1440, height: 900, rate: 30 },
          { width: 448, height: 820, rate: 30 },
        ],
      }),
    },
    {
      method: 'POST',
      url: 'https://neko.test/api/room/screen',
      response: ({ init }) => makeResponse({ json: JSON.parse(init.body) }),
    },
  ]);
  const companion = createNekoCompanion({
    origin: 'https://neko.test',
    bearerToken: 'token-mobile-telemetry',
    fetchImpl,
    screenConfigurationsEndpoint: '/api/room/screen/configurations',
    screenEndpoint: '/api/room/screen',
  });
  const events = [];
  companion.onEvent((event) => events.push(event));

  await companion.dispatch({
    type: 'viewport',
    width: 448,
    height: 819,
    screenWidth: 448,
    screenHeight: 819,
    deviceScaleFactor: 1,
    mobile: true,
    hasTouch: true,
  });

  assert.deepEqual(JSON.parse(fetchImpl.calls.find((call) => call.url === 'https://neko.test/api/room/screen').init.body), {
    width: 448,
    height: 820,
    rate: 30,
  });
  assert.deepEqual(events, [
    {
      kind: 'screen_configuration',
      requested: { width: 448, height: 819 },
      selected: { width: 448, height: 820, rate: 30 },
      applied: { width: 448, height: 820, rate: 30 },
    },
  ]);
});

test('n.eko adapter selects near-exact 1x landscape preset for native n.eko input alignment', async () => {
  const fetchImpl = makeFetch([
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/configurations',
      response: makeResponse({
        json: [
          { width: 920, height: 412, rate: 30 },
          { width: 936, height: 432, rate: 30 },
          { width: 952, height: 364, rate: 30 },
          { width: 1840, height: 704, rate: 30 },
          { width: 2128, height: 816, rate: 30 },
        ],
      }),
    },
    {
      method: 'POST',
      url: 'https://neko.test/api/room/screen',
      response: ({ init }) => makeResponse({ json: JSON.parse(init.body) }),
    },
  ]);
  const companion = createNekoCompanion({
    origin: 'https://neko.test',
    bearerToken: 'token-native-landscape',
    fetchImpl,
    screenConfigurationsEndpoint: '/api/room/screen/configurations',
    screenEndpoint: '/api/room/screen',
  });

  await companion.dispatch({
    type: 'viewport',
    width: 947,
    height: 364,
    screenWidth: 947,
    screenHeight: 364,
    deviceScaleFactor: 1,
    mobile: true,
    hasTouch: true,
  });

  const screenPost = fetchImpl.calls.find((call) => call.url === 'https://neko.test/api/room/screen');
  assert.ok(screenPost, 'expected POST to /api/room/screen');
  const applied = JSON.parse(screenPost.init.body);
  assert.deepEqual(applied, { width: 952, height: 364, rate: 30 });
});

test('n.eko adapter targets the actual capture-pixel paint surface so the X mode matches Emulation, not the larger fallback screen mode (regression: Brave Android white borders)', async () => {
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
      method: 'GET',
      url: 'https://neko.test/api/room/screen/configurations',
      response: makeResponse({
        json: [
          // Legacy modes the picker had to fall back to before the 1008x1736
          // modeline was exposed. 1080x1920 was the closest fitting cover.
          { width: 1080, height: 1920, rate: 30 },
          { width: 1280, height: 720, rate: 30 },
          { width: 1920, height: 1080, rate: 30 },
          // The exact paint-surface match. Picker must choose this one.
          { width: 1008, height: 1736, rate: 30 },
          // Other 1008-wide neighbours that could be confused for the match.
          { width: 1008, height: 1840, rate: 30 },
          { width: 1008, height: 2176, rate: 30 },
        ],
      }),
    },
    {
      method: 'POST',
      url: 'https://neko.test/api/room/screen',
      response: ({ init }) => makeResponse({ json: JSON.parse(init.body) }),
    },
  ]);
  const companion = createNekoCompanion({
    origin: 'https://neko.test',
    bearerToken: 'token-brave-portrait',
    fetchImpl,
    screenConfigurationsEndpoint: '/api/room/screen/configurations',
    screenEndpoint: '/api/room/screen',
  });

  await companion.dispatch({
    type: 'viewport',
    width: 448,
    height: 771,
    screenWidth: 1008,
    screenHeight: 1736,
    deviceScaleFactor: 2.25,
    mobile: true,
    hasTouch: true,
  });

  const screenPost = fetchImpl.calls.find((call) => call.url === 'https://neko.test/api/room/screen');
  assert.ok(screenPost, 'expected POST to /api/room/screen');
  const applied = JSON.parse(screenPost.init.body);
  assert.deepEqual(
    applied,
    { width: 1008, height: 1736, rate: 30 },
    `expected the exact paint-surface 1008x1736 mode, got ${JSON.stringify(applied)}`,
  );
  assert.notEqual(
    applied.width, 1080,
    'must not pick the wider 1080x1920 mode that leaks X desktop into the captured frame',
  );
  assert.notEqual(
    applied.height, 1840,
    'must not pick the taller 1008x1840 neighbour when the exact paint-height mode is available',
  );
});

test('n.eko adapter still selects 920x412 for low-DPR landscape viewports when no high-DPR mode fits (legacy preservation)', async () => {
  // Without the shallow high-DPR modes available (e.g. low-DPR desktop
  // landscape viewer requesting roughly 920x440), ranking must continue to
  // pick the closest legacy landscape preset — 920x412 is still the
  // best-effort choice. Guards against an over-eager bias toward shallow
  // high-DPR modes when the target genuinely is small.
  const fetchImpl = makeFetch([
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/configurations',
      response: makeResponse({
        json: [
          { width: 920, height: 412, rate: 30 },
          { width: 936, height: 432, rate: 30 },
          { width: 1280, height: 720, rate: 30 },
          { width: 1920, height: 1080, rate: 30 },
          { width: 1080, height: 1920, rate: 30 },
        ],
      }),
    },
    {
      method: 'POST',
      url: 'https://neko.test/api/room/screen',
      response: ({ init }) => makeResponse({ json: JSON.parse(init.body) }),
    },
  ]);
  const companion = createNekoCompanion({
    origin: 'https://neko.test',
    bearerToken: 'token-landscape-low',
    fetchImpl,
    screenConfigurationsEndpoint: '/api/room/screen/configurations',
    screenEndpoint: '/api/room/screen',
  });

  await companion.dispatch({
    type: 'viewport',
    width: 916,
    height: 412,
    screenWidth: 916,
    screenHeight: 412,
    deviceScaleFactor: 1,
    mobile: false,
    hasTouch: false,
  });

  const screenPost = fetchImpl.calls.find((call) => call.url === 'https://neko.test/api/room/screen');
  const applied = JSON.parse(screenPost.init.body);
  assert.equal(applied.width, 920, `expected legacy 920-wide landscape preset, got ${JSON.stringify(applied)}`);
});

test('n.eko adapter navigates an explicit start URL through the browser client in assistive mode', async () => {
  const fetchImpl = makeFetch([
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/cast.jpg',
      response: makeResponse({ body: 'jpeg' }),
    },
  ]);
  const browserClient = makeFakeBrowserClient();
  const companion = createNekoCompanion({
    origin: 'https://neko.test',
    bearerToken: 'token-5',
    fetchImpl,
    sleep: makeAbortableSleep(),
    browserClient,
    cdpHttpUrl: 'http://127.0.0.1:9222',
    startUrl: 'data:text/html,<h1>playground</h1>',
    stealthMode: 'balanced',
  });

  await companion.start({ width: 800, height: 600, deviceScaleFactor: 2 });

  assert.equal(companion._internal.stealthMode(), 'assistive');
  assert.deepEqual(
    browserClient.calls.map((call) => call.op),
    ['connect', 'setViewportSize', 'exposeBinding', 'addInitScript', 'evaluate', 'goto'],
  );
  assert.deepEqual(browserClient.calls.find((call) => call.op === 'setViewportSize').viewport, {
    width: 800,
    height: 600,
  });
  assert.equal(
    browserClient.calls.find((call) => call.op === 'goto').url,
    'data:text/html,<h1>playground</h1>',
  );

  await companion.stop();
});

test('n.eko adapter treats initial navigation as best-effort when CDP control is unavailable', async () => {
  const fetchImpl = makeFetch([
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/cast.jpg',
      response: makeResponse({ body: 'jpeg' }),
    },
  ]);
  const logs = [];
  const companion = createNekoCompanion({
    origin: 'https://neko.test',
    bearerToken: 'token-no-cdp',
    fetchImpl,
    logger: { warn: (entry) => logs.push(entry) },
    sleep: makeAbortableSleep(),
    startUrl: 'https://www.reddit.com/login/',
  });
  const frames = [];
  companion.onFrame((frame) => frames.push(frame));

  await companion.start({ width: 800, height: 600, deviceScaleFactor: 2 });
  await waitFor(() => frames.length === 1);

  assert.ok(logs.some((entry) => entry.msg === 'neko_initial_navigation_skipped'));
  assert.equal(fetchImpl.calls.some((call) => String(call.url).includes('/json')), false);

  await companion.stop();
});

test('n.eko adapter emits remote editable focus events through the browser-client binding', async () => {
  const fetchImpl = makeFetch([
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/cast.jpg',
      response: makeResponse({ body: 'jpeg' }),
    },
  ]);
  const browserClient = makeFakeBrowserClient();
  const companion = createNekoCompanion({
    origin: 'https://neko.test',
    bearerToken: 'token-6',
    fetchImpl,
    sleep: makeAbortableSleep(),
    browserClient,
    cdpHttpUrl: 'http://127.0.0.1:9222',
    stealthMode: 'balanced',
  });
  const events = [];
  companion.onEvent((event) => events.push(event));

  await companion.start({ width: 390, height: 844 });
  await waitFor(() => browserClient.calls.some((call) => call.op === 'exposeBinding'));

  browserClient.emitBinding('__pdppNekoFocusChanged', {
    type: 'focus',
    tagName: 'INPUT',
    inputType: 'text',
    x: 12,
    y: 34,
    width: 200,
    height: 44,
  });
  browserClient.emitBinding('__pdppNekoFocusChanged', { type: 'blur' });

  assert.deepEqual(events, [
    {
      kind: 'keyboard_focus',
      focused: true,
      element: {
        type: 'focus',
        tagName: 'INPUT',
        inputType: 'text',
        x: 12,
        y: 34,
        width: 200,
        height: 44,
      },
    },
    {
      kind: 'keyboard_focus',
      focused: false,
      element: { type: 'blur' },
    },
  ]);

  await companion.stop();
});

test('n.eko adapter strict browser-owner mode keeps CDP assistive helpers off', async () => {
  const fetchImpl = makeFetch([
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/configurations',
      response: makeResponse({
        json: [
          { width: 390, height: 844, rate: 30 },
          { width: 400, height: 844, rate: 30 },
        ],
      }),
    },
    {
      method: 'POST',
      url: 'https://neko.test/api/room/screen',
      response: makeResponse({ json: { width: 400, height: 844, rate: 30 } }),
    },
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen',
      response: makeResponse({ json: { width: 400, height: 844, rate: 30 } }),
    },
  ]);
  let browserClientFactoryCalls = 0;
  const companion = createNekoCompanion({
    origin: 'https://neko.test',
    bearerToken: 'token-4',
    browserOwnerMode: 'browser-owner',
    fetchImpl,
    sleep: async () => {},
    createBrowserClient() {
      browserClientFactoryCalls += 1;
      return makeFakeBrowserClient();
    },
    cdpHttpUrl: 'http://127.0.0.1:9222',
    screenConfigurationsEndpoint: '/api/room/screen/configurations',
    screenEndpoint: '/api/room/screen',
  });
  const events = [];
  companion.onEvent((event) => events.push(event));

  assert.equal(companion._internal.browserOwnerMode(), 'browser-owner');
  assert.equal(companion._internal.stealthMode(), 'strict');

  await companion.dispatch({
    type: 'viewport',
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
    userAgent: 'Mobile Safari test UA',
  });
  await companion.dispatch({ type: 'paste', text: 'one-time code 123456' });
  await companion.dispatch({ type: 'copy' });
  const status = await companion.queryNekoStatus();

  const screenPost = fetchImpl.calls.find((call) => call.url === 'https://neko.test/api/room/screen');
  assert.deepEqual(JSON.parse(screenPost.init.body), { width: 400, height: 844, rate: 30 });
  assert.equal(browserClientFactoryCalls, 0);
  assert.deepEqual(events, [
    {
      kind: 'screen_configuration',
      requested: { width: 390, height: 844 },
      selected: { width: 400, height: 844, rate: 30 },
      applied: { width: 400, height: 844, rate: 30 },
    },
  ]);
  assert.deepEqual(status, {
    screen: { width: 400, height: 844, rate: 30 },
    window_skipped: {
      browser_owner_mode: 'browser-owner',
      stealth_mode: 'strict',
    },
    page_cdp_available: false,
    page_cdp_skipped: {
      browser_owner_mode: 'browser-owner',
      stealth_mode: 'strict',
    },
  });

  await companion.stop();
});

test('n.eko resolver-backed factory defers target lookup until start', async () => {
  let resolved = false;
  const fetchImpl = makeFetch([
    {
      method: 'POST',
      url: 'https://neko.test/api/login',
      response: makeResponse({ json: { token: 'noauth-token' } }),
    },
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/cast.jpg',
      response: makeResponse({ body: 'jpeg' }),
    },
  ]);
  const factory = createDefaultStreamingCompanionFactory({
    resolveTargetForInteraction(runId, interactionId) {
      resolved = true;
      assert.equal(runId, 'run_1');
      assert.equal(interactionId, 'int_1');
      return { origin: 'https://neko.test' };
    },
    fetchImpl,
    sleep: makeAbortableSleep(),
  });

  assert.equal(createDefaultStreamingCompanionFactory({ env: {} }), null);
  assert.equal(factory({ run_id: 'run_1', browser_session_id: 'bs' }), null);

  const companion = factory({ run_id: 'run_1', interaction_id: 'int_1', browser_session_id: 'bs' });
  assert.equal(companion.backend, 'neko');
  assert.equal(resolved, false);

  await companion.start();
  await waitFor(() => fetchImpl.calls.length === 2);
  assert.equal(resolved, true);

  await companion.stop();
});

test('n.eko resolver-backed factory applies nested n.eko defaults', async () => {
  const fetchImpl = makeFetch([
    {
      method: 'POST',
      url: 'https://neko.test/api/login',
      response: makeResponse({ json: { token: 'token-nested' } }),
    },
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/configurations',
      response: makeResponse({ json: [{ width: 400, height: 844, rate: 30 }] }),
    },
    {
      method: 'POST',
      url: 'https://neko.test/api/room/screen',
      response: makeResponse({ json: { width: 400, height: 844, rate: 30 } }),
    },
    {
      method: 'GET',
      url: 'http://127.0.0.1:9222/json',
      response: makeResponse({
        json: [
          {
            id: 'page-1',
            type: 'page',
            url: 'data:text/html,<body></body>',
            webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-1',
          },
        ],
      }),
    },
    {
      method: 'GET',
      url: 'http://127.0.0.1:9222/json/version',
      response: makeResponse({
        json: { webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/browser-1' },
      }),
    },
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/cast.jpg',
      response: makeResponse({ body: 'jpeg' }),
    },
  ]);
  const browserClient = makeFakeBrowserClient();
  const browserClientFactoryCalls = [];
  const factory = createDefaultStreamingCompanionFactory({
    resolveTargetForInteraction() {
      return { backend: 'neko', base_url: 'https://neko.test' };
    },
    fetchImpl,
    sleep: makeAbortableSleep(),
    neko: {
      cdpHttpUrl: 'http://127.0.0.1:9222',
      createBrowserClient(args) {
        browserClientFactoryCalls.push(args);
        return browserClient;
      },
      screenConfigurationsEndpoint: '/api/room/screen/configurations',
      screenEndpoint: '/api/room/screen',
    },
  });

  const companion = factory({ run_id: 'run_1', interaction_id: 'int_1', browser_session_id: 'bs' });
  await companion.start({ width: 390, height: 844, deviceScaleFactor: 3, mobile: true, hasTouch: true });
  await companion.stop();

  assert.ok(fetchImpl.calls.some((call) => call.url === 'https://neko.test/api/room/screen/configurations'));
  assert.equal(browserClientFactoryCalls.length, 1);
  assert.equal(browserClientFactoryCalls[0].cdpHttpUrl, 'http://127.0.0.1:9222/');
  assert.deepEqual(browserClient.calls.find((call) => call.op === 'setViewportSize').viewport, {
    width: 400,
    height: 844,
  });
  const screenPost = fetchImpl.calls.find((call) => call.url === 'https://neko.test/api/room/screen');
  assert.deepEqual(JSON.parse(screenPost.init.body), { width: 400, height: 844, rate: 30 });
});

test('multi-backend streaming factory selects n.eko descriptors and exposes proxy target', async () => {
  const fetchImpl = makeFetch([
    {
      method: 'POST',
      url: 'https://neko.test/api/login',
      response: makeResponse({ json: { token: 'noauth-token' } }),
    },
    {
      method: 'GET',
      url: 'https://neko.test/api/room/screen/cast.jpg',
      response: makeResponse({ body: 'jpeg' }),
    },
  ]);
  const factory = createStreamingBackendCompanionFactory({
    fetchImpl,
    sleep: makeAbortableSleep(),
    resolveTargetForInteraction(runId, interactionId) {
      assert.equal(runId, 'run_1');
      assert.equal(interactionId, 'int_1');
      return { backend: 'neko', base_url: 'https://neko.test' };
    },
  });

  const companion = factory({ run_id: 'run_1', interaction_id: 'int_1', browser_session_id: 'bs' });
  try {
    await companion.start();
    await waitFor(() => fetchImpl.calls.length === 2);
    assert.equal(companion.backend, 'neko');
    assert.deepEqual(companion.getNekoProxyTarget(), { origin: 'https://neko.test/' });
  } finally {
    await companion.stop();
  }
});
