// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Extracted out of stream-viewer.tsx (a "use client" React component file)
 * into a plain module so this gate can be unit-tested under plain
 * `node --test` without a DOM/PointerEvent runtime. This function decides
 * whether a captured DOM pointer event becomes a forwarded remote-surface
 * intent at all; a wrong decision here silently drops input with no visible
 * symptom other than "taps don't do anything."
 */

export type RemotePointerActionType = "pointercancel" | "pointerdown" | "pointermove" | "pointerup";
export type RemotePointerType = "mouse" | "pen" | "touch";

export interface ReadablePointerEventLike {
  buttons: number;
  pointerType: string;
  type: string;
}

export interface ReadablePointerInput {
  pointerType: RemotePointerType;
  type: RemotePointerActionType;
}

function remoteTypeFor(type: string): RemotePointerActionType | null {
  switch (type) {
    case "pointerdown":
      return "pointerdown";
    case "pointermove":
      return "pointermove";
    case "pointerup":
      return "pointerup";
    case "pointercancel":
      return "pointercancel";
    default:
      return null;
  }
}

/**
 * Gates a raw DOM pointer event down to a forwardable remote-surface intent,
 * or `null` if it should be dropped.
 *
 * Per the W3C Pointer Events spec, `button`/`buttons` describe *mouse-style*
 * button state and are largely meaningless for touch: `button` is 0 (primary)
 * for a touch pointerdown/pointerup, but some touch input paths (stylus
 * palm-rejection proxies, certain WebViews) report `button === -1` on a
 * touch pointerup even though the contact itself is legitimate. Gating touch
 * on `event.button` at all is the wrong signal — touch has no secondary
 * button, so every primary-contact touch event must pass through regardless
 * of `button`. Only `buttons` (a bitmask) is meaningful across pointer types,
 * and it is only used here to suppress hover-only mouse moves.
 */
export function readablePointerInput(event: ReadablePointerEventLike): ReadablePointerInput | null {
  const type = remoteTypeFor(event.type);
  if (!type) {
    return null;
  }
  const pointerType: RemotePointerType =
    event.pointerType === "touch" || event.pointerType === "pen" ? event.pointerType : "mouse";
  // Hover-move gate: suppress mouse moves with no button held to prevent
  // hover floods. Touch/pen have no hover-move concept at this layer.
  if (type === "pointermove" && pointerType === "mouse" && event.buttons === 0) {
    return null;
  }
  return { pointerType, type };
}

/**
 * Normalizes `PointerEvent.button` into a primary-contact button index that is
 * safe to forward, for touch and pen only.
 *
 * The gate above stopped *dropping* touch events with a non-zero `button`, but
 * the raw value is still forwarded in the wire payload — and downstream it is
 * arithmetic, not a filter. `NekoPointerController.handle` (remote-surface
 * 1.5.2, `controllers/neko-pointer-controller.js`) computes the X11 button as
 * `(event.button ?? 0) + 1`, where X11 button 1 is primary. A touch
 * `pointerdown` reporting `button === -1` — the same non-spec value this
 * module's own comment above documents as real on touch input paths —
 * therefore becomes X11 button **0**, which is not a button at all, so neko
 * presses nothing and the tap never clicks.
 *
 * Verified against the installed controller by replaying the exact client
 * payload shape: `button: 0` on down yields `buttonDown(1)`, while
 * `button: -1` on down yields `buttonDown(0)`.
 *
 * `pointerup` was already safe by luck — the controller prefers the remembered
 * press button over the event's own — but `pointerdown` has nothing to fall
 * back to, so it must be normalized here at the payload boundary.
 *
 * Touch and pen have no secondary button, so pinning them to primary loses no
 * information. Mouse is passed through untouched: its `button` is meaningful
 * (middle/right/back/forward) and must survive.
 */
export function normalizedPointerButton(button: number, pointerType: RemotePointerType): number {
  if (pointerType === "mouse") {
    return button;
  }
  return button < 0 ? 0 : button;
}
