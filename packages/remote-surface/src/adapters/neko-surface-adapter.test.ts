// Smoke tests for NekoSurfaceAdapter. We mock the NekoClientApi and
// verify the adapter's lifecycle contract; no real n.eko is involved.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type NekoClientApi,
  NekoSurfaceAdapter,
  type NekoSurfaceConfig,
} from "./neko-surface-adapter.ts";

// Minimal HTMLElement stand-in. The adapter only stores the reference
// and passes it to client.start, so we don't need DOM semantics here.
const fakeEl = {} as unknown as HTMLElement;

const baseConfig: NekoSurfaceConfig = {
  kind: "neko",
  serverPath: "wss://example.invalid/ws",
};

interface MockClient extends NekoClientApi {
  startCalls: Array<{ container: HTMLElement; config: unknown }>;
  stopCalls: number;
  focusCalls: number;
  sendTextCalls: string[];
}

function makeMockClient(overrides: Partial<NekoClientApi> = {}): MockClient {
  const startCalls: MockClient["startCalls"] = [];
  let stopCalls = 0;
  let focusCalls = 0;
  const sendTextCalls: string[] = [];
  const client: MockClient = {
    startCalls,
    get stopCalls() {
      return stopCalls;
    },
    get focusCalls() {
      return focusCalls;
    },
    sendTextCalls,
    async start(container, config) {
      startCalls.push({ container, config });
    },
    async stop() {
      stopCalls += 1;
    },
    focusKeyboard() {
      focusCalls += 1;
    },
    async sendText(text) {
      sendTextCalls.push(text);
    },
    ...overrides,
  };
  return client;
}

