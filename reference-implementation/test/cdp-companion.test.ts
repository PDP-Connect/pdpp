// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the pure CDP input-event translator and screencast-param
// builder (server/streaming/cdp-companion.ts).
//
// `mapInputEventToCdp` translates a wire input event into an ordered list of
// CDP commands; `buildScreencastParams` derives clamped screencast params from
// a viewport. Both are pure. Assertions pin the command sequences (a dblclick
// is four events with the right clickCounts), the button map, the printable-vs-
// rawKeyDown branch, the touchEnd empty-touchpoints rule, the invalid-input
// error code, and the quality/dimension clamps.

import { strict as assert } from "node:assert/strict";
import { test } from "node:test";

import { buildScreencastParams, type CdpCommand, mapInputEventToCdp } from "../server/streaming/cdp-companion.ts";

function isCodedError(err: unknown): err is Error & { code?: string } {
  return err instanceof Error;
}

const codeIs = (code: string) => (err: unknown) => isCodedError(err) && err.code === code;

/** Narrows a CdpCommand's `params` (typed `unknown` in the source) to a plain record for property access in assertions. */
function paramsOf(cmd: CdpCommand): Record<string, unknown> {
  assert.ok(cmd.params && typeof cmd.params === "object");
  return cmd.params as Record<string, unknown>;
}

function cmdAt(cmds: CdpCommand[], i: number): CdpCommand {
  const cmd = cmds[i];
  assert.ok(cmd, `expected a command at index ${i}`);
  return cmd;
}

/** `paramsOf(cmds[i])` with a noUncheckedIndexedAccess guard on the index. */
function paramsAt(cmds: CdpCommand[], i: number): Record<string, unknown> {
  return paramsOf(cmdAt(cmds, i));
}

test("mapInputEventToCdp rejects non-object events", () => {
  assert.throws(() => mapInputEventToCdp(null), codeIs("invalid_input"));
  assert.throws(() => mapInputEventToCdp("x"), codeIs("invalid_input"));
  assert.throws(() => mapInputEventToCdp({ type: "nope" }), codeIs("invalid_input"));
});

test("mouse mousemove dispatches a single mouseMoved with button none", () => {
  const cmds = mapInputEventToCdp({ action: "mousemove", type: "mouse", x: 10, y: 20 });
  assert.deepEqual(cmds, [
    { method: "Input.dispatchMouseEvent", params: { button: "none", type: "mouseMoved", x: 10, y: 20 } },
  ]);
});

test("mouse click is a press then release with clickCount 1", () => {
  const cmds = mapInputEventToCdp({ action: "click", type: "mouse", x: 1, y: 2 });
  assert.equal(cmds.length, 2);
  assert.equal(paramsAt(cmds, 0).type, "mousePressed");
  assert.equal(paramsAt(cmds, 1).type, "mouseReleased");
  assert.equal(paramsAt(cmds, 0).clickCount, 1);
});

test("mouse dblclick emits four events ending in clickCount 2", () => {
  const cmds = mapInputEventToCdp({ action: "dblclick", type: "mouse", x: 5, y: 6 });
  assert.equal(cmds.length, 4);
  assert.deepEqual(
    cmds.map((c) => paramsOf(c).type),
    ["mousePressed", "mouseReleased", "mousePressed", "mouseReleased"]
  );
  assert.deepEqual(
    cmds.map((c) => paramsOf(c).clickCount),
    [1, 1, 2, 2]
  );
});

test("mouse button map resolves 0/1/2 and falls back to left", () => {
  assert.equal(
    paramsAt(mapInputEventToCdp({ action: "mousedown", button: 1, type: "mouse", x: 0, y: 0 }), 0).button,
    "middle"
  );
  assert.equal(
    paramsAt(mapInputEventToCdp({ action: "mousedown", button: 2, type: "mouse", x: 0, y: 0 }), 0).button,
    "right"
  );
  // Unknown button code falls back to 'left'.
  assert.equal(
    paramsAt(mapInputEventToCdp({ action: "mousedown", button: 9, type: "mouse", x: 0, y: 0 }), 0).button,
    "left"
  );
  // Absent button defaults to 0 → 'left'.
  assert.equal(paramsAt(mapInputEventToCdp({ action: "mousedown", type: "mouse", x: 0, y: 0 }), 0).button, "left");
});

test("mouse rejects non-finite coordinates and unknown actions", () => {
  assert.throws(() => mapInputEventToCdp({ action: "click", type: "mouse", x: "a", y: 2 }), codeIs("invalid_input"));
  assert.throws(() => mapInputEventToCdp({ action: "wiggle", type: "mouse", x: 1, y: 2 }), codeIs("invalid_input"));
});

test("keyboard keydown of a printable char emits keyDown with text", () => {
  const cmds = mapInputEventToCdp({ action: "keydown", key: "a", type: "keyboard" });
  assert.equal(cmds.length, 1);
  assert.equal(paramsAt(cmds, 0).type, "keyDown");
  assert.equal(paramsAt(cmds, 0).text, "a");
});

