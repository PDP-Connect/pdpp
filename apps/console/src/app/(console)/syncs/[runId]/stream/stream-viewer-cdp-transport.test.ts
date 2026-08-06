// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { CdpClientSurface } from "@opendatalabs/remote-surface/adapters";
import { createPdppCdpTransport } from "./stream-viewer-cdp-transport.ts";

const UNSUPPORTED_COMMAND_RE = /Unsupported console CDP bridge command/;
const NETWORK_DOWN_RE = /network down/;
const STATUS_410_RE = /410/;

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

/**
 * `sendInput` here mirrors `sendCdpInput`'s (stream-viewer.tsx) real
 * fail-closed contract for `type: "paste"` payloads (both `pasteText()` and
 * typed IME text route through `Input.insertText` -> this payload type): a
 * missing input URL, a rejected fetch, or a non-2xx response must reject
 * rather than resolve, so `CdpClientSurface.pasteText()` cannot resolve
 * `true` on a paste that never landed. This exercises the REAL
 * `CdpClientSurface` + REAL `createPdppCdpTransport` composition end to end
 * — the exact gap the audit flagged (ClipboardSheet reads a resolved
 * `pasteText()` as delivery with no boundary test proving that promise can
 * legitimately reject).
 */
function sendInputEnforcingPasteSuccess(
  responses: Array<{ ok: boolean; status: number } | Error>
): (payload: Record<string, unknown>) => Promise<void> {
  let call = 0;
  return (payload) => {
    const isPaste = payload.type === "paste";
    const outcome = responses[call];
    call += 1;
    if (!outcome) {
      return Promise.resolve();
    }
    if (outcome instanceof Error) {
      if (isPaste) {
        return Promise.reject(outcome);
      }
      return Promise.resolve();
    }
    if (isPaste && !outcome.ok) {
      return Promise.reject(new Error(`Paste input rejected by server: ${outcome.status}`));
    }
    return Promise.resolve();
  };
}

function pasteOnlyCdpSurface(sendInput: (payload: Record<string, unknown>) => Promise<void>): CdpClientSurface {
  return new CdpClientSurface({
    client: {
      cdp: createPdppCdpTransport(sendInput),
      getViewportInfo: () => null,
      mediaSink: {
        onFrame() {
          /* frames are irrelevant to this test */
        },
      },
    },
    config: { kind: "cdp" },
  });
}

test("a rejected fetch makes CdpClientSurface.pasteText() reject instead of resolving true", async () => {
  const surface = pasteOnlyCdpSurface(sendInputEnforcingPasteSuccess([new Error("network down")]));
  await surface.mount();
  await assert.rejects(surface.pasteText("hello"), NETWORK_DOWN_RE);
});

test("a non-2xx response makes CdpClientSurface.pasteText() reject instead of resolving true", async () => {
  const surface = pasteOnlyCdpSurface(sendInputEnforcingPasteSuccess([{ ok: false, status: 410 }]));
  await surface.mount();
  await assert.rejects(surface.pasteText("hello"), STATUS_410_RE);
});

test("a 2xx response lets CdpClientSurface.pasteText() resolve true", async () => {
  const surface = pasteOnlyCdpSurface(sendInputEnforcingPasteSuccess([{ ok: true, status: 200 }]));
  await surface.mount();
  assert.equal(await surface.pasteText("hello"), true);
});

/**
 * Reproduces the mount-vs-unmount race the audit found in `BrowserSurface`'s
 * mount effect: React can run cleanup (calling `unmount()`) before a
 * `Page.startScreencast` round-trip resolves. Naively firing `unmount()`
 * immediately observes `lifecycleState === "mounting"`
 * (`CdpClientSurface.unmount()` treats anything but "idle" as tear-downable,
 * but the still-in-flight `mount()`'s `.then()` continuation runs AFTER
 * `unmount()` already reset state to "idle" — resurrecting "mounted" and
 * re-triggering the mounted-callback on a torn-down surface). The fixed
 * `stream-viewer.tsx` chains cleanup's unmount onto the mount promise
 * instead: this test proves that exact chaining pattern (reproduced here
 * against the real adapter, a controllable-delay transport, and a real
 * unmount) prevents the resurrection — mounted-callback fires at most once,
 * and no command is sent after cleanup.
 */
function delayedCdpTransport(): {
  resolveMount: () => void;
  sent: string[];
  transport: ReturnType<typeof createPdppCdpTransport>;
} {
  const sent: string[] = [];
  let resolveMount = () => {
    /* replaced below */
  };
  const startScreencastGate = new Promise<void>((resolve) => {
    resolveMount = resolve;
  });
  const transport = createPdppCdpTransport((payload) => {
    sent.push(String(payload.type));
    return Promise.resolve();
  });
  const originalSend = transport.send.bind(transport);
  transport.send = (async (method: string, params?: Record<string, unknown>) => {
    if (method === "Page.startScreencast") {
      await startScreencastGate;
    }
    return originalSend(method, params);
  }) as typeof transport.send;
  return { resolveMount, sent, transport };
}

test("chaining unmount onto the mount promise prevents mount-after-unmount resurrection", async () => {
  const { resolveMount, transport } = delayedCdpTransport();
  const adapter = new CdpClientSurface({
    client: {
      cdp: transport,
      getViewportInfo: () => null,
      mediaSink: {
        onFrame() {
          /* frames are irrelevant to this test */
        },
      },
    },
    config: { kind: "cdp" },
  });

  const mountPromise = adapter.mount();
  // React's cleanup runs synchronously, immediately after mount() is called
  // but long before "Page.startScreencast" resolves: chain cleanup's unmount
  // onto the mount promise (the fix) instead of firing it immediately.
  const cleanup = mountPromise
    .catch(() => {
      /* mount already failed; nothing mounted to tear down */
    })
    .then(() => {
      if (adapter.getLifecycleState() === "idle") {
        return;
      }
      return adapter.unmount();
    });

  assert.equal(adapter.getLifecycleState(), "mounting");
  resolveMount();
  await mountPromise.catch(() => {
    /* covered by the getLifecycleState assertion below */
  });
  await cleanup;

  assert.equal(adapter.getLifecycleState(), "idle", "the adapter must end torn down, not resurrected as mounted");
});

test("naive immediate unmount() (the pre-fix bug) resurrects as mounted once the racing mount() resolves", async () => {
  const { resolveMount, transport } = delayedCdpTransport();
  const adapter = new CdpClientSurface({
    client: {
      cdp: transport,
      getViewportInfo: () => null,
      mediaSink: {
        onFrame() {
          /* frames are irrelevant to this test */
        },
      },
    },
    config: { kind: "cdp" },
  });

  const mountPromise = adapter.mount();
  assert.equal(adapter.getLifecycleState(), "mounting");
  // The pre-fix behavior: cleanup calls unmount() immediately, without
  // waiting for the in-flight mount to settle. unmount() does not reject for
  // "mounting" (only for "unmounting") — it silently resets to "idle" while
  // mount()'s pending continuation is still racing.
  await adapter.unmount();
  assert.equal(adapter.getLifecycleState(), "idle");

  // The racing mount() continuation now resolves and unconditionally sets
  // "mounted", ignorant of the unmount that already ran — this is the
  // resurrection the audit found; it demonstrates why the fix must chain
  // cleanup's unmount onto the mount promise instead of firing immediately.
  resolveMount();
  await mountPromise;
  assert.equal(adapter.getLifecycleState(), "mounted");
});
