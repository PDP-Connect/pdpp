import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  findUnsafeDescriptorPaths,
  isSafeRemoteSurfaceBackendDescriptor,
  type SafeRemoteSurfaceBackendDescriptor,
} from "./index.ts";

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
});
