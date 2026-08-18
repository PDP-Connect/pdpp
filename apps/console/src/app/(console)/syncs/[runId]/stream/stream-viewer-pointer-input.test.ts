// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { readablePointerInput } from "./stream-viewer-pointer-input.ts";

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
