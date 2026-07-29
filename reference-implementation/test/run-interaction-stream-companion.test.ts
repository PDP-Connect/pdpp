// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
/**
 * Unit tests for the streaming companion CDP mapping. The wire shape sent
 * by the viewer is translated to a deterministic CDP command list. These
 * tests pin the translation so a viewer-side change cannot accidentally
 * widen the kinds of commands the runtime will dispatch.
 */
import test from "node:test";

import {
  buildScreencastParams,
  type CdpCommand,
  createMockCompanion,
  mapInputEventToCdp,
} from "../server/streaming/cdp-companion.ts";
import { createDefaultStreamingCompanionFactory } from "../server/streaming/companion-factory.ts";

type CodedError = Error & { code?: string };

/** Narrows a CDP command's `params` (typed `unknown` at the source) for assertions. */
function paramsOf(cmd: CdpCommand | undefined): Record<string, unknown> {
  assert.ok(cmd, "expected a CDP command at this index");
  assert.ok(cmd.params && typeof cmd.params === "object", "expected object params");
  return cmd.params as Record<string, unknown>;
}

function commandAt(cmds: CdpCommand[], index: number): CdpCommand {
  const cmd = cmds[index];
  assert.ok(cmd, `expected a CDP command at index ${index}`);
  return cmd;
}

test("mouse mousemove → Input.dispatchMouseEvent (mouseMoved)", () => {
  const cmds = mapInputEventToCdp({ action: "mousemove", type: "mouse", x: 100, y: 200 });
  assert.equal(cmds.length, 1);
  const cmd = commandAt(cmds, 0);
  assert.equal(cmd.method, "Input.dispatchMouseEvent");
  const params = paramsOf(cmd);
  assert.equal(params.type, "mouseMoved");
  assert.equal(params.x, 100);
  assert.equal(params.y, 200);
});

test("mouse click → press + release", () => {
  const cmds = mapInputEventToCdp({ action: "click", button: 0, type: "mouse", x: 10, y: 20 });
  assert.deepEqual(
    cmds.map((c) => paramsOf(c).type),
    ["mousePressed", "mouseReleased"]
  );
  assert.equal(paramsOf(commandAt(cmds, 0)).button, "left");
});

test("mouse dblclick emits two press/release pairs with clickCount progression", () => {
  const cmds = mapInputEventToCdp({ action: "dblclick", type: "mouse", x: 1, y: 1 });
  assert.equal(cmds.length, 4);
  assert.equal(paramsOf(commandAt(cmds, 0)).clickCount, 1);
  assert.equal(paramsOf(commandAt(cmds, 1)).clickCount, 1);
  assert.equal(paramsOf(commandAt(cmds, 2)).clickCount, 2);
  assert.equal(paramsOf(commandAt(cmds, 3)).clickCount, 2);
});

test("keyboard printable key sets text and keyDown", () => {
  const cmds = mapInputEventToCdp({ action: "keydown", code: "KeyA", key: "a", type: "keyboard" });
  const cmd = commandAt(cmds, 0);
  assert.equal(cmd.method, "Input.dispatchKeyEvent");
  const params = paramsOf(cmd);
  assert.equal(params.type, "keyDown");
  assert.equal(params.text, "a");
});

test("keyboard named key uses rawKeyDown and a virtual key code", () => {
  const cmds = mapInputEventToCdp({ action: "keydown", code: "Enter", key: "Enter", type: "keyboard" });
  const params = paramsOf(commandAt(cmds, 0));
  assert.equal(params.type, "rawKeyDown");
  assert.equal(params.windowsVirtualKeyCode, 13);
  assert.equal(params.text, undefined);
});

test("touch start translates to Input.dispatchTouchEvent with one touch point", () => {
  const cmds = mapInputEventToCdp({ action: "touchstart", id: 1, type: "touch", x: 10, y: 20 });
  const cmd = commandAt(cmds, 0);
  assert.equal(cmd.method, "Input.dispatchTouchEvent");
  const params = paramsOf(cmd);
  assert.equal(params.type, "touchStart");
  assert.deepEqual(params.touchPoints, [{ id: 1, x: 10, y: 20 }]);
});

test("touch end emits an empty touchPoints list", () => {
  const cmds = mapInputEventToCdp({ action: "touchend", type: "touch", x: 0, y: 0 });
  const params = paramsOf(commandAt(cmds, 0));
  assert.equal(params.type, "touchEnd");
  assert.deepEqual(params.touchPoints, []);
});

test("scroll → mouseWheel with deltas", () => {
  const cmds = mapInputEventToCdp({ deltaX: 1, deltaY: -2, type: "scroll", x: 5, y: 6 });
  const params = paramsOf(commandAt(cmds, 0));
  assert.equal(params.type, "mouseWheel");
  assert.equal(params.deltaX, 1);
  assert.equal(params.deltaY, -2);
});

