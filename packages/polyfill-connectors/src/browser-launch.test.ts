import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireBrowserForConnector,
  acquireRemoteHostBrowser,
  decideContainerHeadedBrowserGate,
  HostBrowserBridgeUnavailableError,
} from "./browser-launch.ts";
import { HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE } from "./host-browser-bridge-config.ts";

const BRIDGE_ENV_VARS = [
  "PDPP_HOST_BROWSER_BRIDGE_URL",
  "PDPP_HOST_BROWSER_BRIDGE_TOKEN",
  "PDPP_HOST_BROWSER_BRIDGE_DAILY_CHROME",
  "PDPP_REFERENCE_MODE",
  "PDPP_FORCE_CONTAINER",
  "PDPP_ALLOW_HEADED_CONTAINER_BROWSER",
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

// ─── In-container fail-closed gate (narrow: HEADED only) ──────────────
//
// We exercise the gate via the pure decision helper rather than against
// the live launcher. The launcher itself successfully spawns a Chromium
// in this test environment when the gate does NOT fire, which would
// turn every "must NOT throw the typed error" assertion into a real
// browser launch — slow, flaky, and unrelated to the policy under test.
// One integration test remains for the fail-closed case because it
// short-circuits before any launcher work runs.

test("decideContainerHeadedBrowserGate: host-direct headed acquisition proceeds", () => {
  assert.deepEqual(
    decideContainerHeadedBrowserGate({ headless: false, inContainer: false, escapeHatchEnabled: false }),
    { kind: "proceed" }
  );
});

test("decideContainerHeadedBrowserGate: host-direct headless acquisition proceeds", () => {
  assert.deepEqual(
    decideContainerHeadedBrowserGate({ headless: true, inContainer: false, escapeHatchEnabled: false }),
    { kind: "proceed" }
  );
});

test("decideContainerHeadedBrowserGate: HEADLESS in container proceeds (legitimate non-interactive workload)", () => {
  assert.deepEqual(decideContainerHeadedBrowserGate({ headless: true, inContainer: true, escapeHatchEnabled: false }), {
    kind: "proceed",
  });
});

test("decideContainerHeadedBrowserGate: HEADED in container fails closed", () => {
  assert.deepEqual(
    decideContainerHeadedBrowserGate({ headless: false, inContainer: true, escapeHatchEnabled: false }),
    { kind: "fail_closed" }
  );
});

test("decideContainerHeadedBrowserGate: escape hatch downgrades HEADED-in-container to warn_and_proceed", () => {
  assert.deepEqual(decideContainerHeadedBrowserGate({ headless: false, inContainer: true, escapeHatchEnabled: true }), {
    kind: "warn_and_proceed",
  });
});

test("decideContainerHeadedBrowserGate: escape hatch is a no-op when not in container", () => {
  // Defensive — the escape hatch should never matter on the host-direct
  // path. Asserting this prevents an accidental future refactor from
  // turning the env into a side-effect on host runs.
  assert.deepEqual(
    decideContainerHeadedBrowserGate({ headless: false, inContainer: false, escapeHatchEnabled: true }),
    { kind: "proceed" }
  );
});

test("decideContainerHeadedBrowserGate: undefined headless in container fails closed (mirrors acquireIsolatedBrowser default of headless=false)", () => {
  // Regression for the 2026-04-27 owner review: acquireIsolatedBrowser
  // destructures `{ headless = false }`, so a library-direct caller
  // writing `acquireBrowserForConnector({ profileName })` with no
  // headless field is asking for a visible browser. The gate MUST
  // mirror the launcher's effective default — anything else lets the
  // exact silent-headed-in-container failure mode the gate exists to
  // prevent slip through.
  assert.deepEqual(
    decideContainerHeadedBrowserGate({ headless: undefined, inContainer: true, escapeHatchEnabled: false }),
    { kind: "fail_closed" }
  );
});

test("decideContainerHeadedBrowserGate: undefined headless on host (no container) proceeds", () => {
  // Defensive: outside a container the gate must not fire regardless of
  // the headless default — the host-direct launcher is exactly what we
  // want to reach.
  assert.deepEqual(
    decideContainerHeadedBrowserGate({ headless: undefined, inContainer: false, escapeHatchEnabled: false }),
    { kind: "proceed" }
  );
});

test("decideContainerHeadedBrowserGate: explicit headless: true in container proceeds even when undefined would not", () => {
  // Explicit headless=true is the legitimate non-interactive workload
  // (cookie-authenticated scrape, fingerprint-only fetch). It must
  // remain allowed in container after the undefined-as-headed fix.
  assert.deepEqual(decideContainerHeadedBrowserGate({ headless: true, inContainer: true, escapeHatchEnabled: false }), {
    kind: "proceed",
  });
});

test("acquireBrowserForConnector fails closed when caller omits 'headless' in container (matches acquireIsolatedBrowser default)", async () => {
  // 2026-04-27 owner-review regression: a library-direct caller writing
  // `acquireBrowserForConnector({ profileName })` with NO headless field
  // is asking for a visible browser (acquireIsolatedBrowser destructures
  // `{ headless = false }`). The gate MUST fail closed in container;
  // otherwise the silent-headed-in-container path the gate exists to
  // close still slips through for that call shape.
  const restore = withEnv({ PDPP_FORCE_CONTAINER: "1" });
  try {
    await assert.rejects(
      () => acquireBrowserForConnector({ profileName: "test_connector" }),
      (err: unknown) => {
        assert.ok(err instanceof HostBrowserBridgeUnavailableError, `got ${String(err)}`);
        if (err instanceof HostBrowserBridgeUnavailableError) {
          assert.equal(err.code, HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE);
        }
        return true;
      }
    );
  } finally {
    restore();
  }
});

test("acquireBrowserForConnector fails closed for HEADED in container with no bridge (PDPP_REFERENCE_MODE=composed)", async () => {
  // Integration test — the fail-closed branch short-circuits before any
  // launcher work, so this is fast and deterministic. Compose stacks
  // export PDPP_REFERENCE_MODE=composed. Without a bridge URL, the
  // runtime would otherwise launch an invisible in-container Chromium.
  // Per design-host-browser-bridge-for-docker design.md § "Failure Mode
  // When Unavailable".
  const restore = withEnv({
    PDPP_REFERENCE_MODE: "composed",
  });
  try {
    await assert.rejects(
      () => acquireBrowserForConnector({ profileName: "test_connector", headless: false }),
      (err: unknown) => {
        assert.ok(err instanceof HostBrowserBridgeUnavailableError, `got ${String(err)}`);
        if (err instanceof HostBrowserBridgeUnavailableError) {
          assert.equal(err.code, HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE);
          assert.equal(err.bridgeUrl, null);
          assert.match(err.message, /container/i);
          assert.match(err.message, /PDPP_HOST_BROWSER_BRIDGE_URL/);
          // Message must explicitly mention that headless is unaffected so
          // the operator who hits this never thinks the gate applies to
          // their non-interactive workload.
          assert.match(err.message, /[Hh]eadless/);
        }
        return true;
      }
    );
  } finally {
    restore();
  }
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
