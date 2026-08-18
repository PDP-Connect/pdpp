// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
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
import test from "node:test";

import {
  createCdpCompanion as createCdpCompanionUntyped,
  createDefaultStreamingCompanionFactory as createDefaultStreamingCompanionFactoryUntyped,
  normalizeTouchPointerInputForCdp,
} from "../server/streaming/cdp-adapter.ts";

interface CdpEvent {
  kind: string;
  [key: string]: unknown;
}

interface CdpCompanion {
  ackFrame: (sessionId: number) => Promise<void>;
  browser_session_id: string;
  dispatch: (event: Record<string, unknown>) => Promise<void>;
  onEvent: (handler: (event: CdpEvent) => void) => () => void;
  onFrame: (handler: (frame: { sessionId: unknown; data: unknown; metadata: unknown }) => void) => () => void;
  readRemoteSelection: () => Promise<string>;
  start: (viewport?: {
    width?: number;
    height?: number;
    deviceScaleFactor?: number;
    mobile?: boolean;
  }) => Promise<void>;
  stop: () => Promise<void>;
}

interface CreateCdpCompanionOptions {
  browser_session_id: string;
  commandTimeoutMs?: number;
  logger?: unknown;
  openTimeoutMs?: number;
  WebSocketCtor?: typeof WebSocket;
  wsUrl: string;
}

interface CreateStreamingCompanionFactoryOptions {
  commandTimeoutMs?: number;
  logger?: unknown;
  openTimeoutMs?: number;
  resolveTargetForInteraction?: ((runId: string, interactionId: string) => string | null) | null;
  WebSocketCtor?: typeof WebSocket;
}

type StreamingCompanionFactory = (args: {
  run_id?: string;
  interaction_id?: string;
  browser_session_id: string;
}) => CdpCompanion | null;

const createCdpCompanion = createCdpCompanionUntyped as unknown as (opts: CreateCdpCompanionOptions) => CdpCompanion;
const createDefaultStreamingCompanionFactory = createDefaultStreamingCompanionFactoryUntyped as unknown as (
  opts?: CreateStreamingCompanionFactoryOptions
) => StreamingCompanionFactory | null;

type WsListenerName = "open" | "message" | "error" | "close";
type WsListener = (event: { data?: string; error?: unknown; message?: string }) => void;

interface CdpMessage {
  __answered?: boolean;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

interface FakeSocketPeer {
  deliver: (data: unknown) => void;
  messages: CdpMessage[];
  open: () => void;
  triggerClose: () => void;
  triggerError: (error: Error | undefined) => void;
}

interface FakeSocketHandle {
  peer: FakeSocketPeer;
  socket: unknown;
  url: string;
}

/**
 * The adapter's `WebSocketCtor` param defaults to `globalThis.WebSocket`, so
 * TS infers the full DOM `WebSocket` constructor type there. Our fake only
 * implements the subset the adapter actually calls (constructor, readyState,
 * addEventListener, send, close) — cast once here rather than at each of the
 * many call sites below.
 */
type FakeWebSocketCtor = typeof WebSocket;

/**
 * Minimal fake WebSocket. Mirrors the surface the adapter uses:
 *   - constructor(url) → readyState transitions to 1 after `open`
 *   - addEventListener('open'|'message'|'error'|'close', handler)
 *   - send(data)
 *   - close()
 *
 * Plus a `peer` handle the test uses to drive messages back at the adapter.
 */
function makeFakeSocketCtor(): { FakeSocket: FakeWebSocketCtor; sockets: FakeSocketHandle[] } {
  const sockets: FakeSocketHandle[] = [];
  function FakeSocket(this: unknown, url: string) {
    const listeners: Record<WsListenerName, WsListener[]> = { close: [], error: [], message: [], open: [] };
    let readyState = 0;
    const peer: FakeSocketPeer = {
      deliver(data: unknown) {
        const payload = typeof data === "string" ? data : JSON.stringify(data);
        for (const fn of listeners.message) {
          fn({ data: payload });
        }
      },
      messages: [],
      open() {
        readyState = 1;
        for (const fn of listeners.open) {
          fn({});
        }
      },
      triggerClose() {
        readyState = 3;
        for (const fn of listeners.close) {
          fn({});
        }
      },
      triggerError(error) {
        for (const fn of listeners.error) {
          fn({ error, message: error?.message || "fake_error" });
        }
      },
    };
    const socket = {
      addEventListener(name: WsListenerName, handler: WsListener) {
        if (listeners[name]) {
          listeners[name].push(handler);
        }
      },
      close() {
        if (readyState !== 3) {
          readyState = 3;
          for (const fn of listeners.close) {
            fn({});
          }
        }
      },
      get readyState() {
        return readyState;
      },
      send(data: unknown) {
        peer.messages.push((typeof data === "string" ? JSON.parse(data) : data) as CdpMessage);
      },
      url,
    };
    sockets.push({ peer, socket, url });
    // Open on next tick so the adapter has a chance to register listeners.
    queueMicrotask(() => peer.open());
    return socket;
  }
  return { FakeSocket: FakeSocket as unknown as FakeWebSocketCtor, sockets };
}

function findSocket(sockets: FakeSocketHandle[], url: string): FakeSocketHandle | undefined {
  return sockets.find((s) => s.url === url);
}

async function flush(): Promise<void> {
  // Several microtask flushes cover open + adapter-side promise chains.
  // biome-ignore lint/style/noIncrementDecrement: localized test assertion preserves its explicit contract.
  for (let i = 0; i < 8; i++) {
    // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
    await Promise.resolve();
  }
}

/**
 * Wait until the peer has captured an outbound CDP message matching `method`
 * that hasn't been answered yet. Polls the microtask queue rather than the
 * event loop so it stays deterministic.
 */
async function waitForMessage(peer: FakeSocketPeer, method: string, timeoutMs = 200): Promise<CdpMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = peer.messages.find((m) => !m.__answered && m.method === method);
    if (msg) {
      return msg;
    }
    // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
    await flush();
  }
  throw new Error(
    `Timed out waiting for CDP method ${method}; saw ${peer.messages
      .map((m) => `${m.method}${m.__answered ? "*" : ""}`)
      .join(", ")}`
  );
}