describe("NekoSurfaceAdapter", () => {
  it("transitions idle → mounted on mount()", async () => {
    const client = makeMockClient();
    const adapter = new NekoSurfaceAdapter({ client, config: baseConfig });
    assert.equal(adapter.getLifecycleState(), "idle");
    await adapter.mount(fakeEl);
    assert.equal(adapter.getLifecycleState(), "mounted");
    assert.equal(client.startCalls.length, 1);
    assert.equal(client.startCalls[0]?.container, fakeEl);
    assert.deepEqual(client.startCalls[0]?.config, baseConfig);
  });

  it("transitions mounted → idle on unmount()", async () => {
    const client = makeMockClient();
    const adapter = new NekoSurfaceAdapter({ client, config: baseConfig });
    await adapter.mount(fakeEl);
    await adapter.unmount();
    assert.equal(adapter.getLifecycleState(), "idle");
    assert.equal(client.stopCalls, 1);
  });

  it("throws on double mount()", async () => {
    const client = makeMockClient();
    const adapter = new NekoSurfaceAdapter({ client, config: baseConfig });
    await adapter.mount(fakeEl);
    await assert.rejects(() => adapter.mount(fakeEl), /invalid state mounted/);
  });

  it("throws on methods called before mount()", async () => {
    const client = makeMockClient();
    const adapter = new NekoSurfaceAdapter({ client, config: baseConfig });
    assert.throws(() => adapter.focusTextInput(), /invalid state idle/);
    await assert.rejects(
      () =>
        adapter.sendPointer({
          type: "pointerdown",
          x: 0,
          y: 0,
          pointerType: "mouse",
          pointerId: 1,
        }),
      /invalid state idle/,
    );
    await assert.rejects(
      () => adapter.sendKeysym({ type: "keydown", keysym: 0xff0d }),
      /invalid state idle/,
    );
    await assert.rejects(() => adapter.sendText("hi"), /invalid state idle/);
  });

  it("transitions to error and rethrows if start() fails", async () => {
    const boom = new Error("ws refused");
    const client = makeMockClient({
      start: () => Promise.reject(boom),
    });
    const adapter = new NekoSurfaceAdapter({ client, config: baseConfig });
    await assert.rejects(() => adapter.mount(fakeEl), /ws refused/);
    assert.equal(adapter.getLifecycleState(), "error");
  });

  it("unmount() is a no-op when already idle", async () => {
    const client = makeMockClient();
    const adapter = new NekoSurfaceAdapter({ client, config: baseConfig });
    await adapter.unmount();
    assert.equal(adapter.getLifecycleState(), "idle");
    assert.equal(client.stopCalls, 0);
  });

  it("focusTextInput() delegates to client.focusKeyboard", async () => {
    const client = makeMockClient();
    const adapter = new NekoSurfaceAdapter({ client, config: baseConfig });
    await adapter.mount(fakeEl);
    adapter.focusTextInput();
    adapter.focusTextInput({ inputMode: "email" });
    assert.equal(client.focusCalls, 2);
  });

  it("sendText() delegates to client.sendText", async () => {
    const client = makeMockClient();
    const adapter = new NekoSurfaceAdapter({ client, config: baseConfig });
    await adapter.mount(fakeEl);
    await adapter.sendText("hello");
    assert.deepEqual(client.sendTextCalls, ["hello"]);
  });

  it("sendPointer delegates to a NekoPointerController built from client-supplied control", async () => {
    const buttonDownCalls: Array<{ button: number; x: number; y: number }> = [];
    const buttonUpCalls: Array<{ button: number; x: number; y: number }> = [];
    const control = {
      buttonDown(button: number, pos: { x: number; y: number }) {
        buttonDownCalls.push({ button, x: pos.x, y: pos.y });
      },
      buttonUp(button: number, pos: { x: number; y: number }) {
        buttonUpCalls.push({ button, x: pos.x, y: pos.y });
      },
      move() {
        /* no-op */
      },
    };
    const mapCalls: Array<{ x: number; y: number }> = [];
    const client: NekoClientApi = {
      async start() {
        /* ok */
      },
      getPointerControl: () => control,
      mapPointerToRemote: (x, y) => {
        mapCalls.push({ x, y });
        return { x: x + 1000, y: y + 2000 };
      },
    };
    const adapter = new NekoSurfaceAdapter({ client, config: baseConfig });
    await adapter.mount(fakeEl);
    await adapter.sendPointer({
      type: "pointerdown",
      x: 3,
      y: 4,
      pointerType: "touch",
      pointerId: 1,
      button: 0,
    });
    await adapter.sendPointer({
      type: "pointerup",
      x: 3,
      y: 4,
      pointerType: "touch",
      pointerId: 1,
      button: 0,
    });
    assert.deepEqual(buttonDownCalls, [{ button: 1, x: 1003, y: 2004 }]);
    assert.deepEqual(buttonUpCalls, [{ button: 1, x: 1003, y: 2004 }]);
    assert.equal(mapCalls.length, 2);
  });

  it("sendPointer warns and no-ops when client provides no pointer control", async () => {
    const client: NekoClientApi = {
      async start() {
        /* ok */
      },
    };
    const logs: Array<{ level: string; msg: string }> = [];
    const adapter = new NekoSurfaceAdapter({
      client,
      config: baseConfig,
      logger: (level, msg) => logs.push({ level, msg }),
    });
    await adapter.mount(fakeEl);
    await adapter.sendPointer({
      type: "pointerdown",
      x: 0,
      y: 0,
      pointerType: "touch",
      pointerId: 1,
    });
    assert.ok(
      logs.some(
        (l) => l.level === "warn" && l.msg === "neko-surface-adapter.no-pointer-control",
      ),
    );
  });

  it("tolerates missing optional client methods", async () => {
    const client: NekoClientApi = {
      start: async () => {
        /* ok */
      },
    };
    const logs: Array<{ level: string; msg: string }> = [];
    const adapter = new NekoSurfaceAdapter({
      client,
      config: baseConfig,
      logger: (level, msg) => logs.push({ level, msg }),
    });
    await adapter.mount(fakeEl);
    adapter.focusTextInput();
    await adapter.sendText("x");
    await adapter.unmount();
    assert.equal(adapter.getLifecycleState(), "idle");
    const warnings = logs.filter((l) => l.level === "warn").map((l) => l.msg);
    assert.ok(warnings.includes("neko-surface-adapter.no-focus-keyboard-helper"));
    assert.ok(warnings.includes("neko-surface-adapter.no-send-text-helper"));
    assert.ok(warnings.includes("neko-surface-adapter.no-stop-helper"));
  });
});
