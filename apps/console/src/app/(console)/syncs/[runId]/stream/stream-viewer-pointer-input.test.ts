// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { normalizedPointerButton, readablePointerInput } from "./stream-viewer-pointer-input.ts";

test("a primary-contact touch tap is forwarded, matching real touch pointerdown/pointerup semantics", () => {
  // Per the Pointer Events spec, `button` is 0 for the primary contact on a
  // touch pointerdown/pointerup. A regression that gates touch on `button`
  // drops every real-world tap while leaving synthetic-event tests (which
  // often omit `button` or set it to a mouse-like value) green.
  assert.deepEqual(readablePointerInput({ buttons: 1, pointerType: "touch", type: "pointerdown" }), {
    pointerType: "touch",
    type: "pointerdown",
  });
  assert.deepEqual(readablePointerInput({ buttons: 0, pointerType: "touch", type: "pointerup" }), {
    pointerType: "touch",
    type: "pointerup",
  });
});

test("touch pointermove is always forwarded regardless of the mouse-only hover-move gate", () => {
  assert.deepEqual(readablePointerInput({ buttons: 0, pointerType: "touch", type: "pointermove" }), {
    pointerType: "touch",
    type: "pointermove",
  });
});

test("a mouse hover move with no button held is dropped to avoid flooding the wire", () => {
  assert.equal(readablePointerInput({ buttons: 0, pointerType: "mouse", type: "pointermove" }), null);
});

test("a mouse drag move with a button held is forwarded", () => {
  assert.deepEqual(readablePointerInput({ buttons: 1, pointerType: "mouse", type: "pointermove" }), {
    pointerType: "mouse",
    type: "pointermove",
  });
});

test("pointercancel is always forwarded for every pointer type", () => {
  assert.deepEqual(readablePointerInput({ buttons: 0, pointerType: "touch", type: "pointercancel" }), {
    pointerType: "touch",
    type: "pointercancel",
  });
  assert.deepEqual(readablePointerInput({ buttons: 0, pointerType: "mouse", type: "pointercancel" }), {
    pointerType: "mouse",
    type: "pointercancel",
  });
});

test("an unrecognized DOM event type is dropped", () => {
  assert.equal(readablePointerInput({ buttons: 0, pointerType: "touch", type: "pointerenter" }), null);
});

// `normalizedPointerButton` exists because the forwarded `button` is not a
// filter downstream — it is arithmetic. neko computes the X11 button as
// `(button ?? 0) + 1`, and X11 button 1 is primary, so a touch pointerdown
// reporting the non-spec `button === -1` becomes X11 button 0 (no button at
// all) and the remote page never sees a press. This is the residual half of
// the owner's "can't tap the captcha on mobile" report: an earlier fix stopped
// DROPPING such events but still forwarded the raw value into that arithmetic.

test("a touch pointerdown reporting button -1 is normalized to primary contact", () => {
  // The exact value the sibling gate's own doc comment documents as real on
  // touch input paths. Left raw, it silently disarms the tap.
  assert.equal(normalizedPointerButton(-1, "touch"), 0);
});

test("a pen pointerdown reporting button -1 is normalized to primary contact", () => {
  assert.equal(normalizedPointerButton(-1, "pen"), 0);
});

test("an ordinary primary-contact touch button is left alone", () => {
  assert.equal(normalizedPointerButton(0, "touch"), 0);
});

test("mouse buttons are passed through so middle/right/back/forward survive", () => {
  // Touch and pen have no secondary button, but a mouse does — normalizing it
  // would turn every right-click into a left-click.
  assert.equal(normalizedPointerButton(0, "mouse"), 0);
  assert.equal(normalizedPointerButton(1, "mouse"), 1);
  assert.equal(normalizedPointerButton(2, "mouse"), 2);
  assert.equal(normalizedPointerButton(3, "mouse"), 3);
  assert.equal(normalizedPointerButton(4, "mouse"), 4);
  // A mouse never legitimately reports -1 on a press, but if it does the value
  // is preserved rather than invented — mouse `button` is meaningful.
  assert.equal(normalizedPointerButton(-1, "mouse"), -1);
});
