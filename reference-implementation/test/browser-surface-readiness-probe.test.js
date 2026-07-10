import test from 'node:test';
import assert from 'node:assert/strict';

import {
  probeBrowserSurfaceReadinessOverHttp,
  createDefaultBrowserSurfaceReadinessProbe,
  BROWSER_SURFACE_READINESS_PROBE_CODES,
} from '../runtime/browser-surface-readiness.ts';

const READY_SURFACE = Object.freeze({
  surface_id: 'srf_1',
  health: 'ready',
  cdp_url: 'http://neko.local:9222',
});

const TIMEOUT = 50;

function pageTarget(id = 'T1', webSocketDebuggerUrl = `ws://neko/${id}`) {
  return { id, type: 'page', url: 'https://example.com', webSocketDebuggerUrl };
}

function makeFetchSpy(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    calls.push({ url: requestUrl, init });
    for (const [needle, spec] of Object.entries(routes)) {
      if (requestUrl.includes(needle)) {
        if (spec.throw) {
          throw spec.throw;
        }
        const status = spec.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => {
            if (spec.malformed) {
              throw new SyntaxError('Unexpected token');
            }
            return spec.json;
          },
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { calls, fetch };
}

function makeFakeWebSocketCtor() {
  const sockets = [];

  function FakeWebSocket(url) {
    const listeners = { open: [], message: [], error: [], close: [] };
    let readyState = 0;
    const peer = {
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
      deliver(data) {
        const payload = typeof data === 'string' ? data : JSON.stringify(data);
        for (const fn of listeners.message) {
          fn({ data: payload });
        }
      },
      triggerError(error = new Error('fake_error')) {
        for (const fn of listeners.error) {
          fn({ error, message: error?.message || 'fake_error' });
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
    };
    const socket = {
      url,
      get readyState() {
        return readyState;
      },
      addEventListener(name, handler) {
        if (listeners[name]) {
          listeners[name].push(handler);
        }
      },
      send(data) {
        peer.messages.push(typeof data === 'string' ? JSON.parse(data) : data);
      },
      close() {
        peer.triggerClose();
      },
    };
    sockets.push({ peer, socket, url });
    queueMicrotask(() => peer.open());
    return socket;
  }

  return { FakeWebSocket, sockets };
}

async function waitForMessage(peer, method, timeoutMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = peer.messages.find((entry) => !entry.__answered && entry.method === method);
    if (message) {
      return message;
    }
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for CDP method ${method}`);
}

async function waitForSocket(sockets, timeoutMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sockets[0]) {
      return sockets[0];
    }
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  throw new Error('timed out waiting for websocket open');
}

function happyRoutes(over = {}) {
  return {
    'json/version': { json: { Browser: 'Chrome/120', webSocketDebuggerUrl: 'ws://neko/browser' } },
    'json/list': { json: [pageTarget('T1'), pageTarget('T2')] },
    ...over,
  };
}

test('surface health other than ready → browser_surface_not_ready without any fetch or ws', async () => {
  const { calls, fetch } = makeFetchSpy({});
  const { sockets, FakeWebSocket } = makeFakeWebSocketCtor();
  const r = await probeBrowserSurfaceReadinessOverHttp(
    { ...READY_SURFACE, health: 'starting' },
    fetch,
    FakeWebSocket,
    TIMEOUT,
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 'browser_surface_not_ready');
  assert.equal(calls.length, 0, 'a not-ready surface must not be probed over HTTP');
  assert.equal(sockets.length, 0, 'a not-ready surface must not open a websocket');
});

test('missing or non-http cdp_url → browser_surface_not_ready', async () => {
  const { fetch, calls } = makeFetchSpy({});
  const { FakeWebSocket } = makeFakeWebSocketCtor();
  const noUrl = await probeBrowserSurfaceReadinessOverHttp({ ...READY_SURFACE, cdp_url: '' }, fetch, FakeWebSocket, TIMEOUT);
  assert.equal(noUrl.code, 'browser_surface_not_ready');
  assert.equal(calls.length, 0);

  const wsScheme = await probeBrowserSurfaceReadinessOverHttp(
    { ...READY_SURFACE, cdp_url: 'ws://neko.local:9222' },
    fetch,
    FakeWebSocket,
    TIMEOUT,
  );
  assert.equal(wsScheme.code, 'browser_surface_not_ready', 'a ws:// scheme is not an http CDP base');

  const garbage = await probeBrowserSurfaceReadinessOverHttp(
    { ...READY_SURFACE, cdp_url: 'not a url' },
    fetch,
    FakeWebSocket,
    TIMEOUT,
  );
  assert.equal(garbage.code, 'browser_surface_not_ready', 'an unparseable url is not-ready');
});

test('all stages succeed → ok with page-target count and browser version', async () => {
  const { calls, fetch } = makeFetchSpy(happyRoutes());
  const { FakeWebSocket, sockets } = makeFakeWebSocketCtor();
  const resultPromise = probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  const socket = await waitForSocket(sockets);
  const message = await waitForMessage(socket.peer, 'Page.getFrameTree');
  message.__answered = true;
  socket.peer.deliver({ id: message.id, result: { frameTree: { frame: { id: 'root' } } } });
  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.equal(result.pageTargetCount, 2, 'counts only the /json/list page targets');
  assert.equal(result.browserVersion, 'Chrome/120');
  assert.deepEqual(calls.map((call) => call.url), [
    'http://neko.local:9222/json/version',
    'http://neko.local:9222/json/list',
  ]);
  assert.equal(socket.peer.messages.length, 1, 'only the semantic command is sent');
  assert.equal(socket.peer.messages[0].method, 'Page.getFrameTree');
});

test('ok without a Browser string omits browserVersion', async () => {
  const { fetch } = makeFetchSpy(happyRoutes({ 'json/version': { json: { webSocketDebuggerUrl: 'ws://neko/browser' } } }));
  const { FakeWebSocket, sockets } = makeFakeWebSocketCtor();
  const resultPromise = probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  const socket = await waitForSocket(sockets);
  const message = await waitForMessage(socket.peer, 'Page.getFrameTree');
  socket.peer.deliver({ id: message.id, result: { frameTree: { frame: { id: 'root' } } } });
  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.ok(!('browserVersion' in result), 'no Browser field → no browserVersion key');
});

test('version endpoint HTTP error → browser_surface_cdp_disconnected', async () => {
  const { fetch } = makeFetchSpy(happyRoutes({ 'json/version': { status: 500, json: {} } }));
  const { FakeWebSocket } = makeFakeWebSocketCtor();
  const result = await probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  assert.equal(result.code, 'browser_surface_cdp_disconnected');
});

test('version payload missing webSocketDebuggerUrl → browser_surface_cdp_disconnected', async () => {
  const { fetch } = makeFetchSpy(happyRoutes({ 'json/version': { json: { Browser: 'Chrome/120' } } }));
  const { FakeWebSocket } = makeFakeWebSocketCtor();
  const result = await probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  assert.equal(result.code, 'browser_surface_cdp_disconnected');
});

test('version network throw (not aborted) → browser_surface_cdp_unreachable', async () => {
  const { fetch } = makeFetchSpy(happyRoutes({ 'json/version': { throw: new TypeError('ECONNREFUSED') } }));
  const { FakeWebSocket } = makeFakeWebSocketCtor();
  const result = await probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  assert.equal(result.code, 'browser_surface_cdp_unreachable');
});

test('version malformed JSON → browser_surface_cdp_disconnected', async () => {
  const { fetch } = makeFetchSpy(happyRoutes({ 'json/version': { malformed: true, json: {} } }));
  const { FakeWebSocket } = makeFakeWebSocketCtor();
  const result = await probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  assert.equal(result.code, 'browser_surface_cdp_disconnected');
});

test('list not an array → browser_surface_cdp_disconnected', async () => {
  const { fetch } = makeFetchSpy(happyRoutes({ 'json/list': { json: { not: 'an array' } } }));
  const { FakeWebSocket } = makeFakeWebSocketCtor();
  const result = await probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  assert.equal(result.code, 'browser_surface_cdp_disconnected');
});

test('list empty → browser_surface_page_stale (zero targets)', async () => {
  const { fetch } = makeFetchSpy(happyRoutes({ 'json/list': { json: [] } }));
  const { FakeWebSocket } = makeFakeWebSocketCtor();
  const result = await probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  assert.equal(result.code, 'browser_surface_page_stale');
  assert.match(result.detail, /zero targets/);
});

test('list has targets but none usable → browser_surface_page_stale', async () => {
  const unusable = [
    { id: 'x', type: 'page', url: 'devtools://devtools/inspector.html', webSocketDebuggerUrl: 'ws://neko/x' },
    { id: 'y', type: 'background_page', url: 'https://ok', webSocketDebuggerUrl: 'ws://neko/y' },
    { id: '', type: 'page', url: 'https://ok', webSocketDebuggerUrl: 'ws://neko/z' },
    { type: 'page', url: 'https://ok', webSocketDebuggerUrl: 'ws://neko/w' },
    { id: 'q', type: 'page', url: 'https://ok' },
  ];
  const { fetch } = makeFetchSpy(happyRoutes({ 'json/list': { json: unusable } }));
  const { FakeWebSocket } = makeFakeWebSocketCtor();
  const result = await probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  assert.equal(result.code, 'browser_surface_page_stale');
  assert.match(result.detail, /none are usable/);
});

test('semantic probe timeout → browser_surface_probe_timeout and only version/list fetches', async () => {
  const { calls, fetch } = makeFetchSpy(happyRoutes());
  const { FakeWebSocket } = makeFakeWebSocketCtor();
  const result = await probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, 25);
  assert.equal(result.code, 'browser_surface_probe_timeout');
  assert.deepEqual(calls.map((call) => call.url), [
    'http://neko.local:9222/json/version',
    'http://neko.local:9222/json/list',
  ]);
  assert.doesNotMatch(result.detail, /ws:\/\//);
});

test('semantic probe error response → browser_surface_cdp_disconnected without leaking raw target URL', async () => {
  const targetUrl = 'ws://neko.local:9222/devtools/page/T1?token=secret';
  const { fetch } = makeFetchSpy(
    happyRoutes({
      'json/list': { json: [pageTarget('T1', targetUrl)] },
    })
  );
  const { FakeWebSocket, sockets } = makeFakeWebSocketCtor();
  const resultPromise = probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  const socket = await waitForSocket(sockets);
  const message = await waitForMessage(socket.peer, 'Page.getFrameTree');
  socket.peer.deliver({ id: message.id, error: { code: -32000, message: 'cdp boom' } });
  const result = await resultPromise;
  assert.equal(result.code, 'browser_surface_cdp_disconnected');
  assert.doesNotMatch(result.detail, /secret|ws:\/\//);
});

test('semantic probe early close → browser_surface_cdp_disconnected without leaking raw target URL', async () => {
  const targetUrl = 'ws://neko.local:9222/devtools/page/T1?token=secret';
  const { fetch } = makeFetchSpy(
    happyRoutes({
      'json/list': { json: [pageTarget('T1', targetUrl)] },
    })
  );
  const { FakeWebSocket, sockets } = makeFakeWebSocketCtor();
  const resultPromise = probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fetch, FakeWebSocket, TIMEOUT);
  const socket = await waitForSocket(sockets);
  await waitForMessage(socket.peer, 'Page.getFrameTree');
  socket.peer.triggerClose();
  const result = await resultPromise;
  assert.equal(result.code, 'browser_surface_cdp_disconnected');
  assert.doesNotMatch(result.detail, /secret|ws:\/\//);
});

test('createDefaultBrowserSurfaceReadinessProbe rejects a non-positive-integer timeout', () => {
  assert.throws(() => createDefaultBrowserSurfaceReadinessProbe({ timeoutMs: 0 }), /positive integer/);
  assert.throws(() => createDefaultBrowserSurfaceReadinessProbe({ timeoutMs: -5 }), /positive integer/);
  assert.throws(() => createDefaultBrowserSurfaceReadinessProbe({ timeoutMs: 1.5 }), /positive integer/);
  const probe = createDefaultBrowserSurfaceReadinessProbe({
    timeoutMs: 1000,
    fetchImpl: makeFetchSpy(happyRoutes()).fetch,
    webSocketFactory: makeFakeWebSocketCtor().FakeWebSocket,
  });
  assert.equal(typeof probe.probe, 'function');
});

test('the injected probe drives the happy path end-to-end', async () => {
  const { fetch } = makeFetchSpy(happyRoutes());
  const { FakeWebSocket, sockets } = makeFakeWebSocketCtor();
  const probe = createDefaultBrowserSurfaceReadinessProbe({
    timeoutMs: 1000,
    fetchImpl: fetch,
    webSocketFactory: FakeWebSocket,
  });
  const resultPromise = probe.probe(READY_SURFACE);
  const socket = await waitForSocket(sockets);
  const message = await waitForMessage(socket.peer, 'Page.getFrameTree');
  socket.peer.deliver({ id: message.id, result: { frameTree: { frame: { id: 'root' } } } });
  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.equal(result.pageTargetCount, 2);
});

test('BROWSER_SURFACE_READINESS_PROBE_CODES enumerates the documented failure codes', () => {
  assert.deepEqual([...BROWSER_SURFACE_READINESS_PROBE_CODES].sort(), [
    'browser_surface_cdp_disconnected',
    'browser_surface_cdp_unreachable',
    'browser_surface_not_ready',
    'browser_surface_page_stale',
    'browser_surface_probe_timeout',
  ]);
});
