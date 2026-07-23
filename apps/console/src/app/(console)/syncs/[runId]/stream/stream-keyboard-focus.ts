// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export const MOBILE_KEYBOARD_GESTURE_EXPIRY_MS = 1500;
// Keep a confirmed rect only across the same short trusted-touch window. This
// covers the common warm follow-up tap without turning a past remote focus
// into a durable authority to summon the keyboard.
export const MOBILE_KEYBOARD_EDITABLE_RECT_CACHE_TTL_MS = 1500;
export const MOBILE_KEYBOARD_TAP_SLOP_PX = 12;

export interface RemotePoint {
  x: number;
  y: number;
}

export interface RemoteEditableRect extends RemotePoint {
  height: number;
  width: number;
}

interface ConfirmedEditableRectCacheEntry {
  confirmedAtMs: number;
  rect: RemoteEditableRect;
}

interface MobileKeyboardFocusGesture {
  lastRemotePoint: RemotePoint;
  moved: boolean;
  phase: "active" | "awaiting-confirmation";
  pointerId: number;
  startedAtMs: number;
  startRemotePoint: RemotePoint;
}

export interface MobileKeyboardFocusState {
  affordanceVisible: boolean;
  editableRectCache: ConfirmedEditableRectCacheEntry | null;
  gesture: MobileKeyboardFocusGesture | null;
  remoteEditableFocused: boolean;
}

export type MobileKeyboardFocusEvent =
  | { atMs: number; pointerId: number; remotePoint: RemotePoint; type: "pointerdown" }
  | { atMs: number; pointerId: number; remotePoint: RemotePoint; type: "pointermove" }
  | { atMs: number; pointerId: number; type: "pointercancel" }
  | { atMs: number; pointerId: number; remotePoint: RemotePoint; type: "pointerup" }
  | { atMs: number; rect: RemoteEditableRect | null; type: "remote-focus" }
  | { type: "remote-blur" }
  | { reason: "geometry-epoch" | "navigation" | "remount"; type: "editable-rect-cache-invalidated" }
  | { atMs: number; type: "affordance-tap" }
  | { succeeded: boolean; type: "affordance-focus-result" };

export type MobileKeyboardFocusEffect = "attempt-affordance-focus" | "focus-text-input" | "none" | "show-affordance";

export interface MobileKeyboardFocusTransition {
  effect: MobileKeyboardFocusEffect;
  state: MobileKeyboardFocusState;
}

export interface MobileKeyboardFocusProxy {
  focusTextInput: () => void;
  isTextInputFocused: () => boolean;
}

export function createMobileKeyboardFocusState(): MobileKeyboardFocusState {
  return {
    affordanceVisible: false,
    editableRectCache: null,
    gesture: null,
    remoteEditableFocused: false,
  };
}

function isGestureExpired(gesture: MobileKeyboardFocusGesture, atMs: number): boolean {
  return atMs < gesture.startedAtMs || atMs - gesture.startedAtMs > MOBILE_KEYBOARD_GESTURE_EXPIRY_MS;
}

function isEditableRectCacheExpired(entry: ConfirmedEditableRectCacheEntry, atMs: number): boolean {
  return atMs < entry.confirmedAtMs || atMs - entry.confirmedAtMs > MOBILE_KEYBOARD_EDITABLE_RECT_CACHE_TTL_MS;
}

function isPointInsideRect(point: RemotePoint, rect: RemoteEditableRect | null): boolean {
  return Boolean(
    rect && point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height
  );
}

function movedBeyondTapSlop(start: RemotePoint, current: RemotePoint): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) > MOBILE_KEYBOARD_TAP_SLOP_PX;
}

function expireGesture(state: MobileKeyboardFocusState, atMs: number): MobileKeyboardFocusState {
  if (state.gesture && isGestureExpired(state.gesture, atMs)) {
    return {
      ...state,
      affordanceVisible: false,
      gesture: null,
    };
  }
  return state;
}

function clearEditableRectCache(state: MobileKeyboardFocusState): MobileKeyboardFocusState {
  return { ...state, affordanceVisible: false, editableRectCache: null };
}

function expireEditableRectCache(state: MobileKeyboardFocusState, atMs: number): MobileKeyboardFocusState {
  const entry = state.editableRectCache;
  return entry && isEditableRectCacheExpired(entry, atMs) ? clearEditableRectCache(state) : state;
}

export function readRemoteEditableRect(element: unknown): RemoteEditableRect | null {
  if (!element || typeof element !== "object") {
    return null;
  }
  const candidate = element as Record<string, unknown>;
  const x = typeof candidate.x === "number" ? candidate.x : Number.NaN;
  const y = typeof candidate.y === "number" ? candidate.y : Number.NaN;
  const width = typeof candidate.width === "number" ? candidate.width : Number.NaN;
  const height = typeof candidate.height === "number" ? candidate.height : Number.NaN;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }
  return { height, width, x, y };
}

function transitionPointerDown(
  state: MobileKeyboardFocusState,
  event: Extract<MobileKeyboardFocusEvent, { type: "pointerdown" }>
): MobileKeyboardFocusTransition {
  return {
    effect: "none",
    state: {
      ...state,
      affordanceVisible: false,
      gesture: {
        lastRemotePoint: event.remotePoint,
        moved: false,
        phase: "active",
        pointerId: event.pointerId,
        startedAtMs: event.atMs,
        startRemotePoint: event.remotePoint,
      },
    },
  };
}

