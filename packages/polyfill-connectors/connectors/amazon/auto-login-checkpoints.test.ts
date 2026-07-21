/**
 * Amazon auto-login session-establishment checkpoint coverage.
 *
 * The session-establishment watchdog keys on checkpoint progress. This test
 * proves `ensureAmazonSession` invokes the checkpoint hook at each auth phase
 * (probe, sign-in loaded, email submit, password submit, 2FA decision, final
 * verify) so a hang at any phase resets/observes the watchdog and leaves a
 * phase-labelled diagnostic instead of only an about:blank artifact.
 *
 * No real Playwright and no live Amazon: a scripted fake page walks the
 * non-2FA happy path (login form renders, fields fill, final probe succeeds).
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { BrowserContext, Locator, Page } from "playwright";

import { ensureAmazonSession } from "../../src/auto-login/amazon.ts";
import type { InteractionRequest, InteractionResponse } from "../../src/connector-runtime.ts";

// ensureAmazonSession's context arg is unused (`_context`); a bare object
// single-cast is the established pattern for this in-package test surface.
const fakeContext = {} as BrowserContext;

// A fake locator that reports one visible, fillable element. `inputValue`
// returns "" so the email step always fills. `innerText` returns "" so the
// 2FA prompt text never matches (non-2FA path).
//
// The sign-in form locator (`form[name="signIn"]`) is special: probeAmazonSession
// returns true only when that form is NOT visible, so on the orders page it must
// report not-visible. We key on the selector substring to model that.
type FakeLocatorShape = Pick<
  Locator,
  "click" | "count" | "fill" | "first" | "innerText" | "inputValue" | "isVisible" | "nth" | "waitFor"
>;

function makeFakeLocator(selector: string): Locator {
  const isSignInForm = selector.includes('form[name="signIn"]');
  const shape: FakeLocatorShape = {
    // first/nth return the same locator; assigned after the single cast below.
    first: () => locator,
    nth: () => locator,
    count: () => Promise.resolve(1),
    // The sign-in form is "not visible" so the session probe treats a
    // non-signin URL as a live session; all other locators are visible so
    // fillWhenVisible succeeds immediately.
    isVisible: () => Promise.resolve(!isSignInForm),
    fill: () => Promise.resolve(),
    click: () => Promise.resolve(),
    inputValue: () => Promise.resolve(""),
    innerText: () => Promise.resolve(""),
    waitFor: () => Promise.resolve(),
  };
  const locator = shape as Locator;
  return locator;
}

// A fake page whose `url()` walks a scripted sequence so probeAmazonSession
// returns false on the first (pre-login) probe and true on the final probe.
// `goto` advances the URL state; everything else is inert + fast.
interface FakePageState {
  idx: number;
  urls: string[];
}

// ensureAmazonSession + its helpers only touch goto/locator/url/waitForTimeout
// (verified by `grep -oE "page\.[a-zA-Z]+" amazon.ts`). Capture is null in
// these tests, so the capture path's content/title/screenshot are never reached.
type FakePageShape = Pick<Page, "goto" | "locator" | "url" | "waitForTimeout">;

function makeFakePage(state: FakePageState): Page {
  const page: FakePageShape = {
    url: () => state.urls[Math.min(state.idx, state.urls.length - 1)] ?? "about:blank",
    goto: () => {
      // Each navigation advances to the next scripted URL (clamped).
      state.idx = Math.min(state.idx + 1, state.urls.length - 1);
      return Promise.resolve(null);
    },
    waitForTimeout: () => Promise.resolve(),
    locator: (selector: string) => makeFakeLocator(selector) as ReturnType<Page["locator"]>,
  };
  return page as Page;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.AMAZON_USERNAME = "owner@example.test";
  process.env.AMAZON_PASSWORD = "correct-horse";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

test("ensureAmazonSession invokes the checkpoint hook at each auth phase (non-2FA path)", async () => {
  // URL sequence:
  //   [0] start (about:blank)
  //   [1] probeAmazonSession initial goto -> sign-in URL (probe returns false)
  //   [2] ensureAmazonSession login goto -> sign-in URL
  //   [3] final probeAmazonSession goto -> orders URL (probe returns true)
  const state: FakePageState = {
    urls: [
      "about:blank",
      "https://www.amazon.com/ap/signin",
      "https://www.amazon.com/ap/signin",
      "https://www.amazon.com/your-orders/orders",
    ],
    idx: 0,
  };
  const page = makeFakePage(state);

  const checkpoints: string[] = [];
  const checkpoint = (label: string): Promise<void> => {
    checkpoints.push(label);
    return Promise.resolve();
  };

  // No interaction is needed on the non-2FA happy path; if one is requested,
  // succeed so the flow proceeds (keeps the test from hanging on a real wait).
  const sendInteraction = (req: InteractionRequest): Promise<InteractionResponse> =>
    Promise.resolve({
      type: "INTERACTION_RESPONSE",
      request_id: req.request_id ?? "x",
      status: "success",
      data: { code: "123456" },
    });

  const ok = await ensureAmazonSession({
    capture: null,
    checkpoint,
    context: fakeContext,
    page,
    sendInteraction,
  });

  assert.equal(ok, true);
  // The required phase checkpoints, in order. The flow may add others
  // (e.g. amazon-session-already-live is NOT expected here since the first
  // probe fails); assert the auth-phase set is present and ordered.
  const expectedOrder = [
    "amazon-auth-probe",
    "amazon-signin-loaded",
    "amazon-email-submit",
    "amazon-password-submit",
    "amazon-2fa-decision",
    "amazon-final-verify",
  ];
  for (const label of expectedOrder) {
    assert.ok(checkpoints.includes(label), `missing checkpoint: ${label} (saw: ${checkpoints.join(", ")})`);
  }
  // Verify relative ordering of the required phases.
  const positions = expectedOrder.map((l) => checkpoints.indexOf(l));
  for (let i = 1; i < positions.length; i++) {
    assert.ok(
      (positions[i] ?? -1) > (positions[i - 1] ?? -1),
      `checkpoint ${expectedOrder[i]} should come after ${expectedOrder[i - 1]}`
    );
  }
});

test("ensureAmazonSession checkpoints the auth probe even when the session is already live", async () => {
  // First probe succeeds immediately (already authenticated): the flow should
  // still mark the auth-probe phase, then short-circuit with a live-session
  // checkpoint.
  const state: FakePageState = {
    urls: ["about:blank", "https://www.amazon.com/your-orders/orders"],
    idx: 0,
  };
  const page = makeFakePage(state);
  const checkpoints: string[] = [];
  const checkpoint = (label: string): Promise<void> => {
    checkpoints.push(label);
    return Promise.resolve();
  };

  const ok = await ensureAmazonSession({
    capture: null,
    checkpoint,
    context: fakeContext,
    page,
    sendInteraction: (req) =>
      Promise.resolve({ type: "INTERACTION_RESPONSE", request_id: req.request_id ?? "x", status: "success" }),
  });

  assert.equal(ok, true);
  assert.equal(checkpoints[0], "amazon-auth-probe");
  assert.ok(checkpoints.includes("amazon-session-already-live"));
  // It must NOT have proceeded into the login form phases.
  assert.equal(checkpoints.includes("amazon-email-submit"), false);
});

test("ensureAmazonSession defaults the checkpoint hook to a no-op when omitted", async () => {
  // Existing callers (and the runtime fallback) may omit checkpoint; the
  // function must not throw on the no-op default.
  const state: FakePageState = {
    urls: ["about:blank", "https://www.amazon.com/your-orders/orders"],
    idx: 0,
  };
  const page = makeFakePage(state);
  const ok = await ensureAmazonSession({
    capture: null,
    context: fakeContext,
    page,
    sendInteraction: (req) =>
      Promise.resolve({ type: "INTERACTION_RESPONSE", request_id: req.request_id ?? "x", status: "success" }),
  });
  assert.equal(ok, true);
});
