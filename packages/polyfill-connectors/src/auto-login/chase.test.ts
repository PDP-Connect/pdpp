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

async function withoutChaseCredentials(run: () => Promise<void>): Promise<void> {
  const priorUsername = process.env.CHASE_USERNAME;
  const priorPassword = process.env.CHASE_PASSWORD;
  const priorStreamingEnv = new Map<(typeof STREAMING_ENV_KEYS)[number], string | undefined>();
  delete process.env.CHASE_USERNAME;
  delete process.env.CHASE_PASSWORD;
  for (const key of STREAMING_ENV_KEYS) {
    priorStreamingEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    await run();
  } finally {
    if (priorUsername === undefined) {
      delete process.env.CHASE_USERNAME;
    } else {
      process.env.CHASE_USERNAME = priorUsername;
    }
    if (priorPassword === undefined) {
      delete process.env.CHASE_PASSWORD;
    } else {
      process.env.CHASE_PASSWORD = priorPassword;
    }
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
  gotoCalls: string[];
  page: Page;
  state: FakeOtpPageState;
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
  const signInButton: Pick<Locator, "click" | "count" | "first"> = {
    click: (): Promise<void> => {
      onAfterSignInClick?.(state);
      return Promise.resolve();
    },
    count: (): Promise<number> => Promise.resolve(1),
    first: (): Locator => signInButton as Locator,
  };
  const credentialField: Pick<Locator, "fill" | "first" | "waitFor"> = {
    fill: (): Promise<void> => Promise.resolve(),
    first: (): Locator => credentialField as Locator,
    waitFor: (): Promise<void> => Promise.resolve(),
  };

  const fake: Pick<Page, "getByRole" | "getByText" | "goto" | "isClosed" | "locator"> = {
    getByRole: (): Locator => absentLocator(),
    getByText: (text: Parameters<Page["getByText"]>[0]): Locator => {
      const source = text instanceof RegExp ? text.source : String(text);
      // The dashboard "Sign Out" probe: visible only once signed in.
      if (/Sign Out/i.test(source)) {
        return textLocator((): boolean => !state.signedOut);
      }
      // The identity-challenge method chooser. These tests land straight on
      // the OTP surface, so the chooser is never on screen.
      if (/Confirm Your Identity/i.test(source)) {
        return textLocator((): boolean => false);
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
      if (selector.includes("password") || selector.includes("userId") || selector.includes("username")) {
        return credentialField as Locator;
      }
      return absentLocator();
    },
  };
  return { gotoCalls, page: fake as Page, state };
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

async function withChaseCredentials(run: () => Promise<void>): Promise<void> {
  const priorUsername = process.env.CHASE_USERNAME;
  const priorPassword = process.env.CHASE_PASSWORD;
  process.env.CHASE_USERNAME = "test-user";
  process.env.CHASE_PASSWORD = "test-password";
  try {
    await run();
  } finally {
    if (priorUsername === undefined) {
      delete process.env.CHASE_USERNAME;
    } else {
      process.env.CHASE_USERNAME = priorUsername;
    }
    if (priorPassword === undefined) {
      delete process.env.CHASE_PASSWORD;
    } else {
      process.env.CHASE_PASSWORD = priorPassword;
    }
  }
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
      ensureChaseSession({ context, page, sendInteraction: recordingInteraction(requests) }),
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
      ensureChaseSession({ context, page: guardedPage, sendInteraction: recordingInteraction(requests) }),
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
    assert.match(requests[0]?.message ?? "", /No optional Chase sign-in details/);
    assert.doesNotMatch(requests[0]?.message ?? "", /password|test-user/u);
  });
});