async function answerInOrder(
  peer: FakeSocketPeer,
  method: string,
  result: Record<string, unknown> = {}
): Promise<void> {
  const msg = await waitForMessage(peer, method);
  msg.__answered = true;
  peer.deliver({ id: msg.id, result });
  await flush();
}

async function stopAndDrain(companion: CdpCompanion, peer?: FakeSocketPeer): Promise<void> {
  if (!peer) {
    await companion.stop();
    return;
  }
  const stopPromise = companion.stop();
  await answerInOrder(peer, "Page.stopScreencast");
  await answerInOrder(peer, "Target.setDiscoverTargets");
  await stopPromise;
}

async function startAndDrainViewport(peer: FakeSocketPeer): Promise<void> {
  await answerInOrder(peer, "Target.setDiscoverTargets");
  await answerInOrder(peer, "Emulation.setDeviceMetricsOverride");
  await answerInOrder(peer, "Emulation.setTouchEmulationEnabled");
  await answerInOrder(peer, "Page.enable");
  await answerInOrder(peer, "Page.startScreencast");
  await answerInOrder(peer, "Runtime.enable");
  await answerInOrder(peer, "Runtime.addBinding");
  await answerInOrder(peer, "Page.addScriptToEvaluateOnNewDocument");
  await answerInOrder(peer, "Runtime.evaluate");
}

async function startAndDrainNoViewport(peer: FakeSocketPeer): Promise<void> {
  await answerInOrder(peer, "Target.setDiscoverTargets");
  await answerInOrder(peer, "Page.enable");
  await answerInOrder(peer, "Page.startScreencast");
  await answerInOrder(peer, "Runtime.enable");
  await answerInOrder(peer, "Runtime.addBinding");
  await answerInOrder(peer, "Page.addScriptToEvaluateOnNewDocument");
  await answerInOrder(peer, "Runtime.evaluate");
}

test("cdp adapter delegates viewport, frames, and focus setup to Remote Surface 1.5.1", async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    browser_session_id: "bs_test_1",
    WebSocketCtor: FakeSocket,
    wsUrl: "ws://fake/page",
  });
  const startPromise = companion.start({ deviceScaleFactor: 2, height: 600, width: 800 });
  await flush();
  const sock = findSocket(sockets, "ws://fake/page");
  assert.ok(sock, "adapter opened a socket");

  await answerInOrder(sock.peer, "Target.setDiscoverTargets");
  await answerInOrder(sock.peer, "Emulation.setDeviceMetricsOverride");
  await answerInOrder(sock.peer, "Emulation.setTouchEmulationEnabled");
  await answerInOrder(sock.peer, "Page.enable");
  await answerInOrder(sock.peer, "Page.startScreencast");
  await answerInOrder(sock.peer, "Runtime.enable");
  await answerInOrder(sock.peer, "Runtime.addBinding");
  await answerInOrder(sock.peer, "Page.addScriptToEvaluateOnNewDocument");
  await answerInOrder(sock.peer, "Runtime.evaluate");
  await startPromise;

  const methods = sock.peer.messages.map((m) => m.method);
  assert.deepEqual(methods, [
    "Target.setDiscoverTargets",
    "Emulation.setDeviceMetricsOverride",
    "Emulation.setTouchEmulationEnabled",
    "Page.enable",
    "Page.startScreencast",
    "Runtime.enable",
    "Runtime.addBinding",
    "Page.addScriptToEvaluateOnNewDocument",
    "Runtime.evaluate",
  ]);
  const discover = sock.peer.messages.find((m) => m.method === "Target.setDiscoverTargets");
  assert.ok(discover, "Target.setDiscoverTargets was sent");
  assert.deepEqual(discover.params, { discover: true });
  const screencast = sock.peer.messages.find((m) => m.method === "Page.startScreencast");
  assert.ok(screencast, "Page.startScreencast was sent");
  assert.ok(screencast.params, "startScreencast carries params");
  assert.equal(screencast.params.format, "jpeg");
  assert.equal(screencast.params.maxWidth, 800);
  assert.equal(screencast.params.maxHeight, 600);

  await stopAndDrain(companion, sock.peer);
});

test("cdp adapter forwards server-side editable focus events through the existing event wire", async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    browser_session_id: "bs_focus",
    WebSocketCtor: FakeSocket,
    wsUrl: "ws://fake/page-focus",
  });
  const events: CdpEvent[] = [];
  companion.onEvent((event) => events.push(event));
  const startPromise = companion.start();
  await flush();
  const sock = findSocket(sockets, "ws://fake/page-focus");
  assert.ok(sock, "adapter opened a socket");
  await startAndDrainNoViewport(sock.peer);
  await startPromise;

  sock.peer.deliver({
    method: "Runtime.bindingCalled",
    params: {
      executionContextId: 7,
      name: "__remoteSurfaceTextInputFocus",
      payload: JSON.stringify({ focused: true, inputType: "text", tagName: "input" }),
    },
  });
  await flush();
  assert.deepEqual(events, [
    {
      element: { inputType: "text", tagName: "input" },
      focused: true,
      kind: "keyboard_focus",
    },
  ]);

  await stopAndDrain(companion, sock.peer);
});

