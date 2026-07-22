// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createNekoViewerInputRouter,
  type NekoClientApi,
  type NekoPointerControl,
  NekoSurfaceAdapter,
} from "@opendatalabs/remote-surface/client";
import type { RemoteSurfaceInputPayload } from "@opendatalabs/remote-surface/protocol";
import {
  completeNekoTouchScrollGesture,
  deliverNekoFallbackTap,
  deliverNekoTouchScrollSteps,
} from "./neko-client.ts";
import {
  cancelActiveViewerPresses,
  createActiveViewerPresses,
  trackActiveViewerPress,
} from "./stream-viewer-active-presses.ts";
import { mapPointerToStreamViewport } from "./stream-viewer-geometry.ts";

type NekoControlCall =
  | { type: "buttonDown" | "buttonUp"; button: number; x: number; y: number }
  | { type: "move"; x: number; y: number }
  | { type: "scroll"; controlKey: boolean; deltaX: number; deltaY: number };

const VIEWER_POINTER_DISPATCH_RE = /viewer\.dispatchInput\(pointerIntent\)/;
const VIEWER_WHEEL_DISPATCH_RE = /viewer\.dispatchInput\(\{\s*action:\s*"wheel"/;
const DIRECT_ADAPTER_POINTER_DISPATCH_RE = /adapter\.sendPointer\(/;
const TOUCH_BRIDGE_VIEWER_DISPATCH_RE = /startMobileTouchScrollBridge\(neko, options\.dispatchInput\)/;
const TOUCH_SCROLL_WHEEL_INTENT_RE = /if \(options\.dispatchInput\) \{[\s\S]{0,400}source:\s*"touch-gesture"/;
const TOUCH_SCROLL_BOUNDARY_RE = /function dispatchNekoTouchScrollBoundary\([\s\S]{0,500}deltaX:\s*0,[\s\S]{0,100}deltaY:\s*0,[\s\S]{0,100}gestureBoundary:\s*true/;
const TOUCH_SCROLL_TERMINAL_HANDLER_RE = /function completeNekoTouchScrollGesture\([\s\S]{0,700}dispatchNekoTouchScrollBoundary\(state, dispatchInput\)/;
const FALLBACK_TAP_DELIVERY_RE = /function deliverNekoFallbackTap\([\s\S]{0,1000}if \(!dispatchInput\) \{[\s\S]{0,300}clickNekoAt\([\s\S]{0,1000}action: "pointerdown"[\s\S]{0,500}action: "pointerup"/;
const MOUNTED_FALLBACK_TAP_RE = /deliverNekoFallbackTap\(\{ interactionSeq: state\.interactionSeq, pointerId: state\.id \}, touch, dispatchInput\)/;
const REMOUNT_CANCEL_RE = /cancelActiveViewerPresses\(activeViewerPressesRef\.current, \(intent\) => mountedViewer\.dispatchInput\(intent\)\)/;
const VIEWER_INPUT_DIAGNOSTIC_RE = /onInputDiagnostic:\s*\(event\)[\s\S]{0,400}remote_surface_viewer\.input/;

interface TouchGesture {
  end: { clientX: number; clientY: number };
  moves: readonly { clientX: number; clientY: number }[];
  start: { clientX: number; clientY: number };
}

function createMountedAdapter(mapPointerToRemote = (x: number, y: number) => ({ x, y })) {
  const calls: NekoControlCall[] = [];
  const control: NekoPointerControl = {
    buttonDown(button, pos) {
      calls.push({ button, type: "buttonDown", ...pos });
    },
    buttonUp(button, pos) {
      calls.push({ button, type: "buttonUp", ...pos });
    },
    move(pos) {
      calls.push({ type: "move", ...pos });
    },
    scroll(step) {
      calls.push({ controlKey: step.controlKey ?? false, type: "scroll", deltaX: step.deltaX, deltaY: step.deltaY });
    },
  };
  const client: NekoClientApi = {
    getPointerControl: () => control,
    mapPointerToRemote,
    start: async () => undefined,
    stop: () => undefined,
  };
  const adapter = new NekoSurfaceAdapter({
    client,
    config: { kind: "neko" } as never,
  });
  const bridgeControl = {
    move(pos: { x: number; y: number }) {
      calls.push({ type: "move", ...pos });
    },
    scroll(scroll: { control_key?: boolean; delta_x: number; delta_y: number }) {
      calls.push({
        controlKey: scroll.control_key ?? false,
        deltaX: scroll.delta_x,
        deltaY: scroll.delta_y,
        type: "scroll",
      });
    },
  };
  return { adapter, bridgeControl, calls, control };
}

async function mountAdapter(adapter: NekoSurfaceAdapter): Promise<void> {
  await adapter.mount({} as HTMLElement);
}

function deliverProductionDirectTouchScroll(
  control: ReturnType<typeof createMountedAdapter>["bridgeControl"],
  gesture: TouchGesture
): void {
  let state = {
    accumulatedX: 0,
    accumulatedY: 0,
    lastX: gesture.start.clientX,
    lastY: gesture.start.clientY,
  };
  for (const touch of gesture.moves) {
    state = deliverNekoTouchScrollSteps(state, touch, {
      control,
      mapControlPos: (clientX, clientY) => ({ x: clientX, y: clientY }),
    });
  }
}

function deliverProductionRoutedTouchScroll(
  dispatchInput: (intent: Extract<RemoteSurfaceInputPayload, { type: "pointer" }>) => void,
  gesture: TouchGesture
): void {
  let state = {
    accumulatedX: 0,
    accumulatedY: 0,
    lastX: gesture.start.clientX,
    lastY: gesture.start.clientY,
  };
  const directControl = {
    move() {
      assert.fail("mounted touch delivery must not call direct control.move");
    },
    scroll() {
      assert.fail("mounted touch delivery must not call direct control.scroll");
    },
  };
  for (const touch of gesture.moves) {
    state = deliverNekoTouchScrollSteps(state, touch, {
      control: directControl,
      dispatchInput,
      mapControlPos: () => {
        assert.fail("mounted touch delivery must not map a direct control position");
      },
    });
  }
  completeNekoTouchScrollGesture({ ...state, scrolling: true }, gesture.end, dispatchInput);
}

const pointerGesture: readonly Extract<RemoteSurfaceInputPayload, { type: "pointer" }>[] = [
  { action: "pointerdown", button: 0, pointerId: 1, pointerType: "mouse", type: "pointer", x: 80, y: 120 },
  { action: "pointermove", button: 0, pointerId: 1, pointerType: "mouse", type: "pointer", x: 110, y: 150 },
  { action: "pointerup", button: 0, pointerId: 1, pointerType: "mouse", type: "pointer", x: 110, y: 150 },
];

const desktopWheelBurst: readonly Extract<RemoteSurfaceInputPayload, { type: "pointer" }>[] = [
  { action: "wheel", deltaX: 0, deltaY: 25, type: "pointer", x: 110, y: 150 },
  { action: "wheel", deltaX: 0, deltaY: 25, type: "pointer", x: 110, y: 150 },
];

const touchScrollGestures: readonly TouchGesture[] = [
  {
    end: { clientX: 152, clientY: 318 },
    moves: [{ clientX: 150, clientY: 330 }],
    start: { clientX: 150, clientY: 360 },
  },
  {
    end: { clientX: 145, clientY: 287 },
    moves: [{ clientX: 150, clientY: 300 }],
    start: { clientX: 150, clientY: 330 },
  },
];

test("console capture targets the viewer router while preserving the host-owned bridge seam", async () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const [client, viewer] = await Promise.all([
    readFile(`${here}neko-client.ts`, "utf8"),
    readFile(`${here}stream-viewer.tsx`, "utf8"),
  ]);

  assert.match(viewer, VIEWER_POINTER_DISPATCH_RE);
  assert.match(viewer, VIEWER_WHEEL_DISPATCH_RE);
  assert.doesNotMatch(viewer, DIRECT_ADAPTER_POINTER_DISPATCH_RE);
  assert.match(client, TOUCH_BRIDGE_VIEWER_DISPATCH_RE);
  assert.match(client, TOUCH_SCROLL_WHEEL_INTENT_RE);
  assert.match(client, TOUCH_SCROLL_BOUNDARY_RE);
  assert.match(client, TOUCH_SCROLL_TERMINAL_HANDLER_RE);
  assert.match(client, FALLBACK_TAP_DELIVERY_RE);
  assert.match(client, MOUNTED_FALLBACK_TAP_RE);
  const touchEnd = client.slice(client.indexOf("const onTouchEnd"), client.indexOf("const onTouchCancel"));
  assert.doesNotMatch(touchEnd, /clickNekoAt\(/, "mounted fallback tap must not bypass viewer.dispatchInput");
  assert.match(viewer, VIEWER_INPUT_DIAGNOSTIC_RE);
  assert.match(viewer, REMOUNT_CANCEL_RE);
});

test("production delivery parity isolates touch residuals while the viewer owns mounted movement", async () => {
  const direct = createMountedAdapter();
  await mountAdapter(direct.adapter);
  for (const intent of pointerGesture) {
    await direct.adapter.sendPointer({
      button: intent.button,
      pointerId: intent.pointerId ?? 0,
      pointerType: intent.pointerType ?? "mouse",
      type: intent.action as "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
      x: intent.x,
      y: intent.y,
    });
  }
  for (const intent of desktopWheelBurst.slice(0, 1)) {
    await direct.adapter.sendWheel?.({
      deltaX: intent.deltaX ?? 0,
      deltaY: intent.deltaY ?? 0,
      x: intent.x,
      y: intent.y,
    });
  }
  for (const gesture of touchScrollGestures) {
    deliverProductionDirectTouchScroll(direct.bridgeControl, gesture);
  }
  for (const intent of desktopWheelBurst.slice(1)) {
    await direct.adapter.sendWheel?.({
      deltaX: intent.deltaX ?? 0,
      deltaY: intent.deltaY ?? 0,
      x: intent.x,
      y: intent.y,
    });
  }

  const routed = createMountedAdapter();
  await mountAdapter(routed.adapter);
  const router = createNekoViewerInputRouter({ adapter: routed.adapter, isSettled: () => true });
  const routedIntents: Extract<RemoteSurfaceInputPayload, { type: "pointer" }>[] = [];
  const boundaryControlCallCounts: number[] = [];
  const viewer = {
    dispatchInput(intent: RemoteSurfaceInputPayload) {
      routedIntents.push(intent as Extract<RemoteSurfaceInputPayload, { type: "pointer" }>);
      const controlCallCount = routed.calls.length;
      router.dispatch(intent);
      if (intent.type === "pointer" && intent.action === "wheel" && intent.gestureBoundary) {
        boundaryControlCallCounts.push(routed.calls.length - controlCallCount);
      }
    },
  };
  for (const intent of pointerGesture) {
    viewer.dispatchInput(intent);
  }
  for (const intent of desktopWheelBurst.slice(0, 1)) {
    viewer.dispatchInput(intent);
  }
  for (const gesture of touchScrollGestures) {
    deliverProductionRoutedTouchScroll((intent) => viewer.dispatchInput(intent), gesture);
  }
  for (const intent of desktopWheelBurst.slice(1)) {
    viewer.dispatchInput(intent);
  }

  assert.deepEqual(routed.calls, direct.calls);
  assert.deepEqual(boundaryControlCallCounts, [0, 0]);
  assert.deepEqual(
    routed.calls.filter((call) => call.type === "move" && call.x === 150 && (call.y === 330 || call.y === 300)),
    [
      { type: "move", x: 150, y: 330 },
      { type: "move", x: 150, y: 300 },
    ]
  );
  assert.deepEqual(
    routedIntents.filter((intent) => intent.action === "wheel" && intent.source === "touch-gesture"),
    [
      {
        action: "wheel",
        deltaX: 0,
        deltaY: 30,
        pointerType: "touch",
        source: "touch-gesture",
        type: "pointer",
        x: 150,
        y: 330,
      },
      {
        action: "wheel",
        deltaX: 0,
        deltaY: 0,
        gestureBoundary: true,
        pointerType: "touch",
        source: "touch-gesture",
        type: "pointer",
        x: 150,
        y: 330,
      },
      {
        action: "wheel",
        deltaX: 0,
        deltaY: 30,
        pointerType: "touch",
        source: "touch-gesture",
        type: "pointer",
        x: 150,
        y: 300,
      },
      {
        action: "wheel",
        deltaX: 0,
        deltaY: 0,
        gestureBoundary: true,
        pointerType: "touch",
        source: "touch-gesture",
        type: "pointer",
        x: 150,
        y: 300,
      },
    ]
  );
  assert.equal(routedIntents.some((intent) => intent.action === "wheel" && intent.source !== "touch-gesture"), true);
});

test("console-dispatched input stays held until the viewer router settles and flushes", () => {
  const dispatched: Extract<RemoteSurfaceInputPayload, { type: "pointer" }>[] = [];
  let settled = false;
  const router = createNekoViewerInputRouter({
    adapter: {
      copyRemoteSelection() {
        return Promise.resolve(false);
      },
      blurTextInput() {
        // Unused by this input-router fixture.
      },
      focusTextInput() {
        // Unused by this input-router fixture.
      },
      mount() {
        return Promise.resolve();
      },
      pasteText() {
        return Promise.resolve(false);
      },
      sendPointer(intent) {
        dispatched.push({
          action: intent.type,
          pointerType: intent.pointerType,
          type: "pointer",
          x: intent.x,
          y: intent.y,
        });
        return Promise.resolve();
      },
      sendKeysym() {
        return Promise.resolve();
      },
      sendWheel(intent) {
        dispatched.push({ action: "wheel", pointerType: "mouse", type: "pointer", x: intent.x, y: intent.y });
        return Promise.resolve();
      },
      sendText() {
        return Promise.resolve();
      },
      setRemoteInputFocused() {
        // Unused by this input-router fixture.
      },
      unmount() {
        return Promise.resolve();
      },
    },
    isSettled: () => settled,
  });
  const viewer = { dispatchInput: (intent: RemoteSurfaceInputPayload) => router.dispatch(intent) };

  viewer.dispatchInput({ action: "wheel", deltaX: 0, deltaY: 90, type: "pointer", x: 40, y: 60 });
  assert.equal(router.queueSize(), 1);
  assert.deepEqual(dispatched, []);

  router.flush();
  assert.deepEqual(dispatched, []);
  settled = true;
  router.flush();
  assert.equal(router.queueSize(), 0);
  assert.deepEqual(dispatched, [{ action: "wheel", pointerType: "mouse", type: "pointer", x: 40, y: 60 }]);
});

test("rotation settle gate prevents taps landing off-target after rotation through the production console path", async () => {
  const tap = { clientX: 400, clientY: 150 };
  const portraitViewport = { height: 844, width: 390 };
  const landscapeViewport = { height: 390, width: 844 };
  const landscapeContainer = { height: 390, left: 0, top: 0, width: 844 };
  let geometry = {
    // During rotation the container has changed but the painted portrait media
    // has not. This is the stale mapping the router must never use for input.
    imageBox: { height: 390, left: 331.9, top: 0, width: 180.2 },
    viewport: portraitViewport,
  };
  const projectWithProductionGeometrySeam = (x: number, y: number) => {
    const projected = mapPointerToStreamViewport({
      containerBox: landscapeContainer as DOMRect,
      event: { clientX: x, clientY: y },
      imageBox: geometry.imageBox as DOMRect,
      viewport: geometry.viewport,
    });
    assert.ok(projected, "the tap must be inside the painted media");
    return projected;
  };
  const staleProjection = projectWithProductionGeometrySeam(tap.clientX, tap.clientY);
  const routed = createMountedAdapter(projectWithProductionGeometrySeam);
  await mountAdapter(routed.adapter);
  let settled = false;
  const router = createNekoViewerInputRouter({ adapter: routed.adapter, isSettled: () => settled });
  const viewer = { dispatchInput: (intent: RemoteSurfaceInputPayload) => router.dispatch(intent) };

  deliverNekoFallbackTap(
    { interactionSeq: 1, pointerId: 1 },
    tap,
    (intent) => viewer.dispatchInput(intent)
  );
  assert.equal(router.queueSize(), 2);
  assert.deepEqual(routed.calls, []);

  geometry = {
    imageBox: landscapeContainer,
    viewport: landscapeViewport,
  };
  const postTransitionProjection = projectWithProductionGeometrySeam(tap.clientX, tap.clientY);
  assert.notDeepEqual(postTransitionProjection, staleProjection);
  settled = true;
  router.flush();

  assert.deepEqual(routed.calls, [
    { button: 1, type: "buttonDown", ...postTransitionProjection },
    { button: 1, type: "buttonUp", ...postTransitionProjection },
  ]);
});

test("remount teardown cancels a delivered press exactly once and ignores the late DOM terminal event", async () => {
  const routed = createMountedAdapter();
  await mountAdapter(routed.adapter);
  const router = createNekoViewerInputRouter({ adapter: routed.adapter, isSettled: () => true });
  const presses = createActiveViewerPresses();
  const dispatchInput = (intent: RemoteSurfaceInputPayload) => router.dispatch(intent);
  const down: Extract<RemoteSurfaceInputPayload, { type: "pointer" }> = {
    action: "pointerdown",
    button: 0,
    buttons: 1,
    pointerId: 9,
    pointerType: "touch",
    type: "pointer",
    x: 80,
    y: 120,
  };

  dispatchInput(down);
  trackActiveViewerPress(presses, down);
  cancelActiveViewerPresses(presses, dispatchInput);
  // The old viewer is gone. The late DOM pointerup is intentionally not sent
  // through any dispatcher, and drained tracking cannot emit another release.
  trackActiveViewerPress(presses, { ...down, action: "pointerup", buttons: 0 });
  cancelActiveViewerPresses(presses, dispatchInput);

  assert.deepEqual(routed.calls, [
    { button: 1, type: "buttonDown", x: 80, y: 120 },
    { button: 1, type: "buttonUp", x: 80, y: 120 },
  ]);
});
