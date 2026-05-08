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
  // microtask hop between message availability points. Target.setDiscoverTargets
  // is sent immediately after Page.enable so the adapter can observe popup
  // and URL-change events on the same connection.
  await answerInOrder(sock.peer, 'Page.enable');
  await answerInOrder(sock.peer, 'Target.setDiscoverTargets');
  await answerInOrder(sock.peer, 'Emulation.setDeviceMetricsOverride');
  await answerInOrder(sock.peer, 'Page.startScreencast');
  await startPromise;

  const methods = sock.peer.messages.map((m) => m.method);
  assert.deepEqual(methods, [
    'Page.enable',
    'Target.setDiscoverTargets',
    'Emulation.setDeviceMetricsOverride',
    'Page.startScreencast',
  ]);
  const discover = sock.peer.messages.find((m) => m.method === 'Target.setDiscoverTargets');
  assert.deepEqual(discover.params, { discover: true });
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
  for (const method of [
    'Page.enable',
    'Target.setDiscoverTargets',
    'Emulation.setDeviceMetricsOverride',
    'Page.startScreencast',
  ]) {
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

  const lateFrames = [];
  const unsubscribeLate = companion.onFrame((f) => lateFrames.push(f));
  assert.equal(lateFrames.length, 1);
  assert.equal(lateFrames[0].sessionId, 42);
  unsubscribeLate();

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
  await answerInOrder(sock.peer, 'Target.setDiscoverTargets');
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

  // Viewport resize updates CDP device metrics and restarts the screencast so
  // maxWidth/maxHeight track the operator's current frame.
  const viewportPromise = companion.dispatch({
    type: 'viewport',
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });
  const metrics = await waitForMessage(sock.peer, 'Emulation.setDeviceMetricsOverride');
  metrics.__answered = true;
  sock.peer.deliver({ id: metrics.id, result: {} });
  await answerInOrder(sock.peer, 'Page.stopScreencast');
  const restart = await waitForMessage(sock.peer, 'Page.startScreencast');
  restart.__answered = true;
  sock.peer.deliver({ id: restart.id, result: {} });
  await viewportPromise;
  assert.deepEqual(metrics.params, {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });
  assert.equal(restart.params.maxWidth, 390);
  assert.equal(restart.params.maxHeight, 844);

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
  await answerInOrder(sock.peer, 'Target.setDiscoverTargets');
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

test('createDefaultStreamingCompanionFactory returns null when no resolver is supplied', () => {
  // No resolver → factory is null. Route layer maps this to 503
  // streaming_companion_unavailable. Operators must wire the run-target
  // registry resolver explicitly; there is no env-var fallback.
  assert.equal(createDefaultStreamingCompanionFactory({}), null);
  assert.equal(createDefaultStreamingCompanionFactory({ resolveTargetForInteraction: null }), null);
  assert.equal(createDefaultStreamingCompanionFactory(), null);
});

test('createDefaultStreamingCompanionFactory returns a factory when resolver is supplied', () => {
  const { FakeSocket } = makeFakeSocketCtor();
  const factory = createDefaultStreamingCompanionFactory({
    resolveTargetForInteraction: () => 'ws://fake/page',
    WebSocketCtor: FakeSocket,
  });
  assert.equal(typeof factory, 'function');
});

test('resolver-backed companion: returns null companion when run_id or interaction_id is missing', () => {
  const { FakeSocket } = makeFakeSocketCtor();
  const factory = createDefaultStreamingCompanionFactory({
    resolveTargetForInteraction: () => 'ws://fake/page',
    WebSocketCtor: FakeSocket,
  });
  // Missing both.
  assert.equal(factory({ browser_session_id: 'bs_x' }), null);
  // Missing run_id.
  assert.equal(
    factory({ interaction_id: 'int_a', browser_session_id: 'bs_x' }),
    null,
  );
  // Empty run_id.
  assert.equal(
    factory({ run_id: '', interaction_id: 'int_a', browser_session_id: 'bs_x' }),
    null,
  );
  // Missing interaction_id — composite key is not satisfiable.
  assert.equal(
    factory({ run_id: 'run_xyz', browser_session_id: 'bs_x' }),
    null,
  );
  // Empty interaction_id.
  assert.equal(
    factory({ run_id: 'run_xyz', interaction_id: '', browser_session_id: 'bs_x' }),
    null,
  );
});

test('resolver-backed companion: passes both run_id and interaction_id through to resolver', async () => {
  const { FakeSocket } = makeFakeSocketCtor();
  let seenArgs = null;
  const factory = createDefaultStreamingCompanionFactory({
    resolveTargetForInteraction: (runId, interactionId) => {
      seenArgs = { runId, interactionId };
      return null;
    },
    WebSocketCtor: FakeSocket,
  });
  const companion = factory({
    run_id: 'run_resolver_args',
    interaction_id: 'int_resolver_args',
    browser_session_id: 'bs_resolver_args',
  });
  await assert.rejects(
    companion.start({ width: 100, height: 100 }),
    (err) => err.code === 'streaming_target_unregistered',
  );
  assert.deepEqual(seenArgs, {
    runId: 'run_resolver_args',
    interactionId: 'int_resolver_args',
  });
  await companion.stop();
});

test('resolver-backed companion: rejects start with streaming_target_unregistered when resolver returns null', async () => {
  const { FakeSocket } = makeFakeSocketCtor();
  const factory = createDefaultStreamingCompanionFactory({
    resolveTargetForInteraction: () => null,
    WebSocketCtor: FakeSocket,
  });
  const companion = factory({
    run_id: 'run_xyz',
    interaction_id: 'int_xyz',
    browser_session_id: 'bs_y',
  });
  assert.ok(companion, 'companion shim built even when resolver currently has no record');
  await assert.rejects(
    companion.start({ width: 100, height: 100 }),
    (err) => err.code === 'streaming_target_unregistered',
  );
  await companion.stop();
});

test('resolver-backed companion: pre-start onFrame unsubscribe revokes registration after start', async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const factory = createDefaultStreamingCompanionFactory({
    resolveTargetForInteraction: () => 'ws://fake/page-resolver-unsub',
    WebSocketCtor: FakeSocket,
  });
  const companion = factory({
    run_id: 'run_resolver_unsub',
    interaction_id: 'int_resolver_unsub',
    browser_session_id: 'bs_resolver_unsub',
  });

  // Subscribe BEFORE start — exercises the pendingHandlers replay path.
  let received = 0;
  const off = companion.onFrame(() => {
    received++;
  });

  const startPromise = companion.start({ width: 100, height: 100 });
  // Wait for the inner socket to be created (lazy on start).
  let sock = null;
  for (let i = 0; i < 20 && !sock; i++) {
    // eslint-disable-next-line no-await-in-loop
    await flush();
    sock = findSocket(sockets, 'ws://fake/page-resolver-unsub');
  }
  assert.ok(sock, 'inner CDP socket was opened from the resolved ws URL');
  await answerInOrder(sock.peer, 'Page.enable');
  await answerInOrder(sock.peer, 'Target.setDiscoverTargets');
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

// ── Out-of-band wire events: URL changes and popups ─────────────────────────

async function startAndDrainViewport(peer) {
  await answerInOrder(peer, 'Page.enable');
  await answerInOrder(peer, 'Target.setDiscoverTargets');
  await answerInOrder(peer, 'Emulation.setDeviceMetricsOverride');
  await answerInOrder(peer, 'Page.startScreencast');
}

async function startAndDrainNoViewport(peer) {
  await answerInOrder(peer, 'Page.enable');
  await answerInOrder(peer, 'Target.setDiscoverTargets');
  await answerInOrder(peer, 'Page.startScreencast');
}

test('cdp adapter emits url_changed for main-frame Page.frameNavigated and ignores sub-frames', async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    wsUrl: 'ws://fake/page-url',
    browser_session_id: 'bs_url_main',
    WebSocketCtor: FakeSocket,
  });
  const events = [];
  companion.onEvent((e) => events.push(e));
  const startPromise = companion.start();
  await flush();
  const sock = findSocket(sockets, 'ws://fake/page-url');
  await startAndDrainNoViewport(sock.peer);
  await startPromise;

  // Iframe nav must NOT emit (parentId is set).
  sock.peer.deliver({
    method: 'Page.frameNavigated',
    params: {
      frame: { id: 'sub_1', parentId: 'main_0', url: 'https://ad.example.com/iframe' },
    },
  });
  await flush();
  assert.equal(events.length, 0, 'sub-frame nav must not emit url_changed');

  // Main-frame nav (no parentId) emits.
  sock.peer.deliver({
    method: 'Page.frameNavigated',
    params: {
      frame: { id: 'main_0', url: 'https://example.com/login' },
    },
  });
  await flush();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { kind: 'url_changed', url: 'https://example.com/login' });

  // Same URL again must NOT re-emit (de-dupe).
  sock.peer.deliver({
    method: 'Page.frameNavigated',
    params: { frame: { id: 'main_0', url: 'https://example.com/login' } },
  });
  await flush();
  assert.equal(events.length, 1, 'identical URL must not re-emit');

  // First page target is recorded as our own and suppressed; its title is cached.
  sock.peer.deliver({
    method: 'Target.targetCreated',
    params: { targetInfo: { type: 'page', targetId: 'tg_main', url: 'https://example.com/login', title: 'Sign in' } },
  });
  await flush();
  assert.equal(events.length, 1, 'first page target is treated as our own and suppressed');

  // Now navigate again — title should appear because it was cached.
  sock.peer.deliver({
    method: 'Page.frameNavigated',
    params: { frame: { id: 'main_0', url: 'https://example.com/dashboard' } },
  });
  await flush();
  assert.equal(events.length, 2);
  assert.equal(events[1].kind, 'url_changed');
  assert.equal(events[1].url, 'https://example.com/dashboard');
  assert.equal(events[1].title, 'Sign in');

  await companion.stop();
});