test("cdp adapter dispatches frames to onFrame subscribers and acks back-pressure", async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    browser_session_id: "bs_test_2",
    WebSocketCtor: FakeSocket,
    wsUrl: "ws://fake/page",
  });

  const frames: { sessionId: unknown; data: unknown; metadata: unknown }[] = [];
  companion.onFrame((f) => frames.push(f));

  const startPromise = companion.start({ height: 480, width: 320 });
  await flush();
  const sock = findSocket(sockets, "ws://fake/page");
  assert.ok(sock, "adapter opened a socket");
  await startAndDrainViewport(sock.peer);
  await startPromise;

  // Push a screencast frame from the "browser".
  sock.peer.deliver({
    method: "Page.screencastFrame",
    params: {
      data: "AA==",
      metadata: { device_height: 480, device_width: 320 },
      sessionId: 42,
    },
  });
  const frameAck = await waitForMessage(sock.peer, "Page.screencastFrameAck");
  frameAck.__answered = true;
  sock.peer.deliver({ id: frameAck.id, result: {} });
  await flush();
  assert.equal(frames.length, 1);
  const [frame] = frames;
  assert.ok(frame, "a screencast frame was captured");
  assert.equal(frame.sessionId, 42);
  assert.equal(frame.data, "AA==");
  assert.equal((frame.metadata as { device_width: number }).device_width, 320);

  const lateFrames: { sessionId: unknown; data: unknown; metadata: unknown }[] = [];
  const unsubscribeLate = companion.onFrame((f) => lateFrames.push(f));
  assert.equal(lateFrames.length, 1);
  const [lateFrame] = lateFrames;
  assert.ok(lateFrame, "a late-subscribed frame was captured");
  assert.equal(lateFrame.sessionId, 42);
  unsubscribeLate();

  // Remote Surface's server backend owns the frame acknowledgement. The
  // compatibility hook must not issue a second ack.
  await companion.ackFrame(42);
  assert.equal(sock.peer.messages.filter((m) => m.method === "Page.screencastFrameAck").length, 1);

  await stopAndDrain(companion, sock.peer);
});

test("cdp adapter maps wire input events through mapInputEventToCdp", async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    browser_session_id: "bs_test_3",
    WebSocketCtor: FakeSocket,
    wsUrl: "ws://fake/page",
  });
  const startPromise = companion.start();
  await flush();
  const sock = findSocket(sockets, "ws://fake/page");
  assert.ok(sock, "adapter opened a socket");
  await startAndDrainNoViewport(sock.peer);
  await startPromise;

  // Helper: answer a typed Input.dispatchMouseEvent matching `mouseType`.
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const peer = sock.peer;
  async function answerMouse(mouseType: string): Promise<CdpMessage> {
    const deadline = Date.now() + 200;
    while (Date.now() < deadline) {
      const msg = peer.messages.find(
        (m) => m.method === "Input.dispatchMouseEvent" && m.params?.type === mouseType && !m.__answered
      );
      if (msg) {
        msg.__answered = true;
        peer.deliver({ id: msg.id, result: {} });
        // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
        await flush();
        return msg;
      }
      await flush();
    }
    throw new Error(`Timed out waiting for Input.dispatchMouseEvent type=${mouseType}`);
  }

  // Click is two CDP commands: mousePressed + mouseReleased.
  const clickPromise = companion.dispatch({ action: "click", button: 0, type: "mouse", x: 10, y: 20 });
  await answerMouse("mousePressed");
  await answerMouse("mouseReleased");
  await clickPromise;

  // Keydown produces one CDP command.
  const keyPromise = companion.dispatch({ action: "keydown", key: "a", type: "keyboard" });
  await answerInOrder(sock.peer, "Input.dispatchKeyEvent");
  await keyPromise;

  // Viewport resize updates CDP device metrics and restarts the screencast so
  // maxWidth/maxHeight track the operator's current frame.
  const viewportPromise = companion.dispatch({
    deviceScaleFactor: 3,
    height: 844,
    mobile: true,
    type: "viewport",
    width: 390,
  });
  const metrics = await waitForMessage(sock.peer, "Emulation.setDeviceMetricsOverride");
  metrics.__answered = true;
  sock.peer.deliver({ id: metrics.id, result: {} });
  await answerInOrder(sock.peer, "Emulation.setTouchEmulationEnabled");
  await answerInOrder(sock.peer, "Emulation.setUserAgentOverride");
  await answerInOrder(sock.peer, "Page.stopScreencast");
  const restart = await waitForMessage(sock.peer, "Page.startScreencast");
  restart.__answered = true;
  sock.peer.deliver({ id: restart.id, result: {} });
  await viewportPromise;
  assert.deepEqual(metrics.params, {
    deviceScaleFactor: 3,
    height: 844,
    mobile: true,
    screenHeight: 844,
    screenWidth: 390,
    width: 390,
  });
  assert.ok(restart.params, "restarted screencast carries params");
  assert.equal(restart.params.maxWidth, undefined);
  assert.equal(restart.params.maxHeight, undefined);

  await stopAndDrain(companion, sock.peer);
});

