// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContext, Locator, Page } from "playwright";
import type { InteractionRequest, InteractionResponse } from "../connector-runtime.ts";
import { classifyChaseBrowserSurface, ensureChaseSession, probeChaseSession } from "./chase.ts";

const DASHBOARD_URL = "https://secure.chase.com/web/auth/dashboard";
const STREAMING_ENV_KEYS = [
  "PDPP_RUN_ID",
  "PDPP_REFERENCE_BASE_URL",
  "PDPP_STREAMING_REGISTRATION_TOKEN",
  "PDPP_LOCAL_DEVICE_TOKEN",
] as const;

interface FakePage {
  gotoCalls: string[];
  page: Page;
}

function makeTextLocator(visible: boolean): Locator {
  const waitable: Pick<Locator, "waitFor"> = {
    waitFor(): Promise<void> {
      return visible ? Promise.resolve() : Promise.reject(new Error("not visible"));
    },
  };
  const locator: Pick<Locator, "first" | "waitFor"> = {
    first(): Locator {
      return waitable as Locator;
    },
    waitFor: waitable.waitFor,
  };
  return locator as Locator;
}

function makePage({ closed, loggedIn }: { closed: boolean; loggedIn: boolean }): FakePage {
  const gotoCalls: string[] = [];
  const fake: Pick<Page, "getByText" | "goto" | "isClosed"> = {
    getByText(_text: Parameters<Page["getByText"]>[0], _options?: Parameters<Page["getByText"]>[1]): Locator {
      return makeTextLocator(loggedIn);
    },
    goto(url: string, _options?: Parameters<Page["goto"]>[1]): ReturnType<Page["goto"]> {
      gotoCalls.push(url);
      return Promise.resolve(null);
    },
    isClosed(): boolean {
      return closed;
    },
  };
  return { gotoCalls, page: fake as Page };
}

function makeContext(pages: Page[], newPage: Page): BrowserContext {
  const fake: Pick<BrowserContext, "newPage" | "pages"> = {
    newPage(): Promise<Page> {
      return Promise.resolve(newPage);
    },
    pages(): Page[] {
      return pages;
    },
  };
  return fake as BrowserContext;
}

test("probeChaseSession opens a fresh page before probing when the OTP page was closed", async () => {
  const closed = makePage({ closed: true, loggedIn: false });
  const replacement = makePage({ closed: false, loggedIn: true });
  const context = makeContext([], replacement.page);

  const result = await probeChaseSession(context, closed.page);

  assert.equal(result.loggedIn, true);
  assert.equal(result.page, replacement.page);
  assert.deepEqual(closed.gotoCalls, []);
  assert.deepEqual(replacement.gotoCalls, [DASHBOARD_URL]);
});

test("probeChaseSession reuses an existing open page before creating a new one", async () => {
  const closed = makePage({ closed: true, loggedIn: false });
  const existing = makePage({ closed: false, loggedIn: true });
  const unusedNewPage = makePage({ closed: false, loggedIn: false });
  const context = makeContext([existing.page], unusedNewPage.page);

  const result = await probeChaseSession(context, closed.page);

  assert.equal(result.loggedIn, true);
  assert.equal(result.page, existing.page);
  assert.deepEqual(existing.gotoCalls, [DASHBOARD_URL]);
  assert.deepEqual(unusedNewPage.gotoCalls, []);
});

test("classifyChaseBrowserSurface distinguishes page close, context close, and browser disconnect", () => {
  const closedPage = makePage({ closed: true, loggedIn: false });
  const openPage = makePage({ closed: false, loggedIn: false });

  assert.equal(
    classifyChaseBrowserSurface(closedPage.page, {
      browserDisconnected: () => false,
      contextClosed: () => false,
    }),
    "page_closed"
  );
  assert.equal(
    classifyChaseBrowserSurface(openPage.page, {
      browserDisconnected: () => false,
      contextClosed: () => true,
    }),
    "context_closed"
  );
  assert.equal(
    classifyChaseBrowserSurface(openPage.page, {
      browserDisconnected: () => true,
      contextClosed: () => false,
    }),
    "browser_disconnected"
  );
  assert.equal(
    classifyChaseBrowserSurface(openPage.page, {
      browserDisconnected: () => false,
      contextClosed: () => false,
    }),
    "open"
  );
});

