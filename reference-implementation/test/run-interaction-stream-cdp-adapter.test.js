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
  createDefaultStreamingCompanionFactory,
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
