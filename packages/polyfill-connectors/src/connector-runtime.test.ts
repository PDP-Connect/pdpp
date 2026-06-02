import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext, Page } from "playwright";
import {
  type BrowserLaunchSource,
  type BrowserRuntimeVisibility,
  captureBrowserPage,
  closeBrowserContextPagesExcept,
  closeBrowserPage,
  decorateBrowserManualAction,
  type InteractionRequest,
  isContextDisconnected,
  makeBrowserInteractionKeepalive,
  makeTracer,
  resolveBrowserLaunchSource,
  resolveBrowserRuntimeVisibility,
} from "./connector-runtime.ts";
import type { CaptureSession } from "./fixture-capture.ts";

const HEADLESS: BrowserRuntimeVisibility = {
  envKey: "PDPP_REDDIT_HEADLESS",
  headless: true,
  profileName: "reddit",
};

const MANUAL_ACTION: InteractionRequest = {
  kind: "manual_action",
  message: "Log in to reddit.com in the browser window and re-run.",
  timeout_seconds: 1800,
};

interface KeepaliveTestBrowser {
  isConnected: () => boolean;
  newBrowserCDPSession: () => Promise<{
    detach: () => Promise<void>;
    send: (method: string) => Promise<unknown>;
  }>;
  off?: (event: "disconnected", listener: () => void) => KeepaliveTestBrowser;
  on?: (event: "disconnected", listener: () => void) => KeepaliveTestBrowser;
}

function makeKeepaliveContext(
  browser: KeepaliveTestBrowser,
  pages: Page[] = []
): Pick<BrowserContext, "browser" | "pages"> {
  return {
    browser: () => browser as ReturnType<BrowserContext["browser"]>,
    pages: () => pages,
  };
}

function makeDiagnosticPage(url: string, closed = false): Page {
  const fake: Pick<Page, "isClosed" | "url"> = {
    isClosed: () => closed,
    url: () => url,
  };
  return fake as Page;
}

function makeClosablePage(closed = false): { closeCalls: number; page: Page } {
  let isClosed = closed;
  let closeCalls = 0;
  const fake: Pick<Page, "close" | "isClosed"> = {
    close: () => {
      closeCalls++;
      isClosed = true;
      return Promise.resolve();
    },
    isClosed: () => isClosed,
  };
  return {
    get closeCalls() {
      return closeCalls;
    },
    page: fake as Page,
  };
}

test("closeBrowserContextPagesExcept closes stale open pages while keeping the working page alive", async () => {
  const first = makeClosablePage(false);
  const alreadyClosed = makeClosablePage(true);
  const working = makeClosablePage(false);

  const closedCount = await closeBrowserContextPagesExcept(
    {
      pages: () => [first.page, alreadyClosed.page, working.page],
    },
    working.page
  );

  assert.equal(closedCount, 1);
  assert.equal(first.closeCalls, 1);
  assert.equal(alreadyClosed.closeCalls, 0);
  assert.equal(working.closeCalls, 0);
});

test("closeBrowserPage closes the runtime-owned working page best-effort", async () => {
  const working = makeClosablePage(false);

  assert.equal(await closeBrowserPage(working.page), true);
  assert.equal(working.closeCalls, 1);
  assert.equal(await closeBrowserPage(working.page), false);
  assert.equal(working.closeCalls, 1);
});

test("closeBrowserPage ignores remote target cleanup errors", async () => {
  let closeCalls = 0;
  const page = {
    close: () => {
      closeCalls++;
      return Promise.reject(new Error("Target page has been closed"));
    },
    isClosed: () => false,
  };

  assert.equal(await closeBrowserPage(page), false);
  assert.equal(closeCalls, 1);
});

test("closeBrowserPage abandons a wedged remote target close after the deadline", async () => {
  let closeCalls = 0;
  const page = {
    close: () => {
      closeCalls++;
      return new Promise<never>(() => undefined);
    },
    isClosed: () => false,
  };

  const startedAt = Date.now();
  assert.equal(await closeBrowserPage(page, 20), false);
  assert.equal(closeCalls, 1);
  assert.ok(Date.now() - startedAt < 1000);
});