test('cdp adapter emits popup_opened/closed for additional page targets only', async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    wsUrl: 'ws://fake/page-popup',
    browser_session_id: 'bs_popup',
    WebSocketCtor: FakeSocket,
  });
  const events = [];
  companion.onEvent((e) => events.push(e));
  const startPromise = companion.start();
  await flush();
  const sock = findSocket(sockets, 'ws://fake/page-popup');
  await startAndDrainNoViewport(sock.peer);
  await startPromise;

  // First page target = our own page; suppressed.
  sock.peer.deliver({
    method: 'Target.targetCreated',
    params: { targetInfo: { type: 'page', targetId: 'tg_self', url: 'https://example.com', title: 'Home' } },
  });
  await flush();
  assert.equal(events.length, 0, 'own page target is not a popup');

  // Non-page targets are ignored.
  sock.peer.deliver({
    method: 'Target.targetCreated',
    params: { targetInfo: { type: 'service_worker', targetId: 'tg_sw', url: 'https://example.com/sw.js' } },
  });
  await flush();
  assert.equal(events.length, 0, 'non-page targets must not emit popup_opened');

  // Second page target → popup.
  sock.peer.deliver({
    method: 'Target.targetCreated',
    params: { targetInfo: { type: 'page', targetId: 'tg_popup', url: 'https://oauth.example.com/auth' } },
  });
  await flush();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    kind: 'popup_opened',
    targetId: 'tg_popup',
    url: 'https://oauth.example.com/auth',
  });

  // Destroying the popup emits popup_closed.
  sock.peer.deliver({ method: 'Target.targetDestroyed', params: { targetId: 'tg_popup' } });
  await flush();
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], { kind: 'popup_closed', targetId: 'tg_popup' });

  // Destroying our own page does NOT emit popup_closed (teardown handles it).
  sock.peer.deliver({ method: 'Target.targetDestroyed', params: { targetId: 'tg_self' } });
  await flush();
  assert.equal(events.length, 2, 'own page destruction must not emit popup_closed');

  // Destroying an unknown targetId is a no-op (no popup was announced for it).
  sock.peer.deliver({ method: 'Target.targetDestroyed', params: { targetId: 'tg_never_seen' } });
  await flush();
  assert.equal(events.length, 2);

  await companion.stop();
});

