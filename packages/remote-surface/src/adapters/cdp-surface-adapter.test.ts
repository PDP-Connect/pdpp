import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  CdpCommandParams,
  CdpCommandTransport,
} from "../backends/cdp/index.ts";
import { XK_Return } from "../ime/index.ts";
import {
  CdpSurfaceAdapter,
  type CdpSurfaceClientApi,
  type CdpSurfaceFrame,
  type CdpInputPayload,
} from "./cdp-surface-adapter.ts";

class FakeElement {
  listeners = new Map<string, Set<EventListener>>();
  rect = { height: 100, left: 10, top: 20, width: 200 };
  focused = false;

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  focus(): void {
    this.focused = true;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  dispatch(type: string, event: object): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as Event);
    }
  }
}

type FakeFrameElement = {
  getBoundingClientRect(): { height: number; left: number; top: number; width: number };
};

type RecordedCommand = {
  method: string;
  params?: CdpCommandParams;
};

class FakeCdpSession implements CdpCommandTransport {
  readonly commands: RecordedCommand[] = [];
  private frameHandler: ((params: unknown) => void) | null = null;
  failMethod: string | null = null;
  selectionText = "";

  async send<Result = unknown>(method: string, params?: CdpCommandParams): Promise<Result> {
    this.commands.push(params === undefined ? { method } : { method, params });
    if (method === this.failMethod) {
      throw new Error(`failed ${method}`);
    }
    if (method === "Runtime.evaluate") {
      return { result: { value: this.selectionText } } as Result;
    }
    return undefined as Result;
  }

  on(eventName: string, handler: (params: unknown) => void) {
    assert.equal(eventName, "Page.screencastFrame");
    this.frameHandler = handler;
    return {
      unsubscribe: () => {
        this.frameHandler = null;
      },
    };
  }

  emitFrame(params: unknown): void {
    this.frameHandler?.(params);
  }

  hasFrameHandler(): boolean {
    return this.frameHandler !== null;
  }
}

function keyboardEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    altKey: false,
    code: "KeyA",
    ctrlKey: false,
    key: "a",
    metaKey: false,
    preventDefault() {
      /* no-op */
    },
    shiftKey: false,
    type: "keydown",
    ...overrides,
  } as KeyboardEvent;
}

function pasteEvent(text: string): ClipboardEvent {
  return {
    clipboardData: {
      getData: (format: string) => (format === "text" ? text : ""),
    },
    preventDefault() {
      /* no-op */
    },
  } as ClipboardEvent;
}

function touchEvent(
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  point: { clientX: number; clientY: number; identifier?: number }
): TouchEvent {
  const touch = {
    clientX: point.clientX,
    clientY: point.clientY,
    identifier: point.identifier ?? 7,
  } as Touch;
  return {
    changedTouches: [touch],
    preventDefault() {
      /* no-op */
    },
    touches: type === "touchend" || type === "touchcancel" ? [] : [touch],
    type,
  } as unknown as TouchEvent;
}

