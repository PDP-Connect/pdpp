// Tests for NekoPointerController. Verifies the canonical tap-to-click
// pattern (buttonDown + buttonUp at the mapped remote coordinates) and
// the drag / cancel / dispose contracts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RemotePointerEvent } from "../types.ts";
import {
  type NekoControlPos,
  type NekoPointerControl,
  NekoPointerController,
} from "./neko-pointer-controller.ts";

type Call =
  | { kind: "buttonDown"; button: number; pos: NekoControlPos }
  | { kind: "buttonUp"; button: number; pos: NekoControlPos }
  | { kind: "move"; pos: NekoControlPos }
  | { kind: "touchBegin"; id: number; pos: NekoControlPos; pressure: number | undefined }
  | { kind: "touchUpdate"; id: number; pos: NekoControlPos; pressure: number | undefined }
  | { kind: "touchEnd"; id: number; pos: NekoControlPos; pressure: number | undefined };

function makeControl(opts: { withTouch?: boolean } = {}): {
  control: NekoPointerControl;
  calls: Call[];
} {
  const calls: Call[] = [];
  const control: NekoPointerControl = {
    buttonDown(button, pos) {
      calls.push({ kind: "buttonDown", button, pos });
    },
    buttonUp(button, pos) {
      calls.push({ kind: "buttonUp", button, pos });
    },
    move(pos) {
      calls.push({ kind: "move", pos });
    },
  };
  if (opts.withTouch) {
    control.touchBegin = (id, pos, pressure) =>
      calls.push({ kind: "touchBegin", id, pos, pressure });
    control.touchUpdate = (id, pos, pressure) =>
      calls.push({ kind: "touchUpdate", id, pos, pressure });
    control.touchEnd = (id, pos, pressure) =>
      calls.push({ kind: "touchEnd", id, pos, pressure });
  }
  return { control, calls };
}

// Map (x, y) → (x * 10, y * 10) so we can assert the controller passes
// the *mapped* coordinates, not the raw input.
const scaleByTen = (x: number, y: number): NekoControlPos => ({
  x: x * 10,
  y: y * 10,
});

function touchDown(pointerId: number, x: number, y: number): RemotePointerEvent {
  return { type: "pointerdown", x, y, pointerType: "touch", pointerId, button: 0 };
}
function touchUp(pointerId: number, x: number, y: number): RemotePointerEvent {
  return { type: "pointerup", x, y, pointerType: "touch", pointerId, button: 0 };
}
function touchMove(pointerId: number, x: number, y: number): RemotePointerEvent {
  return { type: "pointermove", x, y, pointerType: "touch", pointerId };
}

