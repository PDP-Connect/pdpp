/**
 * Tests for the real CDP companion adapter.
 *
 * The adapter speaks JSON-RPC over a CDP page-target WebSocket. We deliberately
 * avoid Playwright/Puppeteer in the reference server, and the test harness
 * injects an in-memory fake WebSocket implementation so the protocol surface
 * (JSON-RPC dispatch, pending-response correlation, screencast frame fan-out,
 * back-pressure ack, viewport mapping, teardown) is exercised deterministically
 * without launching a real Chromium.
 *
 * Each fake socket pair exposes a `peer` whose `messages` array captures every
 * JSON-RPC message the adapter sends. Tests synthesize CDP responses and frame
 * events through `peer.deliver(...)` and assert against the captured calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCdpCompanion,
  createCdpTargetFromHttp,
  createDefaultStreamingCompanionFactory,
  resolveCdpHttpUrlFromEnv,
  resolveCdpWsUrlFromEnv,
} from '../server/streaming/cdp-adapter.js';

/**
 * Minimal fake WebSocket. Mirrors the surface the adapter uses:
 *   - constructor(url) → readyState transitions to 1 after `open`
 *   - addEventListener('open'|'message'|'error'|'close', handler)
 *   - send(data)
 *   - close()
 *
 * Plus a `peer` handle the test uses to drive messages back at the adapter.
 */
function makeFakeSocketCtor() {
  const sockets = [];
  function FakeSocket(url) {
    const listeners = { open: [], message: [], error: [], close: [] };
    let readyState = 0;
    const peer = {
      messages: [],
      deliver(data) {
        const payload = typeof data === 'string' ? data : JSON.stringify(data);
        for (const fn of listeners.message) fn({ data: payload });
      },
      triggerError(error) {
        for (const fn of listeners.error) fn({ error, message: error?.message || 'fake_error' });
      },
      triggerClose() {
        readyState = 3;
        for (const fn of listeners.close) fn({});
      },
      open() {
        readyState = 1;
        for (const fn of listeners.open) fn({});
      },
    };
    const socket = {
      url,
      get readyState() {
        return readyState;
      },
      addEventListener(name, handler) {
        if (listeners[name]) listeners[name].push(handler);
      },
      send(data) {
        peer.messages.push(typeof data === 'string' ? JSON.parse(data) : data);
      },
      close() {
        if (readyState !== 3) {
          readyState = 3;
          for (const fn of listeners.close) fn({});
        }
      },
    };
    sockets.push({ socket, peer, url });
    // Open on next tick so the adapter has a chance to register listeners.
    queueMicrotask(() => peer.open());
    return socket;
  }
  return { FakeSocket, sockets };
}

function findSocket(sockets, url) {
  return sockets.find((s) => s.url === url);
}

async function flush() {
  // Several microtask flushes cover open + adapter-side promise chains.
  for (let i = 0; i < 8; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

/**
 * Wait until the peer has captured an outbound CDP message matching `method`
 * that hasn't been answered yet. Polls the microtask queue rather than the
 * event loop so it stays deterministic.
 */
async function waitForMessage(peer, method, timeoutMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = peer.messages.find((m) => !m.__answered && m.method === method);
    if (msg) return msg;
    // eslint-disable-next-line no-await-in-loop
    await flush();
  }
  throw new Error(
    `Timed out waiting for CDP method ${method}; saw ${peer.messages
      .map((m) => `${m.method}${m.__answered ? '*' : ''}`)
      .join(', ')}`,
  );
}

async function answerInOrder(peer, method, result = {}) {
  const msg = await waitForMessage(peer, method);
  msg.__answered = true;
  peer.deliver({ id: msg.id, result });
  await flush();
}

test('cdp adapter sends Page.enable, viewport override, and startScreencast on start()', async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    wsUrl: 'ws://fake/page',
    browser_session_id: 'bs_test_1',
    WebSocketCtor: FakeSocket,
  });
  const startPromise = companion.start({ width: 800, height: 600, deviceScaleFactor: 2 });
  await flush();
  const sock = findSocket(sockets, 'ws://fake/page');
  assert.ok(sock, 'adapter opened a socket');

  // Drain the start chain in order — each await in the adapter requires a
  // microtask hop between message availability points.
  await answerInOrder(sock.peer, 'Page.enable');
  await answerInOrder(sock.peer, 'Emulation.setDeviceMetricsOverride');
  await answerInOrder(sock.peer, 'Page.startScreencast');
  await startPromise;

  const methods = sock.peer.messages.map((m) => m.method);
  assert.deepEqual(methods, ['Page.enable', 'Emulation.setDeviceMetricsOverride', 'Page.startScreencast']);
  const screencast = sock.peer.messages.find((m) => m.method === 'Page.startScreencast');
  assert.equal(screencast.params.format, 'jpeg');
  assert.equal(screencast.params.maxWidth, 800);
  assert.equal(screencast.params.maxHeight, 600);

  await companion.stop();
});

