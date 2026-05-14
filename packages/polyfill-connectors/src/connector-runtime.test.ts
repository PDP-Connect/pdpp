import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext } from "playwright";
import {
  type BrowserLaunchSource,
  type BrowserRuntimeVisibility,
  decorateBrowserManualAction,
  type InteractionRequest,
  makeBrowserInteractionKeepalive,
  resolveBrowserLaunchSource,
  resolveBrowserRuntimeVisibility,
} from "./connector-runtime.ts";

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
}

function makeKeepaliveContext(browser: KeepaliveTestBrowser): Pick<BrowserContext, "browser"> {
  return {
    browser: () => browser as ReturnType<BrowserContext["browser"]>,
  };
}

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