function transitionPointerMove(
  state: MobileKeyboardFocusState,
  event: Extract<MobileKeyboardFocusEvent, { type: "pointermove" }>
): MobileKeyboardFocusTransition {
  const gesture = state.gesture;
  if (gesture?.phase !== "active" || gesture.pointerId !== event.pointerId) {
    return { effect: "none", state };
  }
  return {
    effect: "none",
    state: {
      ...state,
      gesture: {
        ...gesture,
        lastRemotePoint: event.remotePoint,
        moved: gesture.moved || movedBeyondTapSlop(gesture.startRemotePoint, event.remotePoint),
      },
    },
  };
}

function clearGesture(state: MobileKeyboardFocusState): MobileKeyboardFocusTransition {
  return {
    effect: "none",
    state: {
      ...state,
      affordanceVisible: false,
      gesture: null,
    },
  };
}

function transitionPointerCancel(
  state: MobileKeyboardFocusState,
  event: Extract<MobileKeyboardFocusEvent, { type: "pointercancel" }>
): MobileKeyboardFocusTransition {
  return state.gesture?.pointerId === event.pointerId ? clearGesture(state) : { effect: "none", state };
}

function transitionPointerUp(
  state: MobileKeyboardFocusState,
  event: Extract<MobileKeyboardFocusEvent, { type: "pointerup" }>
): MobileKeyboardFocusTransition {
  const gesture = state.gesture;
  if (gesture?.phase !== "active" || gesture.pointerId !== event.pointerId || gesture.moved) {
    return gesture?.pointerId === event.pointerId && gesture.moved ? clearGesture(state) : { effect: "none", state };
  }
  if (isPointInsideRect(event.remotePoint, state.editableRectCache?.rect ?? null)) {
    return { effect: "focus-text-input", state: { ...state, affordanceVisible: false, gesture: null } };
  }
  if (state.editableRectCache) {
    return clearGesture(state);
  }
  return {
    effect: "none",
    state: {
      ...state,
      affordanceVisible: false,
      gesture: { ...gesture, lastRemotePoint: event.remotePoint, phase: "awaiting-confirmation" },
    },
  };
}

function transitionRemoteFocus(
  state: MobileKeyboardFocusState,
  event: Extract<MobileKeyboardFocusEvent, { type: "remote-focus" }>
): MobileKeyboardFocusTransition {
  const gesture = state.gesture;
  const canMatchLateConfirmation =
    gesture?.phase === "awaiting-confirmation" &&
    !isGestureExpired(gesture, event.atMs) &&
    isPointInsideRect(gesture.lastRemotePoint, event.rect);
  const matchedState = {
    ...state,
    affordanceVisible: canMatchLateConfirmation,
    editableRectCache: event.rect ? { confirmedAtMs: event.atMs, rect: event.rect } : null,
    remoteEditableFocused: true,
  };
  if (gesture?.phase === "awaiting-confirmation" && event.rect && !canMatchLateConfirmation) {
    return { effect: "none", state: { ...matchedState, gesture: null } };
  }
  return { effect: canMatchLateConfirmation ? "show-affordance" : "none", state: matchedState };
}

export function transitionMobileKeyboardFocus(
  current: MobileKeyboardFocusState,
  event: MobileKeyboardFocusEvent
): MobileKeyboardFocusTransition {
  const expired = "atMs" in event ? expireEditableRectCache(expireGesture(current, event.atMs), event.atMs) : current;
  switch (event.type) {
    case "affordance-tap":
      return { effect: expired.affordanceVisible ? "attempt-affordance-focus" : "none", state: expired };
    case "affordance-focus-result":
      if (!(expired.affordanceVisible && event.succeeded)) {
        return { effect: "none", state: expired };
      }
      return { effect: "none", state: { ...expired, affordanceVisible: false, gesture: null } };
    case "pointerdown":
      return transitionPointerDown(expired, event);
    case "pointermove":
      return transitionPointerMove(expired, event);
    case "pointercancel":
      return transitionPointerCancel(expired, event);
    case "pointerup":
      return transitionPointerUp(expired, event);
    case "remote-focus":
      return transitionRemoteFocus(expired, event);
    case "remote-blur":
      return { effect: "none", state: createMobileKeyboardFocusState() };
    case "editable-rect-cache-invalidated":
      return { effect: "none", state: clearEditableRectCache(expired) };
    default:
      throw new Error("Unhandled mobile keyboard focus event");
  }
}

export function activateMobileKeyboardAffordance(
  current: MobileKeyboardFocusState,
  proxy: MobileKeyboardFocusProxy,
  nowMs = Date.now()
): { focused: boolean; transition: MobileKeyboardFocusTransition } {
  const attempt = transitionMobileKeyboardFocus(current, { atMs: nowMs, type: "affordance-tap" });
  if (attempt.effect !== "attempt-affordance-focus") {
    return { focused: false, transition: attempt };
  }
  let focused = false;
  try {
    proxy.focusTextInput();
    focused = proxy.isTextInputFocused();
  } catch {
    focused = false;
  }
  return {
    focused,
    transition: transitionMobileKeyboardFocus(attempt.state, {
      succeeded: focused,
      type: "affordance-focus-result",
    }),
  };
}