test("resolveBrowserRuntimeVisibility defaults browser connectors to headless unless env disables it", () => {
  assert.deepEqual(resolveBrowserRuntimeVisibility({}, "reddit", {}), {
    envKey: "PDPP_REDDIT_HEADLESS",
    headless: true,
    profileName: "reddit",
  });

  assert.deepEqual(resolveBrowserRuntimeVisibility({}, "reddit", { PDPP_REDDIT_HEADLESS: "0" }), {
    envKey: "PDPP_REDDIT_HEADLESS",
    headless: false,
    profileName: "reddit",
  });
});

test("resolveBrowserRuntimeVisibility honors explicit profile names", () => {
  assert.deepEqual(resolveBrowserRuntimeVisibility({ profileName: "chatgpt" }, "ignored", {}), {
    envKey: "PDPP_CHATGPT_HEADLESS",
    headless: true,
    profileName: "chatgpt",
  });
});

test("resolveBrowserLaunchSource prefers managed n.eko lease env over legacy profile CDP env", () => {
  assert.deepEqual(
    resolveBrowserLaunchSource(
      { profileName: "chatgpt" },
      {
        PDPP_BROWSER_SURFACE_REQUIRED: "neko",
        PDPP_BROWSER_SURFACE_LEASE_ID: "lease_123",
        PDPP_BROWSER_SURFACE_PROFILE_KEY: "chatgpt:owner",
        PDPP_BROWSER_SURFACE_REMOTE_CDP_URL: "http://managed-neko:9223",
        PDPP_CHATGPT_REMOTE_CDP_URL: "http://legacy-dev:9223",
      }
    ),
    {
      kind: "managed_neko",
      leaseId: "lease_123",
      profileKey: "chatgpt:owner",
      remoteCdpUrl: "http://managed-neko:9223",
    } satisfies BrowserLaunchSource
  );
});

test("resolveBrowserLaunchSource fails closed for required n.eko without managed CDP URL", () => {
  assert.throws(
    () =>
      resolveBrowserLaunchSource(
        { profileName: "chatgpt" },
        {
          PDPP_BROWSER_SURFACE_REQUIRED: "neko",
          PDPP_CHATGPT_REMOTE_CDP_URL: "http://legacy-dev:9223",
        }
      ),
    /PDPP_BROWSER_SURFACE_REQUIRED=neko.*PDPP_BROWSER_SURFACE_REMOTE_CDP_URL is missing/u
  );
});

test("resolveBrowserLaunchSource keeps unmanaged per-profile CDP env as a dev override", () => {
  assert.deepEqual(
    resolveBrowserLaunchSource(
      { profileName: "chatgpt" },
      {
        PDPP_CHATGPT_REMOTE_CDP_URL: "http://legacy-dev:9223",
      }
    ),
    {
      envKey: "PDPP_CHATGPT_REMOTE_CDP_URL",
      kind: "legacy_remote_cdp",
      remoteCdpUrl: "http://legacy-dev:9223",
    } satisfies BrowserLaunchSource
  );
});

test("resolveBrowserLaunchSource falls back to isolated local launch only when no remote surface applies", () => {
  assert.deepEqual(resolveBrowserLaunchSource({ profileName: "chatgpt" }, {}), {
    kind: "isolated_local",
  } satisfies BrowserLaunchSource);
});

test("decorateBrowserManualAction appends recovery copy for headless browser runs", () => {
  const decorated = decorateBrowserManualAction(MANUAL_ACTION, HEADLESS);

  assert.notEqual(decorated, MANUAL_ACTION);
  // The decoration should point operators at the streaming companion as the
  // primary path, with the headless-rerun env var as the alternative.
  assert.match(decorated.message, /streaming companion/iu);
  assert.match(decorated.message, /PDPP_REDDIT_HEADLESS=0/u);
});

test("decorateBrowserManualAction leaves non-manual interactions unchanged", () => {
  const otp: InteractionRequest = {
    kind: "otp",
    message: "Enter the verification code.",
  };

  assert.equal(decorateBrowserManualAction(otp, HEADLESS), otp);
});