test('cdp adapter dispatches frames to onFrame subscribers and acks back-pressure', async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    wsUrl: 'ws://fake/page',
    browser_session_id: 'bs_test_2',
    WebSocketCtor: FakeSocket,
  });

  const frames = [];
  companion.onFrame((f) => frames.push(f));

  const startPromise = companion.start({ width: 320, height: 480 });
  await flush();
  const sock = findSocket(sockets, 'ws://fake/page');
  for (const method of ['Page.enable', 'Emulation.setDeviceMetricsOverride', 'Page.startScreencast']) {
    // eslint-disable-next-line no-await-in-loop
    await answerInOrder(sock.peer, method);
  }
  await startPromise;

  // Push a screencast frame from the "browser".
  sock.peer.deliver({
    method: 'Page.screencastFrame',
    params: {
      sessionId: 42,
      data: 'AA==',
      metadata: { device_width: 320, device_height: 480 },
    },
  });
  await flush();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].sessionId, 42);
  assert.equal(frames[0].data, 'AA==');
  assert.equal(frames[0].metadata.device_width, 320);

  // Adapter ackFrame issues Page.screencastFrameAck.
  const ackPromise = companion.ackFrame(42);
  await answerInOrder(sock.peer, 'Page.screencastFrameAck');
  await ackPromise;

  await companion.stop();
});

test('cdp adapter maps wire input events through mapInputEventToCdp', async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    wsUrl: 'ws://fake/page',
    browser_session_id: 'bs_test_3',
    WebSocketCtor: FakeSocket,
  });
  const startPromise = companion.start();
  await flush();
  const sock = findSocket(sockets, 'ws://fake/page');
  await answerInOrder(sock.peer, 'Page.enable');
  await answerInOrder(sock.peer, 'Page.startScreencast');
  await startPromise;

  // Helper: answer a typed Input.dispatchMouseEvent matching `mouseType`.
  async function answerMouse(mouseType) {
    const deadline = Date.now() + 200;
    while (Date.now() < deadline) {
      const msg = sock.peer.messages.find(
        (m) => m.method === 'Input.dispatchMouseEvent' && m.params.type === mouseType && !m.__answered,
      );
      if (msg) {
        msg.__answered = true;
        sock.peer.deliver({ id: msg.id, result: {} });
        await flush();
        return msg;
      }
      await flush();
    }
    throw new Error(`Timed out waiting for Input.dispatchMouseEvent type=${mouseType}`);
  }

  // Click is two CDP commands: mousePressed + mouseReleased.
  const clickPromise = companion.dispatch({ type: 'mouse', action: 'click', x: 10, y: 20, button: 0 });
  await answerMouse('mousePressed');
  await answerMouse('mouseReleased');
  await clickPromise;

  // Keydown produces one CDP command.
  const keyPromise = companion.dispatch({ type: 'keyboard', action: 'keydown', key: 'a' });
  await answerInOrder(sock.peer, 'Input.dispatchKeyEvent');
  await keyPromise;

  await companion.stop();
});

