import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type CdpInputPayload,
  CdpSurfaceAdapter,
  type CdpSurfaceClientApi,
} from "./cdp-surface-adapter.ts";

class FakeElement {
  listeners = new Map<string, Set<EventListener>>();
  rect = { height: 100, left: 10, top: 20, width: 200 };

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
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

function makeAdapter(overrides: Partial<CdpSurfaceClientApi> = {}) {
  const input: CdpInputPayload[] = [];
  const debug: string[] = [];
  const client: CdpSurfaceClientApi = {
    sendInput(payload) {
      input.push(payload);
    },
    getViewportInfo: () => ({ height: 50, width: 100 }),
    getClipboardPolicy: () => ({ canForwardNativePasteEvent: true }),
    onInputDebug(event) {
      debug.push(event);
    },
    ...overrides,
  };
  const adapter = new CdpSurfaceAdapter({ client, config: { kind: "cdp" } });
  return { adapter, debug, input };
}

describe("CdpSurfaceAdapter", () => {
  it("mounts DOM listeners and routes keyboard input through the package client boundary", async () => {
    const node = new FakeElement();
    const { adapter, input } = makeAdapter();
    await adapter.mount(node as unknown as HTMLElement);

    node.dispatch("keydown", keyboardEvent({ ctrlKey: true }));
    node.dispatch("keyup", keyboardEvent({ type: "keyup" }));

    assert.deepEqual(input, [
      { type: "keyboard", action: "keydown", key: "a", code: "KeyA", modifiers: 2 },
      { type: "keyboard", action: "keyup", key: "a", code: "KeyA", modifiers: 0 },
    ]);
  });

  it("forwards native paste only when host policy allows it", async () => {
    const node = new FakeElement();
    const { adapter, input } = makeAdapter();
    await adapter.mount(node as unknown as HTMLElement);
    node.dispatch("paste", pasteEvent("clip"));
    assert.deepEqual(input, [{ type: "paste", text: "clip" }]);

    const denied = new FakeElement();
    const deniedRun = makeAdapter({
      getClipboardPolicy: () => ({ canForwardNativePasteEvent: false }),
    });
    await deniedRun.adapter.mount(denied as unknown as HTMLElement);
    denied.dispatch("paste", pasteEvent("secret"));
    assert.deepEqual(deniedRun.input, []);
  });

  it("routes pointer-like DOM events with viewport coordinates", async () => {
    const node = new FakeElement();
    const { adapter, input } = makeAdapter({
      getFrameElement: () => node as unknown as FakeFrameElement,
    });
    await adapter.mount(node as unknown as HTMLElement);

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

    assert.deepEqual(input, [
      { type: "mouse", action: "mousedown", x: 50, y: 25, button: 0 },
      { type: "mouse", action: "mouseup", x: 100, y: 50, button: 0 },
      { type: "scroll", x: 0, y: 0, deltaX: 1, deltaY: 2 },
    ]);
  });

  it("maps CDP pointer events through object-contain letterboxing", async () => {
    const node = new FakeElement();
    node.rect = { height: 100, left: 0, top: 0, width: 200 };
    const { adapter, input } = makeAdapter({
      getFrameElement: () => node as unknown as FakeFrameElement,
      getViewportInfo: () => ({ height: 100, width: 100 }),
    });
    await adapter.mount(node as unknown as HTMLElement);

    node.dispatch("mousedown", { button: 0, clientX: 25, clientY: 50 });
    node.dispatch("mousedown", { button: 0, clientX: 50, clientY: 50 });
    node.dispatch("mouseup", { button: 0, clientX: 150, clientY: 50 });

    assert.deepEqual(input, [
      { type: "mouse", action: "mousedown", x: 0, y: 50, button: 0 },
      { type: "mouse", action: "mouseup", x: 100, y: 50, button: 0 },
    ]);
  });

  it("cleans up DOM listeners on unmount", async () => {
    const node = new FakeElement();
    const { adapter, input } = makeAdapter();
    await adapter.mount(node as unknown as HTMLElement);
    await adapter.unmount();

    node.dispatch("keydown", keyboardEvent());
    assert.deepEqual(input, []);
  });
});
