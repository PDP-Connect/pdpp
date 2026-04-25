import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireBrowserForConnector,
  acquireRemoteHostBrowser,
  HostBrowserBridgeUnavailableError,
} from "./browser-launch.ts";
import { HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE } from "./host-browser-bridge-config.ts";

const BRIDGE_ENV_VARS = [
  "PDPP_HOST_BROWSER_BRIDGE_URL",
  "PDPP_HOST_BROWSER_BRIDGE_TOKEN",
  "PDPP_HOST_BROWSER_BRIDGE_DAILY_CHROME",
] as const;

function withEnv(values: Partial<Record<(typeof BRIDGE_ENV_VARS)[number], string>>) {
  const previous = new Map<string, string | undefined>();
  for (const name of BRIDGE_ENV_VARS) {
    previous.set(name, process.env[name]);
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string") {
      process.env[name] = value;
    }
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

test("acquireBrowserForConnector throws HostBrowserBridgeUnavailableError when bridge URL is set without a token", async () => {
  const restore = withEnv({
    PDPP_HOST_BROWSER_BRIDGE_URL: "ws://host.docker.internal:7670",
  });
  try {
    await assert.rejects(
      () => acquireBrowserForConnector({ profileName: "test_connector" }),
      (err: unknown) => {
        assert.ok(err instanceof HostBrowserBridgeUnavailableError);
        if (err instanceof HostBrowserBridgeUnavailableError) {
          assert.equal(err.code, HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE);
          assert.match(err.message, /misconfigured/);
          assert.match(err.message, /unauthenticated/);
        }
        return true;
      }
    );
  } finally {
    restore();
  }
});

test("acquireBrowserForConnector throws HostBrowserBridgeUnavailableError when only the token is set", async () => {
  const restore = withEnv({
    PDPP_HOST_BROWSER_BRIDGE_TOKEN: "secret-without-url",
  });
  try {
    await assert.rejects(
      () => acquireBrowserForConnector({ profileName: "test_connector" }),
      (err: unknown) => err instanceof HostBrowserBridgeUnavailableError
    );
  } finally {
    restore();
  }
});

test("acquireRemoteHostBrowser surfaces HostBrowserBridgeUnavailableError when the bridge is unreachable", async () => {
  // Port 1 is privileged + closed on every test runner. The patchright
  // CDP client raises a connection error which we wrap.
  await assert.rejects(
    () =>
      acquireRemoteHostBrowser({
        bridgeUrl: "ws://127.0.0.1:1",
        bridgeToken: "irrelevant-token",
      }),
    (err: unknown) => {
      assert.ok(err instanceof HostBrowserBridgeUnavailableError, `got ${String(err)}`);
      if (err instanceof HostBrowserBridgeUnavailableError) {
        assert.equal(err.code, HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE);
        assert.equal(err.bridgeUrl, "ws://127.0.0.1:1");
        // Message should name the URL and point at the host bridge CLI.
        assert.match(err.message, /127\.0\.0\.1:1/);
        assert.match(err.message, /host-browser-bridge/);
      }
      return true;
    }
  );
});

test("HostBrowserBridgeUnavailableError carries the stable code", () => {
  const err = new HostBrowserBridgeUnavailableError({
    bridgeUrl: "ws://x:1",
    message: "test",
  });
  assert.equal(err.code, HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE);
  assert.equal(err.name, "HostBrowserBridgeUnavailableError");
  assert.ok(err instanceof Error);
});