test('cdp adapter surfaces CDP error responses via dispatch()', async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    wsUrl: 'ws://fake/page',
    browser_session_id: 'bs_err',
    WebSocketCtor: FakeSocket,
  });
  const startPromise = companion.start();
  await flush();
  const sock = findSocket(sockets, 'ws://fake/page');
  await answerInOrder(sock.peer, 'Page.enable');
  await answerInOrder(sock.peer, 'Page.startScreencast');
  await startPromise;

  const dispatchP = companion.dispatch({ type: 'paste', text: 'hello' });
  const insert = await waitForMessage(sock.peer, 'Input.insertText');
  insert.__answered = true;
  sock.peer.deliver({ id: insert.id, error: { code: -32000, message: 'cdp boom' } });
  await assert.rejects(dispatchP, (err) => err.code === 'cdp_error' && /cdp boom/.test(err.message));

  await companion.stop();
});

test('cdp adapter rejects pending commands when the socket closes', async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    wsUrl: 'ws://fake/page',
    browser_session_id: 'bs_close',
    WebSocketCtor: FakeSocket,
  });
  const startPromise = companion.start();
  // Wait until Page.enable has been sent so a pending command exists, then
  // close the socket without answering. The close handler must reject all
  // pending commands with `cdp_closed`.
  const sock = await (async () => {
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      await flush();
      const found = findSocket(sockets, 'ws://fake/page');
      if (found && found.peer.messages.some((m) => m.method === 'Page.enable')) return found;
    }
  })();
  sock.peer.triggerClose();
  await assert.rejects(startPromise, (err) => err.code === 'cdp_closed');
});

test('createDefaultStreamingCompanionFactory returns null when no URL is configured', () => {
  assert.equal(createDefaultStreamingCompanionFactory({ wsUrl: null }), null);
  assert.equal(createDefaultStreamingCompanionFactory({ wsUrl: '' }), null);
});

test('createDefaultStreamingCompanionFactory builds a real adapter when URL is set', async () => {
  const { FakeSocket } = makeFakeSocketCtor();
  const factory = createDefaultStreamingCompanionFactory({
    wsUrl: 'ws://fake/page',
    WebSocketCtor: FakeSocket,
  });
  assert.equal(typeof factory, 'function');
  const companion = factory({ browser_session_id: 'bs_factory' });
  assert.equal(companion.browser_session_id, 'bs_factory');
  // The adapter has not connected yet — start() does that.
  await companion.stop();
});

test('resolveCdpWsUrlFromEnv reads PDPP_RUN_INTERACTION_CDP_WS_URL', () => {
  assert.equal(resolveCdpWsUrlFromEnv({}), null);
  assert.equal(resolveCdpWsUrlFromEnv({ PDPP_RUN_INTERACTION_CDP_WS_URL: '' }), null);
  assert.equal(
    resolveCdpWsUrlFromEnv({ PDPP_RUN_INTERACTION_CDP_WS_URL: 'ws://localhost:9222/devtools/page/abc' }),
    'ws://localhost:9222/devtools/page/abc',
  );
});

test('resolveCdpHttpUrlFromEnv reads PDPP_RUN_INTERACTION_CDP_HTTP_URL', () => {
  assert.equal(resolveCdpHttpUrlFromEnv({}), null);
  assert.equal(resolveCdpHttpUrlFromEnv({ PDPP_RUN_INTERACTION_CDP_HTTP_URL: '   ' }), null);
  assert.equal(
    resolveCdpHttpUrlFromEnv({ PDPP_RUN_INTERACTION_CDP_HTTP_URL: 'http://127.0.0.1:9222' }),
    'http://127.0.0.1:9222',
  );
});