test("keyboard keydown of a named key emits rawKeyDown with virtual key code and no text", () => {
  const cmds = mapInputEventToCdp({ action: "keydown", key: "Enter", type: "keyboard" });
  assert.equal(paramsAt(cmds, 0).type, "rawKeyDown");
  assert.equal(paramsAt(cmds, 0).windowsVirtualKeyCode, 13);
  assert.equal(paramsAt(cmds, 0).nativeVirtualKeyCode, 13);
  assert.equal(paramsAt(cmds, 0).text, undefined); // named keys carry no text
});

test("keyboard keyup emits keyUp and preserves modifiers", () => {
  const cmds = mapInputEventToCdp({ action: "keyup", key: "a", modifiers: 2, type: "keyboard" });
  assert.equal(paramsAt(cmds, 0).type, "keyUp");
  assert.equal(paramsAt(cmds, 0).modifiers, 2);
});

test("keyboard rejects a missing key and unknown action", () => {
  assert.throws(() => mapInputEventToCdp({ action: "keydown", key: "", type: "keyboard" }), codeIs("invalid_input"));
  assert.throws(() => mapInputEventToCdp({ action: "hold", key: "a", type: "keyboard" }), codeIs("invalid_input"));
});

test("keyboard defaults non-finite modifiers to 0", () => {
  const cmds = mapInputEventToCdp({ action: "keydown", key: "a", modifiers: "nope", type: "keyboard" });
  assert.equal(paramsAt(cmds, 0).modifiers, 0);
});

test("touch start/move include the touch point; touchEnd sends empty touchPoints", () => {
  const start = mapInputEventToCdp({ action: "touchstart", id: 7, type: "touch", x: 3, y: 4 });
  assert.equal(paramsAt(start, 0).type, "touchStart");
  assert.deepEqual(paramsAt(start, 0).touchPoints, [{ id: 7, x: 3, y: 4 }]);
  const end = mapInputEventToCdp({ action: "touchend", type: "touch", x: 3, y: 4 });
  assert.equal(paramsAt(end, 0).type, "touchEnd");
  assert.deepEqual(paramsAt(end, 0).touchPoints, []);
});

test("touch defaults id to 1 and rejects unknown actions", () => {
  const move = mapInputEventToCdp({ action: "touchmove", type: "touch", x: 1, y: 1 });
  assert.equal((paramsAt(move, 0).touchPoints as { id: number }[])[0]?.id, 1);
  assert.throws(() => mapInputEventToCdp({ action: "tap", type: "touch", x: 1, y: 1 }), codeIs("invalid_input"));
});

test("scroll maps to a mouseWheel with the deltas", () => {
  const cmds = mapInputEventToCdp({ deltaX: 3, deltaY: -4, type: "scroll", x: 1, y: 2 });
  assert.deepEqual(cmds, [
    { method: "Input.dispatchMouseEvent", params: { deltaX: 3, deltaY: -4, type: "mouseWheel", x: 1, y: 2 } },
  ]);
});

test("paste inserts text and rejects a non-string", () => {
  assert.deepEqual(mapInputEventToCdp({ text: "hi", type: "paste" }), [
    { method: "Input.insertText", params: { text: "hi" } },
  ]);
  assert.throws(() => mapInputEventToCdp({ text: 42, type: "paste" }), codeIs("invalid_input"));
});

test("viewport emits device-metrics override then restart screencast", () => {
  const cmds = mapInputEventToCdp({ height: 600, type: "viewport", width: 800 });
  assert.equal(cmdAt(cmds, 0).method, "Emulation.setDeviceMetricsOverride");
  assert.deepEqual(cmdAt(cmds, 0).params, { deviceScaleFactor: 1, height: 600, mobile: false, width: 800 });
  assert.equal(cmdAt(cmds, 1).method, "Page.stopScreencast");
  assert.equal(cmdAt(cmds, 2).method, "Page.startScreencast");
  assert.equal(paramsAt(cmds, 2).maxWidth, 800);
  assert.equal(paramsAt(cmds, 2).maxHeight, 600);
});

test("buildScreencastParams clamps quality into [1,100] and floors it", () => {
  assert.equal(buildScreencastParams({ quality: 70 }).quality, 70);
  assert.equal(buildScreencastParams({ quality: 0 }).quality, 1); // below min
  assert.equal(buildScreencastParams({ quality: 500 }).quality, 100); // above max
  assert.equal(buildScreencastParams({ quality: 55.9 }).quality, 55); // floored
});

test("buildScreencastParams uses viewport dimensions when positive, else defaults", () => {
  const withViewport = buildScreencastParams({ viewport: { height: 768, width: 1024 } });
  assert.equal(withViewport.maxWidth, 1024);
  assert.equal(withViewport.maxHeight, 768);
  // Non-positive / missing viewport → 1280x720 defaults.
  const defaults = buildScreencastParams({ viewport: { height: -5, width: 0 } });
  assert.equal(defaults.maxWidth, 1280);
  assert.equal(defaults.maxHeight, 720);
  assert.equal(buildScreencastParams().maxWidth, 1280);
});

test("buildScreencastParams always advertises jpeg every-frame", () => {
  const params = buildScreencastParams({ viewport: { height: 480, width: 640 } });
  assert.equal(params.format, "jpeg");
  assert.equal(params.everyNthFrame, 1);
});
