import assert from "node:assert/strict";
import test from "node:test";
import { createPdppCdpTransport } from "./stream-viewer-cdp-transport.ts";

const UNSUPPORTED_COMMAND_RE = /Unsupported console CDP bridge command/;

test("PDPP CDP transport preserves the console input wire", async () => {
  const sent: Record<string, unknown>[] = [];
  const transport = createPdppCdpTransport((payload) => {
    sent.push(payload);
    return Promise.resolve();
  });

  await transport.send("Input.dispatchMouseEvent", {
    button: "right",
    type: "mousePressed",
    x: 12,
    y: 34,
  });
  await transport.send("Input.dispatchMouseEvent", {
    deltaX: 1,
    deltaY: 2,
    type: "mouseWheel",
    x: 56,
    y: 78,
  });
  await transport.send("Input.dispatchTouchEvent", {
    touchPoints: [{ id: 7, x: 90, y: 123 }],
    type: "touchMove",
  });
  await transport.send("Input.dispatchKeyEvent", {
    code: "KeyA",
    key: "a",
    modifiers: 0,
    type: "keyDown",
  });
  await transport.send("Input.insertText", { text: "pasted" });

  assert.deepEqual(sent, [
    { action: "mousedown", button: 2, type: "mouse", x: 12, y: 34 },
    { deltaX: 1, deltaY: 2, type: "scroll", x: 56, y: 78 },
    { action: "touchmove", id: 7, type: "touch", x: 90, y: 123 },
    { action: "keydown", code: "KeyA", key: "a", modifiers: 0, type: "keyboard" },
    { text: "pasted", type: "paste" },
  ]);
});

test("PDPP CDP transport leaves stream lifecycle with the host", async () => {
  const sent: Record<string, unknown>[] = [];
  const transport = createPdppCdpTransport((payload) => {
    sent.push(payload);
    return Promise.resolve();
  });

  await transport.send("Page.enable");
  await transport.send("Page.startScreencast");
  await transport.send("Emulation.setDeviceMetricsOverride", { height: 844, width: 390 });

  assert.deepEqual(sent, []);
  await assert.rejects(async () => {
    await transport.send("Runtime.evaluate");
  }, UNSUPPORTED_COMMAND_RE);
});
