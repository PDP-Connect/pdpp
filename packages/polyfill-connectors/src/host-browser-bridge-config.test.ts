import assert from "node:assert/strict";
import test from "node:test";
import {
  HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE,
  hostBrowserBridgeUnavailableMessage,
  resolveHostBrowserBridgeConfig,
} from "./host-browser-bridge-config.ts";

test("resolveHostBrowserBridgeConfig returns disabled when no env vars are set", () => {
  const result = resolveHostBrowserBridgeConfig({});
  assert.equal(result.mode, "disabled");
});

test("resolveHostBrowserBridgeConfig treats whitespace-only URL as unset", () => {
  const result = resolveHostBrowserBridgeConfig({
    PDPP_HOST_BROWSER_BRIDGE_URL: "   ",
  });
  assert.equal(result.mode, "disabled");
});

test("resolveHostBrowserBridgeConfig returns configured when url and token are set", () => {
  const result = resolveHostBrowserBridgeConfig({
    PDPP_HOST_BROWSER_BRIDGE_URL: "ws://host.docker.internal:7670",
    PDPP_HOST_BROWSER_BRIDGE_TOKEN: "secret-abc",
  });
  assert.equal(result.mode, "configured");
  if (result.mode === "configured") {
    assert.equal(result.config.url, "ws://host.docker.internal:7670");
    assert.equal(result.config.token, "secret-abc");
    assert.equal(result.config.dailyChromeAcknowledged, false);
  }
});

test("resolveHostBrowserBridgeConfig accepts wss:// URLs", () => {
  const result = resolveHostBrowserBridgeConfig({
    PDPP_HOST_BROWSER_BRIDGE_URL: "wss://localhost:7670",
    PDPP_HOST_BROWSER_BRIDGE_TOKEN: "t",
  });
  assert.equal(result.mode, "configured");
});

test("resolveHostBrowserBridgeConfig rejects http:// URLs", () => {
  const result = resolveHostBrowserBridgeConfig({
    PDPP_HOST_BROWSER_BRIDGE_URL: "http://localhost:7670",
    PDPP_HOST_BROWSER_BRIDGE_TOKEN: "t",
  });
  assert.equal(result.mode, "misconfigured");
  if (result.mode === "misconfigured") {
    assert.match(result.reason, /must be a ws:\/\/ or wss:\/\/ URL/);
  }
});

test("resolveHostBrowserBridgeConfig fails closed when token is missing", () => {
  const result = resolveHostBrowserBridgeConfig({
    PDPP_HOST_BROWSER_BRIDGE_URL: "ws://host.docker.internal:7670",
  });
  assert.equal(result.mode, "misconfigured");
  if (result.mode === "misconfigured") {
    assert.match(result.reason, /refusing to connect unauthenticated/);
  }
});

test("resolveHostBrowserBridgeConfig fails closed when token is whitespace", () => {
  const result = resolveHostBrowserBridgeConfig({
    PDPP_HOST_BROWSER_BRIDGE_URL: "ws://host.docker.internal:7670",
    PDPP_HOST_BROWSER_BRIDGE_TOKEN: "   ",
  });
  assert.equal(result.mode, "misconfigured");
});

test("resolveHostBrowserBridgeConfig surfaces token-without-URL as misconfigured", () => {
  const result = resolveHostBrowserBridgeConfig({
    PDPP_HOST_BROWSER_BRIDGE_TOKEN: "abc",
  });
  assert.equal(result.mode, "misconfigured");
  if (result.mode === "misconfigured") {
    assert.match(result.reason, /URL is empty/);
  }
});

test("resolveHostBrowserBridgeConfig surfaces daily-chrome-without-URL as misconfigured", () => {
  const result = resolveHostBrowserBridgeConfig({
    PDPP_HOST_BROWSER_BRIDGE_DAILY_CHROME: "1",
  });
  assert.equal(result.mode, "misconfigured");
});

test("resolveHostBrowserBridgeConfig recognizes daily-chrome opt-in only at literal '1'", () => {
  const yes = resolveHostBrowserBridgeConfig({
    PDPP_HOST_BROWSER_BRIDGE_URL: "ws://host.docker.internal:7670",
    PDPP_HOST_BROWSER_BRIDGE_TOKEN: "t",
    PDPP_HOST_BROWSER_BRIDGE_DAILY_CHROME: "1",
  });
  assert.equal(yes.mode, "configured");
  if (yes.mode === "configured") {
    assert.equal(yes.config.dailyChromeAcknowledged, true);
  }

  // Common truthy-but-not-"1" strings must NOT count as opt-in. Stops
  // operators from accidentally toggling the daily-Chrome posture by
  // setting the var to "true" or "yes" thinking it's a generic flag.
  // (Whitespace around "1" is allowed because we trim env vars
  // consistently across config — see readEnv.)
  for (const value of ["0", "true", "yes", "on", "Y"]) {
    const result = resolveHostBrowserBridgeConfig({
      PDPP_HOST_BROWSER_BRIDGE_URL: "ws://host.docker.internal:7670",
      PDPP_HOST_BROWSER_BRIDGE_TOKEN: "t",
      PDPP_HOST_BROWSER_BRIDGE_DAILY_CHROME: value,
    });
    assert.equal(result.mode, "configured", `value=${value}`);
    if (result.mode === "configured") {
      assert.equal(result.config.dailyChromeAcknowledged, false, `value=${value}`);
    }
  }
});

test("hostBrowserBridgeUnavailableMessage names URL and points at the host CLI", () => {
  const message = hostBrowserBridgeUnavailableMessage({
    url: "ws://host.docker.internal:7670",
    cause: "ECONNREFUSED",
  });
  assert.match(message, /ws:\/\/host\.docker\.internal:7670/);
  assert.match(message, /ECONNREFUSED/);
  assert.match(message, /host-browser-bridge/);
  assert.match(message, /PDPP_HOST_BROWSER_BRIDGE_TOKEN/);
});

test("HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE is the stable failure code", () => {
  assert.equal(HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE, "host_browser_bridge_unavailable");
});
