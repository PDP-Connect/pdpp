// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { CdpCommandParams, CdpCommandTransport } from "@opendatalabs/remote-surface/backends/cdp";

type SendPdppCdpInput = (payload: Record<string, unknown>) => Promise<void>;
type CdpCommandHandler = (params: CdpCommandParams) => Promise<void>;

const HOST_OWNED_COMMANDS = new Set([
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setTouchEmulationEnabled",
  "Page.enable",
  "Page.screencastFrameAck",
  "Page.startScreencast",
  "Page.stopScreencast",
]);

function mouseButton(button: unknown): number {
  switch (button) {
    case "middle":
      return 1;
    case "right":
      return 2;
    case "back":
      return 3;
    case "forward":
      return 4;
    default:
      return 0;
  }
}

function mouseAction(type: unknown): "mousedown" | "mousemove" | "mouseup" {
  if (type === "mousePressed") {
    return "mousedown";
  }
  if (type === "mouseReleased") {
    return "mouseup";
  }
  return "mousemove";
}

function touchAction(type: unknown): "touchend" | "touchmove" | "touchstart" {
  if (type === "touchStart") {
    return "touchstart";
  }
  if (type === "touchMove") {
    return "touchmove";
  }
  return "touchend";
}

function firstTouchPoint(params: CdpCommandParams): Record<string, unknown> {
  const touchPoints = Array.isArray(params.touchPoints) ? params.touchPoints : [];
  const [point] = touchPoints;
  return typeof point === "object" && point !== null ? (point as Record<string, unknown>) : {};
}

function inputHandlers(sendInput: SendPdppCdpInput): Record<string, CdpCommandHandler> {
  return {
    "Input.dispatchKeyEvent": async (params) => {
      await sendInput({
        action: params.type === "keyUp" ? "keyup" : "keydown",
        code: params.code,
        key: params.key,
        modifiers: params.modifiers,
        type: "keyboard",
      });
    },
    "Input.dispatchMouseEvent": async (params) => {
      if (params.type === "mouseWheel") {
        await sendInput({
          deltaX: params.deltaX,
          deltaY: params.deltaY,
          type: "scroll",
          x: params.x,
          y: params.y,
        });
        return;
      }
      await sendInput({
        action: mouseAction(params.type),
        button: mouseButton(params.button),
        type: "mouse",
        x: params.x,
        y: params.y,
      });
    },
    "Input.dispatchTouchEvent": async (params) => {
      const touch = firstTouchPoint(params);
      await sendInput({
        action: touchAction(params.type),
        type: "touch",
        x: touch.x ?? 0,
        y: touch.y ?? 0,
        ...(typeof touch.id === "number" ? { id: touch.id } : {}),
      });
    },
    "Input.insertText": async (params) => {
      await sendInput({ text: params.text, type: "paste" });
    },
  };
}

export function createPdppCdpTransport(sendInput: SendPdppCdpInput): CdpCommandTransport {
  const handlers = inputHandlers(sendInput);
  return {
    on() {
      // Frames arrive on the console's existing SSE stream, not this input-only bridge.
      return {
        unsubscribe() {
          // No local subscription was created.
        },
      };
    },
    async send<Result = unknown>(method: string, params: CdpCommandParams = {}): Promise<Result> {
      if (HOST_OWNED_COMMANDS.has(method)) {
        // The PDPP host owns these through its viewport endpoint and SSE stream.
        return undefined as Result;
      }
      const handler = handlers[method];
      if (!handler) {
        throw new Error(`Unsupported console CDP bridge command: ${method}`);
      }
      await handler(params);
      return undefined as Result;
    },
  };
}
