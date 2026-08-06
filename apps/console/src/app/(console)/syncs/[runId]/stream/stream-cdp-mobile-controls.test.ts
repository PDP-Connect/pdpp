// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assessClipboardCapabilities, decideClipboardPolicy } from "@opendatalabs/remote-surface/client";
import {
  attachCdpMobileTextInputBridge,
  type CdpTextInputTarget,
  classifyReadyBackend,
  decideCdpMobileControls,
  focusMountedCdpTextInputInTrustedEvent,
  type MountedCdpSurface,
  writeCdpClipboardToDevice,
} from "./stream-cdp-mobile-controls.ts";

const STREAM_VIEWER_FILE = fileURLToPath(new URL("./stream-viewer.tsx", import.meta.url));
const ADAPTER_MOUNT_RE = /onAdapterMounted\(adapter\)/;
const BACKEND_CLASSIFICATION_RE = /setReadyBackend\("neko"\)/;
const UNKNOWN_PRE_READY_RE = /useState<ReadyBackend>\("unknown"\)/;
const CLIPBOARD_FAIL_CLOSED_UNKNOWN_RE = /readyBackend !== "unknown"[\s\S]*showClipboardSheet/;
const CLIPBOARD_SINK_RE = /clipboardSink: \{/;
const KEYBOARD_HANDLER_RE = /focusMountedCdpTextInputInTrustedEvent\(mountedCdpSurface\)/;
const IME_BRIDGE_ATTACH_RE = /attachCdpMobileTextInputBridge\(softKeyboardTextareaRef\.current, adapter,/;
const MOUNT_UNMOUNT_RACE_GUARD_RE =
  /const unmountAdapter = async \(\) => \{[\s\S]*getLifecycleState\(\) === "idle"[\s\S]*mountPromise[\s\S]*\.then\(unmountAdapter\)/;
const MOUNTED_ADAPTER_RE =
  /adapter[\s\S]*\.mount\(node\)[\s\S]*\.then\(\(\) => \{[\s\S]*adapter\.getLifecycleState\(\) === "mounted"[\s\S]*onAdapterMounted\(adapter\)/;
const NO_TOUCH_FOCUS_RE = /onTouchStart[\s\S]{0,160}focusMountedCdpTextInputInTrustedEvent/;
const UNAVAILABLE_RE = /unavailable/;
const WRITE_DENIED_RE = /denied/;

function policy({
  directionPolicy = "bidirectional-text",
  pointerCoarse = true,
  sessionBackend = "cdp",
}: {
  directionPolicy?: "disabled" | "local-to-remote" | "remote-to-local" | "bidirectional-text";
  pointerCoarse?: boolean;
  sessionBackend?: "neko" | "cdp";
} = {}) {
  return decideClipboardPolicy({
    capabilities: assessClipboardCapabilities({
      browserFamily: "chromium",
      isSecureContext: true,
      pointerCoarse,
      readTextAvailable: true,
      topLevel: true,
      writeTextAvailable: true,
    }),
    directionPolicy,
    hasStreamSession: true,
    helperMode: "balanced",
    sessionBackend,
  });
}

test("direct-CDP controls require a coarse pointer and retain clipboard direction policy", () => {
  const bidirectional = policy();
  assert.deepEqual(decideCdpMobileControls({ backend: "cdp", clipboardPolicy: bidirectional, pointerCoarse: true }), {
    showCopy: true,
    showKeyboard: true,
    showPaste: true,
  });
  assert.deepEqual(decideCdpMobileControls({ backend: "cdp", clipboardPolicy: bidirectional, pointerCoarse: false }), {
    showCopy: false,
    showKeyboard: false,
    showPaste: false,
  });

  assert.deepEqual(
    decideCdpMobileControls({
      backend: "cdp",
      clipboardPolicy: policy({ directionPolicy: "local-to-remote" }),
      pointerCoarse: true,
    }),
    { showCopy: false, showKeyboard: true, showPaste: true }
  );
  assert.deepEqual(
    decideCdpMobileControls({
      backend: "cdp",
      clipboardPolicy: policy({ directionPolicy: "remote-to-local" }),
      pointerCoarse: true,
    }),
    { showCopy: true, showKeyboard: true, showPaste: false }
  );
  assert.deepEqual(
    decideCdpMobileControls({
      backend: "cdp",
      clipboardPolicy: policy({ directionPolicy: "disabled" }),
      pointerCoarse: true,
    }),
    { showCopy: false, showKeyboard: false, showPaste: false }
  );
});

test("CDP keyboard focus happens synchronously in the invoking trusted-event turn", () => {
  let inTrustedHandler = true;
  const calls: string[] = [];
  const surface: MountedCdpSurface = {
    focusTextInput() {
      assert.equal(inTrustedHandler, true);
      calls.push("focus");
    },
    getLifecycleState: () => "mounted",
  };

  assert.equal(focusMountedCdpTextInputInTrustedEvent(surface), true);
  inTrustedHandler = false;
  assert.deepEqual(calls, ["focus"]);
});

test("CDP keyboard focus fails closed when no mounted adapter is available", () => {
  let focused = false;
  const unmounted: MountedCdpSurface = {
    focusTextInput() {
      focused = true;
    },
    getLifecycleState: () => "mounting",
  };
  assert.equal(focusMountedCdpTextInputInTrustedEvent(null), false);
  assert.equal(focusMountedCdpTextInputInTrustedEvent(unmounted), false);
  assert.equal(focused, false);
});

test("the CDP clipboard sink writes through and buffers only after a failed device write", async () => {
  const buffered: string[] = [];
  const copied: string[] = [];
  await writeCdpClipboardToDevice({
    onWriteFailure: (text: string) => {
      buffered.push(text);
    },
    policy: policy(),
    text: "selected text",
    writeText: (text) => {
      copied.push(text);
    },
  });
  assert.deepEqual(copied, ["selected text"]);
  assert.equal(buffered.length, 0);

  await assert.rejects(
    writeCdpClipboardToDevice({
      onWriteFailure: (text: string) => {
        buffered.push(text);
      },
      policy: policy(),
      text: "manual fallback",
      writeText: null,
    }),
    UNAVAILABLE_RE
  );
  await assert.rejects(
    writeCdpClipboardToDevice({
      onWriteFailure: (text: string) => {
        buffered.push(text);
      },
      policy: policy({ directionPolicy: "local-to-remote" }),
      text: "policy fallback",
      writeText: () => undefined,
    }),
    UNAVAILABLE_RE
  );
  await assert.rejects(
    writeCdpClipboardToDevice({
      onWriteFailure: (text: string) => {
        buffered.push(text);
      },
      policy: policy(),
      text: "rejected write",
      writeText: () => {
        throw new Error("denied");
      },
    }),
    WRITE_DENIED_RE
  );
  assert.deepEqual(buffered, ["manual fallback", "policy fallback", "rejected write"]);
});

test("the CDP-only override does not alter n.eko's existing keyboard policy", () => {
  const nekoPolicy = policy({ sessionBackend: "neko" });
  assert.equal(nekoPolicy.showKeyboardButton, true);
  assert.deepEqual(decideCdpMobileControls({ backend: "neko", clipboardPolicy: nekoPolicy, pointerCoarse: true }), {
    showCopy: false,
    showKeyboard: false,
    showPaste: false,
  });
});

test("the host classifies the backend explicitly from backend_ready, not from nekoSession presence", async () => {
  const src = await readFile(STREAM_VIEWER_FILE, "utf8");
  assert.match(src, UNKNOWN_PRE_READY_RE);
  assert.match(src, CLIPBOARD_FAIL_CLOSED_UNKNOWN_RE);
  assert.match(src, BACKEND_CLASSIFICATION_RE);
  assert.match(src, ADAPTER_MOUNT_RE);
  assert.match(src, CLIPBOARD_SINK_RE);
  assert.match(src, MOUNTED_ADAPTER_RE);
  assert.match(src, KEYBOARD_HANDLER_RE);
  assert.match(src, IME_BRIDGE_ATTACH_RE);
  assert.match(src, MOUNT_UNMOUNT_RACE_GUARD_RE);
  assert.doesNotMatch(src, NO_TOUCH_FOCUS_RE);
});

test("classifyReadyBackend fails closed for pre-ready and unrecognized backend values", () => {
  assert.equal(classifyReadyBackend("cdp"), "cdp");
  assert.equal(classifyReadyBackend("neko"), "neko");
  assert.equal(classifyReadyBackend("vnc"), "unknown");
  assert.equal(classifyReadyBackend(""), "unknown");
  assert.equal(classifyReadyBackend("some-future-backend"), "unknown");
});

test("decideCdpMobileControls fails closed for the unknown pre-ready backend", () => {
  const bidirectional = policy();
  assert.deepEqual(
    decideCdpMobileControls({ backend: "unknown", clipboardPolicy: bidirectional, pointerCoarse: true }),
    { showCopy: false, showKeyboard: false, showPaste: false }
  );
});

/**
 * apps/console's test suite has no jsdom dependency anywhere (see
 * neko-client.test.ts's own note on this), so `MobileTextInputController` is
 * driven here through Node's native, WHATWG-compliant `EventTarget`/`Event`
 * rather than a browser DOM: the controller's only textarea-shaped surface
 * is `tagName`/`value`/`setSelectionRange`/`add|removeEventListener` (see
 * `dist/ime/mobile-text-input-controller.js`), all of which this fake
 * implements. This exercises the REAL controller and the REAL
 * `attachCdpMobileTextInputBridge` — not a source regex — for the exact
 * commit-only input/composition semantics the audit found broken against a
 * plain `<input>` sentinel.
 */
function createFakeTextarea(): HTMLTextAreaElement {
  const target = new EventTarget();
  const fake = Object.assign(target, {
    dataset: {} as Record<string, string>,
    setSelectionRange: () => {
      /* no-op: controller call is optional-chained */
    },
    style: {},
    tagName: "TEXTAREA",
    value: "",
  });
  return fake as unknown as HTMLTextAreaElement;
}

function inputEvent(data: string | null, inputType: string): Event {
  const ev = new Event("input");
  Object.assign(ev, { data, inputType });
  return ev;
}

test("attachCdpMobileTextInputBridge wires real typed text and chorded special keys through the adapter's existing sendText/sendKey primitives", async () => {
  const textarea = createFakeTextarea();

  const sentText: string[] = [];
  const sentKeys: Array<{ type: string; code?: string; key?: string; modifiers?: readonly string[] }> = [];
  const surface: CdpTextInputTarget = {
    sendKey: (intent) => {
      sentKeys.push(intent);
      return Promise.resolve();
    },
    sendText: (text) => {
      sentText.push(text);
      return Promise.resolve();
    },
  };

  const detach = attachCdpMobileTextInputBridge(textarea, surface);
  assert.equal(textarea.dataset.remoteSurfaceImeBridge, "true");

  textarea.dispatchEvent(inputEvent("hi", "insertText"));
  assert.deepEqual(sentText, ["hi"]);

  textarea.dispatchEvent(inputEvent(null, "deleteContentBackward"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sentKeys.length, 2);
  assert.equal(sentKeys[0]?.type, "keydown");
  assert.equal(sentKeys[0]?.code, "Backspace");
  assert.equal(sentKeys[1]?.type, "keyup");
  assert.equal(sentKeys[0]?.modifiers, undefined);

  sentKeys.length = 0;
  textarea.dispatchEvent(inputEvent(null, "deleteWordBackward"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sentKeys[0]?.modifiers, ["Control"]);

  detach();
  assert.equal(textarea.dataset.remoteSurfaceImeBridge, undefined);
});

test("attachCdpMobileTextInputBridge reports (does not throw on) a rejected dispatch", async () => {
  const textarea = createFakeTextarea();
  const errors: unknown[] = [];
  const surface: CdpTextInputTarget = {
    sendKey: () => Promise.reject(new Error("transport down")),
    sendText: () => Promise.reject(new Error("transport down")),
  };
  const detach = attachCdpMobileTextInputBridge(textarea, surface, (err) => errors.push(err));

  textarea.dispatchEvent(inputEvent("x", "insertText"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(errors.length, 1);

  detach();
});