test("normalizeTouchPointerInputForCdp remaps touch/pen press-or-release to mouse with clickCount", () => {
  const touchDown = { action: "pointerdown", pointerType: "touch", type: "pointer", x: 10, y: 20 };
  assert.deepEqual(normalizeTouchPointerInputForCdp(touchDown), {
    action: "pointerdown",
    clickCount: 1,
    pointerType: "mouse",
    type: "pointer",
    x: 10,
    y: 20,
  });

  const penUp = { action: "pointerup", pointerType: "pen", type: "pointer", x: 5, y: 6 };
  assert.deepEqual(normalizeTouchPointerInputForCdp(penUp), {
    action: "pointerup",
    clickCount: 1,
    pointerType: "mouse",
    type: "pointer",
    x: 5,
    y: 6,
  });

  const touchCancel = { action: "pointercancel", pointerType: "touch", type: "pointer", x: 1, y: 2 };
  assert.equal(normalizeTouchPointerInputForCdp(touchCancel).pointerType, "mouse");

  // A caller-supplied clickCount (e.g. a double-tap) is preserved, not
  // clobbered to 1.
  const doubleTouchDown = {
    action: "pointerdown",
    clickCount: 2,
    pointerType: "touch",
    type: "pointer",
    x: 10,
    y: 20,
  };
  assert.equal(normalizeTouchPointerInputForCdp(doubleTouchDown).clickCount, 2);

  // Left alone: mouse pointer events (already the working path), touch
  // pointermove (drag/scroll already works per the reported symptom), and
  // non-pointer wire events.
  const mouseDown = { action: "pointerdown", pointerType: "mouse", type: "pointer", x: 1, y: 1 };
  assert.equal(normalizeTouchPointerInputForCdp(mouseDown), mouseDown);
  const touchMove = { action: "pointermove", pointerType: "touch", type: "pointer", x: 1, y: 1 };
  assert.equal(normalizeTouchPointerInputForCdp(touchMove), touchMove);
  const keyboardEvent = { action: "keydown", key: "a", type: "keyboard" };
  assert.equal(normalizeTouchPointerInputForCdp(keyboardEvent), keyboardEvent);
});

test("cdp adapter dispatch() routes a touch tap through Input.dispatchMouseEvent, not dispatchTouchEvent", async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    browser_session_id: "bs_touch_tap",
    WebSocketCtor: FakeSocket,
    wsUrl: "ws://fake/page",
  });
  const startPromise = companion.start();
  await flush();
  const sock = findSocket(sockets, "ws://fake/page");
  assert.ok(sock, "adapter opened a socket");
  await startAndDrainNoViewport(sock.peer);
  await startPromise;

  // This is the exact wire shape the console's remote-surface pointer input
  // controller sends for a real touchscreen tap (verified live: a Reddit
  // reCAPTCHA checkbox tapped at these coordinates via CDP
  // Input.dispatchTouchEvent alone stayed unchecked; the equivalent mouse
  // click at the same coordinates advanced the challenge).
  const downPromise = companion.dispatch({
    action: "pointerdown",
    button: 0,
    pointerId: 1,
    pointerType: "touch",
    type: "pointer",
    x: 205,
    y: 468,
  });
  const pressed = await waitForMessage(sock.peer, "Input.dispatchMouseEvent");
  assert.equal(pressed.params?.type, "mousePressed");
  assert.equal(pressed.params?.clickCount, 1);
  assert.equal(pressed.params?.x, 205);
  assert.equal(pressed.params?.y, 468);
  pressed.__answered = true;
  sock.peer.deliver({ id: pressed.id, result: {} });
  await downPromise;

  const upPromise = companion.dispatch({
    action: "pointerup",
    button: 0,
    pointerId: 1,
    pointerType: "touch",
    type: "pointer",
    x: 205,
    y: 468,
  });
  const released = await waitForMessage(sock.peer, "Input.dispatchMouseEvent");
  assert.equal(released.params?.type, "mouseReleased");
  assert.equal(released.params?.clickCount, 1);
  released.__answered = true;
  sock.peer.deliver({ id: released.id, result: {} });
  await upPromise;

  const touchMethods = sock.peer.messages.filter((m) => m.method === "Input.dispatchTouchEvent");
  assert.equal(touchMethods.length, 0, "a stationary touch tap must not use Input.dispatchTouchEvent");

  await stopAndDrain(companion, sock.peer);
});

test("cdp adapter surfaces CDP error responses via dispatch()", async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    browser_session_id: "bs_err",
    WebSocketCtor: FakeSocket,
    wsUrl: "ws://fake/page",
  });
  const startPromise = companion.start();
  await flush();
  const sock = findSocket(sockets, "ws://fake/page");
  assert.ok(sock, "adapter opened a socket");
  await startAndDrainNoViewport(sock.peer);
  await startPromise;

  const dispatchP = companion.dispatch({ text: "hello", type: "paste" });
  const insert = await waitForMessage(sock.peer, "Input.insertText");
  insert.__answered = true;
  sock.peer.deliver({ error: { code: -32_000, message: "cdp boom" }, id: insert.id });
  await assert.rejects(
    dispatchP,
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    (err: Error & { code?: string }) => err.code === "cdp_error" && /cdp boom/.test(err.message)
  );

  await stopAndDrain(companion, sock.peer);
});