test('createCdpTargetFromHttp PUTs /json/new and returns webSocketDebuggerUrl', async () => {
  const calls = [];
  async function fakeFetch(url, init = {}) {
    calls.push({ url, method: init.method || 'GET' });
    if (url.endsWith('/json/new?about:blank')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            id: 'TARGET-123',
            type: 'page',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/TARGET-123',
          };
        },
      };
    }
    if (url.includes('/json/close/')) {
      return { ok: true, status: 200, async json() { return {}; } };
    }
    throw new Error(`unexpected url ${url}`);
  }
  const target = await createCdpTargetFromHttp({ httpUrl: 'http://127.0.0.1:9222', fetch: fakeFetch });
  assert.equal(target.webSocketDebuggerUrl, 'ws://127.0.0.1:9222/devtools/page/TARGET-123');
  assert.equal(target.targetId, 'TARGET-123');
  assert.equal(calls[0].url, 'http://127.0.0.1:9222/json/new?about:blank');
  assert.equal(calls[0].method, 'PUT');

  await target.close();
  assert.ok(calls.some((c) => c.url.includes('/json/close/TARGET-123')), 'close hit /json/close');
});

test('createCdpTargetFromHttp falls back to GET when PUT throws (older Chromium)', async () => {
  let putAttempts = 0;
  async function fakeFetch(url, init = {}) {
    if (init.method === 'PUT') {
      putAttempts++;
      throw new Error('method not allowed');
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          id: 'T2',
          webSocketDebuggerUrl: 'ws://x/devtools/page/T2',
        };
      },
    };
  }
  const target = await createCdpTargetFromHttp({ httpUrl: 'http://127.0.0.1:9222/', fetch: fakeFetch });
  assert.equal(putAttempts, 1);
  assert.equal(target.webSocketDebuggerUrl, 'ws://x/devtools/page/T2');
});

test('createCdpTargetFromHttp surfaces missing webSocketDebuggerUrl as cdp_http_no_ws_url', async () => {
  async function fakeFetch() {
    return { ok: true, status: 200, async json() { return { id: 'T3' /* no ws url */ }; } };
  }
  await assert.rejects(
    createCdpTargetFromHttp({ httpUrl: 'http://127.0.0.1:9222', fetch: fakeFetch }),
    (err) => err.code === 'cdp_http_no_ws_url',
  );
});

test('createCdpTargetFromHttp rejects malformed httpUrl with cdp_http_url_invalid', async () => {
  await assert.rejects(
    createCdpTargetFromHttp({ httpUrl: 'not a url', fetch: async () => ({ ok: true, json: async () => ({}) }) }),
    (err) => err.code === 'cdp_http_url_invalid',
  );
});

test('createCdpTargetFromHttp rejects non-2xx /json/new with cdp_http_create_failed (500 is not a fallback case)', async () => {
  let calls = 0;
  async function fakeFetch() {
    calls++;
    return { ok: false, status: 500, async json() { return {}; } };
  }
  await assert.rejects(
    createCdpTargetFromHttp({ httpUrl: 'http://127.0.0.1:9222', fetch: fakeFetch }),
    (err) => err.code === 'cdp_http_create_failed' && err.status === 500,
  );
  // The 500 was a real server error — we must NOT silently retry as GET, or
  // operators would be looking at a bogus "missing webSocketDebuggerUrl" error
  // when the underlying problem is a broken DevTools endpoint.
  assert.equal(calls, 1, 'no retry for 500');
});

test('createCdpTargetFromHttp falls back to GET on PUT 405', async () => {
  const seen = [];
  async function fakeFetch(url, init = {}) {
    seen.push(init.method || 'GET');
    if (init.method === 'PUT') {
      return { ok: false, status: 405, async json() { return {}; } };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { id: 'T405', webSocketDebuggerUrl: 'ws://x/devtools/page/T405' };
      },
    };
  }
  const target = await createCdpTargetFromHttp({ httpUrl: 'http://127.0.0.1:9222', fetch: fakeFetch });
  assert.deepEqual(seen, ['PUT', 'GET']);
  assert.equal(target.webSocketDebuggerUrl, 'ws://x/devtools/page/T405');
});

