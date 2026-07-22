// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  activateMobileKeyboardAffordance,
  createMobileKeyboardFocusState,
  MOBILE_KEYBOARD_EDITABLE_RECT_CACHE_TTL_MS,
  MOBILE_KEYBOARD_GESTURE_EXPIRY_MS,
  readRemoteEditableRect,
  transitionMobileKeyboardFocus,
} from "./stream-keyboard-focus.ts";

const editableRect = { height: 44, width: 220, x: 100, y: 200 };
const editablePoint = { x: 140, y: 220 };
const unrelatedPoint = { x: 20, y: 40 };
const VIEWER_FILE = fileURLToPath(new URL("./stream-viewer.tsx", import.meta.url));
const NAVIGATION_INVALIDATION = /invalidateMobileKeyboardEditableRectCache\([\s\S]*"navigation"/;
const GEOMETRY_INVALIDATION = /invalidateMobileKeyboardEditableRectCache\([\s\S]*"geometry-epoch"/;
const REMOUNT_INVALIDATION = /invalidateMobileKeyboardEditableRectCache\([\s\S]*"remount"/;

function transition(
  state: ReturnType<typeof createMobileKeyboardFocusState>,
  event: Parameters<typeof transitionMobileKeyboardFocus>[1]
) {
  return transitionMobileKeyboardFocus(state, event);
}

test("confirmation before pointerup focuses only when the current mapped point is inside the confirmed rect", () => {
  let state = createMobileKeyboardFocusState();
  state = transition(state, { atMs: 10, pointerId: 7, remotePoint: editablePoint, type: "pointerdown" }).state;
  state = transition(state, { atMs: 20, rect: editableRect, type: "remote-focus" }).state;

  const focused = transition(state, {
    atMs: 30,
    pointerId: 7,
    remotePoint: editablePoint,
    type: "pointerup",
  });
  assert.equal(focused.effect, "focus-text-input");
  assert.equal(focused.state.gesture, null);

  let unrelated = transition(state, {
    atMs: 30,
    pointerId: 7,
    remotePoint: unrelatedPoint,
    type: "pointerup",
  });
  assert.equal(unrelated.effect, "none");
  assert.equal(unrelated.state.affordanceVisible, false);
  unrelated = transition(unrelated.state, { atMs: 40, rect: editableRect, type: "remote-focus" });
  assert.equal(unrelated.effect, "none");
  assert.equal(unrelated.state.affordanceVisible, false);
});

test("late confirmation matches the same completed gesture and exposes a retryable affordance", () => {
  let state = createMobileKeyboardFocusState();
  state = transition(state, { atMs: 10, pointerId: 3, remotePoint: editablePoint, type: "pointerdown" }).state;
  const released = transition(state, {
    atMs: 20,
    pointerId: 3,
    remotePoint: editablePoint,
    type: "pointerup",
  });
  assert.equal(released.effect, "none");
  assert.equal(released.state.gesture?.phase, "awaiting-confirmation");

  const confirmed = transition(released.state, { atMs: 30, rect: editableRect, type: "remote-focus" });
  assert.equal(confirmed.effect, "show-affordance");
  assert.equal(confirmed.state.affordanceVisible, true);

  const nextGesture = transition(confirmed.state, {
    atMs: 40,
    pointerId: 4,
    remotePoint: unrelatedPoint,
    type: "pointerdown",
  });
  assert.equal(nextGesture.state.affordanceVisible, false);
  assert.equal(nextGesture.state.gesture?.pointerId, 4);
});

test("a warm confirmed editable rect focuses on one trusted tap", () => {
  let state = createMobileKeyboardFocusState();
  state = transition(state, { atMs: 10, rect: editableRect, type: "remote-focus" }).state;
  state = transition(state, { atMs: 20, pointerId: 3, remotePoint: editablePoint, type: "pointerdown" }).state;

  const released = transition(state, { atMs: 30, pointerId: 3, remotePoint: editablePoint, type: "pointerup" });
  assert.equal(released.effect, "focus-text-input");
  assert.equal(released.state.affordanceVisible, false);
});

test("a warm cache miss leaves the late-confirmation affordance behavior unchanged", () => {
  let state = createMobileKeyboardFocusState();
  state = transition(state, { atMs: 10, rect: editableRect, type: "remote-focus" }).state;
  state = transition(state, { atMs: 20, pointerId: 3, remotePoint: unrelatedPoint, type: "pointerdown" }).state;

  const released = transition(state, { atMs: 30, pointerId: 3, remotePoint: unrelatedPoint, type: "pointerup" });
  assert.equal(released.effect, "none");
  assert.equal(released.state.affordanceVisible, false);
  assert.equal(released.state.gesture, null);
});

test("an expired warm cache falls back to the existing late-confirmation affordance", () => {
  let state = createMobileKeyboardFocusState();
  state = transition(state, { atMs: 10, rect: editableRect, type: "remote-focus" }).state;
  const atMs = 10 + MOBILE_KEYBOARD_EDITABLE_RECT_CACHE_TTL_MS + 1;
  state = transition(state, { atMs, pointerId: 3, remotePoint: editablePoint, type: "pointerdown" }).state;

  const released = transition(state, { atMs: atMs + 1, pointerId: 3, remotePoint: editablePoint, type: "pointerup" });
  assert.equal(released.effect, "none");
  assert.equal(released.state.gesture?.phase, "awaiting-confirmation");
  const confirmed = transition(released.state, { atMs: atMs + 2, rect: editableRect, type: "remote-focus" });
  assert.equal(confirmed.effect, "show-affordance");
});

test("geometry, navigation, and remount each invalidate a warm editable cache", () => {
  for (const reason of ["geometry-epoch", "navigation", "remount"] as const) {
    let state = createMobileKeyboardFocusState();
    state = transition(state, { atMs: 10, rect: editableRect, type: "remote-focus" }).state;
    state = transition(state, { reason, type: "editable-rect-cache-invalidated" }).state;
    state = transition(state, { atMs: 20, pointerId: 3, remotePoint: editablePoint, type: "pointerdown" }).state;

    const released = transition(state, { atMs: 30, pointerId: 3, remotePoint: editablePoint, type: "pointerup" });
    assert.equal(released.effect, "none", reason);
    assert.equal(released.state.gesture?.phase, "awaiting-confirmation", reason);
  }
});

test("the real viewer wires cache invalidation into navigation, geometry epochs, and remounts", async () => {
  const source = await readFile(VIEWER_FILE, "utf8");
  const navigationStart = source.indexOf("const parsed = parseUrlChangedMessage");
  const geometryStart = source.indexOf("useEffect(() => {\n    if (localSurfaceViewportInfo || viewportInfo)");
  const remountStart = source.indexOf("const nekoMountNode: HTMLElement = mountNode");

  assert.notEqual(navigationStart, -1, "the viewer must handle remote navigation");
  assert.notEqual(geometryStart, -1, "the viewer must react to a geometry epoch");
  assert.notEqual(remountStart, -1, "the viewer must mount the n.eko surface");
  assert.match(source.slice(navigationStart, navigationStart + 700), NAVIGATION_INVALIDATION);
  assert.match(source.slice(geometryStart, geometryStart + 700), GEOMETRY_INVALIDATION);
  assert.match(source.slice(remountStart, remountStart + 5000), REMOUNT_INVALIDATION);
});

test("a tap just outside a warm editable rect never summons the keyboard", () => {
  let state = createMobileKeyboardFocusState();
  const justOutside = { x: editableRect.x + editableRect.width + 0.01, y: editablePoint.y };
  state = transition(state, { atMs: 10, rect: editableRect, type: "remote-focus" }).state;
  state = transition(state, { atMs: 20, pointerId: 3, remotePoint: justOutside, type: "pointerdown" }).state;

  const released = transition(state, { atMs: 30, pointerId: 3, remotePoint: justOutside, type: "pointerup" });
  assert.equal(released.effect, "none");
  assert.equal(released.state.affordanceVisible, false);
});

test("pointer identity, movement, cancel, expiry, and blur fail closed", () => {
  let state = createMobileKeyboardFocusState();
  state = transition(state, { atMs: 0, pointerId: 9, remotePoint: editablePoint, type: "pointerdown" }).state;
  const wrongPointerUp = transition(state, {
    atMs: 10,
    pointerId: 10,
    remotePoint: editablePoint,
    type: "pointerup",
  });
  assert.equal(wrongPointerUp.effect, "none");
  assert.equal(wrongPointerUp.state.gesture?.pointerId, 9);

  const canceled = transition(wrongPointerUp.state, { atMs: 20, pointerId: 9, type: "pointercancel" });
  assert.equal(canceled.state.gesture, null);
  const scriptFocusAfterCancel = transition(canceled.state, { atMs: 30, rect: editableRect, type: "remote-focus" });
  assert.equal(scriptFocusAfterCancel.state.affordanceVisible, false);

  state = transition(createMobileKeyboardFocusState(), {
    atMs: 100,
    pointerId: 11,
    remotePoint: editablePoint,
    type: "pointerdown",
  }).state;
  state = transition(state, {
    atMs: 110,
    pointerId: 11,
    remotePoint: { x: editablePoint.x + 20, y: editablePoint.y },
    type: "pointermove",
  }).state;
  const scrolled = transition(state, {
    atMs: 120,
    pointerId: 11,
    remotePoint: editablePoint,
    type: "pointerup",
  });
  assert.equal(scrolled.effect, "none");
  assert.equal(scrolled.state.gesture, null);

  state = transition(createMobileKeyboardFocusState(), {
    atMs: 200,
    pointerId: 12,
    remotePoint: editablePoint,
    type: "pointerdown",
  }).state;
  state = transition(state, {
    atMs: 210,
    pointerId: 12,
    remotePoint: editablePoint,
    type: "pointerup",
  }).state;
  const expired = transition(state, {
    atMs: 210 + MOBILE_KEYBOARD_GESTURE_EXPIRY_MS + 1,
    rect: editableRect,
    type: "remote-focus",
  });
  assert.equal(expired.effect, "none");
  assert.equal(expired.state.gesture, null);
  assert.equal(expired.state.affordanceVisible, false);

  const blurred = transition(expired.state, { type: "remote-blur" });
  assert.deepEqual(blurred.state, createMobileKeyboardFocusState());
});

test("failed affordance focus remains retryable and success consumes it", () => {
  let state = createMobileKeyboardFocusState();
  state = transition(state, { atMs: 10, pointerId: 1, remotePoint: editablePoint, type: "pointerdown" }).state;
  state = transition(state, { atMs: 20, pointerId: 1, remotePoint: editablePoint, type: "pointerup" }).state;
  state = transition(state, { atMs: 30, rect: editableRect, type: "remote-focus" }).state;
  assert.equal(state.affordanceVisible, true);

  let proxyFocused = false;
  const failed = activateMobileKeyboardAffordance(
    state,
    {
      focusTextInput: () => {
        proxyFocused = false;
      },
      isTextInputFocused: () => proxyFocused,
    },
    40
  );
  assert.equal(failed.focused, false);
  assert.equal(failed.transition.state.affordanceVisible, true);

  const succeeded = activateMobileKeyboardAffordance(
    failed.transition.state,
    {
      focusTextInput: () => {
        proxyFocused = true;
      },
      isTextInputFocused: () => proxyFocused,
    },
    40
  );
  assert.equal(succeeded.focused, true);
  assert.equal(succeeded.transition.state.affordanceVisible, false);
});

test("geometry extraction is fail-closed when the SSE element has no complete rect", () => {
  assert.deepEqual(readRemoteEditableRect({ x: 1, y: 2, width: 3, height: 4 }), {
    height: 4,
    width: 3,
    x: 1,
    y: 2,
  });
  assert.equal(readRemoteEditableRect({ x: 1, y: 2, width: 3 }), null);
  assert.equal(readRemoteEditableRect(null), null);
});