test("cdp adapter rejects pending commands when the socket closes", async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    browser_session_id: "bs_close",
    WebSocketCtor: FakeSocket,
    wsUrl: "ws://fake/page",
  });
  const startPromise = companion.start();
  // Let discovery complete, wait until the assembled backend has issued its
  // first command, then close the socket without answering. The close handler
  // must reject all pending commands with `cdp_closed`.
  const sock = await (async () => {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
      await flush();
      const found = findSocket(sockets, "ws://fake/page");
      // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
      if (found?.peer.messages.some((m) => m.method === "Target.setDiscoverTargets")) {
        return found;
      }
    }
  })();
  const discover = await waitForMessage(sock.peer, "Target.setDiscoverTargets");
  discover.__answered = true;
  sock.peer.deliver({ id: discover.id, result: {} });
  await waitForMessage(sock.peer, "Page.enable");
  sock.peer.triggerClose();
  await assert.rejects(startPromise, (err: Error & { code?: string }) => err.code === "cdp_closed");
});

test("createDefaultStreamingCompanionFactory returns null when no resolver is supplied", () => {
  // No resolver → factory is null. Route layer maps this to 503
  // streaming_companion_unavailable. Operators must wire the run-target
  // registry resolver explicitly; there is no env-var fallback.
  assert.equal(createDefaultStreamingCompanionFactory({}), null);
  assert.equal(createDefaultStreamingCompanionFactory({ resolveTargetForInteraction: null }), null);
  assert.equal(createDefaultStreamingCompanionFactory(), null);
});

test("createDefaultStreamingCompanionFactory returns a factory when resolver is supplied", () => {
  const { FakeSocket } = makeFakeSocketCtor();
  const factory = createDefaultStreamingCompanionFactory({
    resolveTargetForInteraction: () => "ws://fake/page",
    WebSocketCtor: FakeSocket,
  });
  assert.equal(typeof factory, "function");
});

test("resolver-backed companion: returns null companion when run_id or interaction_id is missing", () => {
  const { FakeSocket } = makeFakeSocketCtor();
  const factory = createDefaultStreamingCompanionFactory({
    resolveTargetForInteraction: () => "ws://fake/page",
    WebSocketCtor: FakeSocket,
  });
  assert.ok(factory, "factory was created");
  // Missing both.
  assert.equal(factory({ browser_session_id: "bs_x" }), null);
  // Missing run_id.
  assert.equal(factory({ browser_session_id: "bs_x", interaction_id: "int_a" }), null);
  // Empty run_id.
  assert.equal(factory({ browser_session_id: "bs_x", interaction_id: "int_a", run_id: "" }), null);
  // Missing interaction_id — composite key is not satisfiable.
  assert.equal(factory({ browser_session_id: "bs_x", run_id: "run_xyz" }), null);
  // Empty interaction_id.
  assert.equal(factory({ browser_session_id: "bs_x", interaction_id: "", run_id: "run_xyz" }), null);
});

test("resolver-backed companion: passes both run_id and interaction_id through to resolver", async () => {
  const { FakeSocket } = makeFakeSocketCtor();
  let seenArgs: { runId: string; interactionId: string } | null = null;
  const factory = createDefaultStreamingCompanionFactory({
    resolveTargetForInteraction: (runId, interactionId) => {
      seenArgs = { interactionId, runId };
      return null;
    },
    WebSocketCtor: FakeSocket,
  });
  assert.ok(factory, "factory was created");
  const companion = factory({
    browser_session_id: "bs_resolver_args",
    interaction_id: "int_resolver_args",
    run_id: "run_resolver_args",
  });
  assert.ok(companion, "resolved companion shim was created");
  await assert.rejects(
    companion.start({ height: 100, width: 100 }),
    (err: Error & { code?: string }) => err.code === "streaming_target_unregistered"
  );
  assert.deepEqual(seenArgs, {
    interactionId: "int_resolver_args",
    runId: "run_resolver_args",
  });
  await companion.stop();
});

test("resolver-backed companion: rejects start with streaming_target_unregistered when resolver returns null", async () => {
  const { FakeSocket } = makeFakeSocketCtor();
  const factory = createDefaultStreamingCompanionFactory({
    resolveTargetForInteraction: () => null,
    WebSocketCtor: FakeSocket,
  });
  assert.ok(factory, "factory was created");
  const companion = factory({
    browser_session_id: "bs_y",
    interaction_id: "int_xyz",
    run_id: "run_xyz",
  });
  assert.ok(companion, "companion shim built even when resolver currently has no record");
  await assert.rejects(
    companion.start({ height: 100, width: 100 }),
    (err: Error & { code?: string }) => err.code === "streaming_target_unregistered"
  );
  await companion.stop();
});