test('createCdpTargetFromHttp falls back to GET on PUT 404 and 501 too', async () => {
  for (const status of [404, 501]) {
    const seen = [];
    async function fakeFetch(url, init = {}) {
      seen.push(init.method || 'GET');
      if (init.method === 'PUT') {
        return { ok: false, status, async json() { return {}; } };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { id: `T${status}`, webSocketDebuggerUrl: `ws://x/devtools/page/T${status}` };
        },
      };
    }
    // eslint-disable-next-line no-await-in-loop
    const target = await createCdpTargetFromHttp({ httpUrl: 'http://127.0.0.1:9222', fetch: fakeFetch });
    assert.deepEqual(seen, ['PUT', 'GET'], `fallback for status ${status}`);
    assert.equal(target.webSocketDebuggerUrl, `ws://x/devtools/page/T${status}`);
  }
});

test('createCdpTargetFromHttp does NOT fall back on PUT 500 (real server error)', async () => {
  let putCalls = 0;
  let getCalls = 0;
  async function fakeFetch(url, init = {}) {
    if (init.method === 'PUT') {
      putCalls++;
      return { ok: false, status: 500, async json() { return {}; } };
    }
    getCalls++;
    return { ok: true, status: 200, async json() { return {}; } };
  }
  await assert.rejects(
    createCdpTargetFromHttp({ httpUrl: 'http://127.0.0.1:9222', fetch: fakeFetch }),
    (err) => err.code === 'cdp_http_create_failed' && err.status === 500,
  );
  assert.equal(putCalls, 1);
  assert.equal(getCalls, 0, 'must not silently retry a 500 as GET');
});

test('createCdpTargetFromHttp rejects non-http/https schemes with cdp_http_url_invalid', async () => {
  for (const bad of ['ws://127.0.0.1:9222', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://x']) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      createCdpTargetFromHttp({ httpUrl: bad, fetch: async () => ({ ok: true, json: async () => ({}) }) }),
      (err) => err.code === 'cdp_http_url_invalid',
      `scheme rejected: ${bad}`,
    );
  }
});

test('createCdpTargetFromHttp accepts both http: and https: schemes', async () => {
  for (const good of ['http://127.0.0.1:9222', 'https://browser.example.com:9222']) {
    async function fakeFetch() {
      return {
        ok: true,
        status: 200,
        async json() {
          return { id: 'T-OK', webSocketDebuggerUrl: 'ws://x/devtools/page/T-OK' };
        },
      };
    }
    // eslint-disable-next-line no-await-in-loop
    const target = await createCdpTargetFromHttp({ httpUrl: good, fetch: fakeFetch });
    assert.equal(target.targetId, 'T-OK');
  }
});

test('default factory uses HTTP resolver when only httpUrl is set, and closes target on stop', async () => {
  const { FakeSocket } = makeFakeSocketCtor();
  const fetchCalls = [];
  async function fakeFetch(url, init = {}) {
    fetchCalls.push({ url, method: init.method || 'GET' });
    if (url.endsWith('/json/new?about:blank')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            id: 'T-FACTORY',
            webSocketDebuggerUrl: 'ws://fake/page',
          };
        },
      };
    }
    return { ok: true, status: 200, async json() { return {}; } };
  }
  const factory = createDefaultStreamingCompanionFactory({
    wsUrl: null,
    httpUrl: 'http://127.0.0.1:9222',
    WebSocketCtor: FakeSocket,
    fetch: fakeFetch,
  });
  assert.equal(typeof factory, 'function');
  const companion = factory({ browser_session_id: 'bs_http' });
  assert.equal(companion.browser_session_id, 'bs_http');
  // HTTP target is created lazily on stop too — calling stop before start
  // should not throw, and should not have fetched anything.
  await companion.stop();
  assert.equal(fetchCalls.length, 0, 'no fetch before start');

  // Fresh companion to exercise the start/stop path including target close.
  const companion2 = factory({ browser_session_id: 'bs_http_2' });
  // We don't drive the inner CDP socket here — start() will hang waiting for
  // Page.enable. Use the lower-level HTTP path by stopping after the target is
  // created. Drive start in the background and tear down.
  let resolved = false;
  companion2
    .start()
    .then(() => {
      resolved = true;
    })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 10));
  await companion2.stop();
  assert.ok(
    fetchCalls.some((c) => c.url.endsWith('/json/new?about:blank')),
    'HTTP resolver was invoked',
  );
  assert.ok(
    fetchCalls.some((c) => c.url.includes('/json/close/T-FACTORY')),
    'best-effort target close was invoked on stop',
  );
  assert.equal(resolved, false, 'inner start did not complete (we never sent Page.enable)');
});