test("decorateBrowserManualAction leaves visible-browser-capable runs unchanged", () => {
  assert.equal(decorateBrowserManualAction(MANUAL_ACTION, { ...HEADLESS, headless: false }), MANUAL_ACTION);
});

test("decorateBrowserManualAction does not duplicate existing recovery copy", () => {
  const alreadyActionable: InteractionRequest = {
    kind: "manual_action",
    message: "If it is headless, cancel this interaction and rerun headed with PDPP_USAA_HEADLESS=0.",
    timeout_seconds: 1800,
  };

  assert.equal(decorateBrowserManualAction(alreadyActionable, HEADLESS), alreadyActionable);
});

test("makeBrowserInteractionKeepalive sends browser-level CDP pings while interaction is pending", async () => {
  let pingCalls = 0;
  let detachCalls = 0;
  const context = makeKeepaliveContext({
    isConnected: () => true,
    newBrowserCDPSession: () =>
      Promise.resolve({
        detach: () => {
          detachCalls++;
          return Promise.resolve();
        },
        send: (method: string) => {
          assert.equal(method, "Browser.getVersion");
          pingCalls++;
          return Promise.resolve({});
        },
      }),
  });
  let resolveInteraction:
    | ((value: { request_id: string; status: "success"; type: "INTERACTION_RESPONSE" }) => void)
    | undefined;
  const wrapped = makeBrowserInteractionKeepalive({
    context,
    intervalMs: 5,
    sendInteraction: (req) =>
      new Promise((resolve) => {
        resolveInteraction = resolve;
        assert.equal(req.kind, "otp");
      }),
  });

  const responsePromise = wrapped({ kind: "otp", message: "Enter OTP" });
  await delay(20);
  assert.ok(pingCalls > 0, "expected Browser.getVersion CDP pings while waiting");

  resolveInteraction?.({ request_id: "int_test", status: "success", type: "INTERACTION_RESPONSE" });
  assert.equal((await responsePromise).status, "success");
  await delay(5);
  assert.equal(detachCalls, 1);
  const callsAfterResponse = pingCalls;
  await delay(20);
  assert.equal(pingCalls, callsAfterResponse);
});

test("makeBrowserInteractionKeepalive stops after interaction errors", async () => {
  let pingCalls = 0;
  let detachCalls = 0;
  const wrapped = makeBrowserInteractionKeepalive({
    context: makeKeepaliveContext({
      isConnected: () => true,
      newBrowserCDPSession: () =>
        Promise.resolve({
          detach: () => {
            detachCalls++;
            return Promise.resolve();
          },
          send: () => {
            pingCalls++;
            return Promise.resolve({});
          },
        }),
    }),
    intervalMs: 5,
    sendInteraction: async () => {
      await delay(15);
      throw new Error("interaction_failed");
    },
  });

  await assert.rejects(() => wrapped({ kind: "manual_action", message: "Continue in browser" }), /interaction_failed/u);
  await delay(5);
  assert.equal(detachCalls, 1);
  const callsAfterError = pingCalls;
  await delay(20);
  assert.equal(pingCalls, callsAfterError);
});

test("makeBrowserInteractionKeepalive skips pings when browser is already disconnected", async () => {
  let newSessionCalls = 0;
  const wrapped = makeBrowserInteractionKeepalive({
    context: makeKeepaliveContext({
      isConnected: () => false,
      newBrowserCDPSession: () => {
        newSessionCalls++;
        return Promise.resolve({
          detach: () => Promise.resolve(),
          send: () => Promise.resolve({}),
        });
      },
    }),
    intervalMs: 5,
    sendInteraction: async (req) => ({
      request_id: req.request_id ?? "int_test",
      status: "success",
      type: "INTERACTION_RESPONSE",
    }),
  });

  assert.equal((await wrapped({ kind: "otp", message: "Enter OTP" })).status, "success");
  await delay(10);
  assert.equal(newSessionCalls, 0);
});