describe("NekoPointerController", () => {
  it("single tap emits buttonDown + buttonUp at mapped coords (button 1)", () => {
    const { control, calls } = makeControl();
    const c = new NekoPointerController({ control, mapToRemote: scaleByTen });
    c.handle(touchDown(1, 5, 7));
    c.handle(touchUp(1, 5, 7));
    assert.deepEqual(calls, [
      { kind: "buttonDown", button: 1, pos: { x: 50, y: 70 } },
      { kind: "buttonUp", button: 1, pos: { x: 50, y: 70 } },
    ]);
  });

  it("drag emits buttonDown, move(s), buttonUp", () => {
    const { control, calls } = makeControl();
    const c = new NekoPointerController({ control, mapToRemote: scaleByTen });
    c.handle(touchDown(1, 1, 1));
    c.handle(touchMove(1, 2, 2));
    c.handle(touchMove(1, 3, 3));
    c.handle(touchUp(1, 4, 4));
    assert.deepEqual(calls, [
      { kind: "buttonDown", button: 1, pos: { x: 10, y: 10 } },
      { kind: "move", pos: { x: 20, y: 20 } },
      { kind: "move", pos: { x: 30, y: 30 } },
      { kind: "buttonUp", button: 1, pos: { x: 40, y: 40 } },
    ]);
  });

  it("pointercancel after pointerdown releases the held button (no orphan press)", () => {
    const { control, calls } = makeControl();
    const c = new NekoPointerController({ control, mapToRemote: scaleByTen });
    c.handle(touchDown(7, 1, 2));
    c.handle({
      type: "pointercancel",
      x: 1,
      y: 2,
      pointerType: "touch",
      pointerId: 7,
      button: 0,
    });
    assert.deepEqual(calls, [
      { kind: "buttonDown", button: 1, pos: { x: 10, y: 20 } },
      { kind: "buttonUp", button: 1, pos: { x: 10, y: 20 } },
    ]);
    // A second cancel without a press is a silent no-op (logged debug).
    c.handle({
      type: "pointercancel",
      x: 9,
      y: 9,
      pointerType: "touch",
      pointerId: 7,
      button: 0,
    });
    assert.equal(calls.length, 2);
  });

  it("multiple sequential taps each emit their own buttonDown/Up pair", () => {
    const { control, calls } = makeControl();
    const c = new NekoPointerController({ control, mapToRemote: scaleByTen });
    c.handle(touchDown(1, 1, 1));
    c.handle(touchUp(1, 1, 1));
    c.handle(touchDown(2, 2, 2));
    c.handle(touchUp(2, 2, 2));
    const pairs = calls.filter(
      (e) => e.kind === "buttonDown" || e.kind === "buttonUp",
    );
    assert.equal(pairs.length, 4);
    assert.equal(pairs[0]?.kind, "buttonDown");
    assert.equal(pairs[1]?.kind, "buttonUp");
    assert.equal(pairs[2]?.kind, "buttonDown");
    assert.equal(pairs[3]?.kind, "buttonUp");
  });

  it("mapToRemote is called and its output is used verbatim", () => {
    let mapCalls = 0;
    const { control, calls } = makeControl();
    const c = new NekoPointerController({
      control,
      mapToRemote: (_x, _y) => {
        mapCalls += 1;
        return { x: 999, y: 888 };
      },
    });
    c.handle(touchDown(1, 5, 7));
    c.handle(touchUp(1, 5, 7));
    assert.equal(mapCalls, 2);
    for (const ev of calls) {
      if (ev.kind === "buttonDown" || ev.kind === "buttonUp") {
        assert.deepEqual(ev.pos, { x: 999, y: 888 });
      }
    }
  });

  it("native touch is OFF by default — no touchBegin/End emitted even when control supports it", () => {
    const { control, calls } = makeControl({ withTouch: true });
    const c = new NekoPointerController({ control, mapToRemote: scaleByTen });
    c.handle(touchDown(1, 1, 1));
    c.handle(touchUp(1, 1, 1));
    const native = calls.filter(
      (e) =>
        e.kind === "touchBegin" ||
        e.kind === "touchUpdate" ||
        e.kind === "touchEnd",
    );
    assert.deepEqual(native, []);
  });

  it("with nativeTouch=true, emits touchBegin/End for touch pointers but NOT for mouse", () => {
    const { control, calls } = makeControl({ withTouch: true });
    const c = new NekoPointerController({
      control,
      mapToRemote: scaleByTen,
      nativeTouch: true,
    });
    // Touch tap → emits both.
    c.handle(touchDown(1, 1, 1));
    c.handle(touchUp(1, 1, 1));
    const native = calls.filter(
      (e) =>
        e.kind === "touchBegin" ||
        e.kind === "touchUpdate" ||
        e.kind === "touchEnd",
    );
    assert.equal(native.length, 2);
    assert.equal(native[0]?.kind, "touchBegin");
    assert.equal(native[1]?.kind, "touchEnd");

    // Mouse click → no native touch emitted.
    calls.length = 0;
    c.handle({
      type: "pointerdown",
      x: 1,
      y: 1,
      pointerType: "mouse",
      pointerId: 99,
      button: 0,
    });
    c.handle({
      type: "pointerup",
      x: 1,
      y: 1,
      pointerType: "mouse",
      pointerId: 99,
      button: 0,
    });
    const nativeForMouse = calls.filter(
      (e) =>
        e.kind === "touchBegin" ||
        e.kind === "touchUpdate" ||
        e.kind === "touchEnd",
    );
    assert.deepEqual(nativeForMouse, []);
  });

  it("right-button mouse (PointerEvent.button=2) maps to X11 button 3 on down/up", () => {
    const { control, calls } = makeControl();
    const c = new NekoPointerController({ control, mapToRemote: scaleByTen });
    c.handle({
      type: "pointerdown",
      x: 1,
      y: 1,
      pointerType: "mouse",
      pointerId: 1,
      button: 2,
    });
    c.handle({
      type: "pointerup",
      x: 1,
      y: 1,
      pointerType: "mouse",
      pointerId: 1,
      button: 2,
    });
    assert.deepEqual(calls, [
      { kind: "buttonDown", button: 3, pos: { x: 10, y: 10 } },
      { kind: "buttonUp", button: 3, pos: { x: 10, y: 10 } },
    ]);
  });

  it("disposed controller is a silent no-op on handle()", () => {
    const { control, calls } = makeControl();
    const c = new NekoPointerController({ control, mapToRemote: scaleByTen });
    c.dispose();
    c.handle(touchDown(1, 1, 1));
    c.handle(touchUp(1, 1, 1));
    assert.deepEqual(calls, []);
  });
});
