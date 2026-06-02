import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireBrowserForConnector,
  closeRemoteCdpPageTargets,
  configuredBrowserChannel,
  connectOverCdpWithRetry,
  decideContainerHeadedBrowserGate,
  fetchPageTargetWsUrl,
  HEADED_BROWSER_UNAVAILABLE_CODE,
  HeadedBrowserUnavailableError,
  isCdpAttachSessionRaceError,
  resolvePageTargetWsUrl,
  runCdpAttemptWithRaceGuard,
  type UnhandledRejectionHost,
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

test("decideContainerHeadedBrowserGate: HEADED in container with remoteCdpUrl proceeds (remote browser is operator-visible)", () => {
  assert.deepEqual(
    decideContainerHeadedBrowserGate({
      headless: false,
      inContainer: true,
      escapeHatchEnabled: false,
      remoteCdpUrl: "http://neko:9223",
    }),
    { kind: "proceed" }
  );
});

test("decideContainerHeadedBrowserGate: undefined headless in container with remoteCdpUrl proceeds", () => {
  assert.deepEqual(
    decideContainerHeadedBrowserGate({
      headless: undefined,
      inContainer: true,
      escapeHatchEnabled: false,
      remoteCdpUrl: "http://neko:9223",
    }),
    { kind: "proceed" }
  );
});

test("decideContainerHeadedBrowserGate: HEADED in container WITHOUT remoteCdpUrl still fails closed (local headed)", () => {
  assert.deepEqual(
    decideContainerHeadedBrowserGate({
      headless: false,
      inContainer: true,
      escapeHatchEnabled: false,
    }),
    { kind: "fail_closed" }
  );
});