test("makeBrowserInteractionKeepalive ignores CDP ping errors without failing interaction", async () => {
  let pingCalls = 0;
  const wrapped = makeBrowserInteractionKeepalive({
    context: makeKeepaliveContext({
      isConnected: () => true,
      newBrowserCDPSession: () =>
        Promise.resolve({
          detach: () => Promise.resolve(),
          send: () => {
            pingCalls++;
            return Promise.reject(new Error("cdp_unavailable"));
          },
        }),
    }),
    intervalMs: 5,
    sendInteraction: async (req) =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              request_id: req.request_id ?? "int_test",
              status: "success",
              type: "INTERACTION_RESPONSE",
            }),
          15
        )
      ),
  });

  assert.equal((await wrapped({ kind: "otp", message: "Enter OTP" })).status, "success");
  assert.ok(pingCalls > 0);
});

test("makeBrowserInteractionKeepalive emits gated browser-surface diagnostics around interactions", async () => {
  const progressMessages: string[] = [];
  let resolveInteraction:
    | ((value: { request_id: string; status: "success"; type: "INTERACTION_RESPONSE" }) => void)
    | undefined;
  const wrapped = makeBrowserInteractionKeepalive({
    context: makeKeepaliveContext(
      {
        isConnected: () => true,
        newBrowserCDPSession: () =>
          Promise.resolve({
            detach: () => Promise.resolve(),
            send: () => Promise.resolve({}),
          }),
      },
      [makeDiagnosticPage("https://secure.chase.com/web/auth/?secret=redacted")]
    ),
    diagnostics: true,
    intervalMs: 5,
    progress: (message) => {
      progressMessages.push(message);
      return Promise.resolve();
    },
    sendInteraction: (req) =>
      new Promise((resolve) => {
        assert.equal(req.kind, "otp");
        resolveInteraction = resolve;
      }),
  });

  const responsePromise = wrapped({ kind: "otp", message: "Enter OTP", request_id: "int_test" });
  await delay(15);
  resolveInteraction?.({ request_id: "int_test", status: "success", type: "INTERACTION_RESPONSE" });
  assert.equal((await responsePromise).status, "success");

  assert.equal(progressMessages.length, 2);
  const diagnostics = progressMessages.map((message) => {
    assert.match(message, /^browser_surface\.diagnostic /u);
    return JSON.parse(message.replace(/^browser_surface\.diagnostic /u, "")) as {
      keepalive: null | { pingAttempts: number; pingSuccesses: number };
      phase: string;
      response_status: string | null;
      surface: { pages: Array<{ url: string | null }> };
    };
  });
  assert.equal(diagnostics[0]?.phase, "interaction_start");
  assert.equal(diagnostics[0]?.keepalive, null);
  assert.equal(diagnostics[1]?.phase, "interaction_response");
  assert.equal(diagnostics[1]?.response_status, "success");
  assert.ok((diagnostics[1]?.keepalive?.pingAttempts ?? 0) > 0);
  assert.equal(diagnostics[1]?.surface.pages[0]?.url, "https://secure.chase.com/web/auth/");
});

