import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireBrowserForConnector,
  decideContainerHeadedBrowserGate,
  fetchPageTargetWsUrl,
  HEADED_BROWSER_UNAVAILABLE_CODE,
  HeadedBrowserUnavailableError,
  resolvePageTargetWsUrl,
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

// ─── wsUrl extraction (DevToolsActivePort + /json target listing) ──────
//
// We exercise the extraction helpers via injectable `fetch` and a real
// temp dir holding a `DevToolsActivePort` file written in Chromium's
// canonical format. We do NOT spin up a real Chromium for this — the
// extraction's contract is "given a userDataDir with a port file and a
// fetch returning the standard /json shape, return the first page
// target's webSocketDebuggerUrl"; that's a pure data-shape problem.

const FAKE_JSON_RESPONSE = [
  {
    type: "background_page",
    webSocketDebuggerUrl: "ws://127.0.0.1:9999/devtools/page/extension",
  },
  {
    type: "page",
    title: "about:blank",
    url: "about:blank",
    webSocketDebuggerUrl: "ws://127.0.0.1:9999/devtools/page/PAGE_TARGET_ID",
  },
];

function fakeFetchOk(body: unknown): typeof fetch {
  return ((): Promise<Response> =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))) as typeof fetch;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return (input as Request).url;
}

test("fetchPageTargetWsUrl picks the first page target from /json", async () => {
  const wsUrl = await fetchPageTargetWsUrl({
    port: 9999,
    fetchImpl: fakeFetchOk(FAKE_JSON_RESPONSE),
  });
  assert.equal(wsUrl, "ws://127.0.0.1:9999/devtools/page/PAGE_TARGET_ID");
});

test("fetchPageTargetWsUrl returns null when no page target is present", async () => {
  const wsUrl = await fetchPageTargetWsUrl({
    port: 9999,
    fetchImpl: fakeFetchOk([
      { type: "service_worker", webSocketDebuggerUrl: "ws://127.0.0.1:9999/devtools/page/sw" },
      { type: "browser", webSocketDebuggerUrl: "ws://127.0.0.1:9999/devtools/browser/abc" },
    ]),
  });
  assert.equal(wsUrl, null);
});

test("fetchPageTargetWsUrl returns null on /json non-200", async () => {
  const wsUrl = await fetchPageTargetWsUrl({
    port: 9999,
    fetchImpl: ((): Promise<Response> => Promise.resolve(new Response("nope", { status: 500 }))) as typeof fetch,
  });
  assert.equal(wsUrl, null);
});

test("fetchPageTargetWsUrl returns null on /json network error (does not throw)", async () => {
  const wsUrl = await fetchPageTargetWsUrl({
    port: 9999,
    fetchImpl: ((): Promise<Response> => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch,
  });
  assert.equal(wsUrl, null);
});

test("fetchPageTargetWsUrl returns null on non-JSON body (does not throw)", async () => {
  const wsUrl = await fetchPageTargetWsUrl({
    port: 9999,
    fetchImpl: ((): Promise<Response> => Promise.resolve(new Response("not json", { status: 200 }))) as typeof fetch,
  });
  assert.equal(wsUrl, null);
});

test("resolvePageTargetWsUrl reads DevToolsActivePort then queries /json with the parsed port", async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pdpp-launch-test-"));
  try {
    // Chromium writes two lines: PORT, then /devtools/browser/<id>.
    await writeFile(join(userDataDir, "DevToolsActivePort"), "9999\n/devtools/browser/abc-123\n", "utf8");
    let calledUrl: string | null = null;
    const wsUrl = await resolvePageTargetWsUrl({
      userDataDir,
      timeoutMs: 200,
      pollMs: 5,
      fetchImpl: ((input: string | URL | Request): Promise<Response> => {
        calledUrl = urlOf(input);
        return Promise.resolve(new Response(JSON.stringify(FAKE_JSON_RESPONSE), { status: 200 }));
      }) as typeof fetch,
    });
    assert.equal(calledUrl, "http://127.0.0.1:9999/json", "fetch should target the parsed port on loopback");
    assert.equal(wsUrl, "ws://127.0.0.1:9999/devtools/page/PAGE_TARGET_ID");
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("resolvePageTargetWsUrl returns null when DevToolsActivePort never appears", async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pdpp-launch-test-"));
  try {
    // Don't write the file; resolver should give up after timeoutMs.
    const wsUrl = await resolvePageTargetWsUrl({
      userDataDir,
      timeoutMs: 100,
      pollMs: 10,
      fetchImpl: fakeFetchOk(FAKE_JSON_RESPONSE),
    });
    assert.equal(wsUrl, null);
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("resolvePageTargetWsUrl returns null when DevToolsActivePort is malformed", async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pdpp-launch-test-"));
  try {
    await writeFile(join(userDataDir, "DevToolsActivePort"), "not-a-port\n/devtools/browser/abc\n", "utf8");
    const wsUrl = await resolvePageTargetWsUrl({
      userDataDir,
      timeoutMs: 100,
      pollMs: 10,
      fetchImpl: fakeFetchOk(FAKE_JSON_RESPONSE),
    });
    assert.equal(wsUrl, null);
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});