test('default factory returns null when neither wsUrl nor httpUrl is set', () => {
  assert.equal(
    createDefaultStreamingCompanionFactory({ wsUrl: null, httpUrl: null }),
    null,
  );
});

test('HTTP-resolved companion: pre-start onFrame unsubscribe revokes registration after start', async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  async function fakeFetch(url, init = {}) {
    if (url.endsWith('/json/new?about:blank') && (init.method === 'PUT' || init.method === 'GET')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { id: 'T-UNSUB', webSocketDebuggerUrl: 'ws://fake/page-unsub' };
        },
      };
    }
    return { ok: true, status: 200, async json() { return {}; } };
  }
  const factory = createDefaultStreamingCompanionFactory({
    wsUrl: null,
    httpUrl: 'http://127.0.0.1:9222',
    WebSocketCtor: FakeSocket,
    fetch: fakeFetch,
  });
  const companion = factory({ browser_session_id: 'bs_unsub' });

  // Subscribe BEFORE start — this exercises the pendingHandlers replay path.
  let received = 0;
  const off = companion.onFrame(() => {
    received++;
  });

  // Drive start to completion. start() awaits inner.start, which sends
  // Page.enable + Page.startScreencast over the inner socket — answer them.
  const startPromise = companion.start({ width: 100, height: 100 });
  // Wait for the inner socket to be created (lazy on start).
  let sock = null;
  for (let i = 0; i < 20 && !sock; i++) {
    // eslint-disable-next-line no-await-in-loop
    await flush();
    sock = findSocket(sockets, 'ws://fake/page-unsub');
  }
  assert.ok(sock, 'inner CDP socket was opened from the resolved ws URL');
  await answerInOrder(sock.peer, 'Page.enable');
  await answerInOrder(sock.peer, 'Emulation.setDeviceMetricsOverride');
  await answerInOrder(sock.peer, 'Page.startScreencast');
  await startPromise;

  // Sanity: a frame delivered now MUST reach the handler — the pre-start
  // subscriber was successfully replayed into the inner companion.
  sock.peer.deliver({
    method: 'Page.screencastFrame',
    params: { sessionId: 1, data: 'AA==', metadata: {} },
  });
  await flush();
  assert.equal(received, 1, 'pre-start subscriber received a frame after start');

  // Unsubscribe. After this, further frames must NOT reach the handler.
  off();
  sock.peer.deliver({
    method: 'Page.screencastFrame',
    params: { sessionId: 2, data: 'BB==', metadata: {} },
  });
  await flush();
  assert.equal(received, 1, 'unsubscribe revoked inner-companion registration too');

  await companion.stop();
});

test('default factory prefers wsUrl over httpUrl when both are set', async () => {
  const { FakeSocket } = makeFakeSocketCtor();
  let fetchCalled = false;
  const factory = createDefaultStreamingCompanionFactory({
    wsUrl: 'ws://explicit/page',
    httpUrl: 'http://127.0.0.1:9222',
    WebSocketCtor: FakeSocket,
    fetch: async () => {
      fetchCalled = true;
      return { ok: true, status: 200, async json() { return {}; } };
    },
  });
  const companion = factory({ browser_session_id: 'bs_pref' });
  await companion.stop();
  assert.equal(fetchCalled, false, 'fetched nothing — used direct wsUrl path');
});