test('cdp adapter emits url_changed from Target.targetInfoChanged for SPA navigation', async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    wsUrl: 'ws://fake/page-spa',
    browser_session_id: 'bs_spa',
    WebSocketCtor: FakeSocket,
  });
  const events = [];
  companion.onEvent((e) => events.push(e));
  const startPromise = companion.start();
  await flush();
  const sock = findSocket(sockets, 'ws://fake/page-spa');
  await startAndDrainNoViewport(sock.peer);
  await startPromise;

  // Establish own page target.
  sock.peer.deliver({
    method: 'Target.targetCreated',
    params: { targetInfo: { type: 'page', targetId: 'tg_self', url: 'https://app.example.com/', title: 'App' } },
  });
  await flush();
  assert.equal(events.length, 0);

  // SPA in-document nav fires only `targetInfoChanged` (no Page.frameNavigated).
  sock.peer.deliver({
    method: 'Target.targetInfoChanged',
    params: { targetInfo: { type: 'page', targetId: 'tg_self', url: 'https://app.example.com/settings', title: 'Settings · App' } },
  });
  await flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'url_changed');
  assert.equal(events[0].url, 'https://app.example.com/settings');
  assert.equal(events[0].title, 'Settings · App');

  await companion.stop();
});

test('cdp adapter onEvent unsubscribe stops further deliveries', async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    wsUrl: 'ws://fake/page-unsub',
    browser_session_id: 'bs_event_unsub',
    WebSocketCtor: FakeSocket,
  });
  const events = [];
  const off = companion.onEvent((e) => events.push(e));
  const startPromise = companion.start();
  await flush();
  const sock = findSocket(sockets, 'ws://fake/page-unsub');
  await startAndDrainNoViewport(sock.peer);
  await startPromise;

  sock.peer.deliver({
    method: 'Page.frameNavigated',
    params: { frame: { id: 'm', url: 'https://a/' } },
  });
  await flush();
  assert.equal(events.length, 1);

  off();
  sock.peer.deliver({
    method: 'Page.frameNavigated',
    params: { frame: { id: 'm', url: 'https://b/' } },
  });
  await flush();
  assert.equal(events.length, 1, 'unsubscribe stopped delivery');

  await companion.stop();
});

