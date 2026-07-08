import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RemoteSurfaceEventPayload } from "../../protocol/index.ts";
import {
  CdpBackendError,
  type CdpCommandParams,
  type CdpCommandTransport,
  createCdpRemoteSurfaceBackendAdapter,
  createCdpRemoteSurfaceBackendAdapterFactory,
} from "./index.ts";

type RecordedCommand = {
  method: string;
  params?: CdpCommandParams;
};

class FakeCdpTransport implements CdpCommandTransport {
  readonly commands: RecordedCommand[] = [];
  private frameHandler: ((params: unknown) => void) | null = null;
  failMethod: string | null = null;

  async send<Result = unknown>(method: string, params?: CdpCommandParams): Promise<Result> {
    this.commands.push(params === undefined ? { method } : { method, params });
    if (method === this.failMethod) {
      throw new Error(`failed ${method}`);
    }
    return undefined as Result;
  }

  on(eventName: "Page.screencastFrame", handler: (params: unknown) => void) {
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

function makeBackend(options: { now?: number; transport?: FakeCdpTransport } = {}) {
  const transport = options.transport ?? new FakeCdpTransport();
  const backend = createCdpRemoteSurfaceBackendAdapter({
    clock: () => options.now ?? 1_770_000_000_000,
    targetId: "surface-1",
    transport,
  });
  return { backend, transport };
}

describe("CdpRemoteSurfaceBackendAdapter", () => {
  it("starts a CDP screencast with safe client descriptors and optional viewport", async () => {
    const { backend, transport } = makeBackend();

    const lifecycle = await backend.start({
      height: 600,
      mobile: true,
      orientation: "portrait",
      type: "viewport",
      width: 360,
    });

    assert.deepEqual(lifecycle.safeClientDescriptor, {
      backend: "cdp",
      capabilities: backend.capabilities,
    });
    assert.deepEqual(transport.commands, [
      {
        method: "Emulation.setDeviceMetricsOverride",
        params: {
          deviceScaleFactor: 1,
          height: 600,
          mobile: true,
          screenHeight: 600,
          screenOrientation: { angle: 0, type: "portraitPrimary" },
          screenWidth: 360,
          width: 360,
        },
      },
      {
        method: "Emulation.setTouchEmulationEnabled",
        params: { enabled: true, maxTouchPoints: 5 },
      },
      {
        method: "Page.enable",
      },
      {
        method: "Page.startScreencast",
        params: { everyNthFrame: 1, format: "jpeg", quality: 80 },
      },
    ]);
  });

  it("relays screencast frames and acknowledges the CDP session frame", async () => {
    const { backend, transport } = makeBackend({ now: 42 });
    const lifecycle = await backend.start();
    const events: RemoteSurfaceEventPayload[] = [];
    lifecycle.onEvent((event) => events.push(event));

    transport.emitFrame({ data: "jpeg-base64", sessionId: 7 });
    await Promise.resolve();

    assert.deepEqual(transport.commands.at(-1), {
      method: "Page.screencastFrameAck",
      params: { sessionId: 7 },
    });
    assert.deepEqual(events, [
      {
        contentType: "image/jpeg",
        data: "jpeg-base64",
        sequence: 1,
        sessionId: "surface-1",
        timestamp: 42,
        type: "frame",
      },
    ]);
  });

  it("dispatches pointer, scroll, keyboard, text, and paste through typed CDP methods", async () => {
    const { backend, transport } = makeBackend();
    const lifecycle = await backend.start();
    transport.commands.length = 0;

    await lifecycle.input({
      action: "pointerdown",
      button: 0,
      modifiers: ["Shift"],
      pointerType: "mouse",
      type: "pointer",
      x: 11,
      y: 22,
    });
    await lifecycle.input({
      action: "wheel",
      deltaX: 3,
      deltaY: 4,
      type: "pointer",
      x: 5,
      y: 6,
    });
    await lifecycle.input({
      action: "pointermove",
      pointerId: 9,
      pointerType: "touch",
      type: "pointer",
      x: 1,
      y: 2,
    });
    await lifecycle.input({
      action: "keydown",
      code: "KeyA",
      key: "a",
      modifiers: ["Control"],
      type: "keyboard",
    });
    await lifecycle.input({ text: "hello", type: "text" });
    await lifecycle.clipboard?.({ action: "local_to_remote", text: "clip", type: "clipboard" });

    assert.deepEqual(transport.commands, [
      {
        method: "Input.dispatchMouseEvent",
        params: {
          button: "left",
          buttons: 1,
          modifiers: 8,
          type: "mousePressed",
          x: 11,
          y: 22,
        },
      },
      {
        method: "Input.dispatchMouseEvent",
        params: {
          deltaX: 3,
          deltaY: 4,
          modifiers: 0,
          type: "mouseWheel",
          x: 5,
          y: 6,
        },
      },
      {
        method: "Input.dispatchTouchEvent",
        params: {
          modifiers: 0,
          touchPoints: [{ id: 9, radiusX: 1, radiusY: 1, x: 1, y: 2 }],
          type: "touchMove",
        },
      },
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
      { method: "Input.insertText", params: { text: "hello" } },
      { method: "Input.insertText", params: { text: "clip" } },
    ]);
  });

  it("stops screencast and removes the frame subscription", async () => {
    const { backend, transport } = makeBackend();
    const lifecycle = await backend.start();
    const events: RemoteSurfaceEventPayload[] = [];
    lifecycle.onEvent((event) => events.push(event));

    await backend.stop();
    transport.emitFrame({ data: "late", sessionId: 1 });
    await Promise.resolve();

    assert.deepEqual(transport.commands.at(-1), {
      method: "Page.stopScreencast",
    });
    assert.deepEqual(events, [
      {
        sessionId: "surface-1",
        state: "closed",
        timestamp: 1_770_000_000_000,
        type: "lifecycle",
      },
    ]);
  });

  it("guards lifecycle methods before start and keeps start idempotent", async () => {
    const { backend, transport } = makeBackend();

    await assert.rejects(
      () => backend.input({ action: "keydown", key: "a", type: "keyboard" }),
      (error: unknown) => error instanceof CdpBackendError && error.code === "invalid_lifecycle",
    );
    const lifecycle = await backend.start();
    const commandCount = transport.commands.length;
    const repeated = await backend.start();

    assert.equal(repeated, lifecycle);
    assert.equal(transport.commands.length, commandCount);
  });

  it("rolls back the frame subscription when CDP startup fails", async () => {
    const { backend, transport } = makeBackend();
    transport.failMethod = "Page.startScreencast";

    await assert.rejects(() => backend.start(), /failed Page\.startScreencast/u);

    assert.equal(transport.hasFrameHandler(), false);
    await assert.rejects(
      () => backend.input({ action: "keydown", key: "a", type: "keyboard" }),
      (error: unknown) => error instanceof CdpBackendError && error.code === "invalid_lifecycle",
    );
  });

  it("turns malformed screencast frames into lifecycle errors", async () => {
    const { backend, transport } = makeBackend({ now: 99 });
    const lifecycle = await backend.start();
    const events: RemoteSurfaceEventPayload[] = [];
    lifecycle.onEvent((event) => events.push(event));

    transport.emitFrame({ data: "missing-session-id" });
    await Promise.resolve();

    assert.deepEqual(events, [
      {
        reason: "Page.screencastFrame payload missing data or sessionId",
        sessionId: "surface-1",
        state: "error",
        timestamp: 99,
        type: "lifecycle",
      },
    ]);
  });

  it("builds adapter factories from target-scoped transports", async () => {
    const transport = new FakeCdpTransport();
    const factory = createCdpRemoteSurfaceBackendAdapterFactory({
      transportFactory({ targetId }) {
        assert.equal(targetId, "target-from-request");
        return transport;
      },
    });

    const adapter = await factory({ targetId: "target-from-request" });
    const lifecycle = await adapter.start();

    assert.equal(adapter.kind, "cdp");
    assert.equal(lifecycle.safeClientDescriptor.backend, "cdp");
  });
});