test("decideContainerHeadedBrowserGate: empty-string remoteCdpUrl does not bypass the gate", () => {
  assert.deepEqual(
    decideContainerHeadedBrowserGate({
      headless: false,
      inContainer: true,
      escapeHatchEnabled: false,
      remoteCdpUrl: "",
    }),
    { kind: "fail_closed" }
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

test("configuredBrowserChannel defaults to bundled Patchright Chromium", () => {
  assert.equal(configuredBrowserChannel({}), undefined);
  assert.equal(configuredBrowserChannel({ PDPP_BROWSER_CHANNEL: "   " }), undefined);
});

test("configuredBrowserChannel preserves explicit channel override", () => {
  assert.equal(configuredBrowserChannel({ PDPP_BROWSER_CHANNEL: " chrome " }), "chrome");
  assert.equal(configuredBrowserChannel({ PDPP_BROWSER_CHANNEL: "chromium" }), "chromium");
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

test("closeRemoteCdpPageTargets replaces stale page targets before closing them", async () => {
  const seenUrls: string[] = [];
  let listCalls = 0;
  const fetchImpl = ((input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    seenUrls.push(url);
    if (url.endsWith("/json")) {
      listCalls += 1;
      const body =
        listCalls === 1
          ? [
              { id: "PAGE_TARGET_ID", type: "page", url: "https://www.amazon.com/your-orders/orders" },
              { id: "IFRAME_TARGET_ID", type: "iframe", url: "https://www.amazon.com/frame" },
              { id: "SERVICE_WORKER_ID", type: "service_worker", url: "https://www.amazon.com/sw.js" },
            ]
          : [
              { id: "FRESH_PAGE_TARGET_ID", type: "page", url: "about:blank" },
              { id: "IFRAME_TARGET_ID", type: "iframe", url: "https://www.amazon.com/frame" },
              { id: "SERVICE_WORKER_ID", type: "service_worker", url: "https://www.amazon.com/sw.js" },
            ];
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }
    if (url.endsWith("/json/new?about:blank")) {
      return Promise.resolve(
        new Response(JSON.stringify({ id: "FRESH_PAGE_TARGET_ID", type: "page", url: "about:blank" }), { status: 200 })
      );
    }
    return Promise.resolve(new Response("Target is closing", { status: 200 }));
  }) as typeof fetch;

  const result = await closeRemoteCdpPageTargets({
    cdpUrl: "http://neko.example.test:9223/devtools/browser/browser-id",
    fetchImpl,
    timeoutMs: 500,
    pollMs: 1,
  });

  assert.deepEqual(result, { closed: 1, remaining: 0, replacementCreated: true, skipped: false });
  assert.deepEqual(seenUrls, [
    "http://neko.example.test:9223/json",
    "http://neko.example.test:9223/json/new?about:blank",
    "http://neko.example.test:9223/json/close/PAGE_TARGET_ID",
    "http://neko.example.test:9223/json",
  ]);
});

test("closeRemoteCdpPageTargets does not close the last page when replacement creation fails", async () => {
  const seenUrls: string[] = [];
  const fetchImpl = ((input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    seenUrls.push(url);
    if (url.endsWith("/json")) {
      return Promise.resolve(
        new Response(JSON.stringify([{ id: "ONLY_PAGE_TARGET_ID", type: "page", url: "https://www.amazon.com" }]), {
          status: 200,
        })
      );
    }
    if (url.endsWith("/json/new?about:blank")) {
      return Promise.resolve(new Response("nope", { status: 500 }));
    }
    return Promise.resolve(new Response("should not close", { status: 200 }));
  }) as typeof fetch;

  const result = await closeRemoteCdpPageTargets({
    cdpUrl: "http://neko.example.test:9223/",
    fetchImpl,
    timeoutMs: 500,
    pollMs: 1,
  });

  assert.deepEqual(result, { closed: 0, remaining: 1, replacementCreated: false, skipped: true });
  assert.deepEqual(seenUrls, [
    "http://neko.example.test:9223/json",
    "http://neko.example.test:9223/json/new?about:blank",
  ]);
});

test("closeRemoteCdpPageTargets skips when the CDP URL cannot expose an HTTP target list", async () => {
  let called = false;
  const result = await closeRemoteCdpPageTargets({
    cdpUrl: "unix:/tmp/chrome.sock",
    fetchImpl: (() => {
      called = true;
      return Promise.resolve(new Response("unexpected", { status: 200 }));
    }) as typeof fetch,
  });

  assert.deepEqual(result, { closed: 0, remaining: 0, replacementCreated: false, skipped: true });
  assert.equal(called, false);
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

// ─── Remote-CDP attach session-closed race recognition + retry ─────────
//
// The production failure was `connectOverCDP` rejecting with
// `Protocol error (Network.setCacheDisabled): Internal server error,
// session closed.` when Patchright auto-attaches to a transient n.eko
// target that is being torn down mid-attach. The race is transient, so we
// retry the WHOLE attach. We exercise the predicate and the retry policy
// directly with an injectable `connect` and `sleep` — no live browser.

// The exact production error message shape (patchright crConnection.js
// `dispose()` sets this message; `setMessage` prefixes the CDP method).
const PRODUCTION_RACE_MESSAGE = "Protocol error (Network.setCacheDisabled): Internal server error, session closed.";

test("isCdpAttachSessionRaceError matches the production setCacheDisabled session-closed error", () => {
  assert.equal(isCdpAttachSessionRaceError(new Error(PRODUCTION_RACE_MESSAGE)), true);
  // Bare string form (some transports surface message-only).
  assert.equal(isCdpAttachSessionRaceError(PRODUCTION_RACE_MESSAGE), true);
});

test("isCdpAttachSessionRaceError does NOT match unrelated protocol errors (fail fast)", () => {
  // Wrong CDP method — a session-closed on some other command is not this race.
  assert.equal(isCdpAttachSessionRaceError(new Error("Protocol error (Target.attachToTarget): session closed")), false);
  // setCacheDisabled but not session-closed (e.g. a real argument error).
  assert.equal(
    isCdpAttachSessionRaceError(new Error("Protocol error (Network.setCacheDisabled): Invalid parameters")),
    false
  );
  // Completely unrelated failures must fail fast.
  assert.equal(isCdpAttachSessionRaceError(new Error("connect ECONNREFUSED 127.0.0.1:9223")), false);
  assert.equal(isCdpAttachSessionRaceError(new Error("WebSocket error: 403 Forbidden")), false);
  assert.equal(isCdpAttachSessionRaceError(undefined), false);
  assert.equal(isCdpAttachSessionRaceError(null), false);
  assert.equal(isCdpAttachSessionRaceError({}), false);
});

// The retry-LOOP tests inject a trivial `runAttempt` that just calls `connect`
// directly. They exercise the loop's backoff/budget/fail-fast policy, NOT the
// per-attempt unhandled-rejection guard (which has its own block below). This
// keeps them fast (no 250ms settle window) and isolated to one concern.
const directAttempt: typeof runCdpAttemptWithRaceGuard = ({ connect }) => connect();

test("connectOverCdpWithRetry returns immediately on first-attempt success (no retry)", async () => {
  let attempts = 0;
  let slept = 0;
  const browser = await connectOverCdpWithRetry<string>({
    connect: () => {
      attempts += 1;
      return Promise.resolve("BROWSER");
    },
    profileName: "amazon",
    redactedUrl: "http://neko/",
    runAttempt: directAttempt,
    sleep: () => {
      slept += 1;
      return Promise.resolve();
    },
  });
  assert.equal(browser, "BROWSER");
  assert.equal(attempts, 1);
  assert.equal(slept, 0, "no sleep on first-attempt success");
});

test("connectOverCdpWithRetry rides out a transient session-closed race then succeeds", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const browser = await connectOverCdpWithRetry<string>({
    connect: () => {
      attempts += 1;
      if (attempts < 3) {
        return Promise.reject(new Error(PRODUCTION_RACE_MESSAGE));
      }
      return Promise.resolve("BROWSER");
    },
    profileName: "amazon",
    redactedUrl: "http://neko/",
    retryDelayMs: 7,
    runAttempt: directAttempt,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  });
  assert.equal(browser, "BROWSER");
  assert.equal(attempts, 3, "two failed attempts then a success");
  assert.deepEqual(delays, [7, 7], "slept the configured delay between each retry");
});

test("connectOverCdpWithRetry rethrows the race error after exhausting the attempt budget", async () => {
  let attempts = 0;
  let slept = 0;
  await assert.rejects(
    () =>
      connectOverCdpWithRetry<string>({
        connect: () => {
          attempts += 1;
          return Promise.reject(new Error(PRODUCTION_RACE_MESSAGE));
        },
        profileName: "amazon",
        redactedUrl: "http://neko/",
        maxAttempts: 3,
        runAttempt: directAttempt,
        sleep: () => {
          slept += 1;
          return Promise.resolve();
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match((err as Error).message, /session closed/i);
      return true;
    }
  );
  assert.equal(attempts, 3, "tried the full budget");
  assert.equal(slept, 2, "slept between attempts but not after the final failure");
});

test("connectOverCdpWithRetry fails fast on a non-race error (no retry, no sleep)", async () => {
  let attempts = 0;
  let slept = 0;
  await assert.rejects(
    () =>
      connectOverCdpWithRetry<string>({
        connect: () => {
          attempts += 1;
          return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:9223"));
        },
        profileName: "amazon",
        redactedUrl: "http://neko/",
        runAttempt: directAttempt,
        sleep: () => {
          slept += 1;
          return Promise.resolve();
        },
      }),
    /ECONNREFUSED/
  );
  assert.equal(attempts, 1, "non-race error is not retried");
  assert.equal(slept, 0, "no sleep on a fail-fast error");
});

// ─── v2: scoped unhandled-rejection guard around each attach attempt ────
//
// The v1 fix wrapped `connectOverCDP` in a try/catch. That was the WRONG catch
// boundary: in production `connectOverCDP` RESOLVES, then patchright's floated
// `setRequestInterception(true)` (CRPage constructor, no await/no catch) rejects
// on a LATER tick as a Node UNHANDLED REJECTION — escaping the connect promise
// entirely and crashing the process (`node:internal/process/promises`). These
// tests drive a fake `unhandledRejection` host so we can model that escape
// deterministically without a live browser or touching the real process.

interface FakeRejectionHost {
  /** Emit an unhandled rejection to all currently-registered listeners. */
  emit: (reason: unknown) => void;
  host: UnhandledRejectionHost;
  /** How many listeners are currently registered (must return to 0). */
  listenerCount: () => number;
}

function makeFakeRejectionHost(): FakeRejectionHost {
  const listeners = new Set<(reason: unknown) => void>();
  return {
    host: {
      on: (_event, listener) => {
        listeners.add(listener);
      },
      off: (_event, listener) => {
        listeners.delete(listener);
      },
    },
    emit: (reason) => {
      // Copy so a listener removing itself mid-iteration is safe.
      for (const listener of [...listeners]) {
        listener(reason);
      }
    },
    listenerCount: () => listeners.size,
  };
}

test("runCdpAttemptWithRaceGuard resolves and removes its listener on a clean attach", async () => {
  const fake = makeFakeRejectionHost();
  const browser = await runCdpAttemptWithRaceGuard<string>({
    connect: () => Promise.resolve("BROWSER"),
    settleMs: 0,
    host: fake.host,
  });
  assert.equal(browser, "BROWSER");
  assert.equal(fake.listenerCount(), 0, "guard listener is removed after a clean attach");
});

test("runCdpAttemptWithRaceGuard converts an UNHANDLED setCacheDisabled rejection (after connect resolved) into a retryable throw", async () => {
  const fake = makeFakeRejectionHost();
  let disconnected: string | null = null;
  // Model production exactly: connect resolves with a live browser, THEN the
  // floated setRequestInterception rejection escapes as an unhandled rejection
  // a tick later — while the guard's settle window is still open.
  await assert.rejects(
    () =>
      runCdpAttemptWithRaceGuard<string>({
        connect: () => {
          // Schedule the escape for just after connect resolves, like the real
          // floated promise. The guard's settle window must still be open.
          setTimeout(() => fake.emit(new Error(PRODUCTION_RACE_MESSAGE)), 5);
          return Promise.resolve("LIVE_BROWSER");
        },
        disconnect: (b) => {
          disconnected = b;
        },
        settleMs: 200,
        host: fake.host,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match((err as Error).message, /Network\.setCacheDisabled/);
      assert.match((err as Error).message, /session closed/i);
      return true;
    }
  );
  assert.equal(disconnected, "LIVE_BROWSER", "the orphaned just-connected browser is disconnected before retry");
  assert.equal(fake.listenerCount(), 0, "guard listener is removed even when it converts a race to a throw");
});

test("runCdpAttemptWithRaceGuard converts an UNHANDLED race while connect is still pending", async () => {
  const fake = makeFakeRejectionHost();
  let resolveConnect: ((browser: string) => void) | undefined;
  const disconnected: string[] = [];

  await assert.rejects(
    () =>
      runCdpAttemptWithRaceGuard<string>({
        connect: () =>
          new Promise<string>((resolve) => {
            resolveConnect = resolve;
            setTimeout(() => fake.emit(new Error(PRODUCTION_RACE_MESSAGE)), 5);
          }),
        disconnect: (b) => {
          disconnected.push(b);
        },
        settleMs: 200,
        host: fake.host,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match((err as Error).message, /Network\.setCacheDisabled/);
      assert.match((err as Error).message, /session closed/i);
      return true;
    }
  );

  assert.equal(fake.listenerCount(), 0, "guard listener is removed after the pending-connect race");
  assert.deepEqual(disconnected, [], "no Browser existed at the moment the guarded attempt rejected");

  // If Patchright eventually resolves the stale connect promise after the
  // attempt already retried, the late Browser is still disconnected
  // best-effort so the abandoned CDP client does not leak.
  assert.ok(resolveConnect, "connect promise was started");
  resolveConnect("LATE_BROWSER");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(disconnected, ["LATE_BROWSER"], "late browser was disconnected after pending-connect race");
});

test("runCdpAttemptWithRaceGuard does NOT swallow an unrelated unhandled rejection (re-throws to preserve crash semantics)", async () => {
  const fake = makeFakeRejectionHost();
  // A non-race unhandled rejection must NOT be consumed — the guard re-throws
  // it from the listener so Node's default crash-on-unhandled-rejection applies.
  // We assert that synchronous re-throw here (the real process would terminate).
  await runCdpAttemptWithRaceGuard<string>({
    connect: () => Promise.resolve("BROWSER"),
    settleMs: 0,
    host: fake.host,
  });
  // Listener was removed on the clean resolve above; re-arm one to assert the
  // non-race re-throw behavior directly against the guard's listener contract.
  const fake2 = makeFakeRejectionHost();
  let caught: unknown;
  const guarded = runCdpAttemptWithRaceGuard<string>({
    connect: () =>
      new Promise<string>((resolve) => {
        // Emit an unrelated unhandled rejection while the connect is pending.
        // The guard's listener must re-throw it synchronously.
        try {
          fake2.emit(new Error("some unrelated subsystem failure"));
        } catch (err) {
          caught = err;
        }
        resolve("BROWSER");
      }),
    settleMs: 0,
    host: fake2.host,
  });
  await guarded;
  assert.ok(caught instanceof Error, "the non-race rejection was re-thrown, not swallowed");
  assert.match((caught as Error).message, /unrelated subsystem failure/);
  assert.equal(fake2.listenerCount(), 0, "guard removed its listener before re-throwing the non-race rejection");
});

test("runCdpAttemptWithRaceGuard with no escape during the settle window resolves the connected browser", async () => {
  const fake = makeFakeRejectionHost();
  // No unhandled rejection emitted: a clean attach where the transient target
  // never raced. Short settle window so the test is fast.
  const browser = await runCdpAttemptWithRaceGuard<string>({
    connect: () => Promise.resolve("CLEAN_BROWSER"),
    settleMs: 10,
    host: fake.host,
  });
  assert.equal(browser, "CLEAN_BROWSER");
  assert.equal(fake.listenerCount(), 0);
});

test("connectOverCdpWithRetry rides out an UNHANDLED-rejection race end-to-end then succeeds", async () => {
  // Full integration of the loop + guard: attempt 1's connect resolves but the
  // floated rejection escapes as an unhandled rejection (converted to a retry);
  // attempt 2 attaches cleanly. Uses a per-call fake host so each attempt's
  // guard is independent, mirroring the real `process` host across attempts.
  let attempts = 0;
  let slept = 0;
  const disconnects: string[] = [];
  const browser = await connectOverCdpWithRetry<string>({
    connect: () => {
      attempts += 1;
      return Promise.resolve(`BROWSER_ATTEMPT_${attempts}`);
    },
    disconnect: (b) => {
      disconnects.push(b);
    },
    profileName: "amazon",
    redactedUrl: "http://neko/",
    retryDelayMs: 1,
    sleep: () => {
      slept += 1;
      return Promise.resolve();
    },
    runAttempt: ({ connect, disconnect }) => {
      const fake = makeFakeRejectionHost();
      return runCdpAttemptWithRaceGuard({
        connect: () => {
          const p = connect();
          // Only attempt 1 races: schedule the escape just after connect resolves.
          if (attempts === 1) {
            setTimeout(() => fake.emit(new Error(PRODUCTION_RACE_MESSAGE)), 2);
          }
          return p;
        },
        settleMs: attempts === 1 ? 200 : 5,
        host: fake.host,
        ...(disconnect ? { disconnect } : {}),
      });
    },
  });
  assert.equal(browser, "BROWSER_ATTEMPT_2", "second attempt attached cleanly");
  assert.equal(attempts, 2, "one raced attempt, then a clean one");
  assert.equal(slept, 1, "slept once between the converted race and the retry");
  assert.deepEqual(disconnects, ["BROWSER_ATTEMPT_1"], "the orphaned first browser was disconnected before retry");
});
