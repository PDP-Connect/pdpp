// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: remote-surface 1.5.1 is installed in the reference implementation workspace; the repository-root checker does not resolve that local package.
import { createRemoteSurfaceSession } from "@opendatalabs/remote-surface/client";
// @ts-expect-error jsdom is a test-only dev dependency without declarations in the reference tsconfig.
// biome-ignore lint/correctness/noUnresolvedImports: jsdom is installed for this DOM-only session test.
import { JSDOM } from "jsdom";

interface TransportMessage {
  [key: string]: unknown;
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const globals = globalThis as Record<string, unknown>;
  const previous = {
    cancelAnimationFrame: globals.cancelAnimationFrame,
    document: globals.document,
    getComputedStyle: globals.getComputedStyle,
    ResizeObserver: globals.ResizeObserver,
    requestAnimationFrame: globals.requestAnimationFrame,
    window: globals.window,
  };
  const ResizeObserver = class {
    readonly callback: () => void;

    constructor(callback: () => void) {
      this.callback = callback;
    }

    observe(): void {
      this.callback();
    }

    unobserve(): void {
      /* intentional no-op */
    }

    disconnect(): void {
      /* intentional no-op */
    }
  };
  Object.assign(globalThis, {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    ResizeObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    window: dom.window,
  });
  return {
    cleanup() {
      Object.assign(globalThis, previous);
      dom.window.close();
    },
    dom,
  };
}

function makeSurfaceDom(dom: ReturnType<typeof installDom>["dom"]) {
  const container = dom.window.document.createElement("div");
  container.tabIndex = 0;
  Object.defineProperty(container, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ bottom: 240, height: 240, left: 0, right: 320, top: 0, width: 320 }),
  });
  const canvas = dom.window.document.createElement("canvas");
  Object.defineProperty(canvas, "getContext", {
    configurable: true,
    value: () => ({
      drawImage() {
        /* intentional no-op */
      },
    }),
  });
  container.append(canvas);
  dom.window.document.body.append(container);
  return { canvas, container };
}

function makeTransport() {
  const handlers = new Set<(message: TransportMessage) => void>();
  const messages: TransportMessage[] = [];
  return {
    deliver(message: TransportMessage): void {
      for (const handler of handlers) {
        handler(message);
      }
    },
    messages,
    transport: {
      send(message: TransportMessage): void {
        messages.push(message);
      },
      subscribe(handler: (message: TransportMessage) => void): () => void {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    },
  };
}

function pointerDown(
  dom: ReturnType<typeof installDom>["dom"],
  container: ReturnType<typeof makeSurfaceDom>["container"]
): void {
  const event = new dom.window.Event("pointerdown", { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    buttons: { value: 1 },
    clientX: { value: 160 },
    clientY: { value: 120 },
    detail: { value: 1 },
    pointerId: { value: 1 },
    pointerType: { value: "mouse" },
  });
  container.dispatchEvent(event);
}

function focusMessage(): TransportMessage {
  return {
    name: "keyboard_focus",
    payload: { element: { inputType: "text", tagName: "input" }, focused: true },
    type: "backend_event",
  };
}

test("assembled session raises the local IME only after a correlated real pointer", () => {
  const { cleanup, dom } = installDom();
  try {
    const { canvas, container } = makeSurfaceDom(dom);
    const clock = { now: 1000 };
    const withoutPointer = makeTransport();
    const autofocusSession = createRemoteSurfaceSession({
      canvas,
      clock: () => clock.now,
      container,
      initialViewport: { height: 240, width: 320 },
      transport: withoutPointer.transport,
    });

    withoutPointer.deliver(focusMessage());
    assert.notEqual(dom.window.document.activeElement, container.querySelector("textarea"));
    autofocusSession.dispose();

    const withPointer = makeTransport();
    const pointerSession = createRemoteSurfaceSession({
      canvas,
      clock: () => clock.now,
      container,
      initialViewport: { height: 240, width: 320 },
      transport: withPointer.transport,
    });
    pointerDown(dom, container);
    assert.equal(withPointer.messages.filter((message) => message.type === "pointer").length, 1);

    withPointer.deliver(focusMessage());
    const ime = container.querySelector("textarea");
    assert.ok(ime, "assembled session mounts its hidden IME bridge");
    assert.equal(dom.window.document.activeElement, ime);
    assert.equal(withPointer.messages.filter((message) => message.type === "pointer").length, 1);

    pointerSession.dispose();
  } finally {
    cleanup();
  }
});

test("assembled session leaves autofocus and stale pointer focus closed, while manual focus remains available", () => {
  const { cleanup, dom } = installDom();
  try {
    const { canvas, container } = makeSurfaceDom(dom);
    const clock = { now: 1000 };
    const transport = makeTransport();
    const session = createRemoteSurfaceSession({
      canvas,
      clock: () => clock.now,
      container,
      initialViewport: { height: 240, width: 320 },
      transport: transport.transport,
    });

    pointerDown(dom, container);
    clock.now += 1501;
    transport.deliver(focusMessage());
    const ime = container.querySelector("textarea");
    assert.ok(ime);
    assert.notEqual(dom.window.document.activeElement, ime);

    session.focusKeyboard();
    assert.equal(dom.window.document.activeElement, ime);
    session.dispose();
  } finally {
    cleanup();
  }
});