test("makeBrowserInteractionKeepalive records browser disconnect timing in diagnostics", async () => {
  const progressMessages: string[] = [];
  let connected = true;
  let disconnectedListener: (() => void) | undefined;
  let detachCalls = 0;
  const browser: KeepaliveTestBrowser = {
    isConnected: () => connected,
    newBrowserCDPSession: () =>
      Promise.resolve({
        detach: () => {
          detachCalls++;
          return Promise.resolve();
        },
        send: () => Promise.resolve({}),
      }),
    off: (_event, listener) => {
      if (disconnectedListener === listener) {
        disconnectedListener = undefined;
      }
      return browser;
    },
    on: (_event, listener) => {
      disconnectedListener = listener;
      return browser;
    },
  };
  const wrapped = makeBrowserInteractionKeepalive({
    context: makeKeepaliveContext(browser),
    diagnostics: true,
    intervalMs: 5,
    progress: (message) => {
      progressMessages.push(message);
      return Promise.resolve();
    },
    sendInteraction: async (req) =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              request_id: req.request_id ?? "int_test",
              status: "success",
              type: "INTERACTION_RESPONSE",
            }),
          35
        )
      ),
  });

  const responsePromise = wrapped({ kind: "otp", message: "Enter OTP", request_id: "int_test" });
  await delay(10);
  connected = false;
  const listener = disconnectedListener;
  if (!listener) {
    assert.fail("expected keepalive to attach a browser disconnected listener");
  }
  listener();
  assert.equal((await responsePromise).status, "success");

  const responseDiagnostic = JSON.parse(
    progressMessages.at(-1)?.replace(/^browser_surface\.diagnostic /u, "") ?? "{}"
  ) as {
    keepalive?: {
      browserConnectedAtStop: boolean;
      disconnectEventCount: number;
      disconnectEventElapsedMs?: number;
      firstObservedDisconnectedElapsedMs?: number;
      lastSuccessfulPingElapsedMs?: number;
    };
  };
  assert.equal(responseDiagnostic.keepalive?.browserConnectedAtStop, false);
  assert.equal(responseDiagnostic.keepalive?.disconnectEventCount, 1);
  assert.equal(typeof responseDiagnostic.keepalive?.disconnectEventElapsedMs, "number");
  assert.equal(typeof responseDiagnostic.keepalive?.firstObservedDisconnectedElapsedMs, "number");
  assert.equal(typeof responseDiagnostic.keepalive?.lastSuccessfulPingElapsedMs, "number");
  assert.equal(detachCalls, 1);
  assert.equal(disconnectedListener, undefined);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeFakeCapture(): {
  captureDomCalls: { label: string; closed: boolean }[];
  session: CaptureSession;
} {
  const captureDomCalls: { label: string; closed: boolean }[] = [];
  const session: CaptureSession = {
    baseDir: "/tmp/fake-capture",
    keepOnSuccess: false,
    runId: "fake-run",
    captureDom: (page, label) => {
      captureDomCalls.push({ label, closed: page.isClosed() });
      return Promise.resolve();
    },
    captureHttp: () => {
      /* no-op */
    },
    finalize: () => {
      /* no-op */
    },
    markSucceeded: () => {
      /* no-op */
    },
    recordRecord: () => {
      /* no-op */
    },
  };
  return { captureDomCalls, session };
}

test("captureBrowserPage skips capture when the page is already closed", async () => {
  const { captureDomCalls, session } = makeFakeCapture();
  const closedPage = {
    isClosed: () => true,
  } as Page;

  await captureBrowserPage(session, closedPage, "runtime-error");

  assert.equal(captureDomCalls.length, 0);
});

test("captureBrowserPage forwards live pages to capture.captureDom", async () => {
  const { captureDomCalls, session } = makeFakeCapture();
  const livePage = {
    isClosed: () => false,
  } as Page;

  await captureBrowserPage(session, livePage, "runtime-collect-start");

  assert.deepEqual(captureDomCalls, [{ label: "runtime-collect-start", closed: false }]);
});

test("captureBrowserPage no-ops when capture session is null", async () => {
  await captureBrowserPage(null, { isClosed: () => false } as Page, "label");
  // Reaching here without throw is the assertion.
});

type DisconnectableBrowser = Pick<NonNullable<ReturnType<BrowserContext["browser"]>>, "isConnected">;
interface DisconnectableContext {
  browser: () => DisconnectableBrowser | null;
}

test("isContextDisconnected reports disconnected when browser.isConnected() returns false", () => {
  const ctx: DisconnectableContext = {
    browser: () => ({ isConnected: () => false }) as DisconnectableBrowser,
  };
  assert.equal(isContextDisconnected(ctx as Pick<BrowserContext, "browser">), true);
});

test("isContextDisconnected reports connected when browser.isConnected() returns true", () => {
  const ctx: DisconnectableContext = {
    browser: () => ({ isConnected: () => true }) as DisconnectableBrowser,
  };
  assert.equal(isContextDisconnected(ctx as Pick<BrowserContext, "browser">), false);
});

test("isContextDisconnected treats missing browser as connected (best-effort fallback)", () => {
  const ctx: DisconnectableContext = {
    browser: () => null,
  };
  assert.equal(isContextDisconnected(ctx as Pick<BrowserContext, "browser">), false);
});

