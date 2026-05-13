import assert from "node:assert/strict";
import test from "node:test";
import {
  type BrowserLaunchSource,
  type BrowserRuntimeVisibility,
  decorateBrowserManualAction,
  type InteractionRequest,
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
