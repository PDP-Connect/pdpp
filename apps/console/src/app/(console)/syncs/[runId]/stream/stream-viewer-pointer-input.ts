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