test("resolver-backed companion: pre-start onFrame unsubscribe revokes registration after start", async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const factory = createDefaultStreamingCompanionFactory({
    resolveTargetForInteraction: () => "ws://fake/page-resolver-unsub",
    WebSocketCtor: FakeSocket,
  });
  assert.ok(factory, "factory was created");
  const companion = factory({
    browser_session_id: "bs_resolver_unsub",
    interaction_id: "int_resolver_unsub",
    run_id: "run_resolver_unsub",
  });
  assert.ok(companion, "resolved companion shim was created");

  // Subscribe BEFORE start — exercises the pendingHandlers replay path.
  let received = 0;
  const off = companion.onFrame(() => {
    // biome-ignore lint/style/noIncrementDecrement: localized test assertion preserves its explicit contract.
    received++;
  });

  const startPromise = companion.start({ height: 100, width: 100 });
  // Wait for the inner socket to be created (lazy on start).
  let sock: FakeSocketHandle | undefined;
  // biome-ignore lint/style/noIncrementDecrement: localized test assertion preserves its explicit contract.
  for (let i = 0; i < 20 && !sock; i++) {
    // eslint-disable-next-line no-await-in-loop
    // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
    await flush();
    sock = findSocket(sockets, "ws://fake/page-resolver-unsub");
  }
  assert.ok(sock, "inner CDP socket was opened from the resolved ws URL");
  await startAndDrainViewport(sock.peer);
  await startPromise;

  // Sanity: a frame delivered now MUST reach the handler — the pre-start
  // subscriber was successfully replayed into the inner companion.
  sock.peer.deliver({
    method: "Page.screencastFrame",
    params: { data: "AA==", metadata: {}, sessionId: 1 },
  });
  const firstFrameAck = await waitForMessage(sock.peer, "Page.screencastFrameAck");
  firstFrameAck.__answered = true;
  sock.peer.deliver({ id: firstFrameAck.id, result: {} });
  await flush();
  assert.equal(received, 1, "pre-start subscriber received a frame after start");

  // Unsubscribe. After this, further frames must NOT reach the handler.
  off();
  sock.peer.deliver({
    method: "Page.screencastFrame",
    params: { data: "BB==", metadata: {}, sessionId: 2 },
  });
  const secondFrameAck = await waitForMessage(sock.peer, "Page.screencastFrameAck");
  secondFrameAck.__answered = true;
  sock.peer.deliver({ id: secondFrameAck.id, result: {} });
  await flush();
  assert.equal(received, 1, "unsubscribe revoked inner-companion registration too");

  await stopAndDrain(companion, sock.peer);
});

// ── Out-of-band wire events: URL changes and popups ─────────────────────────

test("cdp adapter emits url_changed for main-frame Page.frameNavigated and ignores sub-frames", async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    browser_session_id: "bs_url_main",
    WebSocketCtor: FakeSocket,
    wsUrl: "ws://fake/devtools/page/tg_main",
  });
  const events: CdpEvent[] = [];
  companion.onEvent((e) => events.push(e));
  const startPromise = companion.start();
  await flush();
  const sock = findSocket(sockets, "ws://fake/devtools/page/tg_main");
  assert.ok(sock, "adapter opened a socket");
  await startAndDrainNoViewport(sock.peer);
  await startPromise;

  // Iframe nav must NOT emit (parentId is set).
  sock.peer.deliver({
    method: "Page.frameNavigated",
    params: {
      frame: { id: "sub_1", parentId: "main_0", url: "https://ad.example.com/iframe" },
    },
  });
  await flush();
  assert.equal(events.length, 0, "sub-frame nav must not emit url_changed");

  // Main-frame nav (no parentId) emits.
  sock.peer.deliver({
    method: "Page.frameNavigated",
    params: {
      frame: { id: "main_0", url: "https://example.com/login" },
    },
  });
  await flush();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { kind: "url_changed", url: "https://example.com/login" });

  // Same URL again must NOT re-emit (de-dupe).
  sock.peer.deliver({
    method: "Page.frameNavigated",
    params: { frame: { id: "main_0", url: "https://example.com/login" } },
  });
  await flush();
  assert.equal(events.length, 1, "identical URL must not re-emit");

  // The registered page target is suppressed; its title is cached.
  sock.peer.deliver({
    method: "Target.targetCreated",
    params: { targetInfo: { targetId: "tg_main", title: "Sign in", type: "page", url: "https://example.com/login" } },
  });
  await flush();
  assert.equal(events.length, 1, "registered page target is suppressed");

  // Now navigate again — title should appear because it was cached.
  sock.peer.deliver({
    method: "Page.frameNavigated",
    params: { frame: { id: "main_0", url: "https://example.com/home" } },
  });
  await flush();
  assert.equal(events.length, 2);
  const [, secondEvent] = events;
  assert.ok(secondEvent, "second url_changed event was captured");
  assert.equal(secondEvent.kind, "url_changed");
  assert.equal(secondEvent.url, "https://example.com/home");
  assert.equal(secondEvent.title, "Sign in");

  await stopAndDrain(companion, sock.peer);
});

test("cdp adapter emits popup_opened/closed for user-relevant child page targets", async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    browser_session_id: "bs_popup",
    WebSocketCtor: FakeSocket,
    wsUrl: "ws://fake/page-popup",
  });
  const events: CdpEvent[] = [];
  companion.onEvent((e) => events.push(e));
  const startPromise = companion.start();
  await flush();
  const sock = findSocket(sockets, "ws://fake/page-popup");
  assert.ok(sock, "adapter opened a socket");
  await startAndDrainNoViewport(sock.peer);
  await startPromise;

  // First page target = our own page; suppressed.
  sock.peer.deliver({
    method: "Target.targetCreated",
    params: { targetInfo: { targetId: "tg_self", title: "Home", type: "page", url: "https://example.com" } },
  });
  await flush();
  assert.equal(events.length, 0, "own page target is not a popup");

  // Non-page targets are ignored.
  sock.peer.deliver({
    method: "Target.targetCreated",
    params: { targetInfo: { targetId: "tg_sw", type: "service_worker", url: "https://example.com/sw.js" } },
  });
  await flush();
  assert.equal(events.length, 0, "non-page targets must not emit popup_opened");

  // Second page target → popup.
  sock.peer.deliver({
    method: "Target.targetCreated",
    params: {
      targetInfo: {
        openerId: "tg_self",
        targetId: "tg_popup",
        type: "page",
        url: "https://oauth.example.com/auth",
      },
    },
  });
  await flush();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    kind: "popup_opened",
    targetId: "tg_popup",
    url: "https://oauth.example.com/auth",
  });

  // Target discovery can replay the same target. Its target ID proves this
  // is the same transition, so the adapter must not announce it twice.
  sock.peer.deliver({
    method: "Target.targetCreated",
    params: {
      targetInfo: {
        openerId: "tg_self",
        targetId: "tg_popup",
        type: "page",
        url: "https://oauth.example.com/auth",
      },
    },
  });
  await flush();
  assert.equal(events.length, 1, "the same popup target must not be announced twice");

  // Destroying the popup emits popup_closed.
  sock.peer.deliver({ method: "Target.targetDestroyed", params: { targetId: "tg_popup" } });
  await flush();
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], { kind: "popup_closed", targetId: "tg_popup" });

  // Destroying our own page does NOT emit popup_closed (teardown handles it).
  sock.peer.deliver({ method: "Target.targetDestroyed", params: { targetId: "tg_self" } });
  await flush();
  assert.equal(events.length, 2, "own page destruction must not emit popup_closed");

  // Destroying an unknown targetId is a no-op (no popup was announced for it).
  sock.peer.deliver({ method: "Target.targetDestroyed", params: { targetId: "tg_never_seen" } });
  await flush();
  assert.equal(events.length, 2);

  await stopAndDrain(companion, sock.peer);
});