test('cdp adapter survives Target.setDiscoverTargets failure on start', async () => {
  // Per the requirement: if Target discovery fails (some embedders restrict
  // it on a per-target connection), start() must still succeed and the
  // streaming session must remain usable for screencast + input. Popup/URL
  // events simply will not arrive.
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    wsUrl: 'ws://fake/page-discover-fail',
    browser_session_id: 'bs_discover_fail',
    WebSocketCtor: FakeSocket,
  });
  const startPromise = companion.start({ width: 100, height: 100 });
  await flush();
  const sock = findSocket(sockets, 'ws://fake/page-discover-fail');

  await answerInOrder(sock.peer, 'Page.enable');
  // Reject Target.setDiscoverTargets.
  const discover = await waitForMessage(sock.peer, 'Target.setDiscoverTargets');
  discover.__answered = true;
  sock.peer.deliver({ id: discover.id, error: { code: -32601, message: 'method not supported' } });
  await flush();
  // start() must continue past the failed discover with no propagated rejection.
  await answerInOrder(sock.peer, 'Emulation.setDeviceMetricsOverride');
  await answerInOrder(sock.peer, 'Page.startScreencast');
  await startPromise;

  await companion.stop();
});

test('resolver-backed companion: pre-start onEvent replays into inner companion after start', async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const factory = createDefaultStreamingCompanionFactory({
    resolveTargetForInteraction: () => 'ws://fake/page-resolver-events',
    WebSocketCtor: FakeSocket,
  });
  const companion = factory({
    run_id: 'run_resolver_events',
    interaction_id: 'int_resolver_events',
    browser_session_id: 'bs_resolver_events',
  });

  const events = [];
  const off = companion.onEvent((e) => events.push(e));

  const startPromise = companion.start({ width: 100, height: 100 });
  let sock = null;
  for (let i = 0; i < 20 && !sock; i++) {
    // eslint-disable-next-line no-await-in-loop
    await flush();
    sock = findSocket(sockets, 'ws://fake/page-resolver-events');
  }
  assert.ok(sock);
  await startAndDrainViewport(sock.peer);
  await startPromise;

  // Pre-start subscriber must receive events emitted by the inner companion.
  sock.peer.deliver({
    method: 'Page.frameNavigated',
    params: { frame: { id: 'm', url: 'https://resolved.example/' } },
  });
  await flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].url, 'https://resolved.example/');

  // Unsubscribe revokes inner registration too.
  off();
  sock.peer.deliver({
    method: 'Page.frameNavigated',
    params: { frame: { id: 'm', url: 'https://resolved.example/two' } },
  });
  await flush();
  assert.equal(events.length, 1, 'pre-start onEvent unsubscribe revoked inner registration');

  await companion.stop();
});