function makeLiveLocator(isLive: () => boolean): Locator {
  const fake: Pick<Locator, "first" | "waitFor"> = {
    first: (): Locator => fake as Locator,
    waitFor: (): Promise<void> =>
      isLive() ? Promise.resolve() : Promise.reject(new Error("Chase dashboard is not authenticated")),
  };
  return fake as Locator;
}

function makeLivePage(isLive: () => boolean): FakePage {
  const gotoCalls: string[] = [];
  const signOut = makeLiveLocator(isLive);
  const fake: Pick<Page, "getByText" | "goto" | "isClosed"> = {
    getByText: (): Locator => signOut,
    goto: (url: string, _options?: Parameters<Page["goto"]>[1]): ReturnType<Page["goto"]> => {
      gotoCalls.push(url);
      return Promise.resolve(null);
    },
    isClosed: (): boolean => false,
  };
  return { gotoCalls, page: fake as Page };
}

function makeLiveContext(page: Page): BrowserContext {
  const fake: Pick<BrowserContext, "browser" | "once" | "pages"> = {
    browser: () => null,
    once: ((_event: "close", _listener: () => void): BrowserContext =>
      fake as BrowserContext) as BrowserContext["once"],
    pages: (): Page[] => [page],
  };
  return fake as BrowserContext;
}

/**
 * Runs `run` with the streaming env cleared.
 *
 * This no longer touches `CHASE_USERNAME` / `CHASE_PASSWORD`: an absent
 * credential is now expressed by passing no `credentials` to
 * `ensureChaseSession`, not by mutating the process environment. That is the
 * point of the change — ambient state can no longer decide whether a login is
 * attempted, so a test cannot accidentally depend on it either.
 */