test("cdp adapter only announces a nonblank child of the registered page target", async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    browser_session_id: "bs_popup_classification",
    WebSocketCtor: FakeSocket,
    wsUrl: "ws://fake/devtools/page/tg_adopted",
  });
  const events: CdpEvent[] = [];
  companion.onEvent((e) => events.push(e));
  const startPromise = companion.start();
  await flush();
  const sock = findSocket(sockets, "ws://fake/devtools/page/tg_adopted");
  assert.ok(sock, "adapter opened a socket");
  await startAndDrainNoViewport(sock.peer);
  await startPromise;

  // Discovery can replay an auxiliary page before the exact registered page.
  // It is not a popup, and the provider's navigation on the registered page
  // is not a popup either.
  sock.peer.deliver({
    method: "Target.targetCreated",
    params: { targetInfo: { targetId: "tg_aux", type: "page", url: "about:blank" } },
  });
  sock.peer.deliver({
    method: "Target.targetCreated",
    params: {
      targetInfo: {
        targetId: "tg_adopted",
        type: "page",
        url: "https://accounts.google.com/signin",
      },
    },
  });
  // Provider redirects on the adopted page are URL changes, not popups.
  sock.peer.deliver({
    method: "Target.targetInfoChanged",
    params: {
      targetInfo: {
        targetId: "tg_adopted",
        type: "page",
        url: "https://accounts.google.com/consent",
      },
    },
  });
  // Same-flow target churn has no opener relationship to the adopted page.
  sock.peer.deliver({
    method: "Target.targetCreated",
    params: {
      targetInfo: {
        targetId: "tg_churn",
        type: "page",
        url: "https://accounts.google.com/continue",
      },
    },
  });
  // A genuine popup is a nonblank child of the adopted page.
  sock.peer.deliver({
    method: "Target.targetCreated",
    params: {
      targetInfo: {
        openerId: "tg_adopted",
        targetId: "tg_popup",
        type: "page",
        url: "https://oauth.example.com/auth",
      },
    },
  });
  // Some providers create the child as about:blank, then navigate it.
  sock.peer.deliver({
    method: "Target.targetCreated",
    params: {
      targetInfo: {
        openerId: "tg_adopted",
        targetId: "tg_blank_popup",
        type: "page",
        url: "about:blank",
      },
    },
  });
  sock.peer.deliver({
    method: "Target.targetInfoChanged",
    params: {
      targetInfo: {
        openerId: "tg_adopted",
        targetId: "tg_blank_popup",
        type: "page",
        url: "https://oauth.example.com/blank-child-auth",
      },
    },
  });
  await flush();

  assert.deepEqual(events[0], { kind: "url_changed", url: "https://accounts.google.com/consent" });
  assert.deepEqual(
    events.filter((event) => event.kind === "popup_opened"),
    [
      { kind: "popup_opened", targetId: "tg_popup", url: "https://oauth.example.com/auth" },
      { kind: "popup_opened", targetId: "tg_blank_popup", url: "https://oauth.example.com/blank-child-auth" },
    ]
  );

  sock.peer.deliver({ method: "Target.targetDestroyed", params: { targetId: "tg_popup" } });
  sock.peer.deliver({ method: "Target.targetDestroyed", params: { targetId: "tg_blank_popup" } });
  await flush();
  assert.deepEqual(events.slice(3), [
    { kind: "popup_closed", targetId: "tg_popup" },
    { kind: "popup_closed", targetId: "tg_blank_popup" },
  ]);

  await stopAndDrain(companion, sock.peer);
});

test("cdp adapter emits url_changed from Target.targetInfoChanged for SPA navigation", async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    browser_session_id: "bs_spa",
    WebSocketCtor: FakeSocket,
    wsUrl: "ws://fake/page-spa",
  });
  const events: CdpEvent[] = [];
  companion.onEvent((e) => events.push(e));
  const startPromise = companion.start();
  await flush();
  const sock = findSocket(sockets, "ws://fake/page-spa");
  assert.ok(sock, "adapter opened a socket");
  await startAndDrainNoViewport(sock.peer);
  await startPromise;

  // Establish own page target.
  sock.peer.deliver({
    method: "Target.targetCreated",
    params: { targetInfo: { targetId: "tg_self", title: "App", type: "page", url: "https://app.example.com/" } },
  });
  await flush();
  assert.equal(events.length, 0);

  // SPA in-document nav fires only `targetInfoChanged` (no Page.frameNavigated).
  sock.peer.deliver({
    method: "Target.targetInfoChanged",
    params: {
      targetInfo: {
        targetId: "tg_self",
        title: "Settings · App",
        type: "page",
        url: "https://app.example.com/settings",
      },
    },
  });
  await flush();
  assert.equal(events.length, 1);
  const [spaEvent] = events;
  assert.ok(spaEvent, "SPA nav event was captured");
  assert.equal(spaEvent.kind, "url_changed");
  assert.equal(spaEvent.url, "https://app.example.com/settings");
  assert.equal(spaEvent.title, "Settings · App");

  await stopAndDrain(companion, sock.peer);
});

