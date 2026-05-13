import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  findUnsafeDescriptorPaths,
  isSafeRemoteSurfaceBackendDescriptor,
  parseRemoteSurfaceClipboardPayload,
  parseRemoteSurfaceDiagnosticsPayload,
  parseRemoteSurfaceEventPayload,
  parseRemoteSurfaceInputPayload,
  parseRemoteSurfaceTargetDescriptor,
  parseRemoteSurfaceViewportPayload,
  parseSafeRemoteSurfaceBackendDescriptor,
  RemoteSurfaceProtocolError,
  type SafeRemoteSurfaceBackendDescriptor,
} from "./index.ts";
import {
  REMOTE_SURFACE_CLIPBOARD_FIXTURES,
  REMOTE_SURFACE_DIAGNOSTICS_FIXTURE,
  REMOTE_SURFACE_EVENT_FIXTURES,
  REMOTE_SURFACE_INPUT_FIXTURES,
  REMOTE_SURFACE_TARGET_FIXTURES,
  REMOTE_SURFACE_VIEWPORT_FIXTURES,
} from "../testing/protocol-fixtures.ts";

const capabilities = {
  eventChannel: "sse",
  input: ["pointer"],
  clipboard: ["manual_fallback"],
  viewport: ["report"],
  diagnostics: ["redacted_buffer"],
  ownerBrowser: true,
  serverSideAutomationEndpoint: true,
} as const;

describe("safe backend descriptors", () => {
  it("accepts token-scoped same-origin descriptors", () => {
    const descriptor: SafeRemoteSurfaceBackendDescriptor = {
      backend: "neko",
      capabilities,
      proxy: { path: "/neko/", sameOrigin: true },
      session: { path: "/neko/session", sameOrigin: true },
    };

    assert.equal(isSafeRemoteSurfaceBackendDescriptor(descriptor), true);
  });

  it("reports raw CDP, Docker, and credential authority", () => {
    assert.deepEqual(
      findUnsafeDescriptorPaths({
        backend: "cdp",
        cdpWsUrl: "ws://127.0.0.1/devtools/browser/token",
        nested: { dockerSocket: "/var/run/docker.sock", token: "abc" },
        uppercase: { Authorization: "Bearer abc", sessionToken: "secret" },
      }),
      [
        "$.cdpWsUrl",
        "$.nested.dockerSocket",
        "$.nested.token",
        "$.uppercase.Authorization",
        "$.uppercase.sessionToken",
      ],
    );
  });

  it("rejects raw browser-visible endpoints and endpoint-shaped descriptor strings", () => {
    assert.throws(
      () =>
        parseSafeRemoteSurfaceBackendDescriptor({
          backend: "cdp",
          capabilities,
          proxy: { path: "ws://127.0.0.1:9222/devtools/browser/secret", sameOrigin: true },
        }),
      RemoteSurfaceProtocolError,
    );
    assert.throws(
      () =>
        parseSafeRemoteSurfaceBackendDescriptor({
          backend: "neko",
          capabilities,
          session: { path: "https://neko.internal/session", sameOrigin: true },
        }),
      RemoteSurfaceProtocolError,
    );
  });

  it("rejects browser-visible secret-shaped descriptor fields", () => {
    assert.throws(
      () =>
        parseSafeRemoteSurfaceBackendDescriptor({
          backend: "neko",
          capabilities,
          proxy: { path: "/neko/", sameOrigin: true },
          token: "must-not-leak",
        }),
      RemoteSurfaceProtocolError,
    );
  });
});

describe("protocol fixtures", () => {
  it("parses representative SSE event fixtures", () => {
    assert.deepEqual(
      REMOTE_SURFACE_EVENT_FIXTURES.map((fixture) => parseRemoteSurfaceEventPayload(fixture)),
      REMOTE_SURFACE_EVENT_FIXTURES,
    );
  });

  it("parses representative input fixtures", () => {
    assert.deepEqual(
      REMOTE_SURFACE_INPUT_FIXTURES.map((fixture) => parseRemoteSurfaceInputPayload(fixture)),
      REMOTE_SURFACE_INPUT_FIXTURES,
    );
  });

  it("parses representative viewport fixtures", () => {
    assert.deepEqual(
      REMOTE_SURFACE_VIEWPORT_FIXTURES.map((fixture) => parseRemoteSurfaceViewportPayload(fixture)),
      REMOTE_SURFACE_VIEWPORT_FIXTURES,
    );
  });

  it("parses representative clipboard fixtures", () => {
    assert.deepEqual(
      REMOTE_SURFACE_CLIPBOARD_FIXTURES.map((fixture) => parseRemoteSurfaceClipboardPayload(fixture)),
      REMOTE_SURFACE_CLIPBOARD_FIXTURES,
    );
  });

  it("parses representative target fixtures without raw endpoint leaks", () => {
    assert.deepEqual(
      REMOTE_SURFACE_TARGET_FIXTURES.map((fixture) => parseRemoteSurfaceTargetDescriptor(fixture)),
      REMOTE_SURFACE_TARGET_FIXTURES,
    );
  });

  it("parses a representative redacted diagnostics fixture", () => {
    assert.deepEqual(
      parseRemoteSurfaceDiagnosticsPayload(REMOTE_SURFACE_DIAGNOSTICS_FIXTURE),
      REMOTE_SURFACE_DIAGNOSTICS_FIXTURE,
    );
  });

  it("rejects invalid payload values", () => {
    assert.throws(() => parseRemoteSurfaceInputPayload({ type: "pointer", action: "tap", x: 1, y: 1 }));
    assert.throws(() => parseRemoteSurfaceViewportPayload({ type: "viewport", width: 0, height: 844 }));
    assert.throws(() => parseRemoteSurfaceClipboardPayload({ type: "clipboard", action: "local_to_remote" }));
  });
});
