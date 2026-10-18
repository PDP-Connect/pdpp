// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { copyStatusText, useCopyToClipboard } from "./use-copy-to-clipboard.ts";

interface BrowserHarness {
  dom: JSDOM;
  host: HTMLDivElement;
  restore: () => void;
  root: Root;
}

let browser: BrowserHarness | undefined;

function installBrowser(): BrowserHarness {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);

  const globalObject = globalThis as Record<string, unknown>;
  const windowObject = dom.window as unknown as Record<string, unknown>;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const name of [
    "window",
    "self",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "Text",
    "Event",
    "MouseEvent",
    "MutationObserver",
    "IS_REACT_ACT_ENVIRONMENT",
  ]) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalObject, name));
    let value = windowObject[name];
    if (name === "IS_REACT_ACT_ENVIRONMENT") {
      value = true;
    } else if (name === "document") {
      value = dom.window.document;
    } else if (name === "window" || name === "self") {
      value = dom.window;
    }
    Object.defineProperty(globalObject, name, {
      configurable: true,
      value,
      writable: true,
    });
  }

  const restore = () => {
    browser = undefined;
    for (const [name, descriptor] of previous) {
      if (descriptor === undefined) {
        delete globalObject[name];
      } else {
        Object.defineProperty(globalObject, name, descriptor);
      }
    }
    dom.window.close();
  };
  const root = createRoot(host);
  browser = { dom, host, restore, root };
  return browser;
}

function CopyButton({ payload }: { payload: string }) {
  const { copy, status } = useCopyToClipboard();
  const { announcement, label } = copyStatusText(status);
  const onClick = () => {
    copy(payload);
  };
  return createElement(
    "div",
    null,
    createElement("button", { type: "button", onClick }, label),
    createElement("span", { "aria-live": "polite" }, announcement)
  );
}

function renderCopyButton(payload = "docker run --name pdpp ghcr.io/pdpp/server:latest") {
  const current = browser ?? installBrowser();
  act(() => current.root.render(createElement(CopyButton, { payload })));
  const button = current.host.querySelector("button");
  const liveRegion = current.host.querySelector('[aria-live="polite"]');
  assert.ok(button);
  assert.ok(liveRegion);
  return { ...current, button, liveRegion };
}

function setClipboard(writeText?: (text: string) => Promise<void>) {
  assert.ok(browser);
  Object.defineProperty(browser.dom.window.navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

afterEach(async () => {
  if (!browser) {
    return;
  }
  await act(async () => browser?.root.unmount());
  browser.restore();
});

test("copy writes the exact payload and announces success", async () => {
  const writeText = mock.fn((_text: string) => Promise.resolve());
  const { button, liveRegion } = renderCopyButton();
  setClipboard(writeText);

  await act(async () => button.click());

  assert.deepEqual(
    writeText.mock.calls.map(({ arguments: args }) => args),
    [["docker run --name pdpp ghcr.io/pdpp/server:latest"]]
  );
  assert.equal(button.textContent, "Copied");
  assert.equal(liveRegion.textContent, "Command copied to clipboard.");
});

test("copy failure and missing clipboard announce failure", async (t) => {
  await t.test("a rejected write shows failed state", async () => {
    const { button, liveRegion } = renderCopyButton();
    setClipboard(() => Promise.reject(new Error("permission denied")));

    await act(async () => button.click());

    assert.equal(button.textContent, "Copy failed");
    assert.equal(liveRegion.textContent, "Copy failed.");
  });

  await t.test("an unavailable clipboard shows failed state", async () => {
    const { button, liveRegion } = renderCopyButton();
    setClipboard();

    await act(async () => button.click());

    assert.equal(button.textContent, "Copy failed");
    assert.equal(liveRegion.textContent, "Copy failed.");
  });
});

test("copied state resets after exactly 2000 ms", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { button, liveRegion } = renderCopyButton();
  setClipboard(() => Promise.resolve());
  await act(async () => button.click());
  assert.equal(button.textContent, "Copied");

  await act(async () => t.mock.timers.tick(1999));
  assert.equal(button.textContent, "Copied");
  assert.equal(liveRegion.textContent, "Command copied to clipboard.");

  await act(async () => t.mock.timers.tick(1));
  assert.equal(button.textContent, "Copy");
  assert.equal(liveRegion.textContent, "");
});

test("unmount clears the reset timer before it can update the removed consumer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { clearTimeout } = globalThis;
  const clearedTimers = new Set<ReturnType<typeof setTimeout>>();
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    clearedTimers.add(timer);
    return clearTimeout(timer);
  }) as typeof globalThis.clearTimeout;

  const { button, root } = renderCopyButton();
  setClipboard(() => Promise.resolve());
  await act(async () => button.click());
  await act(async () => root.unmount());

  assert.equal(clearedTimers.size, 1);
  await act(async () => t.mock.timers.tick(2000));
  assert.equal(clearedTimers.size, 1);
});

test("a later failure stays visible when an older clipboard write resolves afterward", async () => {
  let resolveFirst!: () => void;
  let rejectSecond!: (reason: Error) => void;
  const writeText = mock.fn((text: string) => {
    if (text === "first request") {
      return new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
    }
    return new Promise<void>((_resolve, reject) => {
      rejectSecond = reject;
    });
  });
  const { button, liveRegion, root } = renderCopyButton("first request");
  setClipboard(writeText);

  act(() => button.click());
  act(() => root.render(createElement(CopyButton, { payload: "second request" })));
  act(() => button.click());
  await act(async () => rejectSecond(new Error("permission denied")));
  assert.equal(button.textContent, "Copy failed");
  await act(async () => resolveFirst());

  assert.equal(button.textContent, "Copy failed");
  assert.equal(liveRegion.textContent, "Copy failed.");
});

test("a later success stays visible when an older clipboard write rejects first", async () => {
  let rejectFirst!: (reason: Error) => void;
  let resolveSecond!: () => void;
  const writeText = mock.fn((text: string) => {
    if (text === "first request") {
      return new Promise<void>((_resolve, reject) => {
        rejectFirst = reject;
      });
    }
    return new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
  });
  const { button, liveRegion, root } = renderCopyButton("first request");
  setClipboard(writeText);

  act(() => button.click());
  act(() => root.render(createElement(CopyButton, { payload: "second request" })));
  act(() => button.click());
  await act(async () => rejectFirst(new Error("permission denied")));
  assert.equal(button.textContent, "Copy");
  await act(async () => resolveSecond());

  assert.equal(button.textContent, "Copied");
  assert.equal(liveRegion.textContent, "Command copied to clipboard.");
});

test("idle status has no label text and no announcement", () => {
  assert.deepEqual(copyStatusText("idle"), { announcement: "", label: "Copy" });
});

test("copied status announces success", () => {
  assert.deepEqual(copyStatusText("copied"), { announcement: "Command copied to clipboard.", label: "Copied" });
});

test("failed status announces failure", () => {
  assert.deepEqual(copyStatusText("failed"), { announcement: "Copy failed.", label: "Copy failed" });
});
