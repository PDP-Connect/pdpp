// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end oracle for the owner's "can't tap the captcha on mobile" report.
 *
 * The unit tests beside this file assert `normalizedPointerButton` in
 * isolation, which proves only that it does what it says. This file replays
 * the client's real wire payload through the REAL installed
 * `NekoPointerController` from `@opendatalabs/remote-surface` and asserts on
 * the X11 button the remote actually receives. That is the property the owner
 * cares about — "the tap presses a button on the remote page" — and it stays
 * honest if the dependency changes its mapping, because the oracle is the
 * dependency itself rather than a restatement of our own arithmetic.
 *
 * A captcha checkbox is not special here: the remote input path is
 * coordinate-based (neko X11 / CDP `Input.dispatchMouseEvent`), so it crosses
 * cross-origin iframe boundaries like reCAPTCHA's by construction. Nothing in
 * the path hit-tests the top document. What actually broke the tap was the
 * button index, which fails identically inside or outside an iframe — it just
 * gets noticed on a captcha because that is where a tap is unavoidable.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { normalizedPointerButton } from "./stream-viewer-pointer-input.ts";

// X11 button codes, as used by neko's `control.buttonDown`/`buttonUp`.
const X11_PRIMARY = 1;
const X11_NO_BUTTON = 0;

interface ControlCall {
  button: number;
  kind: "buttonDown" | "buttonUp";
}

type NekoPointerControllerCtor = new (deps: {
  control: Record<string, unknown>;
  mapToRemote: (x: number, y: number) => { x: number; y: number };
}) => { handle: (event: Record<string, unknown>) => void };

/** Loads the real controller, or `null` when the dependency isn't installed. */
async function loadNekoPointerController(): Promise<NekoPointerControllerCtor | null> {
  try {
    const mod = await import("@opendatalabs/remote-surface");
    return (mod.NekoPointerController as unknown as NekoPointerControllerCtor | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Replays a touch tap the way the client sends it, returning the X11 button
 * calls neko would make. `rawButton` is what the browser put on the
 * PointerEvent; `normalize` mirrors whether the client sanitizes it.
 */
function tapThroughController(
  Controller: NonNullable<Awaited<ReturnType<typeof loadNekoPointerController>>>,
  rawButton: number,
  normalize: boolean
): ControlCall[] {
  const calls: ControlCall[] = [];
  const controller = new Controller({
    control: {
      buttonDown: (pressed: number) => calls.push({ button: pressed, kind: "buttonDown" }),
      buttonUp: (released: number) => calls.push({ button: released, kind: "buttonUp" }),
      move: () => undefined,
      scroll: () => undefined,
    },
    mapToRemote: (x: number, y: number) => ({ x, y }),
  });
  const button = normalize ? normalizedPointerButton(rawButton, "touch") : rawButton;
  // The payload shape built in stream-viewer.tsx's `dispatchPointerIntent`.
  controller.handle({ button, pointerId: 1, pointerType: "touch", type: "pointerdown", x: 100, y: 200 });
  controller.handle({ button, pointerId: 1, pointerType: "touch", type: "pointerup", x: 100, y: 200 });
  return calls;
}

test("a touch tap reporting button -1 presses a real button on the remote page", async (t) => {
  const Controller = await loadNekoPointerController();
  if (!Controller) {
    t.skip("@opendatalabs/remote-surface is not installed in this workspace");
    return;
  }

  const calls = tapThroughController(Controller, -1, true);

  assert.deepEqual(
    calls,
    [
      { button: X11_PRIMARY, kind: "buttonDown" },
      { button: X11_PRIMARY, kind: "buttonUp" },
    ],
    "a touch tap must press and release X11 primary, or the remote page sees no click at all"
  );
});

test("the unnormalized payload is what silently disarmed the tap", async (t) => {
  const Controller = await loadNekoPointerController();
  if (!Controller) {
    t.skip("@opendatalabs/remote-surface is not installed in this workspace");
    return;
  }

  // Characterizes the defect rather than asserting the fix: forwarding the raw
  // -1 makes neko press X11 button 0, which is not a button. If a future
  // dependency bump makes the raw value safe on its own, this test fails and
  // says so, instead of leaving the normalization as unexplained cargo.
  const calls = tapThroughController(Controller, -1, false);

  assert.equal(
    calls[0]?.button,
    X11_NO_BUTTON,
    "raw button -1 maps to X11 button 0 (no button) — this is why the captcha tap did nothing"
  );
});

test("an ordinary touch tap reporting button 0 was never broken", async (t) => {
  const Controller = await loadNekoPointerController();
  if (!Controller) {
    t.skip("@opendatalabs/remote-surface is not installed in this workspace");
    return;
  }

  // Bounds the blast radius of the report: taps on engines that report a spec
  // -compliant 0 always worked, which is why this reproduced only on some
  // devices and why "taps are broken" was never reproducible on desktop.
  const normalized = tapThroughController(Controller, 0, true);
  const raw = tapThroughController(Controller, 0, false);

  assert.deepEqual(normalized, raw, "normalization must be a no-op for a spec-compliant primary contact");
  assert.equal(normalized[0]?.button, X11_PRIMARY);
});
