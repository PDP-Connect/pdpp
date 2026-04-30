import assert from "node:assert/strict";
import test from "node:test";
import {
  type BrowserRuntimeVisibility,
  decorateBrowserManualAction,
  type InteractionRequest,
  resolveBrowserRuntimeVisibility,
} from "./connector-runtime.ts";

const HEADLESS_NO_BRIDGE: BrowserRuntimeVisibility = {
  envKey: "PDPP_REDDIT_HEADLESS",
  headless: true,
  hostBridgeConfigured: false,
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
    hostBridgeConfigured: false,
    profileName: "reddit",
  });

  assert.deepEqual(resolveBrowserRuntimeVisibility({}, "reddit", { PDPP_REDDIT_HEADLESS: "0" }), {
    envKey: "PDPP_REDDIT_HEADLESS",
    headless: false,
    hostBridgeConfigured: false,
    profileName: "reddit",
  });
});

test("resolveBrowserRuntimeVisibility detects bridge configuration and explicit profile names", () => {
  assert.deepEqual(
    resolveBrowserRuntimeVisibility({ profileName: "chatgpt" }, "ignored", {
      PDPP_HOST_BROWSER_BRIDGE_TOKEN: "token",
      PDPP_HOST_BROWSER_BRIDGE_URL: "ws://host.docker.internal:7670",
    }),
    {
      envKey: "PDPP_CHATGPT_HEADLESS",
      headless: true,
      hostBridgeConfigured: true,
      profileName: "chatgpt",
    }
  );
});

test("decorateBrowserManualAction appends recovery copy for headless browser runs without a bridge", () => {
  const decorated = decorateBrowserManualAction(MANUAL_ACTION, HEADLESS_NO_BRIDGE);

  assert.notEqual(decorated, MANUAL_ACTION);
  assert.match(decorated.message, /headless browser/iu);
  assert.match(decorated.message, /PDPP_REDDIT_HEADLESS=0/u);
  assert.match(decorated.message, /PDPP_HOST_BROWSER_BRIDGE_URL/u);
  assert.match(decorated.message, /PDPP_HOST_BROWSER_BRIDGE_TOKEN/u);
});

test("decorateBrowserManualAction leaves non-manual interactions unchanged", () => {
  const otp: InteractionRequest = {
    kind: "otp",
    message: "Enter the verification code.",
  };

  assert.equal(decorateBrowserManualAction(otp, HEADLESS_NO_BRIDGE), otp);
});

test("decorateBrowserManualAction leaves visible-browser-capable runs unchanged", () => {
  assert.equal(decorateBrowserManualAction(MANUAL_ACTION, { ...HEADLESS_NO_BRIDGE, headless: false }), MANUAL_ACTION);
  assert.equal(
    decorateBrowserManualAction(MANUAL_ACTION, { ...HEADLESS_NO_BRIDGE, hostBridgeConfigured: true }),
    MANUAL_ACTION
  );
});

test("decorateBrowserManualAction does not duplicate existing recovery copy", () => {
  const alreadyActionable: InteractionRequest = {
    kind: "manual_action",
    message: "If it is headless, cancel this interaction and rerun headed with PDPP_USAA_HEADLESS=0.",
    timeout_seconds: 1800,
  };

  assert.equal(decorateBrowserManualAction(alreadyActionable, HEADLESS_NO_BRIDGE), alreadyActionable);
});