async function flushAsync(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

function makeAdapter(overrides: Partial<CdpSurfaceClientApi> = {}) {
  const cdp = new FakeCdpSession();
  const frames: CdpSurfaceFrame[] = [];
  const errors: string[] = [];
  const clipboard: string[] = [];
  const debug: string[] = [];
  const client: CdpSurfaceClientApi = {
    cdp,
    getViewportInfo: () => ({ height: 50, width: 100 }),
    getClipboardPolicy: () => ({ canForwardNativePasteEvent: true }),
    mediaSink: {
      onFrame(frame) {
        frames.push(frame);
      },
      onError(error) {
        errors.push(error.message);
      },
    },
    clipboardSink: {
      writeText(text) {
        clipboard.push(text);
      },
    },
    onInputDebug(event) {
      debug.push(event);
    },
    ...overrides,
  };
  const adapter = new CdpSurfaceAdapter({ client, config: { kind: "cdp" } });
  return { adapter, cdp, clipboard, debug, errors, frames };
}

describe("CdpSurfaceAdapter", () => {
  it("supports legacy stream clients that accept HTTP input commands without direct CDP", async () => {
    const node = new FakeElement();
    const inputs: CdpInputPayload[] = [];
    const client: CdpSurfaceClientApi = {
      getViewportInfo: () => ({ height: 50, width: 100 }),
      sendInput(payload) {
        inputs.push(payload);
      },
    };
    const adapter = new CdpSurfaceAdapter({ client, config: { kind: "cdp" } });

    await adapter.mount(node as unknown as HTMLElement);
    await adapter.sendText("hello");
    assert.equal(await adapter.pasteText("clip"), true);
    await adapter.sendPointer({ pointerId: 1, pointerType: "mouse", type: "pointerdown", x: 7, y: 8 });
    await adapter.unmount();

    assert.deepEqual(inputs, [
      { text: "hello", type: "paste" },
      { text: "clip", type: "paste" },
      { action: "mousedown", button: 0, type: "mouse", x: 7, y: 8 },
    ]);
    assert.equal(adapter.getLifecycleState(), "idle");
  });

  it("starts and stops CDP screencast without leaking frame listeners", async () => {
    const node = new FakeElement();
    const { adapter, cdp, frames } = makeAdapter();

    await adapter.mount(node as unknown as HTMLElement);
    cdp.emitFrame({ data: "jpeg", metadata: { device_width: 100 }, sessionId: 7 });
    await Promise.resolve();
    await adapter.unmount();
    cdp.emitFrame({ data: "late", sessionId: 8 });
    await Promise.resolve();

    assert.deepEqual(cdp.commands, [
      {
        method: "Emulation.setDeviceMetricsOverride",
        params: {
          deviceScaleFactor: 1,
          height: 50,
          mobile: false,
          screenHeight: 50,
          screenWidth: 100,
          width: 100,
        },
      },
      {
        method: "Emulation.setTouchEmulationEnabled",
        params: { enabled: false, maxTouchPoints: 5 },
      },
      {
        method: "Page.enable",
      },
      {
        method: "Page.startScreencast",
        params: { everyNthFrame: 1, format: "jpeg", quality: 80 },
      },
      { method: "Page.screencastFrameAck", params: { sessionId: 7 } },
      { method: "Page.stopScreencast" },
    ]);
    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.data, "jpeg");
  });

  it("rolls back CDP frame subscription when screencast startup fails", async () => {
    const node = new FakeElement();
    const { adapter, cdp, frames } = makeAdapter();
    cdp.failMethod = "Page.startScreencast";

    await assert.rejects(() => adapter.mount(node as unknown as HTMLElement), /failed Page\.startScreencast/u);
    cdp.emitFrame({ data: "late", sessionId: 8 });
    await Promise.resolve();

    assert.equal(adapter.getLifecycleState(), "error");
    assert.equal(cdp.hasFrameHandler(), false);
    assert.deepEqual(frames, []);
  });

  it("routes keyboard events and keysyms through Input.dispatchKeyEvent", async () => {
    const node = new FakeElement();
    const { adapter, cdp } = makeAdapter();
    await adapter.mount(node as unknown as HTMLElement);
    cdp.commands.length = 0;

    node.dispatch("keydown", keyboardEvent({ ctrlKey: true }));
    node.dispatch("keyup", keyboardEvent({ type: "keyup" }));
    await adapter.sendKeysym({ keysym: XK_Return, type: "keydown" });

    assert.deepEqual(cdp.commands, [
      {
        method: "Input.dispatchKeyEvent",
        params: {
          code: "KeyA",
          key: "a",
          modifiers: 2,
          text: "a",
          type: "keyDown",
          unmodifiedText: "a",
          windowsVirtualKeyCode: 65,
        },
      },
      {
        method: "Input.dispatchKeyEvent",
        params: {
          code: "KeyA",
          key: "a",
          modifiers: 0,
          type: "keyUp",
          windowsVirtualKeyCode: 65,
        },
      },
      {
        method: "Input.dispatchKeyEvent",
        params: {
          code: "Enter",
          key: "Enter",
          modifiers: 0,
          text: "\r",
          type: "keyDown",
          unmodifiedText: "\r",
          windowsVirtualKeyCode: 13,
        },
      },
    ]);
  });

  it("uses Input.insertText for sendText, pasteText, and allowed native paste", async () => {
    const node = new FakeElement();
    const { adapter, cdp } = makeAdapter();
    await adapter.mount(node as unknown as HTMLElement);
    cdp.commands.length = 0;

    await adapter.sendText("hello");
    assert.equal(await adapter.pasteText("clip"), true);
    node.dispatch("paste", pasteEvent("native"));

    assert.deepEqual(cdp.commands, [
      { method: "Input.insertText", params: { text: "hello" } },
      { method: "Input.insertText", params: { text: "clip" } },
      { method: "Input.insertText", params: { text: "native" } },
    ]);
  });

  it("does not forward native paste when host policy denies it", async () => {
    const node = new FakeElement();
    const { adapter, cdp } = makeAdapter({
      getClipboardPolicy: () => ({ canForwardNativePasteEvent: false }),
    });
    await adapter.mount(node as unknown as HTMLElement);
    cdp.commands.length = 0;

    node.dispatch("paste", pasteEvent("secret"));

    assert.deepEqual(cdp.commands, []);
  });

  it("routes pointer-like DOM events with viewport coordinates", async () => {
    const node = new FakeElement();
    const { adapter, cdp } = makeAdapter({
      getFrameElement: () => node as unknown as FakeFrameElement,
    });
    await adapter.mount(node as unknown as HTMLElement);
    cdp.commands.length = 0;

    node.dispatch("mousedown", { button: 0, clientX: 110, clientY: 70 });
    node.dispatch("mouseup", { button: 0, clientX: 210, clientY: 120 });
    node.dispatch("wheel", {
      clientX: 10,
      clientY: 20,
      deltaX: 1,
      deltaY: 2,
      preventDefault() {
        /* no-op */
      },
    });

    assert.deepEqual(cdp.commands, [
      {
        method: "Input.dispatchMouseEvent",
        params: { button: "left", buttons: 1, modifiers: 0, type: "mousePressed", x: 50, y: 25 },
      },
      {
        method: "Input.dispatchMouseEvent",
        params: { button: "left", buttons: 0, modifiers: 0, type: "mouseReleased", x: 100, y: 50 },
      },
      {
        method: "Input.dispatchMouseEvent",
        params: { deltaX: 1, deltaY: 2, modifiers: 0, type: "mouseWheel", x: 0, y: 0 },
      },
    ]);
  });

  it("translates DOM touch taps to CDP mouse press and release", async () => {
    const node = new FakeElement();
    const { adapter, cdp } = makeAdapter({
      getFrameElement: () => node as unknown as FakeFrameElement,
    });
    await adapter.mount(node as unknown as HTMLElement);
    cdp.commands.length = 0;

    node.dispatch("touchstart", touchEvent("touchstart", { clientX: 110, clientY: 70 }));
    node.dispatch("touchend", touchEvent("touchend", { clientX: 110, clientY: 70 }));
    await flushAsync();

    assert.equal(node.focused, true);
    assert.equal(cdp.commands[0]?.method, "Runtime.evaluate");
    assert.match(String(cdp.commands[0]?.params?.expression), /active\.blur/u);
    assert.deepEqual(cdp.commands.slice(1), [
      {
        method: "Input.dispatchMouseEvent",
        params: { button: "left", buttons: 1, modifiers: 0, type: "mousePressed", x: 50, y: 25 },
      },
      {
        method: "Input.dispatchMouseEvent",
        params: { button: "left", buttons: 0, modifiers: 0, type: "mouseReleased", x: 50, y: 25 },
      },
    ]);
  });

  it("starts DOM touch drags after the RBS threshold and moves with the primary button held", async () => {
    const node = new FakeElement();
    const { adapter, cdp } = makeAdapter({
      getFrameElement: () => node as unknown as FakeFrameElement,
    });
    await adapter.mount(node as unknown as HTMLElement);
    cdp.commands.length = 0;

    node.dispatch("touchstart", touchEvent("touchstart", { clientX: 110, clientY: 70 }));
    await flushAsync();
    cdp.commands.length = 0;

    node.dispatch("touchmove", touchEvent("touchmove", { clientX: 116, clientY: 70 }));
    await flushAsync();
    assert.deepEqual(cdp.commands, []);

    node.dispatch("touchmove", touchEvent("touchmove", { clientX: 119, clientY: 70 }));
    node.dispatch("touchend", touchEvent("touchend", { clientX: 130, clientY: 70 }));
    await flushAsync();

    assert.deepEqual(cdp.commands, [
      {
        method: "Input.dispatchMouseEvent",
        params: { button: "left", buttons: 1, modifiers: 0, type: "mousePressed", x: 50, y: 25 },
      },
      {
        method: "Input.dispatchMouseEvent",
        params: { button: "left", buttons: 1, modifiers: 0, type: "mouseMoved", x: 55, y: 25 },
      },
      {
        method: "Input.dispatchMouseEvent",
        params: { button: "left", buttons: 0, modifiers: 0, type: "mouseReleased", x: 60, y: 25 },
      },
    ]);
  });

  it("releases a held CDP mouse button when a DOM touch drag is cancelled", async () => {
    const node = new FakeElement();
    const { adapter, cdp } = makeAdapter({
      getFrameElement: () => node as unknown as FakeFrameElement,
    });
    await adapter.mount(node as unknown as HTMLElement);
    cdp.commands.length = 0;

    node.dispatch("touchstart", touchEvent("touchstart", { clientX: 110, clientY: 70 }));
    await flushAsync();
    cdp.commands.length = 0;

    node.dispatch("touchmove", touchEvent("touchmove", { clientX: 119, clientY: 70 }));
    node.dispatch("touchcancel", touchEvent("touchcancel", { clientX: 119, clientY: 70 }));
    await flushAsync();

    assert.deepEqual(cdp.commands, [
      {
        method: "Input.dispatchMouseEvent",
        params: { button: "left", buttons: 1, modifiers: 0, type: "mousePressed", x: 50, y: 25 },
      },
      {
        method: "Input.dispatchMouseEvent",
        params: { button: "left", buttons: 1, modifiers: 0, type: "mouseMoved", x: 55, y: 25 },
      },
      {
        method: "Input.dispatchMouseEvent",
        params: { button: "left", buttons: 0, modifiers: 0, type: "mouseReleased", x: 55, y: 25 },
      },
    ]);
  });

  it("suppresses synthetic mouse events after a DOM touch gesture", async () => {
    const node = new FakeElement();
    const { adapter, cdp } = makeAdapter({
      getFrameElement: () => node as unknown as FakeFrameElement,
    });
    await adapter.mount(node as unknown as HTMLElement);
    cdp.commands.length = 0;

    node.dispatch("touchstart", touchEvent("touchstart", { clientX: 110, clientY: 70 }));
    node.dispatch("touchend", touchEvent("touchend", { clientX: 110, clientY: 70 }));
    node.dispatch("mousedown", { button: 0, clientX: 110, clientY: 70 });
    node.dispatch("mouseup", { button: 0, clientX: 110, clientY: 70 });
    await flushAsync();

    assert.equal(cdp.commands.filter((command) => command.method === "Input.dispatchMouseEvent").length, 2);
  });

  it("keeps explicit programmatic CDP touch input on the CDP touch path", async () => {
    const node = new FakeElement();
    const { adapter, cdp } = makeAdapter();
    await adapter.mount(node as unknown as HTMLElement);
    cdp.commands.length = 0;

    await adapter.sendPointer({
      pointerId: 11,
      pointerType: "touch",
      type: "pointerdown",
      x: 5,
      y: 6,
    });

    assert.deepEqual(cdp.commands, [
      {
        method: "Input.dispatchTouchEvent",
        params: {
          modifiers: 0,
          touchPoints: [{ id: 11, radiusX: 1, radiusY: 1, x: 5, y: 6 }],
          type: "touchStart",
        },
      },
    ]);
  });

  it("maps pointer events through object-contain letterboxing", async () => {
    const node = new FakeElement();
    node.rect = { height: 100, left: 0, top: 0, width: 200 };
    const { adapter, cdp } = makeAdapter({
      getFrameElement: () => node as unknown as FakeFrameElement,
      getViewportInfo: () => ({ height: 100, width: 100 }),
    });
    await adapter.mount(node as unknown as HTMLElement);
    cdp.commands.length = 0;

    node.dispatch("mousedown", { button: 0, clientX: 25, clientY: 50 });
    node.dispatch("mousedown", { button: 0, clientX: 50, clientY: 50 });
    node.dispatch("mouseup", { button: 0, clientX: 150, clientY: 50 });

    assert.deepEqual(cdp.commands, [
      {
        method: "Input.dispatchMouseEvent",
        params: { button: "left", buttons: 1, modifiers: 0, type: "mousePressed", x: 0, y: 50 },
      },
      {
        method: "Input.dispatchMouseEvent",
        params: { button: "left", buttons: 0, modifiers: 0, type: "mouseReleased", x: 100, y: 50 },
      },
    ]);
  });

  it("focuses local soft keyboard affordance and remote selector through Runtime.evaluate", async () => {
    const node = new FakeElement();
    const softKeyboard = new FakeElement();
    const { adapter, cdp } = makeAdapter({
      getRemoteFocusTarget: () => ({ selector: "input[type=email]" }),
      getSoftKeyboardElement: () => softKeyboard,
    });
    const originalWindow = globalThis.window;
    globalThis.window = {
      matchMedia: () => ({ matches: true }),
    } as unknown as Window & typeof globalThis;
    try {
      await adapter.mount(node as unknown as HTMLElement);
      cdp.commands.length = 0;

      adapter.focusTextInput({ inputMode: "email" });
      await Promise.resolve();

      assert.equal(softKeyboard.focused, true);
      assert.equal(cdp.commands[0]?.method, "Runtime.evaluate");
      assert.match(String(cdp.commands[0]?.params?.expression), /input\[type=email\]/u);
    } finally {
      globalThis.window = originalWindow;
    }
  });

  it("copies remote selection through Runtime.evaluate only when a clipboard sink is available", async () => {
    const node = new FakeElement();
    const { adapter, cdp, clipboard } = makeAdapter();
    cdp.selectionText = "selected";
    await adapter.mount(node as unknown as HTMLElement);
    cdp.commands.length = 0;

    assert.equal(await adapter.copyRemoteSelection(), true);

    assert.deepEqual(clipboard, ["selected"]);
    assert.equal(cdp.commands[0]?.method, "Runtime.evaluate");
  });

  it("cleans up DOM listeners on unmount", async () => {
    const node = new FakeElement();
    const { adapter, cdp } = makeAdapter();
    await adapter.mount(node as unknown as HTMLElement);
    await adapter.unmount();
    cdp.commands.length = 0;

    node.dispatch("keydown", keyboardEvent());
    assert.deepEqual(cdp.commands, []);
  });
});
