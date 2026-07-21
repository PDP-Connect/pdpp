// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RemoteSurfaceInputPayload } from "@opendatalabs/remote-surface/protocol";

type RemotePointerIntent = Extract<RemoteSurfaceInputPayload, { type: "pointer" }>;

interface ActiveViewerPress {
  button: number;
  pointerId: number;
  pointerType: "mouse" | "pen" | "touch";
  x: number;
  y: number;
}

export type ActiveViewerPresses = Map<number, ActiveViewerPress>;

export function createActiveViewerPresses(): ActiveViewerPresses {
  return new Map();
}

/**
 * Records presses that reached the mounted viewer. A remount must cancel these
 * before disposing the viewer, because a DOM terminal event can arrive after
 * the old viewer has gone away.
 */
export function trackActiveViewerPress(
  presses: ActiveViewerPresses,
  intent: RemotePointerIntent
): void {
  if (intent.action === "pointerdown") {
    presses.set(intent.pointerId ?? 0, {
      button: intent.button ?? 0,
      pointerId: intent.pointerId ?? 0,
      pointerType: intent.pointerType ?? "mouse",
      x: intent.x,
      y: intent.y,
    });
    return;
  }
  const press = presses.get(intent.pointerId ?? 0);
  if (!press) {
    return;
  }
  if (intent.action === "pointermove") {
    press.x = intent.x;
    press.y = intent.y;
    return;
  }
  if (intent.action === "pointerup" || intent.action === "pointercancel") {
    presses.delete(press.pointerId);
  }
}

/** Sends exactly one terminal cancel for each press before the viewer unmounts. */
export function cancelActiveViewerPresses(
  presses: ActiveViewerPresses,
  dispatchInput: (intent: RemotePointerIntent) => void
): void {
  const active = [...presses.values()];
  for (const press of active) {
    dispatchInput({
      action: "pointercancel",
      button: press.button,
      buttons: 0,
      pointerId: press.pointerId,
      pointerType: press.pointerType,
      type: "pointer",
      x: press.x,
      y: press.y,
    });
  }
  presses.clear();
}
