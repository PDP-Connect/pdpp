import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireBrowserForConnector,
  decideContainerHeadedBrowserGate,
  HEADED_BROWSER_UNAVAILABLE_CODE,
  HeadedBrowserUnavailableError,
} from "./browser-launch.ts";

const ENV_VARS = ["PDPP_FORCE_CONTAINER", "PDPP_ALLOW_HEADED_CONTAINER_BROWSER"] as const;

function withEnv(values: Partial<Record<(typeof ENV_VARS)[number], string>>) {
  const previous = new Map<string, string | undefined>();
  for (const name of ENV_VARS) {
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
  assert.deepEqual(
    decideContainerHeadedBrowserGate({ headless: false, inContainer: false, escapeHatchEnabled: true }),
    { kind: "proceed" }
  );
});

test("decideContainerHeadedBrowserGate: undefined headless in container fails closed (mirrors acquireIsolatedBrowser default)", () => {
  assert.deepEqual(
    decideContainerHeadedBrowserGate({ headless: undefined, inContainer: true, escapeHatchEnabled: false }),
    { kind: "fail_closed" }
  );
});

test("decideContainerHeadedBrowserGate: undefined headless on host (no container) proceeds", () => {
  assert.deepEqual(
    decideContainerHeadedBrowserGate({ headless: undefined, inContainer: false, escapeHatchEnabled: false }),
    { kind: "proceed" }
  );
});

test("decideContainerHeadedBrowserGate: explicit headless: true in container proceeds even when undefined would not", () => {
  assert.deepEqual(decideContainerHeadedBrowserGate({ headless: true, inContainer: true, escapeHatchEnabled: false }), {
    kind: "proceed",
  });
});

test("acquireBrowserForConnector fails closed when caller omits 'headless' in container", async () => {
  const restore = withEnv({ PDPP_FORCE_CONTAINER: "1" });
  try {
    await assert.rejects(
      () => acquireBrowserForConnector({ profileName: "test_connector" }),
      (err: unknown) => {
        assert.ok(err instanceof HeadedBrowserUnavailableError, `got ${String(err)}`);
        if (err instanceof HeadedBrowserUnavailableError) {
          assert.equal(err.code, HEADED_BROWSER_UNAVAILABLE_CODE);
          assert.match(err.message, /collector/i);
        }
        return true;
      }
    );
  } finally {
    restore();
  }
});

test("acquireBrowserForConnector fails closed for HEADED in container with no local collector (PDPP_FORCE_CONTAINER=1)", async () => {
  const restore = withEnv({ PDPP_FORCE_CONTAINER: "1" });
  try {
    await assert.rejects(
      () => acquireBrowserForConnector({ profileName: "test_connector", headless: false }),
      (err: unknown) => {
        assert.ok(err instanceof HeadedBrowserUnavailableError, `got ${String(err)}`);
        if (err instanceof HeadedBrowserUnavailableError) {
          assert.equal(err.code, HEADED_BROWSER_UNAVAILABLE_CODE);
          assert.match(err.message, /container/i);
          assert.match(err.message, /collector/i);
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

test("HeadedBrowserUnavailableError carries the stable code", () => {
  const err = new HeadedBrowserUnavailableError({ message: "test" });
  assert.equal(err.code, HEADED_BROWSER_UNAVAILABLE_CODE);
  assert.equal(err.name, "HeadedBrowserUnavailableError");
  assert.ok(err instanceof Error);
});