test("viewport → Emulation.setDeviceMetricsOverride and restarts screencast", () => {
  const cmds = mapInputEventToCdp({
    deviceScaleFactor: 3,
    height: 844,
    mobile: true,
    type: "viewport",
    width: 390,
  });
  assert.deepEqual(
    cmds.map((cmd) => cmd.method),
    ["Emulation.setDeviceMetricsOverride", "Page.stopScreencast", "Page.startScreencast"]
  );
  const first = commandAt(cmds, 0);
  assert.equal(first.method, "Emulation.setDeviceMetricsOverride");
  const firstParams = paramsOf(first);
  assert.equal(firstParams.width, 390);
  assert.equal(firstParams.height, 844);
  assert.equal(firstParams.deviceScaleFactor, 3);
  assert.equal(firstParams.mobile, true);
  const thirdParams = paramsOf(commandAt(cmds, 2));
  assert.equal(thirdParams.maxWidth, 390);
  assert.equal(thirdParams.maxHeight, 844);
});

test("unknown event types raise invalid_input", () => {
  assert.throws(
    () => mapInputEventToCdp({ action: "spin", type: "mouse", x: 0, y: 0 }),
    (err: unknown) => (err as CodedError).code === "invalid_input"
  );
  assert.throws(
    () => mapInputEventToCdp({ type: "fly" }),
    (err: unknown) => (err as CodedError).code === "invalid_input"
  );
  assert.throws(
    () => mapInputEventToCdp({ action: "click", type: "mouse", x: "oops", y: 0 }),
    (err: unknown) => (err as CodedError).code === "invalid_input"
  );
});

test("buildScreencastParams clamps quality and applies sane defaults", () => {
  assert.deepEqual(buildScreencastParams({ quality: 999, viewport: { height: 768, width: 1024 } }), {
    everyNthFrame: 1,
    format: "jpeg",
    maxHeight: 768,
    maxWidth: 1024,
    quality: 100,
  });
  assert.deepEqual(buildScreencastParams({}), {
    everyNthFrame: 1,
    format: "jpeg",
    maxHeight: 720,
    maxWidth: 1280,
    quality: 70,
  });
});

test("mock companion routes pushFrame to subscribers and accumulates dispatched commands", async () => {
  const companion = createMockCompanion({ browser_session_id: "mock" });
  const seen: unknown[] = [];
  const unsub = companion.onFrame((frame) => seen.push(frame));
  await companion.start({ height: 600, width: 800 });
  companion.pushFrame({ data: "AAAA", sessionId: 1 });
  unsub();
  companion.pushFrame({ data: "BBBB", sessionId: 2 });
  assert.equal(seen.length, 1);

  await companion.dispatch({ action: "click", type: "mouse", x: 1, y: 1 });
  assert.equal(companion.inputs.length, 1);
  assert.ok(companion.cdpCalls.some((c) => c.method === "Input.dispatchMouseEvent"));
  assert.ok(companion.cdpCalls.some((c) => c.method === "Page.startScreencast"));
});

test("resolved companion can resolve n.eko backend before start", async () => {
  const factory = createDefaultStreamingCompanionFactory({
    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    fetchImpl: async () => {
      throw new Error("resolveBackend must not perform network I/O");
    },
    resolveTargetForInteraction: () => ({
      backend: "neko",
      base_url: "http://neko:8080/neko",
    }),
    // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
    WebSocketCtor() {},
  });
  assert.ok(factory, "expected a factory when resolveTargetForInteraction is a function");
  const companion = factory({
    browser_session_id: "bs_neko",
    interaction_id: "int_neko",
    run_id: "run_neko",
  });
  assert.ok(companion, "expected a companion for valid companion ids");

  assert.equal(await companion.resolveBackend(), "neko");
  assert.equal(companion.backend, "neko");
});

test("resolved companion prefers route-resolved target over legacy registry resolver", async () => {
  const factory = createDefaultStreamingCompanionFactory({
    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    fetchImpl: async () => {
      throw new Error("resolveBackend must not perform network I/O");
    },
    resolveTargetForInteraction: () => {
      throw new Error("legacy resolver must not run when route supplied a target");
    },
    // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
    WebSocketCtor() {},
  });
  assert.ok(factory, "expected a factory when resolveTargetForInteraction is a function");
  const companion = factory({
    browser_session_id: "bs_route_target",
    interaction_id: "asst_route_target",
    run_id: "run_route_target",
    target: {
      backend: "neko",
      base_url: "http://neko:8080/neko",
      interaction_id: "asst_route_target",
      lease_id: "lease_route_target",
      profile_key: "chatgpt:cin_route_target",
      surface_id: "surface_route_target",
      window_settle_endpoint: "http://neko:9222/pdpp/window-settle",
    },
  });
  assert.ok(companion, "expected a companion for valid companion ids");

  assert.equal(await companion.resolveBackend(), "neko");
  assert.equal(companion.backend, "neko");
});
