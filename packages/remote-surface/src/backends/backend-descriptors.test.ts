import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCdpSafeClientDescriptor,
  CDP_BACKEND_CAPABILITIES,
  parseCdpSafeClientDescriptor,
} from "./cdp/index.ts";
import {
  buildNekoSafeClientDescriptor,
  NEKO_BACKEND_CAPABILITIES,
  parseNekoSafeClientDescriptor,
} from "./neko/index.ts";

describe("backend safe client descriptors", () => {
  it("constructs n.eko descriptors with only same-origin proxy and session paths", () => {
    assert.deepEqual(
      buildNekoSafeClientDescriptor({
        proxyPath: "/_ref/run-interaction-streams/token_fixture/neko",
        sessionPath: "/_ref/run-interaction-streams/token_fixture/neko/session",
        allowedMethods: ["GET", "POST"],
        expiresAt: 1_770_000_000_000,
      }),
      {
        backend: "neko",
        capabilities: NEKO_BACKEND_CAPABILITIES,
        proxy: {
          path: "/_ref/run-interaction-streams/token_fixture/neko",
          sameOrigin: true,
          allowedMethods: ["GET", "POST"],
        },
        session: {
          path: "/_ref/run-interaction-streams/token_fixture/neko/session",
          sameOrigin: true,
          expiresAt: 1_770_000_000_000,
        },
      },
    );
  });

  it("rejects n.eko descriptors that expose upstream authority or allocator metadata", () => {
    assert.throws(() =>
      parseNekoSafeClientDescriptor({
        backend: "neko",
        capabilities: NEKO_BACKEND_CAPABILITIES,
        proxy: { path: "/neko", sameOrigin: true },
        base_url: "http://neko:6080",
      }),
    );
    assert.throws(() =>
      parseNekoSafeClientDescriptor({
        backend: "neko",
        capabilities: NEKO_BACKEND_CAPABILITIES,
        proxy: { path: "/neko", sameOrigin: true },
        allocatorCredentials: { token: "allocator-secret" },
      }),
    );
  });

  it("constructs CDP descriptors without browser-visible endpoints", () => {
    assert.deepEqual(buildCdpSafeClientDescriptor(), {
      backend: "cdp",
      capabilities: CDP_BACKEND_CAPABILITIES,
    });
  });

  it("rejects CDP descriptors that expose raw WebSocket, HTTP, or DevTools paths", () => {
    for (const unsafe of [
      { cdpWsUrl: "ws://127.0.0.1:9222/devtools/browser/secret" },
      { cdpHttpUrl: "http://127.0.0.1:9222/json/version" },
      { webSocketDebuggerUrl: "wss://localhost/devtools/browser/secret" },
      { proxy: { path: "/devtools/browser/secret", sameOrigin: true } },
    ]) {
      assert.throws(() =>
        parseCdpSafeClientDescriptor({
          backend: "cdp",
          capabilities: CDP_BACKEND_CAPABILITIES,
          ...unsafe,
        }),
      );
    }
  });
});

describe("backend capability declarations", () => {
  it("covers n.eko event, input, clipboard, viewport, diagnostics, owner, and automation modes", () => {
    assert.deepEqual(NEKO_BACKEND_CAPABILITIES, {
      eventChannel: "sse",
      input: ["pointer", "keyboard", "keysym", "text", "paste", "touch", "scroll"],
      clipboard: ["local_to_remote", "remote_to_local", "manual_fallback"],
      viewport: ["report", "resize", "classify_occlusion"],
      diagnostics: ["events", "replay", "redacted_buffer"],
      ownerBrowser: true,
      serverSideAutomationEndpoint: true,
    });
  });

  it("covers CDP event, input, clipboard, viewport, diagnostics, owner, and automation modes", () => {
    assert.deepEqual(CDP_BACKEND_CAPABILITIES, {
      eventChannel: "sse",
      input: ["pointer", "keyboard", "text", "paste", "touch", "scroll"],
      clipboard: ["local_to_remote", "remote_to_local", "manual_fallback"],
      viewport: ["report", "resize", "classify_occlusion"],
      diagnostics: ["events", "replay", "redacted_buffer"],
      ownerBrowser: true,
      serverSideAutomationEndpoint: true,
    });
  });
});