test("cdp adapter onEvent unsubscribe stops further deliveries", async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    browser_session_id: "bs_event_unsub",
    WebSocketCtor: FakeSocket,
    wsUrl: "ws://fake/page-unsub",
  });
  const events: CdpEvent[] = [];
  const off = companion.onEvent((e) => events.push(e));
  const startPromise = companion.start();
  await flush();
  const sock = findSocket(sockets, "ws://fake/page-unsub");
  assert.ok(sock, "adapter opened a socket");
  await startAndDrainNoViewport(sock.peer);
  await startPromise;

  sock.peer.deliver({
    method: "Page.frameNavigated",
    params: { frame: { id: "m", url: "https://a/" } },
  });
  await flush();
  assert.equal(events.length, 1);

  off();
  sock.peer.deliver({
    method: "Page.frameNavigated",
    params: { frame: { id: "m", url: "https://b/" } },
  });
  await flush();
  assert.equal(events.length, 1, "unsubscribe stopped delivery");

  await stopAndDrain(companion, sock.peer);
});

test("cdp adapter survives Target.setDiscoverTargets failure on start", async () => {
  // Per the requirement: if Target discovery fails (some embedders restrict
  // it on a per-target connection), start() must still succeed and the
  // streaming session must remain usable for screencast + input. Popup/URL
  // events simply will not arrive.
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const companion = createCdpCompanion({
    browser_session_id: "bs_discover_fail",
    WebSocketCtor: FakeSocket,
    wsUrl: "ws://fake/page-discover-fail",
  });
  const startPromise = companion.start({ height: 100, width: 100 });
  await flush();
  const sock = findSocket(sockets, "ws://fake/page-discover-fail");
  assert.ok(sock, "adapter opened a socket");

  // Reject Target.setDiscoverTargets.
  const discover = await waitForMessage(sock.peer, "Target.setDiscoverTargets");
  discover.__answered = true;
  sock.peer.deliver({ error: { code: -32_601, message: "method not supported" }, id: discover.id });
  await flush();
  // start() must continue past the failed discover with no propagated rejection.
  await answerInOrder(sock.peer, "Emulation.setDeviceMetricsOverride");
  await answerInOrder(sock.peer, "Emulation.setTouchEmulationEnabled");
  await answerInOrder(sock.peer, "Page.enable");
  await answerInOrder(sock.peer, "Page.startScreencast");
  await answerInOrder(sock.peer, "Runtime.enable");
  await answerInOrder(sock.peer, "Runtime.addBinding");
  await answerInOrder(sock.peer, "Page.addScriptToEvaluateOnNewDocument");
  await answerInOrder(sock.peer, "Runtime.evaluate");
  await startPromise;

  await stopAndDrain(companion, sock.peer);
});

test("resolver-backed companion: pre-start onEvent replays into inner companion after start", async () => {
  const { FakeSocket, sockets } = makeFakeSocketCtor();
  const factory = createDefaultStreamingCompanionFactory({
    resolveTargetForInteraction: () => "ws://fake/page-resolver-events",
    WebSocketCtor: FakeSocket,
  });
  assert.ok(factory, "factory was created");
  const companion = factory({
    browser_session_id: "bs_resolver_events",
    interaction_id: "int_resolver_events",
    run_id: "run_resolver_events",
  });
  assert.ok(companion, "resolved companion shim was created");

  const events: CdpEvent[] = [];
  const off = companion.onEvent((e) => events.push(e));

  const startPromise = companion.start({ height: 100, width: 100 });
  let sock: FakeSocketHandle | undefined;
  // biome-ignore lint/style/noIncrementDecrement: localized test assertion preserves its explicit contract.
  for (let i = 0; i < 20 && !sock; i++) {
    // eslint-disable-next-line no-await-in-loop
    // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
    await flush();
    sock = findSocket(sockets, "ws://fake/page-resolver-events");
  }
  assert.ok(sock);
  await startAndDrainViewport(sock.peer);
  await startPromise;

  // Pre-start subscriber must receive events emitted by the inner companion.
  sock.peer.deliver({
    method: "Page.frameNavigated",
    params: { frame: { id: "m", url: "https://resolved.example/" } },
  });
  await flush();
  assert.equal(events.length, 1);
  const [resolvedEvent] = events;
  assert.ok(resolvedEvent, "pre-start subscriber received the resolved-companion event");
  assert.equal(resolvedEvent.url, "https://resolved.example/");

  // Unsubscribe revokes inner registration too.
  off();
  sock.peer.deliver({
    method: "Page.frameNavigated",
    params: { frame: { id: "m", url: "https://resolved.example/two" } },
  });
  await flush();
  assert.equal(events.length, 1, "pre-start onEvent unsubscribe revoked inner registration");

  await stopAndDrain(companion, sock.peer);
});