test("isContextDisconnected treats throwing bridges as disconnected", () => {
  const ctx: DisconnectableContext = {
    browser: () => {
      throw new Error("ipc lost");
    },
  };
  assert.equal(isContextDisconnected(ctx as Pick<BrowserContext, "browser">), true);
});

interface FakeTracingShape {
  start: (options: { name: string }) => Promise<void>;
  startChunk?: (options?: { title?: string }) => Promise<void>;
  stop: (options?: { path?: string }) => Promise<void>;
  stopChunk?: (options?: { path?: string }) => Promise<void>;
}

function makeTracingContext(tracing: FakeTracingShape, browser: { isConnected: () => boolean } | null): BrowserContext {
  // BrowserContext has dozens of methods we don't need for the trace
  // lifecycle test. Cast through the structurally-sufficient subset.
  const partial: Pick<BrowserContext, "browser" | "tracing"> = {
    browser: () => browser as ReturnType<BrowserContext["browser"]>,
    tracing: tracing as BrowserContext["tracing"],
  };
  return partial as BrowserContext;
}

test("makeTracer.stop() short-circuits when the browser is already disconnected", async () => {
  const previousFixtures = process.env.PDPP_CAPTURE_FIXTURES;
  const previousOnFailure = process.env.PDPP_CAPTURE_ON_FAILURE;
  const previousTrace = process.env.PDPP_TRACE;
  process.env.PDPP_TRACE = "1";
  delete process.env.PDPP_CAPTURE_FIXTURES;
  delete process.env.PDPP_CAPTURE_ON_FAILURE;
  try {
    let stopCalled = false;
    let stopChunkCalled = false;
    const tracing: FakeTracingShape = {
      start: () => Promise.resolve(),
      startChunk: () => Promise.resolve(),
      stop: () => {
        stopCalled = true;
        return Promise.reject(new Error("Target page, context or browser has been closed"));
      },
      stopChunk: () => {
        stopChunkCalled = true;
        return Promise.resolve();
      },
    };
    let connected = true;
    const ctx = makeTracingContext(tracing, { isConnected: () => connected });
    const tracer = makeTracer(ctx, "fake-connector", null);
    await tracer.start();
    // Now the browser drops.
    connected = false;
    // stop() should not reach tracing.stop() / tracing.stopChunk() — they
    // would throw and the disconnect guard prevents the noisy Playwright
    // error from surfacing.
    await tracer.stop();
    assert.equal(stopCalled, false);
    assert.equal(stopChunkCalled, false);
  } finally {
    if (previousFixtures === undefined) {
      delete process.env.PDPP_CAPTURE_FIXTURES;
    } else {
      process.env.PDPP_CAPTURE_FIXTURES = previousFixtures;
    }
    if (previousOnFailure === undefined) {
      delete process.env.PDPP_CAPTURE_ON_FAILURE;
    } else {
      process.env.PDPP_CAPTURE_ON_FAILURE = previousOnFailure;
    }
    if (previousTrace === undefined) {
      delete process.env.PDPP_TRACE;
    } else {
      process.env.PDPP_TRACE = previousTrace;
    }
  }
});

test("makeTracer.stop() is idempotent — second call does not retry against a disconnected context", async () => {
  const previousTrace = process.env.PDPP_TRACE;
  process.env.PDPP_TRACE = "1";
  try {
    let stopCallCount = 0;
    const tracing: FakeTracingShape = {
      start: () => Promise.resolve(),
      startChunk: () => Promise.resolve(),
      stop: () => {
        stopCallCount += 1;
        return Promise.resolve();
      },
      stopChunk: () => Promise.resolve(),
    };
    const ctx = makeTracingContext(tracing, { isConnected: () => true });
    const tracer = makeTracer(ctx, "idempotent", null);
    await tracer.start();
    await tracer.stop();
    await tracer.stop();
    assert.equal(stopCallCount, 1);
  } finally {
    if (previousTrace === undefined) {
      delete process.env.PDPP_TRACE;
    } else {
      process.env.PDPP_TRACE = previousTrace;
    }
  }
});