async function withoutChaseCredentials(run: () => Promise<void>): Promise<void> {
  const priorStreamingEnv = new Map<(typeof STREAMING_ENV_KEYS)[number], string | undefined>();
  for (const key of STREAMING_ENV_KEYS) {
    priorStreamingEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    await run();
  } finally {
    for (const key of STREAMING_ENV_KEYS) {
      const value = priorStreamingEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * A page that models the two facts OTP classification depends on: whether the
 * prompt copy is visible, and how many usable OTP inputs exist.
 *
 * Synthetic, not a real capture — no Chase auth-page markup exists on disk
 * (`connectors/chase/__fixtures__/` holds only post-login collector pages),
 * and the live site is off limits because it is the owner's real bank. The
 * selectors modelled here are copied from the module's own constants.
 */
interface FakeOtpPageState {
  /** Whether "Confirm Your Identity" is visible — the identity-challenge copy. */
  challengeTextVisible?: boolean;
  /** Whether the delivery-method option ("Get a text") is enabled. */
  deliveryOptionEnabled?: boolean;
  /** Whether the delivery-method option is present/visible at all. */
  deliveryOptionPresent?: boolean;
  /** Usable (visible + enabled) OTP inputs. 0 = the page cannot accept a code. */
  otpInputs: number;
  /** Whether OTP_PROMPT_TEXT_WITH_SENT matches something visible. */
  promptTextVisible: boolean;
  signedOut: boolean;
}

/**
 * Models the module's host-then-shadow OTP locator, including the chained
 * `.locator()` and `.or()` calls it builds. Visibility and count are read from
 * `state` at call time so a test can change the page mid-flow.
 */
function otpControlLocator(state: FakeOtpPageState, index: number): Locator {
  const usable = (): boolean => index < state.otpInputs;
  const fake: Pick<
    Locator,
    | "click"
    | "count"
    | "fill"
    | "first"
    | "isEnabled"
    | "isVisible"
    | "locator"
    | "nth"
    | "or"
    | "press"
    | "pressSequentially"
    | "waitFor"
  > = {
    click: (): Promise<void> => Promise.resolve(),
    count: (): Promise<number> => Promise.resolve(state.otpInputs),
    fill: (): Promise<void> => Promise.resolve(),
    first: (): Locator => otpControlLocator(state, 0),
    isEnabled: (): Promise<boolean> => Promise.resolve(usable()),
    isVisible: (): Promise<boolean> => Promise.resolve(usable()),
    // The shadow-root hop and the fallback union both resolve to the same
    // modelled inputs, matching the real selector's intent.
    locator: (): Locator => otpControlLocator(state, index),
    nth: (n: number): Locator => otpControlLocator(state, n),
    or: (): Locator => otpControlLocator(state, index),
    press: (): Promise<void> => Promise.resolve(),
    pressSequentially: (): Promise<void> => Promise.resolve(),
    waitFor: (): Promise<void> =>
      usable() ? Promise.resolve() : Promise.reject(new Error("chase otp input not visible")),
  };
  return fake as Locator;
}

/** A locator that matches nothing — used for every selector that is not OTP. */
function absentLocator(): Locator {
  const fake: Pick<
    Locator,
    | "check"
    | "click"
    | "count"
    | "fill"
    | "first"
    | "isChecked"
    | "isEnabled"
    | "isVisible"
    | "locator"
    | "nth"
    | "waitFor"
  > = {
    check: (): Promise<void> => Promise.resolve(),
    click: (): Promise<void> => Promise.resolve(),
    count: (): Promise<number> => Promise.resolve(0),
    fill: (): Promise<void> => Promise.resolve(),
    first: (): Locator => fake as Locator,
    isChecked: (): Promise<boolean> => Promise.resolve(false),
    isEnabled: (): Promise<boolean> => Promise.resolve(false),
    isVisible: (): Promise<boolean> => Promise.resolve(false),
    locator: (): Locator => fake as Locator,
    nth: (): Locator => fake as Locator,
    waitFor: (): Promise<void> => Promise.reject(new Error("absent")),
  };
  return fake as Locator;
}

/**
 * A locator whose visibility is read at call time, so a test can flip the
 * underlying state between classification and the prompt site.
 */
function textLocator(isVisible: () => boolean): Locator {
  const fake: Pick<Locator, "first" | "isVisible" | "waitFor"> = {
    first: (): Locator => fake as Locator,
    isVisible: (): Promise<boolean> => Promise.resolve(isVisible()),
    waitFor: (): Promise<void> => (isVisible() ? Promise.resolve() : Promise.reject(new Error("not visible"))),
  };
  return fake as Locator;
}

interface FakeOtpPage {
  /**
   * Clicks on the delivery-method option. Each one makes the real Chase send a
   * code to the owner's phone, so this — not the prompt count — is what a test
   * asserting "no dispatch" must check.
   */
  deliveryClicks: number;
  /**
   * Values typed into the sign-in form, keyed by field. Lets a test prove
   * WHICH account was signed in — the fact a process-global credential env var
   * structurally cannot distinguish between two connections.
   */
  filledValues: { password: string[]; username: string[] };
  gotoCalls: string[];
  page: Page;
  state: FakeOtpPageState;
}

/**
 * The delivery-method option ("Get a text"). Visibility and enabledness are
 * read from `state` at call time; a visible-but-disabled option is the case a
 * visibility-only guard would wrongly click.
 */
function deliveryOptionLocator(state: FakeOtpPageState, onClick: () => void): Locator {
  const present = (): boolean => state.deliveryOptionPresent ?? false;
  const fake: Pick<Locator, "click" | "count" | "first" | "isEnabled" | "isVisible" | "nth" | "waitFor"> = {
    click: (): Promise<void> => {
      onClick();
      return Promise.resolve();
    },
    count: (): Promise<number> => Promise.resolve(present() ? 1 : 0),
    first: (): Locator => fake as Locator,
    isEnabled: (): Promise<boolean> => Promise.resolve(present() && (state.deliveryOptionEnabled ?? true)),
    isVisible: (): Promise<boolean> => Promise.resolve(present()),
    nth: (): Locator => fake as Locator,
    waitFor: (): Promise<void> => (present() ? Promise.resolve() : Promise.reject(new Error("option absent"))),
  };
  return fake as Locator;
}

function isOtpSelector(selector: string): boolean {
  return selector.includes("otp") || selector.includes("one-time-code");
}

/**
 * Drives `ensureChaseSession` from the logon form through to the OTP step.
 * `onAfterClassification` fires once the login form has been submitted, which
 * is where a test can mutate the page out from under the connector.
 */
function makeOtpPage(
  init: FakeOtpPageState,
  { onAfterSignInClick }: { onAfterSignInClick?: (state: FakeOtpPageState) => void } = {}
): FakeOtpPage {
  const state: FakeOtpPageState = { ...init };
  const gotoCalls: string[] = [];
  let deliveryClicks = 0;
  const signInButton: Pick<Locator, "click" | "count" | "first"> = {
    click: (): Promise<void> => {
      onAfterSignInClick?.(state);
      return Promise.resolve();
    },
    count: (): Promise<number> => Promise.resolve(1),
    first: (): Locator => signInButton as Locator,
  };
  const filledValues: { password: string[]; username: string[] } = { password: [], username: [] };
  const makeCredentialField = (bucket: string[]): Locator => {
    const field: Pick<Locator, "fill" | "first" | "waitFor"> = {
      fill: (value: string): Promise<void> => {
        bucket.push(value);
        return Promise.resolve();
      },
      first: (): Locator => field as Locator,
      waitFor: (): Promise<void> => Promise.resolve(),
    };
    return field as Locator;
  };
  const usernameField = makeCredentialField(filledValues.username);
  const passwordField = makeCredentialField(filledValues.password);
  // `mds-button#next-content` → `.locator("button")` → `.first()`, the chain
  // `clickChaseNext` walks. Advancing past it is not itself a dispatch; the
  // dispatch already happened when the delivery option was clicked.
  const nextButtonInner: Pick<Locator, "click" | "count" | "first"> = {
    click: (): Promise<void> => Promise.resolve(),
    count: (): Promise<number> => Promise.resolve(1),
    first: (): Locator => nextButtonInner as Locator,
  };
  const nextButton = {
    locator: (): Locator => nextButtonInner as Locator,
  } as unknown as Locator;

  const fake: Pick<Page, "getByRole" | "getByText" | "goto" | "isClosed" | "locator"> = {
    getByRole: ((role: string): Locator => {
      // The delivery-method option is the only role-based control this flow
      // clicks, and clicking it is what dispatches a real code.
      if (role === "link") {
        return deliveryOptionLocator(state, (): void => {
          deliveryClicks += 1;
        });
      }
      return absentLocator();
    }) as Page["getByRole"],
    getByText: (text: Parameters<Page["getByText"]>[0]): Locator => {
      const source = text instanceof RegExp ? text.source : String(text);
      // The dashboard "Sign Out" probe: visible only once signed in.
      if (/Sign Out/i.test(source)) {
        return textLocator((): boolean => !state.signedOut);
      }
      // The identity-challenge method chooser. Off screen unless a test opts
      // in, so the existing OTP-surface tests are unaffected.
      if (/Confirm Your Identity/i.test(source)) {
        return textLocator((): boolean => state.challengeTextVisible ?? false);
      }
      // Anything else here is the OTP prompt copy.
      return textLocator((): boolean => state.promptTextVisible);
    },
    goto: (url: string): ReturnType<Page["goto"]> => {
      gotoCalls.push(url);
      return Promise.resolve(null);
    },
    isClosed: (): boolean => false,
    locator: (selector: string): Locator => {
      if (isOtpSelector(selector)) {
        return otpControlLocator(state, 0);
      }
      if (selector.includes("signin-button")) {
        return signInButton as Locator;
      }
      if (selector.includes("password")) {
        return passwordField;
      }
      if (selector.includes("userId") || selector.includes("username")) {
        return usernameField;
      }
      // The "Next" control that follows the method chooser. Present only when
      // the chooser is, matching Chase's real challenge page. Models the
      // module's `mds-button#next-content` → `button` shadow hop.
      if (selector.includes("next-content")) {
        return state.deliveryOptionPresent ? nextButton : absentLocator();
      }
      return absentLocator();
    },
  };
  return {
    get deliveryClicks(): number {
      return deliveryClicks;
    },
    filledValues,
    gotoCalls,
    page: fake as Page,
    state,
  };
}

function makeOtpContext(page: Page): BrowserContext {
  const fake: Pick<BrowserContext, "browser" | "once" | "pages"> = {
    browser: () => null,
    once: ((_event: "close", _listener: () => void): BrowserContext =>
      fake as BrowserContext) as BrowserContext["once"],
    pages: (): Page[] => [page],
  };
  return fake as BrowserContext;
}

/**
 * Chase's sign-in pair as the runtime hands it to `ensureSession`.
 *
 * Formerly this suite set `process.env.CHASE_USERNAME` / `_PASSWORD` around
 * each test. `ensureChaseSession` now takes the connection's credentials as an
 * argument (see `login-credentials.ts`), so the fixture is a plain object and
 * the tests no longer mutate global state to steer a login.
 */
const CHASE_TEST_CREDENTIALS = Object.freeze({
  CHASE_PASSWORD: "synthetic-password",
  CHASE_USERNAME: "synthetic-user",
});

async function withChaseCredentials(run: () => Promise<void>): Promise<void> {
  await run();
}

function recordingInteraction(
  requests: InteractionRequest[]
): (req: InteractionRequest) => Promise<InteractionResponse> {
  return (req: InteractionRequest): Promise<InteractionResponse> => {
    requests.push(req);
    return Promise.resolve({
      data: { code: "123456" },
      request_id: req.request_id ?? "test_interaction",
      status: "success",
      type: "INTERACTION_RESPONSE",
    });
  };
}

test("a page matching the OTP copy with no code input never asks the owner for a code", async () => {
  await withChaseCredentials(async () => {
    // The defect shape: "we sent" is visible, but nothing on the page can
    // accept a code. Chase dispatched nothing, so PDPP must demand nothing.
    const { page } = makeOtpPage({ otpInputs: 0, promptTextVisible: true, signedOut: true });
    const context = makeOtpContext(page);
    const requests: InteractionRequest[] = [];

    await assert.rejects(
      ensureChaseSession({
        context,
        credentials: CHASE_TEST_CREDENTIALS,
        page,
        sendInteraction: recordingInteraction(requests),
      }),
      /chase_login_incomplete_after_submit/
    );

    assert.deepEqual(
      requests.filter((req): boolean => req.kind === "otp"),
      [],
      "no OTP prompt may be emitted for a page that cannot accept a code"
    );
  });
});

test("a genuine code-entry page still prompts the owner for a code", async () => {
  await withChaseCredentials(async () => {
    // The regression guard: a real OTP screen must behave exactly as before.
    const { page, state } = makeOtpPage({ otpInputs: 1, promptTextVisible: true, signedOut: true });
    const context = makeOtpContext(page);
    const requests: InteractionRequest[] = [];

    const ok = await ensureChaseSession({
      context,
      credentials: CHASE_TEST_CREDENTIALS,
      page,
      sendInteraction: (req: InteractionRequest): Promise<InteractionResponse> => {
        requests.push(req);
        // Entering the code signs the session in, as the real flow does.
        state.signedOut = false;
        return Promise.resolve({
          data: { code: "123456" },
          request_id: req.request_id ?? "test_interaction",
          status: "success",
          type: "INTERACTION_RESPONSE",
        });
      },
    });

    assert.equal(ok, true);
    const otpRequests = requests.filter((req): boolean => req.kind === "otp");
    assert.equal(otpRequests.length, 1, "a real code-entry page must still prompt exactly once");
    assert.match(otpRequests[0]?.message ?? "", /Chase sent a 2FA code/);
  });
});

test("a split per-digit code layout still counts as a real code-entry page", async () => {
  await withChaseCredentials(async () => {
    const { page, state } = makeOtpPage({ otpInputs: 6, promptTextVisible: true, signedOut: true });
    const context = makeOtpContext(page);
    const requests: InteractionRequest[] = [];

    const ok = await ensureChaseSession({
      context,
      credentials: CHASE_TEST_CREDENTIALS,
      page,
      sendInteraction: (req: InteractionRequest): Promise<InteractionResponse> => {
        requests.push(req);
        state.signedOut = false;
        return Promise.resolve({
          data: { code: "123456" },
          request_id: req.request_id ?? "test_interaction",
          status: "success",
          type: "INTERACTION_RESPONSE",
        });
      },
    });

    assert.equal(ok, true);
    assert.equal(requests.filter((req): boolean => req.kind === "otp").length, 1);
  });
});

test("an OTP input that vanishes between classification and the prompt fails loudly instead of prompting", async () => {
  await withChaseCredentials(async () => {
    // Classification sees a usable input; Chase re-renders it away before the
    // prompt site is reached. The prompt-site re-check must catch that.
    const { page, state } = makeOtpPage({ otpInputs: 1, promptTextVisible: true, signedOut: true });
    const context = makeOtpContext(page);
    const requests: InteractionRequest[] = [];

    // Sequenced off the connector's own classification rather than a timer.
    // `isOnChaseOtpPage` reads the prompt copy only after it has confirmed a
    // usable input, so that read marks "classification decided: this is an OTP
    // page". Chase re-renders the input away at that instant, so the
    // prompt-site re-check must find nothing and the prompt must never fire.
    let classifications = 0;
    const guardedPage = new Proxy(page, {
      get(target: Page, prop: string | symbol, receiver: unknown): unknown {
        if (prop === "getByText") {
          return (text: Parameters<Page["getByText"]>[0]): Locator => {
            const resolved = target.getByText(text);
            const source = text instanceof RegExp ? text.source : String(text);
            if (/we sent/i.test(source)) {
              classifications += 1;
              if (classifications === 1) {
                state.otpInputs = 0;
              }
            }
            return resolved;
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    await assert.rejects(
      ensureChaseSession({
        context,
        credentials: CHASE_TEST_CREDENTIALS,
        page: guardedPage,
        sendInteraction: recordingInteraction(requests),
      }),
      /chase_otp_input_missing/
    );

    assert.deepEqual(
      requests.filter((req): boolean => req.kind === "otp"),
      [],
      "the prompt must not fire once the code input is gone"
    );
  });
});

test("ensureChaseSession hands off when optional credentials are absent", async () => {
  await withoutChaseCredentials(async () => {
    let live = false;
    const { gotoCalls, page } = makeLivePage(() => live);
    const context = makeLiveContext(page);
    const requests: InteractionRequest[] = [];

    const ok = await ensureChaseSession({
      context,
      page,
      sendInteraction(req: InteractionRequest): Promise<InteractionResponse> {
        requests.push(req);
        live = true;
        return Promise.resolve({
          request_id: req.request_id ?? "test_interaction",
          status: "cancelled",
          type: "INTERACTION_RESPONSE",
        });
      },
    });

    assert.equal(ok, true);
    assert.deepEqual(gotoCalls, [DASHBOARD_URL, DASHBOARD_URL]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.kind, "manual_action");
    // The owner-facing reason must name the CREDENTIAL, not the page. Before
    // `resolveLoginCredentials`, an absent credential produced copy that read
    // like a provider/page problem; an owner could not tell "nothing was
    // stored for this connection" from "Chase failed to render".
    assert.match(requests[0]?.message ?? "", /no stored credential for this chase connection/);
    assert.match(requests[0]?.message ?? "", /missing: CHASE_USERNAME, CHASE_PASSWORD/);
    assert.doesNotMatch(requests[0]?.message ?? "", /did not render|failed to load/i);
    // Names only, never values.
    assert.doesNotMatch(requests[0]?.message ?? "", /synthetic-password|synthetic-user/u);
  });
});

test("the identity-challenge copy alone never dispatches a code when the delivery option is absent", async () => {
  // "Confirm Your Identity" also appears on Chase's interstitial and error
  // variants of that page. Clicking a delivery option is what makes Chase send
  // a real code, so the copy alone must never authorize it.
  await withChaseCredentials(async () => {
    const fake = makeOtpPage({
      challengeTextVisible: true,
      deliveryOptionPresent: false,
      otpInputs: 0,
      promptTextVisible: false,
      signedOut: true,
    });
    const context = makeOtpContext(fake.page);
    const requests: InteractionRequest[] = [];

    await assert.rejects(
      ensureChaseSession({
        context,
        credentials: CHASE_TEST_CREDENTIALS,
        page: fake.page,
        sendInteraction: recordingInteraction(requests),
      }),
      /chase_delivery_method_not_available/
    );

    assert.equal(fake.deliveryClicks, 0, "no delivery option may be clicked: that click is a real code dispatch");
    assert.deepEqual(
      requests.filter((request) => request.kind === "otp"),
      [],
      "the owner is never asked for a code that was never sent"
    );
  });
});

test("a visible but DISABLED delivery option is not evidence the chooser is ready", async () => {
  // Playwright reports a disabled control as visible, so a visibility-only
  // guard would click here and spend a real code.
  await withChaseCredentials(async () => {
    const fake = makeOtpPage({
      challengeTextVisible: true,
      deliveryOptionEnabled: false,
      deliveryOptionPresent: true,
      otpInputs: 0,
      promptTextVisible: false,
      signedOut: true,
    });
    const context = makeOtpContext(fake.page);
    const requests: InteractionRequest[] = [];

    await assert.rejects(
      ensureChaseSession({
        context,
        credentials: CHASE_TEST_CREDENTIALS,
        page: fake.page,
        sendInteraction: recordingInteraction(requests),
      }),
      /chase_delivery_method_not_available/
    );

    assert.equal(fake.deliveryClicks, 0, "a disabled option must not be clicked");
  });
});

test("a genuine method chooser still dispatches exactly once and reaches the code prompt", async () => {
  await withChaseCredentials(async () => {
    const fake = makeOtpPage({
      challengeTextVisible: true,
      deliveryOptionPresent: true,
      otpInputs: 1,
      promptTextVisible: true,
      signedOut: true,
    });
    // Chase authenticates once the code is submitted.
    const context = makeOtpContext(fake.page);
    const requests: InteractionRequest[] = [];

    await ensureChaseSession({
      context,
      credentials: CHASE_TEST_CREDENTIALS,
      page: fake.page,
      sendInteraction: (request: InteractionRequest): Promise<InteractionResponse> => {
        if (request.kind === "otp") {
          fake.state.signedOut = false;
        }
        return recordingInteraction(requests)(request);
      },
    });

    assert.equal(fake.deliveryClicks, 1, "the genuine chooser dispatches exactly once, as before");
    assert.deepEqual(
      requests.map((request) => request.kind),
      ["otp"],
      "the owner is asked for the code that was genuinely dispatched"
    );
  });
});

/**
 * The case the process-global env-var design structurally cannot express.
 *
 * `process.env.CHASE_USERNAME` holds ONE account. An owner with two Chase
 * connections needs each run to sign in as its OWN account. Because
 * `ensureChaseSession` now takes the connection's credentials as an argument,
 * two runs in the SAME process — sharing one `process.env` — type two
 * different usernames into the sign-in form.
 *
 * The assertion is on what was typed into the form, not on the arguments
 * passed in: proving the right value merely arrived would not prove it reached
 * the login.
 */
test("two connections of one connector sign in as their own accounts", async () => {
  const signIn = async (credentials: Readonly<Record<string, string>>) => {
    const fake = makeOtpPage({ otpInputs: 0, promptTextVisible: false, signedOut: true });
    const context = makeOtpContext(fake.page);
    // The page never becomes live, so this always ends in a throw; the login
    // ATTEMPT — the values typed into the form — is what this test is about.
    await ensureChaseSession({
      context,
      credentials,
      page: fake.page,
      sendInteraction: recordingInteraction([]),
    }).catch((): void => undefined);
    return fake.filledValues;
  };

  const connectionA = await signIn({
    CHASE_PASSWORD: "synthetic-pw-a",
    CHASE_USERNAME: "owner-a@example.invalid",
  });
  const connectionB = await signIn({
    CHASE_PASSWORD: "synthetic-pw-b",
    CHASE_USERNAME: "owner-b@example.invalid",
  });

  assert.deepEqual(connectionA.username, ["owner-a@example.invalid"]);
  assert.deepEqual(connectionB.username, ["owner-b@example.invalid"]);
  assert.deepEqual(connectionA.password, ["synthetic-pw-a"]);
  assert.deepEqual(connectionB.password, ["synthetic-pw-b"]);
  assert.notDeepEqual(connectionA.username, connectionB.username, "two connections must not collapse onto one account");
});
