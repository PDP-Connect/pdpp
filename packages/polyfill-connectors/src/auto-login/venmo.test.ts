// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator, Page } from "playwright";
import { VENMO_RETRYABLE_PATTERN } from "../../connectors/venmo/index.ts";
import { API_BASE } from "../../connectors/venmo/parsers.ts";
import type { InteractionRequest, InteractionResponse } from "../connector-runtime.ts";
import type { CaptureSession } from "../fixture-capture.ts";
import {
  ACCOUNT_PROBE_URL,
  ensureVenmoOrigin,
  ensureVenmoSession,
  isVenmoFamilyUrl,
  isVenmoSignInUrl,
  probeVenmoAccount,
  VENMO_POST_SUBMIT_PROBE_TRANSPORT_ERROR,
  VENMO_PROBE_TRANSPORT_ERROR,
} from "./venmo.ts";

const STREAMING_ENV_KEYS = [
  "PDPP_RUN_ID",
  "PDPP_REFERENCE_BASE_URL",
  "PDPP_STREAMING_REGISTRATION_TOKEN",
  "PDPP_LOCAL_DEVICE_TOKEN",
] as const;

/**
 * `enabled` is modelled separately from `visible` on purpose: Playwright
 * reports a disabled field as visible, so the two are independent facts and a
 * locator fake that conflated them could not express the inert-code-box page.
 */
function makeLocator({
  count = 1,
  enabled = true,
  innerText = "",
  visible = true,
}: {
  count?: number;
  enabled?: boolean;
  innerText?: string;
  visible?: boolean;
} = {}): Locator {
  const fake: Pick<
    Locator,
    "click" | "count" | "fill" | "first" | "innerText" | "isEnabled" | "isVisible" | "nth" | "waitFor"
  > = {
    click: (): Promise<void> => Promise.resolve(),
    count: (): Promise<number> => Promise.resolve(count),
    fill: (_value: string): Promise<void> => Promise.resolve(),
    first(): Locator {
      return fake as Locator;
    },
    innerText: (): Promise<string> => Promise.resolve(innerText),
    isEnabled(): Promise<boolean> {
      return Promise.resolve(enabled);
    },
    isVisible(): Promise<boolean> {
      return Promise.resolve(visible);
    },
    nth(): Locator {
      return fake as Locator;
    },
    waitFor(): Promise<void> {
      return count > 0 ? Promise.resolve() : Promise.reject(new Error("Timeout waiting for locator"));
    },
  };
  return fake as Locator;
}

/** A page whose `/account` probe always returns live=false/true per `accountLive`, honoring successive changes via `setLive`. Starts on `about:blank`, mirroring a fresh run's initial page state. */
function makeProbePage(initialLive: boolean): { gotoUrls: string[]; page: Page; setLive: (live: boolean) => void } {
  let live = initialLive;
  let currentUrl = "about:blank";
  const gotoUrls: string[] = [];
  const empty = makeLocator({ count: 0, visible: false });
  const submit = makeLocator();
  const page: Pick<
    Page,
    "evaluate" | "getByRole" | "goto" | "locator" | "url" | "waitForLoadState" | "waitForTimeout"
  > = {
    // biome-ignore lint/suspicious/useAwait: mirrors Playwright's Promise-returning signature
    async evaluate(): Promise<unknown> {
      return live ? { kind: "live", ownerId: "1234567890123456789" } : { kind: "dead" };
    },
    getByRole(): Locator {
      return submit;
    },
    goto(url: string): ReturnType<Page["goto"]> {
      currentUrl = url;
      gotoUrls.push(url);
      return Promise.resolve(null);
    },
    locator(): Locator {
      return empty;
    },
    url(): string {
      return currentUrl;
    },
    waitForLoadState(): ReturnType<Page["waitForLoadState"]> {
      return Promise.resolve();
    },
    waitForTimeout(): ReturnType<Page["waitForTimeout"]> {
      return Promise.resolve();
    },
  };
  const setLive = (next: boolean): void => {
    live = next;
  };
  return { gotoUrls, page: page as Page, setLive };
}

/** A fill-recording locator whose `first()` returns itself, so a caller that does `.locator(x).first().fill(v)` still records the fill. */
function makeFillRecordingLocator(
  onFill: (value: string) => void,
  opts: { count?: number; visible?: boolean } = {}
): Locator {
  const { count = 1, visible = true } = opts;
  const fake: Pick<Locator, "click" | "count" | "fill" | "first" | "innerText" | "isVisible" | "waitFor"> = {
    click: (): Promise<void> => Promise.resolve(),
    count: (): Promise<number> => Promise.resolve(count),
    fill: (value: string): Promise<void> => {
      onFill(value);
      return Promise.resolve();
    },
    first(): Locator {
      return fake as Locator;
    },
    innerText: (): Promise<string> => Promise.resolve(""),
    isVisible(): Promise<boolean> {
      return Promise.resolve(visible);
    },
    waitFor(): Promise<void> {
      return count > 0 ? Promise.resolve() : Promise.reject(new Error("Timeout waiting for locator"));
    },
  };
  return fake as Locator;
}

/** A page whose login form fills succeed and whose post-submit probe reports live. */
function makePageWithWorkingLoginForm(): { fillCalls: Record<string, string>; page: Page } {
  const fillCalls: Record<string, string> = {};
  let probeCount = 0;
  const username = makeFillRecordingLocator((value) => {
    fillCalls.username = value;
  });
  const password = makeFillRecordingLocator((value) => {
    fillCalls.password = value;
  });
  const submit = makeLocator();
  const otp = makeLocator({ count: 0, visible: false });
  let currentUrl = "https://venmo.com/";
  const page: Pick<
    Page,
    "evaluate" | "getByRole" | "goto" | "locator" | "url" | "waitForLoadState" | "waitForTimeout"
  > = {
    // biome-ignore lint/suspicious/useAwait: mirrors Playwright's Promise-returning signature
    async evaluate(): Promise<unknown> {
      probeCount += 1;
      // First probe (initial check) is dead; every probe after the form submit is live.
      return probeCount > 1 ? { kind: "live", ownerId: "1234567890123456789" } : { kind: "dead" };
    },
    getByRole(): Locator {
      return submit;
    },
    goto(url: string): ReturnType<Page["goto"]> {
      currentUrl = url;
      return Promise.resolve(null);
    },
    locator(selector: string): Locator {
      if (selector.includes("username")) {
        return username;
      }
      if (selector.includes("password")) {
        return password;
      }
      if (selector.includes("otp") || selector.includes("code")) {
        return otp;
      }
      return makeLocator({ count: 0, visible: false });
    },
    url(): string {
      return currentUrl;
    },
    waitForLoadState(): ReturnType<Page["waitForLoadState"]> {
      return Promise.resolve();
    },
    waitForTimeout(): ReturnType<Page["waitForTimeout"]> {
      return Promise.resolve();
    },
  };
  return { fillCalls, page: page as Page };
}

async function withVenmoCredentialValues(
  credentials: { password?: string; username?: string },
  run: () => Promise<void>
): Promise<void> {
  const priorUsername = process.env.VENMO_USERNAME;
  const priorPassword = process.env.VENMO_PASSWORD;
  const priorStreamingEnv = new Map<(typeof STREAMING_ENV_KEYS)[number], string | undefined>();
  for (const key of STREAMING_ENV_KEYS) {
    priorStreamingEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  if (credentials.username) {
    process.env.VENMO_USERNAME = credentials.username;
  }
  if (credentials.password) {
    process.env.VENMO_PASSWORD = credentials.password;
  }
  try {
    await run();
  } finally {
    if (priorUsername === undefined) {
      delete process.env.VENMO_USERNAME;
    } else {
      process.env.VENMO_USERNAME = priorUsername;
    }
    if (priorPassword === undefined) {
      delete process.env.VENMO_PASSWORD;
    } else {
      process.env.VENMO_PASSWORD = priorPassword;
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

async function withVenmoCredentials(run: () => Promise<void>): Promise<void> {
  await withVenmoCredentialValues({ password: "test-password", username: "test-user" }, run);
}

async function withoutVenmoCredentials(run: () => Promise<void>): Promise<void> {
  await withVenmoCredentialValues({}, run);
}

function recordingSendInteraction(): {
  requests: InteractionRequest[];
  sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
} {
  const requests: InteractionRequest[] = [];
  return {
    requests,
    sendInteraction(req: InteractionRequest): Promise<InteractionResponse> {
      requests.push(req);
      return Promise.resolve({
        request_id: req.request_id ?? "test_interaction",
        status: "success",
        type: "INTERACTION_RESPONSE",
      });
    },
  };
}

// ─── Session reuse ───────────────────────────────────────────────────────

test("ensureVenmoSession: a live session is reused with zero interactions and no form fill", async () => {
  const { gotoUrls, page } = makeProbePage(true);
  const { requests, sendInteraction } = recordingSendInteraction();
  const result = await ensureVenmoSession({ page, sendInteraction });
  assert.equal(result.live, true);
  assert.equal(result.ownerId, "1234567890123456789");
  assert.equal(requests.length, 0, "a live session must not prompt the owner at all");
  // F1: the run starts on about:blank; without navigating first the probe's
  // credentialed fetch runs from an opaque origin and cannot prove reuse.
  assert.deepEqual(
    gotoUrls,
    ["https://venmo.com/"],
    "the probe must navigate to venmo.com before proving the persistent session is live"
  );
});

// ─── Interaction-required: no saved credential ──────────────────────────

test("ensureVenmoSession: hands off to manual_action when no credentials are saved, with no password/username leaked", async () => {
  await withoutVenmoCredentials(async () => {
    const { gotoUrls, page } = makeProbePage(false);
    const { requests, sendInteraction } = recordingSendInteraction();
    await assert.rejects(ensureVenmoSession({ page, sendInteraction }), /venmo_login_manual_incomplete/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.kind, "manual_action");
    assert.match(requests[0]?.message ?? "", /No optional Venmo sign-in details/);
    assert.doesNotMatch(requests[0]?.message ?? "", /password|test-user/i);
    // F2: the owner must be handed a real Venmo sign-in page, not
    // about:blank — the manual handoff navigates to LOGIN_URL first.
    assert.ok(
      gotoUrls.includes("https://venmo.com/login"),
      `expected a navigation to the login page before handoff, got: ${JSON.stringify(gotoUrls)}`
    );
  });
});

test("ensureVenmoSession: ignores provider credential environment variables and uses the setup bundle", async () => {
  await withVenmoCredentials(async () => {
    const { page } = makeProbePage(false);
    const { requests, sendInteraction } = recordingSendInteraction();
    await assert.rejects(ensureVenmoSession({ page, sendInteraction }), /venmo_login_manual_incomplete/);
    assert.equal(requests[0]?.kind, "manual_action");
  });
});

test("ensureVenmoSession: manual browser login succeeding is accepted without asking for a password", async () => {
  await withoutVenmoCredentials(async () => {
    const { page, setLive } = makeProbePage(false);
    const { requests, sendInteraction } = recordingSendInteraction();
    const manualHandoff = sendInteraction;
    const result = await ensureVenmoSession({
      page,
      sendInteraction: (req) => {
        setLive(true); // simulate the owner completing sign-in during the manual_action window
        return manualHandoff(req);
      },
    });
    assert.equal(result.live, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.kind, "manual_action");
  });
});

// F9: for an unproven connector built entirely on unverified selectors, the
// first live run must yield selector-rot evidence (which candidate actually
// matched) rather than a bare pass/fail — mirrors reddit's
// LOGIN_LOCATOR_PROBES capture (reddit.ts:40-73).
test("ensureVenmoSession: captures a locator probe of the login page, recording which selector candidates matched", async () => {
  await withVenmoCredentials(async () => {
    const { fillCalls, page } = makePageWithWorkingLoginForm();
    const probeCalls: Array<{ label: string; probeIds: string[] }> = [];
    const capture: Pick<CaptureSession, "captureDom" | "captureLocatorProbe"> = {
      captureDom: () => Promise.resolve(),
      captureLocatorProbe: (_page, label, probes) => {
        probeCalls.push({ label, probeIds: probes.map((p) => p.id) });
        return Promise.resolve();
      },
    };
    const { sendInteraction } = recordingSendInteraction();
    const result = await ensureVenmoSession({
      capture: capture as CaptureSession,
      credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
      page,
      sendInteraction,
    });
    assert.equal(result.live, true);
    assert.equal(fillCalls.username, "test-user");
    assert.ok(probeCalls.length > 0, "expected at least one locator-probe capture during login");
    assert.ok(
      probeCalls.some((c) => c.label === "venmo-login-page"),
      "expected a locator probe captured at the login page, not just later steps"
    );
    for (const call of probeCalls) {
      assert.deepEqual(
        call.probeIds,
        ["username", "password", "submit-role", "otp", "step-one-submit", "captcha"],
        "every capture must record every selector candidate the connector relies on — including the two-step 'Next' control and the captcha frame, whose presence/absence is what distinguishes a two-step page from an unrecognized one"
      );
    }
  });
});

// ─── Credential-assisted login ──────────────────────────────────────────

test("ensureVenmoSession: fills saved credentials and completes login without an OTP prompt when none renders", async () => {
  await withVenmoCredentials(async () => {
    const { fillCalls, page } = makePageWithWorkingLoginForm();
    const { requests, sendInteraction } = recordingSendInteraction();
    const result = await ensureVenmoSession({
      credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
      page,
      sendInteraction,
    });
    assert.equal(result.live, true);
    assert.equal(fillCalls.username, "test-user");
    assert.equal(fillCalls.password, "test-password");
    assert.equal(requests.length, 0, "no OTP interaction when Venmo never rendered one");
  });
});

test("ensureVenmoSession: onCredentialSubmit fires exactly once when the saved password is submitted", async () => {
  await withVenmoCredentials(async () => {
    const { page } = makePageWithWorkingLoginForm();
    const { sendInteraction } = recordingSendInteraction();
    let markerCount = 0;
    const result = await ensureVenmoSession({
      credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
      onCredentialSubmit: () => {
        markerCount += 1;
      },
      page,
      sendInteraction,
    });
    assert.equal(result.live, true);
    assert.equal(markerCount, 1, "one login attempt submitted one credential — the runtime must hear about it once");
  });
});

test("ensureVenmoSession: onCredentialSubmit does NOT fire on session reuse — no credential went out, so pre-submit faults must keep their ordinary retry classification", async () => {
  const { page } = makeProbePage(true);
  const { sendInteraction } = recordingSendInteraction();
  let markerCount = 0;
  const result = await ensureVenmoSession({
    onCredentialSubmit: () => {
      markerCount += 1;
    },
    page,
    sendInteraction,
  });
  assert.equal(result.live, true);
  assert.equal(markerCount, 0);
});

// ─── Durable credential-submit progress marker ──────────────────────────────
//
// `onCredentialSubmit` (above) only flips an in-process flag consumed by
// session-establish.ts's retry classification — it was never itself visible
// in the run's spine_events, so a run record could not distinguish "the saved
// password was submitted and Venmo rejected it" from "the flow never reached
// that point". These tests pin the fix: a `run.progress_reported`-shaped
// message fires at the same instant `onCredentialSubmit` does.

test("ensureVenmoSession: progress emits a durable credential-submit marker exactly when the saved password is submitted", async () => {
  await withVenmoCredentials(async () => {
    const { page } = makePageWithWorkingLoginForm();
    const { sendInteraction } = recordingSendInteraction();
    const progressMessages: string[] = [];
    const result = await ensureVenmoSession({
      credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
      page,
      // biome-ignore lint/suspicious/useAwait: mirrors the runtime's Promise-returning progress signature
      progress: async (message) => {
        progressMessages.push(message);
      },
      sendInteraction,
    });
    assert.equal(result.live, true);
    const marker = progressMessages.filter((m) => m.startsWith("venmo_credential_submit"));
    assert.equal(marker.length, 1, "exactly one durable marker for one credential submission");
    assert.doesNotMatch(
      marker[0] ?? "",
      /test-password|test-user/,
      "the marker must never carry the credential value itself"
    );
  });
});

test("ensureVenmoSession: progress does NOT emit the credential-submit marker on session reuse — no credential went out", async () => {
  const { page } = makeProbePage(true);
  const { sendInteraction } = recordingSendInteraction();
  const progressMessages: string[] = [];
  const result = await ensureVenmoSession({
    page,
    // biome-ignore lint/suspicious/useAwait: mirrors the runtime's Promise-returning progress signature
    progress: async (message) => {
      progressMessages.push(message);
    },
    sendInteraction,
  });
  assert.equal(result.live, true);
  assert.equal(
    progressMessages.filter((m) => m.startsWith("venmo_credential_submit")).length,
    0,
    "a reused, already-live session never submits a credential"
  );
});

// Mutation-kill twin: proves the first test's assertion is load-bearing on the
// fix, not vacuously true because `progress` was never called at all.
test("mutation-kill twin: omitting progress from ensureVenmoSession still succeeds (the hook is additive, not load-bearing for login control flow)", async () => {
  await withVenmoCredentials(async () => {
    const { page } = makePageWithWorkingLoginForm();
    const { sendInteraction } = recordingSendInteraction();
    const result = await ensureVenmoSession({
      credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
      page,
      sendInteraction,
    });
    assert.equal(result.live, true, "ensureVenmoSession must not require a progress callback to function");
  });
});

// ─── OTP handoff ─────────────────────────────────────────────────────────

test("ensureVenmoSession: an OTP input drives sendInteraction with kind=otp, never asking for the password again", async () => {
  await withVenmoCredentials(async () => {
    let probeCount = 0;
    const username = makeLocator();
    const password = makeLocator();
    const submit = makeLocator();
    const otp = makeLocator();
    let currentUrl = "https://venmo.com/";
    const page: Pick<
      Page,
      "evaluate" | "getByRole" | "goto" | "locator" | "url" | "waitForLoadState" | "waitForTimeout"
    > = {
      // biome-ignore lint/suspicious/useAwait: mirrors Playwright's Promise-returning signature
      async evaluate(): Promise<unknown> {
        probeCount += 1;
        return probeCount > 1 ? { kind: "live", ownerId: "1234567890123456789" } : { kind: "dead" };
      },
      getByRole(): Locator {
        return submit;
      },
      goto(url: string): ReturnType<Page["goto"]> {
        currentUrl = url;
        return Promise.resolve(null);
      },
      locator(selector: string): Locator {
        if (selector.includes("username")) {
          return username;
        }
        if (selector.includes("password")) {
          return password;
        }
        if (selector.includes("otp") || selector.includes("code")) {
          return otp;
        }
        return makeLocator({ count: 0, visible: false });
      },
      url(): string {
        return currentUrl;
      },
      waitForLoadState(): ReturnType<Page["waitForLoadState"]> {
        return Promise.resolve();
      },
      waitForTimeout(): ReturnType<Page["waitForTimeout"]> {
        return Promise.resolve();
      },
    };
    const { requests, sendInteraction } = recordingSendInteraction();
    const result = await ensureVenmoSession({
      credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
      page: page as Page,
      sendInteraction,
    });
    assert.equal(result.live, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.kind, "otp");
    assert.doesNotMatch(requests[0]?.message ?? "", /test-password/);
  });
});

/**
 * Drives `ensureVenmoSession` from the login form through to the OTP decision
 * with an OTP field whose usability and the page's body copy are both set by
 * the caller. `onOtpClassified` fires on each read of the OTP selector, which
 * is the connector's own classification checkpoint — that is where a test can
 * mutate the page out from under the prompt site.
 *
 * Synthetic, not a real capture: no Venmo auth-page markup exists on disk, and
 * the live site is off limits because it is the owner's real payments account.
 * The selectors modelled here come from the module's own constants.
 */
function makeOtpDecisionPage({
  bodyText,
  otpCount = 1,
  otpEnabled = true,
  otpVisible = true,
  onOtpClassified,
}: {
  bodyText: string;
  otpCount?: number;
  otpEnabled?: boolean;
  otpVisible?: boolean;
  onOtpClassified?: (mutate: (next: { otpVisible: boolean }) => void) => void;
}): { page: Page } {
  const state = { otpVisible };
  let currentUrl = "https://venmo.com/";
  const submit = makeLocator();
  const otpLocator = (): Locator => makeLocator({ count: otpCount, enabled: otpEnabled, visible: state.otpVisible });
  const page: Pick<
    Page,
    "evaluate" | "getByRole" | "goto" | "locator" | "url" | "waitForLoadState" | "waitForTimeout"
  > = {
    // biome-ignore lint/suspicious/useAwait: mirrors Playwright's Promise-returning signature
    async evaluate(): Promise<unknown> {
      return { kind: "dead" };
    },
    getByRole: (): Locator => submit,
    goto(url: string): ReturnType<Page["goto"]> {
      currentUrl = url;
      return Promise.resolve(null);
    },
    locator(selector: string): Locator {
      if (selector === "body") {
        return makeLocator({ innerText: bodyText });
      }
      if (selector.includes("username")) {
        return makeLocator();
      }
      if (selector.includes("password")) {
        return makeLocator();
      }
      if (selector.includes("otp") || selector.includes("code")) {
        // Reading the OTP selector is the connector's classification
        // checkpoint. Resolve the locator against the CURRENT state first,
        // then let the test mutate what the next read will see.
        const resolved = otpLocator();
        onOtpClassified?.((next) => {
          state.otpVisible = next.otpVisible;
        });
        return resolved;
      }
      return makeLocator({ count: 0, visible: false });
    },
    url: (): string => currentUrl,
    waitForLoadState: (): ReturnType<Page["waitForLoadState"]> => Promise.resolve(),
    waitForTimeout: (): ReturnType<Page["waitForTimeout"]> => Promise.resolve(),
  };
  return { page: page as Page };
}

test("ensureVenmoSession: a page matching the OTP copy with no code input hands off instead of demanding a code", async () => {
  await withVenmoCredentials(async () => {
    // Matching copy with nothing that can accept a code. Venmo dispatched
    // nothing, so PDPP must demand nothing.
    const { page } = makeOtpDecisionPage({
      bodyText: "We sent a verification code to your phone",
      otpCount: 0,
      otpVisible: false,
    });
    const { requests, sendInteraction } = recordingSendInteraction();
    await assert.rejects(
      ensureVenmoSession({
        credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
        page,
        sendInteraction,
      }),
      /venmo_login_incomplete_after_submit/
    );
    assert.deepEqual(
      requests.filter((req): boolean => req.kind === "otp"),
      [],
      "no OTP prompt may be emitted for a page that cannot accept a code"
    );
  });
});

test("ensureVenmoSession: a rendered but disabled code box never asks the owner for a code", async () => {
  await withVenmoCredentials(async () => {
    // The defect shape this fix closes. A disabled field still reports itself
    // visible, so a visibility-only check read an inert box as a live
    // challenge and demanded a code Venmo never sent.
    const { page } = makeOtpDecisionPage({
      bodyText: "We sent a verification code to your phone",
      otpEnabled: false,
      otpVisible: true,
    });
    const { requests, sendInteraction } = recordingSendInteraction();
    await assert.rejects(
      ensureVenmoSession({
        credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
        page,
        sendInteraction,
      }),
      /venmo_login_incomplete_after_submit/
    );
    assert.deepEqual(
      requests.filter((req): boolean => req.kind === "otp"),
      [],
      "a code box that cannot accept input is not evidence a code was sent"
    );
    assert.equal(
      requests.filter((req): boolean => req.kind === "manual_action").length,
      1,
      "the owner is handed the browser rather than asked for a code that does not exist"
    );
  });
});

test("ensureVenmoSession: a split per-digit code layout still counts as a real code-entry page", async () => {
  await withVenmoCredentials(async () => {
    const { page } = makeOtpDecisionPage({
      bodyText: "Enter the code we sent you",
      otpCount: 6,
    });
    const { requests, sendInteraction } = recordingSendInteraction();
    await ensureVenmoSession({
      credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
      page,
      sendInteraction,
    }).catch((): undefined => undefined);
    assert.equal(
      requests.filter((req): boolean => req.kind === "otp").length,
      1,
      "a boxed per-digit layout must stay recognized as a genuine code screen"
    );
  });
});

test("ensureVenmoSession: a code input that vanishes after classification fails loudly instead of prompting", async () => {
  await withVenmoCredentials(async () => {
    // Classification sees a usable input; Venmo re-renders it away before the
    // prompt site is reached. The prompt-site re-check must catch that.
    // Sequenced off the connector's own reads rather than a timer. Read 1 only
    // binds the locator; read 2 is `hasUsableVenmoOtpInput` deciding this IS an
    // OTP page. Venmo re-renders the input away at that instant, so the
    // prompt-site re-check (read 3) must find nothing and throw.
    let otpSelectorReads = 0;
    const { page } = makeOtpDecisionPage({
      bodyText: "We sent a verification code to your phone",
      onOtpClassified: (mutate) => {
        otpSelectorReads += 1;
        if (otpSelectorReads === 2) {
          mutate({ otpVisible: false });
        }
      },
    });
    const { requests, sendInteraction } = recordingSendInteraction();
    await assert.rejects(
      ensureVenmoSession({
        credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
        page,
        sendInteraction,
      }),
      /venmo_otp_input_missing/
    );
    assert.deepEqual(
      requests.filter((req): boolean => req.kind === "otp"),
      [],
      "the prompt must not fire once the code input is gone"
    );
  });
});

// ─── Two-step sign-in (identifier -> Next -> password) ───────────────────
//
// Production `run_1787164654406`, read live over CDP while the page sat on
// `https://id.venmo.com/signin?...`. Its visible, ENABLED inputs were exactly:
//
//   {t: INPUT, ty: password, n: "",           dis: false, vis: true}
//   {t: INPUT, ty: email,    n: "login_email", dis: false, vis: true}
//
// plus a `btnNext` submit button and a reCAPTCHA iframe served from
// paypalobjects.com. Page copy: "Log in" / "Enter email, mobile, or username" /
// "Next" / "Sign up".
//
// `login_email` matched NONE of the connector's three username candidates
// (`phoneEmailUsername`, `#username`, `[autocomplete="username"]`), so
// `loginWithSavedCredentials` read a perfectly ordinary Venmo sign-in page as
// "the sign-in form did not render" and handed off to the owner every single
// time — which is why this connector had collected zero records, ever, across
// all three connections on the instance. The owner completed sign-in by hand
// twice that night and both runs still ended in the manual-handoff path.
//
// SYNTHETIC FIXTURE, STATED PLAINLY: no Venmo auth-page capture exists on disk
// and live contact is forbidden (it is the owner's real payments account). The
// DOM shape above is the measured ground truth these fakes model. If the real
// page differs in ways this shape does not capture, these tests will pass and
// a live login may still not complete.

/**
 * Venmo's CURRENT two-step sign-in, modelled selector-by-selector on the live
 * DOM above.
 *
 * The page starts on screen one: the `login_email` identifier field and
 * `#btnNext` are present, and NO password field is visible. Clicking a submit
 * control advances to screen two, where the password field becomes visible.
 * That ordering is the whole point — a fake that exposed the password field
 * from the start could not tell a working two-step fix from the broken
 * one-screen assumption.
 *
 * `passwordAppearsAfterNext: false` models the second screen never arriving.
 * `captchaVisible` models the reCAPTCHA frame the live page really does embed.
 */
function makeTwoStepVenmoPage({
  captchaVisible = false,
  identifierSelectorMatches = true,
  passwordAppearsAfterNext = true,
  passwordScreenDelayMs = 0,
  semanticSubmitVisible = true,
}: {
  captchaVisible?: boolean;
  identifierSelectorMatches?: boolean;
  passwordAppearsAfterNext?: boolean;
  /**
   * How long Venmo's second screen takes to render after the identifier is
   * submitted. Non-zero is the realistic case and the ONLY one that can tell a
   * real wait from a fixed sleep: a `waitFor` resolves the instant the field
   * appears no matter when that is, whereas a `waitForTimeout(N)` followed by
   * a single visibility check silently misreads any screen slower than `N` as
   * "no password field". With this at 0 the two are indistinguishable.
   */
  passwordScreenDelayMs?: number;
  /**
   * `false` models a step-one control with no accessible name — an icon-only
   * or localized "Next" button that `SUBMIT_BUTTON_NAME_RE` cannot match. This
   * is the ONLY situation the `#btnNext` id fallback exists for; with the
   * semantic button present the role query always wins and the id is never
   * consulted.
   */
  semanticSubmitVisible?: boolean;
} = {}): {
  clicks: string[];
  fillCalls: Record<string, string>;
  page: Page;
} {
  const clicks: string[] = [];
  const fillCalls: Record<string, string> = {};
  let onPasswordScreen = false;
  let probeCount = 0;
  let currentUrl = "https://id.venmo.com/signin?country.x=US";

  const advance = (via: string): void => {
    clicks.push(via);
    if (!passwordAppearsAfterNext) {
      return;
    }
    if (passwordScreenDelayMs <= 0) {
      onPasswordScreen = true;
      return;
    }
    // Venmo's second screen renders asynchronously. A timer models that
    // honestly: nothing about the password field is true at click time, and it
    // becomes true later, on its own schedule.
    const timer = setTimeout(() => {
      onPasswordScreen = true;
    }, passwordScreenDelayMs);
    // Never let the fixture's own timer hold the test process open.
    timer.unref?.();
  };

  /**
   * A password locator that reports its CURRENT visibility on every read and
   * whose `waitFor` genuinely polls until visible or the deadline passes —
   * Playwright's real semantics. A fake whose `waitFor` resolved immediately
   * would make a fixed sleep and a real wait look identical.
   */
  const passwordLocator = (): Locator => {
    const fake: Pick<Locator, "click" | "count" | "fill" | "first" | "isEnabled" | "isVisible" | "waitFor"> = {
      click: (): Promise<void> => Promise.resolve(),
      count: (): Promise<number> => Promise.resolve(onPasswordScreen ? 1 : 0),
      fill: (value: string): Promise<void> => {
        // Only a rendered field can be typed into. Recording a fill against a
        // screen that has not arrived would let a broken wait look successful.
        if (onPasswordScreen) {
          fillCalls.password = value;
        }
        return Promise.resolve();
      },
      first(): Locator {
        return fake as Locator;
      },
      isEnabled: (): Promise<boolean> => Promise.resolve(onPasswordScreen),
      isVisible: (): Promise<boolean> => Promise.resolve(onPasswordScreen),
      async waitFor(options?: { timeout?: number }): Promise<void> {
        const deadline = Date.now() + (options?.timeout ?? 30_000);
        while (!onPasswordScreen) {
          if (Date.now() >= deadline) {
            throw new Error("Timeout waiting for locator");
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      },
    };
    return fake as Locator;
  };

  // Screen one's control. The live page's button carries the accessible name
  // "Next", which SUBMIT_BUTTON_NAME_RE already matches, so the semantic role
  // query is what fires here — `#btnNext` is the id fallback.
  const roleSubmit = semanticSubmitVisible
    ? makeClickRecordingLocator(() => {
        advance(onPasswordScreen ? "role-submit-password-screen" : "role-submit-identifier-screen");
      })
    : makeLocator({ count: 0, visible: false });

  const page: Pick<
    Page,
    "evaluate" | "getByRole" | "goto" | "locator" | "url" | "waitForLoadState" | "waitForTimeout"
  > = {
    // biome-ignore lint/suspicious/useAwait: mirrors Playwright's Promise-returning signature
    async evaluate(): Promise<unknown> {
      probeCount += 1;
      // Probe 1 is the pre-submit liveness check (dead — this is why we log
      // in at all). Everything after the password submit reports live.
      return probeCount > 1 && onPasswordScreen ? { kind: "live", ownerId: "1234567890123456789" } : { kind: "dead" };
    },
    getByRole: (): Locator => roleSubmit,
    goto(url: string): ReturnType<Page["goto"]> {
      // Venmo's real behavior: /login 302s to the identity host, which is where
      // the sign-in form, the captcha, and the OTP screen all live. A fixture
      // that parked on the literal requested URL could not tell a handoff that
      // preserves a live challenge from one that navigates away from it.
      currentUrl = url === "https://venmo.com/login" ? "https://id.venmo.com/signin?country.x=US" : url;
      return Promise.resolve(null);
    },
    locator(selector: string): Locator {
      if (selector === "body") {
        return makeLocator({ innerText: "Log in Enter email, mobile, or username Next Sign up" });
      }
      if (selector.includes("login_email")) {
        // The live identifier field: type=email, name="login_email".
        return identifierSelectorMatches
          ? makeFillRecordingLocator((value) => {
              fillCalls.username = value;
            })
          : makeLocator({ count: 0, visible: false });
      }
      if (selector.includes('input[name="password"]')) {
        // Screen two only. Not-visible on screen one is the fact that makes
        // this a TWO-step page rather than a one-screen form. The locator
        // re-reads the live state on every call, so it flips the moment the
        // second screen renders — it is not frozen at bind time.
        return passwordLocator();
      }
      if (selector.includes("otp") || selector.includes("code")) {
        return makeLocator({ count: 0, visible: false });
      }
      if (selector === "#btnNext") {
        // Screen one's id-addressed control. Present only on screen one — on
        // screen two the id is gone, so a connector that kept clicking it
        // would find nothing.
        return onPasswordScreen
          ? makeLocator({ count: 0, visible: false })
          : makeClickRecordingLocator(() => advance("btnNext"));
      }
      if (selector === 'button[type="submit"]') {
        // The generic fallback both screens carry.
        return makeClickRecordingLocator(() => advance("generic-submit"));
      }
      if (selector.includes("recaptcha") || selector.includes("paypalobjects")) {
        return makeLocator({ count: captchaVisible ? 1 : 0, visible: captchaVisible });
      }
      return makeLocator({ count: 0, visible: false });
    },
    url: (): string => currentUrl,
    waitForLoadState: (): ReturnType<Page["waitForLoadState"]> => Promise.resolve(),
    // Honors its argument, unlike the other fakes in this file. A
    // `waitForTimeout` that resolved instantly would make a fixed sleep
    // indistinguishable from a real bounded wait, which is precisely the
    // difference these two-step tests exist to pin.
    waitForTimeout(ms: number): ReturnType<Page["waitForTimeout"]> {
      return new Promise((resolve) => {
        setTimeout(resolve, ms).unref?.();
      });
    },
  };
  return { clicks, fillCalls, page: page as Page };
}

/** A visible locator that records each click, so a test can pin WHICH control advanced the flow. */
function makeClickRecordingLocator(onClick: () => void): Locator {
  const fake: Pick<Locator, "click" | "count" | "fill" | "first" | "isEnabled" | "isVisible" | "waitFor"> = {
    click: (): Promise<void> => {
      onClick();
      return Promise.resolve();
    },
    count: (): Promise<number> => Promise.resolve(1),
    fill: (): Promise<void> => Promise.resolve(),
    first(): Locator {
      return fake as Locator;
    },
    isEnabled: (): Promise<boolean> => Promise.resolve(true),
    isVisible: (): Promise<boolean> => Promise.resolve(true),
    waitFor: (): Promise<void> => Promise.resolve(),
  };
  return fake as Locator;
}

// (a) The headline case: the real two-step page completes login with NO owner
// handoff. Before the selector fix this test fails at the first hurdle — the
// connector never finds `login_email` and hands off with "sign-in form did not
// render", the exact message both of the owner's manual runs produced.
test("ensureVenmoSession: the live two-step page (login_email -> Next -> password) completes login with no owner handoff", async () => {
  await withVenmoCredentials(async () => {
    const { clicks, fillCalls, page } = makeTwoStepVenmoPage();
    const { requests, sendInteraction } = recordingSendInteraction();
    const result = await ensureVenmoSession({
      credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
      page,
      sendInteraction,
    });
    assert.equal(result.live, true, "a recognized two-step Venmo sign-in must complete, not hand off");
    assert.equal(fillCalls.username, "test-user", "the login_email identifier field must actually be filled");
    assert.equal(fillCalls.password, "test-password", "the password must be filled on the SECOND screen");
    assert.deepEqual(
      requests,
      [],
      "the owner must not be interrupted at all on a sign-in the connector can complete itself"
    );
    assert.equal(clicks.length, 2, "exactly two submits: one to advance past the identifier, one to send the password");
  });
});

// The wait must be a WAIT, not a sleep. The replaced code slept a fixed
// 1500ms and then looked exactly once, so a second screen slower than that was
// misread as "no password field" and the run was handed to the owner — while a
// faster one wasted the remainder. This models a screen that renders at 2500ms
// (comfortably past the old sleep, comfortably inside the real bound): a
// genuine `waitFor` resolves the instant it appears, a fixed sleep cannot.
test("ensureVenmoSession: a password screen slower than the old fixed sleep is still awaited and filled, not misread as absent", async () => {
  await withVenmoCredentials(async () => {
    const { fillCalls, page } = makeTwoStepVenmoPage({ passwordScreenDelayMs: 2500 });
    const { requests, sendInteraction } = recordingSendInteraction();
    const result = await ensureVenmoSession({
      credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
      page,
      passwordScreenTimeoutMs: 10_000,
      sendInteraction,
    });
    assert.equal(result.live, true, "a slow-but-arriving password screen is a success, not a handoff");
    assert.equal(fillCalls.password, "test-password", "the password must be filled once the screen actually renders");
    assert.deepEqual(requests, [], "the owner must not be interrupted for a screen that simply took a moment");
  });
});

// The `#btnNext` id fallback, isolated. With the semantic "Next" name present
// the role query wins and this id is never consulted — so the only way to
// prove the fallback is real is a step-one control whose accessible name
// SUBMIT_BUTTON_NAME_RE cannot match (icon-only or localized). The assertion
// is on WHICH control fired: `#btnNext` must be preferred over the generic
// `button[type="submit"]`, whose `.first()` is a coin flip on a page carrying
// more than one submit control.
test("ensureVenmoSession: an unnamed step-one control is advanced via #btnNext, in preference to the generic submit selector", async () => {
  await withVenmoCredentials(async () => {
    const { clicks, fillCalls, page } = makeTwoStepVenmoPage({ semanticSubmitVisible: false });
    const { requests, sendInteraction } = recordingSendInteraction();
    const result = await ensureVenmoSession({
      credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
      page,
      sendInteraction,
    });
    assert.equal(result.live, true);
    assert.equal(fillCalls.password, "test-password");
    assert.equal(
      clicks[0],
      "btnNext",
      "the identifier screen must advance via Venmo's exact id, not a positional guess among submit buttons"
    );
    assert.deepEqual(requests, [], "an id-addressable step-one control needs no owner handoff");
  });
});

// (3) The credential-resubmission guard under a TWO-submit flow. The marker
// must bind to the PASSWORD submit, never the identifier submit — an
// identifier is not a secret, and marking it as one would terminal runs that
// cost nothing to retry.
test("ensureVenmoSession: onCredentialSubmit fires exactly once on a two-step flow — at the password submit, not the identifier submit", async () => {
  await withVenmoCredentials(async () => {
    const { clicks, page } = makeTwoStepVenmoPage();
    const { sendInteraction } = recordingSendInteraction();
    const markerAtClickCount: number[] = [];
    const result = await ensureVenmoSession({
      credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
      onCredentialSubmit: () => {
        markerAtClickCount.push(clicks.length);
      },
      page,
      sendInteraction,
    });
    assert.equal(result.live, true);
    assert.equal(markerAtClickCount.length, 1, "two submits, but only ONE of them sent a credential");
    assert.equal(
      markerAtClickCount[0],
      2,
      "the marker must fire after the SECOND click (the password submit) — firing at 1 would classify the identifier submit as a credential submission"
    );
  });
});

// The counterweight for (3): a two-step run that dies BEFORE the password is
// ever sent must not be marked as a credential submission, or the runtime
// permanently terminals a run that was safe to retry.
test("ensureVenmoSession: a two-step flow that stalls before the password screen never fires onCredentialSubmit", async () => {
  await withVenmoCredentials(async () => {
    const { page } = makeTwoStepVenmoPage({ passwordAppearsAfterNext: false });
    const { sendInteraction } = recordingSendInteraction();
    let markerCount = 0;
    await assert.rejects(
      ensureVenmoSession({
        credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
        onCredentialSubmit: () => {
          markerCount += 1;
        },
        page,
        passwordScreenTimeoutMs: 50,
        sendInteraction,
      }),
      /venmo_password_screen_timeout/
    );
    assert.equal(markerCount, 0, "no password was ever submitted, so nothing may be marked as a credential submission");
  });
});

// (c) The password screen never arriving must produce a BOUNDED, NAMED
// failure — not a spin, and above all not a fall-through into the OTP path,
// where an absent password field would be misread as a verification prompt and
// fabricate a code demand the owner never received.
test("ensureVenmoSession: a password screen that never renders fails with a bounded, named error and never fabricates an OTP prompt", async () => {
  await withVenmoCredentials(async () => {
    const { page } = makeTwoStepVenmoPage({ passwordAppearsAfterNext: false });
    const { requests, sendInteraction } = recordingSendInteraction();
    const startedAt = Date.now();
    await assert.rejects(
      ensureVenmoSession({
        credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
        page,
        passwordScreenTimeoutMs: 50,
        sendInteraction,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /venmo_password_screen_timeout/, "the failure must name its own cause");
        return true;
      }
    );
    // Reaching this assertion at all is the anti-spin proof: unbounded, the
    // wait never settles.
    assert.ok(Date.now() - startedAt < 20_000, "the wait must respect its own bound rather than spin");
    assert.deepEqual(
      requests.filter((req): boolean => req.kind === "otp"),
      [],
      "a missing password field is not evidence Venmo sent a code — no OTP prompt may be fabricated"
    );
  });
});

// (d) reCAPTCHA is really on this page. Automating past it is not the goal:
// a captcha that blocks progress must hand off honestly via the existing
// manual path, rather than becoming a silent failure or a spin.
test("ensureVenmoSession: a captcha blocking the password screen hands off to the owner instead of spinning or failing silently", async () => {
  await withVenmoCredentials(async () => {
    const { page } = makeTwoStepVenmoPage({ captchaVisible: true, passwordAppearsAfterNext: false });
    const { requests, sendInteraction } = recordingSendInteraction();
    const startedAt = Date.now();
    await assert.rejects(
      ensureVenmoSession({
        credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
        page,
        passwordScreenTimeoutMs: 50,
        sendInteraction,
      }),
      // The handoff happened; the owner's simulated "success" did not produce a
      // live session, so the run still ends honestly rather than claiming one.
      /venmo_login_incomplete_after_submit/
    );
    assert.ok(Date.now() - startedAt < 20_000, "a captcha must not turn into an unbounded wait");
    const manual = requests.filter((req): boolean => req.kind === "manual_action");
    assert.equal(manual.length, 1, "a blocking captcha must reach the owner exactly once");
    assert.match(
      manual[0]?.message ?? "",
      /CAPTCHA|verification challenge/i,
      "the owner must be told what is actually blocking the sign-in"
    );
    assert.doesNotMatch(
      manual[0]?.message ?? "",
      /test-password/,
      "the saved password must never reach the owner copy"
    );
    assert.deepEqual(
      requests.filter((req): boolean => req.kind === "otp"),
      [],
      "a captcha is not a code prompt"
    );
  });
});

// (b) The detection this fix must NOT weaken. A page with no identifier field
// at all is a genuinely unrecognized page, and must still hand off with the
// existing message. The bug was that a RECOGNIZED page was misread — not that
// this check exists.
test("ensureVenmoSession: a page with no username field still hands off with the existing 'sign-in form did not render' message", async () => {
  await withVenmoCredentials(async () => {
    const { fillCalls, page } = makeTwoStepVenmoPage({ identifierSelectorMatches: false });
    const { requests, sendInteraction } = recordingSendInteraction();
    await assert.rejects(
      ensureVenmoSession({
        credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
        page,
        sendInteraction,
      }),
      /venmo_login_incomplete_after_submit/
    );
    const manual = requests.filter((req): boolean => req.kind === "manual_action");
    assert.equal(manual.length, 1, "an unrecognized sign-in page must still reach the owner");
    assert.match(
      manual[0]?.message ?? "",
      /sign-in form did not render/,
      "the existing, load-bearing handoff message must survive the two-step fix"
    );
    assert.equal(fillCalls.username, undefined, "nothing may be typed into a form the connector does not recognize");
    assert.equal(fillCalls.password, undefined);
  });
});

// COUNTERWEIGHT: the one-screen sign-in (both fields visible at once) must
// still work, and must NOT click a step-one control it does not need. A fix
// that made two-step work by always clicking twice would submit a bare
// identifier into a form that already had the password.
test("ensureVenmoSession: a one-screen sign-in still completes with a single submit (COUNTERWEIGHT)", async () => {
  await withVenmoCredentials(async () => {
    const { fillCalls, page } = makePageWithWorkingLoginForm();
    const { requests, sendInteraction } = recordingSendInteraction();
    const result = await ensureVenmoSession({
      credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
      page,
      sendInteraction,
    });
    assert.equal(result.live, true);
    assert.equal(fillCalls.username, "test-user");
    assert.equal(fillCalls.password, "test-password");
    assert.deepEqual(requests, [], "a one-screen form needs no owner involvement");
  });
});

// ─── Expired session repair ──────────────────────────────────────────────

test("ensureVenmoSession: an expired session (dead initial probe) with saved credentials re-authenticates rather than failing immediately", async () => {
  await withVenmoCredentials(async () => {
    const { fillCalls, page } = makePageWithWorkingLoginForm();
    const { sendInteraction } = recordingSendInteraction();
    const result = await ensureVenmoSession({
      credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
      page,
      sendInteraction,
    });
    assert.equal(result.live, true, "expired session must be repaired via the credential-assisted form, not just fail");
    assert.equal(fillCalls.username, "test-user");
  });
});

// ─── probeVenmoAccount: pure page-context probe ──────────────────────────

test("probeVenmoAccount: navigates to venmo.com first when the page starts on about:blank", async () => {
  const gotoUrls: string[] = [];
  // A real `page.goto` that lands successfully updates `page.url()` to the
  // destination — this fake must mirror that (see
  // `ensureVenmoOrigin`'s post-navigation landed-origin check) or it proves
  // nothing about a real browser's behavior.
  let currentUrl = "about:blank";
  const page: Pick<Page, "evaluate" | "goto" | "url"> = {
    // biome-ignore lint/suspicious/useAwait: mirrors Playwright's Promise-returning signature
    async evaluate(): Promise<unknown> {
      return { kind: "live", ownerId: "1234567890123456789" };
    },
    goto(url: string): ReturnType<Page["goto"]> {
      gotoUrls.push(url);
      currentUrl = url;
      return Promise.resolve(null);
    },
    url(): string {
      return currentUrl;
    },
  };
  const result = await probeVenmoAccount(page as Page);
  assert.equal(result.live, true, "the probe must actually run the fetch after navigating, not read the blank page");
  assert.deepEqual(gotoUrls, ["https://venmo.com/"], "a fresh about:blank page must navigate to venmo.com first");
});

// Regression for production run_1787101857760 (2026-08-18, the owner's
// first-ever Venmo run): `ensureVenmoOrigin`'s `page.goto` was wrapped in
// `.catch(() => undefined)` and the function returned unconditionally
// afterward, with no check that the navigation actually landed. When the
// ONE-TIME navigation on a brand-new persistent-profile page silently failed
// (rejected `goto`, or — as reproduced here — a `goto` that resolves without
// the page actually leaving `about:blank`, e.g. a same-document
// about:blank->about:blank no-op some Playwright/Patchright builds report as
// a successful navigation), the probe proceeded straight to a credentialed
// fetch from an opaque origin and threw the bare, uninformative
// `venmo_probe_transport_error: Failed to fetch` — exactly what production
// recorded. Before this fix, this exact scenario silently proceeded to the
// fetch instead of failing fast with a diagnosable cause.
test("probeVenmoAccount: a goto that resolves without leaving about:blank throws a diagnosable origin-navigation fault, not a bare fetch failure", async () => {
  const gotoUrls: string[] = [];
  const page: Pick<Page, "evaluate" | "goto" | "url"> = {
    async evaluate(): Promise<unknown> {
      // Exactly what production hit: the browser's own fetch implementation
      // reports "Failed to fetch" when called from an opaque (about:blank)
      // origin. This must never be reached once ensureVenmoOrigin fails
      // fast — asserted below via gotoUrls/evaluateCalls staying consistent
      // with an early throw.
      return await Promise.reject(new TypeError("Failed to fetch"));
    },
    goto(url: string): ReturnType<Page["goto"]> {
      gotoUrls.push(url);
      // Resolves (no rejection) — the real defect: a successful-looking
      // `goto` that did not actually change the page's origin.
      return Promise.resolve(null);
    },
    url(): string {
      return "about:blank";
    },
  };
  await assert.rejects(probeVenmoAccount(page as Page), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(
      err.message,
      /venmo_origin_navigation_failed/,
      "a stuck-on-about:blank navigation must surface its own diagnosable cause, not an opaque downstream fetch failure"
    );
    assert.match(err.message, /venmo_probe_transport_error/, "still wrapped in the probe's own phase-aware fault name");
    return true;
  });
  assert.deepEqual(gotoUrls, ["https://venmo.com/"], "the navigation must still be attempted exactly once");
});

test("probeVenmoAccount: does not re-navigate when the page is already on venmo.com", async () => {
  let gotoCalls = 0;
  const page: Pick<Page, "evaluate" | "goto" | "url"> = {
    // biome-ignore lint/suspicious/useAwait: mirrors Playwright's Promise-returning signature
    async evaluate(): Promise<unknown> {
      return { kind: "dead" };
    },
    goto(): ReturnType<Page["goto"]> {
      gotoCalls += 1;
      return Promise.resolve(null);
    },
    url(): string {
      return "https://venmo.com/some-path";
    },
  };
  await probeVenmoAccount(page as Page);
  assert.equal(gotoCalls, 0, "already being on the venmo.com origin must not trigger a re-navigation");
});

test("probeVenmoAccount: reports live=false (not a throw) for a reachable-but-expired session", async () => {
  const page: Pick<Page, "evaluate" | "goto" | "url"> = {
    // biome-ignore lint/suspicious/useAwait: mirrors Playwright's Promise-returning signature
    async evaluate(): Promise<unknown> {
      return { kind: "dead" };
    },
    goto(): ReturnType<Page["goto"]> {
      return Promise.resolve(null);
    },
    url(): string {
      return "https://venmo.com/";
    },
  };
  const result = await probeVenmoAccount(page as Page);
  assert.equal(result.live, false);
  assert.equal(result.ownerId, null);
});

// F4: a transport/origin fault (the fetch could not run at all) must throw
// distinguishably from a dead-but-reachable session, rather than being
// swallowed into the same `{live:false}` shape — see
// /tmp/review-venmo-browser-redesign-0810.md F4. Before this fix, the prior
// version of this exact test asserted the OPPOSITE: that a thrown fetch
// collapses to `{live:false}` via the test's own `.catch()` fallback, which
// is tautological (the expected value comes from the test, not the
// function) and hides the actual defect this proves is fixed.
test("probeVenmoAccount: a page-context transport fault throws venmo_probe_transport_error, distinct from a dead session", async () => {
  const page: Pick<Page, "evaluate" | "goto" | "url"> = {
    async evaluate(): Promise<unknown> {
      return await Promise.reject(new Error("Failed to fetch"));
    },
    goto(): ReturnType<Page["goto"]> {
      return Promise.resolve(null);
    },
    url(): string {
      return "https://venmo.com/";
    },
  };
  await assert.rejects(probeVenmoAccount(page as Page), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /venmo_probe_transport_error/);
    // Benign counterweight: a transport fault carrying no secret must keep
    // its diagnostic vocabulary legible — redaction must not blank the class
    // of failure a connector's retryablePattern (and an operator) reads.
    assert.match(err.message, /Failed to fetch/);
    return true;
  });
});

// F: the connector index (index.ts's makePageFetch/errorDetail) already
// redacts equivalent transport detail via redactTransportDetail before it
// reaches a thrown error; this probe throw is the one boundary that skipped
// it. A transport fault message is authored by a third-party layer we do not
// control (Chromium's fetch shim, a proxy, an intermediary) and can embed a
// bearer token, a loose secret= form, an email, or a URL bearing a query-
// string credential — none of that may reach the terminal error text this
// probe throws, which lands directly in connector_error_json.
test("probeVenmoAccount: a transport fault carrying a bearer token cannot reach the thrown error text", async () => {
  const page: Pick<Page, "evaluate" | "goto" | "url"> = {
    async evaluate(): Promise<unknown> {
      return await Promise.reject(
        new Error("Failed to fetch https://api.venmo.com/v1/account (Authorization: Bearer abc123SECRETTOKEN)")
      );
    },
    goto(): ReturnType<Page["goto"]> {
      return Promise.resolve(null);
    },
    url(): string {
      return "https://venmo.com/";
    },
  };
  await assert.rejects(probeVenmoAccount(page as Page), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /venmo_probe_transport_error/);
    assert.doesNotMatch(err.message, /abc123SECRETTOKEN/, "a bearer token must not survive");
    assert.match(err.message, /\[redacted-authorization]/);
    assert.match(err.message, /Failed to fetch/, "the safe transport class must remain visible");
    return true;
  });
});

test("probeVenmoAccount: a transport fault carrying a query-string token, cookie, and email cannot reach the thrown error text", async () => {
  const page: Pick<Page, "evaluate" | "goto" | "url"> = {
    async evaluate(): Promise<unknown> {
      return await Promise.reject(
        new Error(
          "fetch failed for https://api.venmo.com/v1/account?access_token=QUERYSECRETVALUE " +
            "cookie=session=COOKIESECRETVALUE; owner contact owner@example.com token=T0KENSECRETVALUE ECONNRESET"
        )
      );
    },
    goto(): ReturnType<Page["goto"]> {
      return Promise.resolve(null);
    },
    url(): string {
      return "https://venmo.com/";
    },
  };
  await assert.rejects(probeVenmoAccount(page as Page), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /venmo_probe_transport_error/);
    for (const leak of ["QUERYSECRETVALUE", "COOKIESECRETVALUE", "owner@example.com", "T0KENSECRETVALUE"]) {
      assert.doesNotMatch(err.message, new RegExp(leak), `${leak} must not survive`);
    }
    assert.match(err.message, /ECONNRESET/, "the safe transport code must remain visible");
    return true;
  });
});

// ─── B4: post-submit transport fault must not retry a credential submission ──
//
// Red-team B4: a transport fault discovered by the FINAL probe — the one
// that verifies the outcome of a password just submitted to Venmo's own
// sign-in form — used to throw the SAME `venmo_probe_transport_error` name
// (and, via the old wildcard/bare-vocabulary retryablePattern, always
// matched anyway on its "Failed to fetch" text) as a pre-submit probe fault.
// The runtime cannot tell "nothing was ever attempted yet" from "a password
// was just submitted and we can't confirm the outcome" from the name/message
// alone, so both were retryable — and a retry re-enters ensureVenmoSession
// from scratch, resubmitting the SAME saved password with no run-scoped
// budget to stop it (this repo's usaa sessionRepairAttempted fix closed the
// analogous within-run gap; this is the cross-run/cross-dispatch version).
//
// `probeVenmoAccount(page, "post_submit")` now throws a distinctly-named,
// deliberately non-retryable error instead.

/**
 * A page whose login form fills succeed, but whose PROBE after the submit
 * always throws a transport fault (never resolves live/dead) — the exact B4
 * repro shape. `probeCount === 1` is the pre-submit initial probe (reports
 * dead, as with any session that needs credential-assisted login);
 * `probeCount > 1` is every probe from that point on, all post-submit.
 */
function makePageWhosePostSubmitProbeThrows(): { fillCalls: Record<string, string>; page: Page } {
  const fillCalls: Record<string, string> = {};
  let probeCount = 0;
  const username = makeFillRecordingLocator((value) => {
    fillCalls.username = value;
  });
  const password = makeFillRecordingLocator((value) => {
    fillCalls.password = value;
  });
  const submit = makeLocator();
  const otp = makeLocator({ count: 0, visible: false });
  let currentUrl = "https://venmo.com/";
  const page: Pick<
    Page,
    "evaluate" | "getByRole" | "goto" | "locator" | "url" | "waitForLoadState" | "waitForTimeout"
  > = {
    async evaluate(): Promise<unknown> {
      probeCount += 1;
      if (probeCount === 1) {
        return { kind: "dead" };
      }
      return await Promise.reject(new Error("Failed to fetch"));
    },
    getByRole(): Locator {
      return submit;
    },
    goto(url: string): ReturnType<Page["goto"]> {
      currentUrl = url;
      return Promise.resolve(null);
    },
    locator(selector: string): Locator {
      if (selector.includes("username")) {
        return username;
      }
      if (selector.includes("password")) {
        return password;
      }
      if (selector.includes("otp") || selector.includes("code")) {
        return otp;
      }
      return makeLocator({ count: 0, visible: false });
    },
    url(): string {
      return currentUrl;
    },
    waitForLoadState(): ReturnType<Page["waitForLoadState"]> {
      return Promise.resolve();
    },
    waitForTimeout(): ReturnType<Page["waitForTimeout"]> {
      return Promise.resolve();
    },
  };
  return { fillCalls, page: page as Page };
}

test("ensureVenmoSession: a transport fault in the post-submit probe throws a distinctly-named, non-retryable error", async () => {
  await withVenmoCredentials(async () => {
    const { fillCalls, page } = makePageWhosePostSubmitProbeThrows();
    const { sendInteraction } = recordingSendInteraction();
    await assert.rejects(
      ensureVenmoSession({
        credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
        page,
        sendInteraction,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /venmo_post_submit_probe_transport_error/);
        assert.doesNotMatch(
          err.message,
          /^venmo_probe_transport_error/,
          "must not collide with the pre-submit probe's error name"
        );
        return true;
      }
    );
    assert.equal(fillCalls.username, "test-user", "the automated form fill did happen — this IS the post-submit case");
    assert.equal(fillCalls.password, "test-password");
  });
});

test("B4 oracle: the post-submit probe's thrown error name does not match the connector's retryablePattern (must not retry)", async () => {
  await withVenmoCredentials(async () => {
    const { page } = makePageWhosePostSubmitProbeThrows();
    const { sendInteraction } = recordingSendInteraction();
    await assert.rejects(
      ensureVenmoSession({
        credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
        page,
        sendInteraction,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(
          VENMO_RETRYABLE_PATTERN.test(err.message),
          false,
          "a post-submit transport fault must terminal the run permanently, not retry it"
        );
        return true;
      }
    );
  });
});

test("B4 oracle: repeated-dispatch simulation — a retry-if-retryable caller submits the password exactly once total across N dispatch attempts", async () => {
  await withVenmoCredentials(async () => {
    const MAX_DISPATCH_ATTEMPTS = 3;
    let submitCount = 0;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_DISPATCH_ATTEMPTS; attempt += 1) {
      const { fillCalls, page } = makePageWhosePostSubmitProbeThrows();
      const { sendInteraction } = recordingSendInteraction();
      try {
        await ensureVenmoSession({
          credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
          page,
          sendInteraction,
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (fillCalls.password) {
          submitCount += 1;
        }
        // A real dispatcher checks retryability BEFORE deciding to loop
        // again — this is the exact decision this oracle exists to pin.
        if (!VENMO_RETRYABLE_PATTERN.test(lastError.message)) {
          break;
        }
        continue;
      }
      break;
    }
    assert.equal(submitCount, 1, "exactly one password submission across every dispatch attempt, never up to three");
    assert.match(lastError?.message ?? "", /venmo_post_submit_probe_transport_error/);
  });
});

// Counterweight: a PRE-submit transport fault (nothing has been typed or
// submitted yet — the initial session-liveness probe) is exactly the safe
// case this fix must not break. It keeps the original retryable name and
// DOES match the pattern, and a caller that retries on it is retrying
// something that cost nothing on the failed attempt.
test("B4 counterweight: a pre-submit transport fault keeps its retryable name and never touches the credential form", async () => {
  await withVenmoCredentials(async () => {
    const page: Pick<Page, "evaluate" | "goto" | "url"> = {
      async evaluate(): Promise<unknown> {
        return await Promise.reject(new Error("Failed to fetch"));
      },
      goto(): ReturnType<Page["goto"]> {
        return Promise.resolve(null);
      },
      url(): string {
        return "https://venmo.com/";
      },
    };
    const { sendInteraction } = recordingSendInteraction();
    await assert.rejects(ensureVenmoSession({ page: page as Page, sendInteraction }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /^venmo_probe_transport_error/);
      assert.equal(
        VENMO_RETRYABLE_PATTERN.test(err.message),
        true,
        "a pre-submit transport fault is exactly the case that SHOULD retry — nothing was submitted to lose"
      );
      return true;
    });
  });
});

// ─── Probe endpoint + bounded probe ──────────────────────────────────────
//
// Production `run_1787108832272`:
//   {"code":null,"message":"venmo_session_failed: venmo_probe_transport_error:
//    Failed to fetch","retryable":true}
// on a host where `https://venmo.com/` itself returned 200 in 0.14s, so this
// was never host connectivity.
//
// Root cause: the probe fetched `https://venmo.com/account` — Venmo's own web
// app route, NOT the `api.venmo.com/v1/account` JSON endpoint whose
// `data.user.id` shape this probe parses and `collect()` actually uses. As of
// 2026-08-18 that route answers a redirect chain ending on plain HTTP
// (`302 -> https://account.venmo.com/account`, `307 ->
// http://account.venmo.com:8080/`), and a browser fetch from the HTTPS
// venmo.com page is blocked at that http:// hop by the mixed-content rule.
// A blocked redirect reaches page JS as exactly `TypeError: Failed to fetch`.

test("probeVenmoAccount fetches the api.venmo.com JSON endpoint, not the venmo.com web route that redirects to plain HTTP", async () => {
  const fetchedUrls: string[] = [];
  const page: Pick<Page, "evaluate" | "goto" | "url"> = {
    evaluate(_fn: unknown, arg: unknown): ReturnType<Page["evaluate"]> {
      fetchedUrls.push((arg as { url: string }).url);
      return Promise.resolve({ kind: "live", ownerId: "1234567890123456789" });
    },
    goto(): ReturnType<Page["goto"]> {
      return Promise.resolve(null);
    },
    url(): string {
      return "https://venmo.com/";
    },
  };

  await probeVenmoAccount(page as Page);

  assert.deepEqual(fetchedUrls, [ACCOUNT_PROBE_URL]);
  assert.equal(
    ACCOUNT_PROBE_URL,
    `${API_BASE}/account`,
    "the probe must hit the SAME endpoint collect() does — a probe that tests a different URL than collection uses proves nothing about collection"
  );
  assert.ok(
    !fetchedUrls.some((u) => u === "https://venmo.com/account"),
    "https://venmo.com/account 302->307s to http://account.venmo.com:8080/, which a browser blocks as mixed content and reports as 'Failed to fetch'"
  );
});

test("probeVenmoAccount: a probe whose in-page fetch never resolves throws a bounded transport error instead of hanging", async () => {
  const page: Pick<Page, "evaluate" | "goto" | "url"> = {
    evaluate(): ReturnType<Page["evaluate"]> {
      // Never resolves, never rejects — the tarpit/wedged-context shape.
      return new Promise<never>(() => undefined);
    },
    goto(): ReturnType<Page["goto"]> {
      return Promise.resolve(null);
    },
    url(): string {
      return "https://venmo.com/";
    },
  };

  const startedAt = Date.now();
  // Reaching this assertion at all is the point: unbounded, this never settles.
  await assert.rejects(probeVenmoAccount(page as Page, "pre_submit", { evaluateTimeoutMs: 50 }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, new RegExp(`^${VENMO_PROBE_TRANSPORT_ERROR}: `));
    return true;
  });
  assert.ok(Date.now() - startedAt < 30_000, "the probe must resolve within its own bound");
});

test("probeVenmoAccount: a hung POST-submit probe keeps the non-retryable name, so a stall never resubmits a password (B4)", async () => {
  const page: Pick<Page, "evaluate" | "goto" | "url"> = {
    evaluate(): ReturnType<Page["evaluate"]> {
      return new Promise<never>(() => undefined);
    },
    goto(): ReturnType<Page["goto"]> {
      return Promise.resolve(null);
    },
    url(): string {
      return "https://venmo.com/";
    },
  };

  await assert.rejects(probeVenmoAccount(page as Page, "post_submit", { evaluateTimeoutMs: 50 }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, new RegExp(`^${VENMO_POST_SUBMIT_PROBE_TRANSPORT_ERROR}: `));
    // The bound must not launder a post-submit fault into the retryable
    // pre-submit name — a retry re-enters ensureVenmoSession and resubmits
    // the saved password against Venmo's own anti-automation gate.
    assert.equal(VENMO_RETRYABLE_PATTERN.test(err.message), false);
    return true;
  });
});

// ─── Origin family: ensureVenmoOrigin's acceptance set ───────────────────
//
// Production `run_1787151856448` (connection cin_94f4a295dda3f17d0f307a33):
// the owner completed a REAL manual Venmo sign-in in the secure browser and
// clicked continue; the run then died with
//   venmo_session_failed: venmo_probe_transport_error:
//   venmo_origin_navigation_failed: could not establish the venmo.com origin
// Venmo signs users in at `id.venmo.com` and bounces a signed-in
// `venmo.com/` request around its own host family, so the guard's
// exact-equality acceptance set rejected the CORRECT outcome. A guard that
// fires on correct behavior is worse than no guard, so the family is now
// accepted as a place to re-navigate FROM — while the CORS precondition
// (ending on `https://venmo.com`) and the hostile-landing failure both stay.

/**
 * A page that reports `finalUrl` after `goto` regardless of the requested URL
 * — the shape of Venmo's own app redirecting a navigation somewhere else.
 * Records every navigation so a test can prove the guard re-navigated rather
 * than silently accepting a non-CORS origin.
 */
function makeRedirectingPage(
  initialUrl: string,
  finalUrl: string | ((attempt: number) => string)
): { gotoUrls: string[]; page: Page } {
  const gotoUrls: string[] = [];
  let currentUrl = initialUrl;
  const page: Pick<Page, "goto" | "url"> = {
    goto(url: string): ReturnType<Page["goto"]> {
      gotoUrls.push(url);
      currentUrl = typeof finalUrl === "function" ? finalUrl(gotoUrls.length) : finalUrl;
      return Promise.resolve(null);
    },
    url(): string {
      return currentUrl;
    },
  };
  return { gotoUrls, page: page as Page };
}

test("isVenmoFamilyUrl: every legitimate Venmo host is accepted", () => {
  for (const url of [
    "https://venmo.com/",
    "https://www.venmo.com/",
    "https://id.venmo.com/signin?country.x=US",
    "https://account.venmo.com/account",
    "https://api.venmo.com/v1/account",
  ]) {
    assert.equal(isVenmoFamilyUrl(url), true, `${url} is a real Venmo host and must be recognized`);
  }
});

// The exact attack an `endsWith("venmo.com")` suffix test would admit:
// `evil-venmo.com` and `notvenmo.com` BOTH satisfy that suffix.
test("isVenmoFamilyUrl: lookalike hosts a suffix match would admit are rejected", () => {
  for (const url of [
    "https://evil-venmo.com/",
    "https://venmo.com.attacker.net/",
    "https://notvenmo.com/",
    "https://venmo.com.evil.co/signin",
    "https://api.venmo.com.attacker.net/v1/account",
  ]) {
    assert.equal(isVenmoFamilyUrl(url), false, `${url} is NOT Venmo and must never be treated as the family`);
  }
});

test("isVenmoFamilyUrl: a plain-http Venmo host and an opaque origin are both rejected", () => {
  // venmo.com's own chain terminates on http://account.venmo.com:8080/ — a
  // downgraded origin whose credentialed fetch is blocked as mixed content.
  assert.equal(isVenmoFamilyUrl("http://account.venmo.com:8080/"), false);
  assert.equal(isVenmoFamilyUrl("http://venmo.com/"), false);
  assert.equal(isVenmoFamilyUrl("about:blank"), false);
  assert.equal(isVenmoFamilyUrl("not a url"), false);
});

test("ensureVenmoOrigin: a post-sign-in page on id.venmo.com re-navigates to venmo.com instead of failing the run", async () => {
  // The exact production shape: the owner signed in at id.venmo.com, so the
  // page sits there when the probe runs. Attempt 1 gets bounced back to
  // id.venmo.com by Venmo's app; attempt 2 lands.
  const { gotoUrls, page } = makeRedirectingPage("https://id.venmo.com/signin", (attempt) =>
    attempt === 1 ? "https://id.venmo.com/signin" : "https://venmo.com/"
  );
  await assert.doesNotReject(
    ensureVenmoOrigin(page),
    "a real sign-in landing on id.venmo.com must not terminal the run"
  );
  assert.deepEqual(
    gotoUrls,
    ["https://venmo.com/", "https://venmo.com/"],
    "the guard must re-navigate, bounded to one extra attempt"
  );
});

// The CONFIRMED production shape, captured by PDPP_BROWSER_SURFACE_DIAGNOSTICS
// on run_1787151856448 / connection cin_94f4a295dda3f17d0f307a33:
//   phase interaction_start    -> surface url https://id.venmo.com/signin
//   phase interaction_response -> surface url https://account.venmo.com/
//                                 (response_status: "success")
// The owner signed in successfully and the page came to rest on
// account.venmo.com. That host is the post-login landing origin and MUST be
// accepted as a legitimate place to navigate back from.
test("ensureVenmoOrigin: the confirmed post-login rest origin https://account.venmo.com/ is accepted, not rejected (run_1787151856448)", async () => {
  assert.equal(
    isVenmoFamilyUrl("https://account.venmo.com/"),
    true,
    "the observed post-login landing origin must be in the family set"
  );
  const { gotoUrls, page } = makeRedirectingPage("https://account.venmo.com/", (attempt) =>
    attempt === 1 ? "https://account.venmo.com/" : "https://venmo.com/"
  );
  await assert.doesNotReject(
    ensureVenmoOrigin(page),
    "a successful sign-in resting on account.venmo.com must not terminal the run"
  );
  assert.equal(new URL(page.url()).origin, "https://venmo.com", "and must end on the CORS-granted origin");
  assert.equal(gotoUrls.length, 2);
});

test("ensureVenmoOrigin: a navigation Venmo redirects to account.venmo.com still ends on the CORS-granted origin", async () => {
  const { gotoUrls, page } = makeRedirectingPage("about:blank", (attempt) =>
    attempt === 1 ? "https://account.venmo.com/account" : "https://venmo.com/"
  );
  await assert.doesNotReject(ensureVenmoOrigin(page));
  assert.equal(
    new URL(page.url()).origin,
    "https://venmo.com",
    "the probe's credentialed fetch needs this exact origin"
  );
  assert.equal(gotoUrls.length, 2);
});

// The guard must NOT become a no-op: a family host that never converges to
// venmo.com still fails, because the credentialed api.venmo.com fetch
// genuinely cannot run from id.venmo.com.
test("ensureVenmoOrigin: a page stuck on a Venmo family host that never reaches venmo.com still fails loudly", async () => {
  const { gotoUrls, page } = makeRedirectingPage("https://id.venmo.com/signin", "https://id.venmo.com/signin");
  await assert.rejects(ensureVenmoOrigin(page), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /venmo_origin_navigation_failed/);
    return true;
  });
  assert.equal(gotoUrls.length, 2, "bounded: exactly one re-navigation, never an unbounded loop");
});

test("ensureVenmoOrigin: landing on a genuinely unexpected origin fails with the named error and does not echo the hostile host", async () => {
  const { gotoUrls, page } = makeRedirectingPage("about:blank", "https://evil-venmo.com/harvest?session=SECRETVALUE");
  await assert.rejects(ensureVenmoOrigin(page), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /venmo_origin_navigation_failed/, "an unexpected landing must still fail loudly");
    assert.doesNotMatch(err.message, /evil-venmo/, "an attacker-chosen hostname must not be echoed to the owner");
    assert.doesNotMatch(err.message, /SECRETVALUE/, "no path/query may ride along into connector_error_json");
    return true;
  });
  assert.equal(gotoUrls.length, 1, "a non-family landing must NOT get a second navigation attempt");
});

test("ensureVenmoOrigin: an already-on-venmo.com page performs no navigation at all (COUNTERWEIGHT)", async () => {
  const { gotoUrls, page } = makeRedirectingPage("https://venmo.com/account", "https://venmo.com/");
  await assert.doesNotReject(ensureVenmoOrigin(page));
  assert.deepEqual(
    gotoUrls,
    [],
    "already on the CORS-granted origin — re-navigating would discard page state for nothing"
  );
});

test("probeVenmoAccount: normal live and dead sessions are unaffected by the bound (COUNTERWEIGHT)", async () => {
  const makePage = (outcome: unknown): Page =>
    ({
      evaluate: (): Promise<unknown> => Promise.resolve(outcome),
      goto: (): Promise<null> => Promise.resolve(null),
      url: (): string => "https://venmo.com/",
    }) as unknown as Page;

  const live = await probeVenmoAccount(makePage({ kind: "live", ownerId: "42" }), "pre_submit", {
    evaluateTimeoutMs: 50,
  });
  assert.deepEqual(live, { live: true, ownerId: "42" });

  const dead = await probeVenmoAccount(makePage({ kind: "dead" }), "pre_submit", { evaluateTimeoutMs: 50 });
  assert.deepEqual(dead, { live: false, ownerId: null });
});

// ─── Step one carries an UNNAMED password input (production run_1787319714987) ───
//
// GROUND TRUTH, from this file's own live CDP reading of `run_1787164654406`
// (quoted above the two-step fixtures): Venmo's step-one sign-in screen renders
// BOTH inputs at once —
//
//   {t: INPUT, ty: password, n: "",            dis: false, vis: true}
//   {t: INPUT, ty: email,    n: "login_email",  dis: false, vis: true}
//
// The password field is UNNAMED. `makeTwoStepVenmoPage` models the password
// field as matching `input[name="password"]`, so its step-one screen answers
// "not visible" to every PASSWORD_SELECTOR read. The real page does not: the
// unnamed field matches PASSWORD_SELECTOR's third alternative,
// `input[type="password"]`, on screen ONE.
//
// That difference is the whole defect. `fillVenmoPassword` opens with
//
//   if (await locatorIsVisible(page.locator(PASSWORD_SELECTOR).first())) {
//     await passwordIn.fill(password); return null;   // "one-screen form"
//   }
//
// so against the real page it types the password into the step-one form and
// returns WITHOUT clicking `Next`. `loginWithSavedCredentials` then treats that
// as "password filled, ready to submit", clicks the only control present
// (`Next`), and thereby submits the IDENTIFIER alone. Venmo stays on step one,
// the post-submit probe reads dead, and the run hands off at venmo.ts:1010 with
// "automated sign-in did not complete" — the post_submit copy — even though no
// password was ever submitted.
//
// This reproduces production `run_1787319714987`: run.started 13:41:55.098,
// interaction_required 13:42:00.620. Five seconds, because NO bounded wait is
// ever entered — the password branch short-circuits immediately and every other
// step is a fast DOM read. The owner's screenshot at handoff showed a pristine
// "Log in / Enter email, mobile, or username / Next / Sign up" screen, which is
// exactly step one, consistent with the identifier having been submitted into
// a form that then re-rendered itself.
function makeVenmoStepOneWithUnnamedPasswordPage({
  captchaVisible = false,
  passwordAppearsAfterNext = true,
  onGoto,
}: {
  captchaVisible?: boolean;
  onGoto?: (url: string) => void;
  passwordAppearsAfterNext?: boolean;
} = {}): {
  clicks: string[];
  fillCalls: Record<string, string>;
  page: Page;
} {
  const clicks: string[] = [];
  const fillCalls: Record<string, string> = {};
  let onPasswordScreen = false;
  let probeCount = 0;
  let currentUrl = "https://id.venmo.com/signin?country.x=US";

  // The unnamed step-one password box. Visible and enabled from the very first
  // paint — the fact `makeTwoStepVenmoPage` cannot express.
  const unnamedPassword: Pick<Locator, "click" | "count" | "fill" | "first" | "isEnabled" | "isVisible" | "waitFor"> = {
    click: (): Promise<void> => Promise.resolve(),
    count: (): Promise<number> => Promise.resolve(1),
    fill: (value: string): Promise<void> => {
      // Records WHICH screen the password was typed on. Typing on step one is
      // the bug; typing on step two is correct behavior.
      fillCalls[onPasswordScreen ? "password" : "passwordOnStepOne"] = value;
      return Promise.resolve();
    },
    first(): Locator {
      return unnamedPassword as Locator;
    },
    isEnabled: (): Promise<boolean> => Promise.resolve(true),
    isVisible: (): Promise<boolean> => Promise.resolve(true),
    waitFor: (): Promise<void> => Promise.resolve(),
  };

  const advance = (via: string): void => {
    clicks.push(via);
    if (passwordAppearsAfterNext) {
      onPasswordScreen = true;
    }
  };

  const page: Pick<
    Page,
    "evaluate" | "getByRole" | "goto" | "locator" | "url" | "waitForLoadState" | "waitForTimeout"
  > = {
    // biome-ignore lint/suspicious/useAwait: mirrors Playwright's Promise-returning signature
    async evaluate(): Promise<unknown> {
      probeCount += 1;
      // Live ONLY once the real password has been submitted on screen two.
      // Submitting a bare identifier can never produce a live session.
      return probeCount > 1 && fillCalls.password !== undefined
        ? { kind: "live", ownerId: "1234567890123456789" }
        : { kind: "dead" };
    },
    getByRole: (): Locator =>
      makeClickRecordingLocator(() => advance(onPasswordScreen ? "role-submit-password" : "role-submit-identifier")),
    goto(url: string): ReturnType<Page["goto"]> {
      onGoto?.(url);
      currentUrl = url;
      // A fresh navigation to the login page resets to screen one, exactly as
      // the real site does.
      onPasswordScreen = false;
      return Promise.resolve(null);
    },
    locator(selector: string): Locator {
      if (selector === "body") {
        return makeLocator({ innerText: "Log in Enter email, mobile, or username Next Sign up" });
      }
      if (selector.includes("login_email")) {
        return makeFillRecordingLocator((value) => {
          fillCalls.username = value;
        });
      }
      // PASSWORD_SELECTOR is a union; the connector passes it whole. The real
      // page's unnamed field matches via `input[type="password"]`, so the union
      // resolves to a VISIBLE locator on screen one.
      if (selector.includes('input[type="password"]')) {
        return unnamedPassword as Locator;
      }
      if (selector.includes("otp") || selector.includes("code")) {
        return makeLocator({ count: 0, visible: false });
      }
      if (selector === "#btnNext") {
        return onPasswordScreen
          ? makeLocator({ count: 0, visible: false })
          : makeClickRecordingLocator(() => advance("btnNext"));
      }
      if (selector === 'button[type="submit"]') {
        return makeClickRecordingLocator(() => advance("generic-submit"));
      }
      if (selector.includes("recaptcha") || selector.includes("paypalobjects")) {
        return makeLocator({ count: captchaVisible ? 1 : 0, visible: captchaVisible });
      }
      return makeLocator({ count: 0, visible: false });
    },
    url: (): string => currentUrl,
    waitForLoadState: (): ReturnType<Page["waitForLoadState"]> => Promise.resolve(),
    waitForTimeout: (): ReturnType<Page["waitForTimeout"]> => Promise.resolve(),
  };

  return { clicks, fillCalls, page: page as Page };
}

test("ensureVenmoSession: step one's UNNAMED password input must not be mistaken for a one-screen form (production run_1787319714987)", async () => {
  await withVenmoCredentials(async () => {
    const { fillCalls, page } = makeVenmoStepOneWithUnnamedPasswordPage();
    const { requests, sendInteraction } = recordingSendInteraction();

    const result = await ensureVenmoSession({
      credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
      page,
      sendInteraction,
    });

    // The load-bearing assertion: the password must never be typed into screen
    // one. Before the fix this records `passwordOnStepOne` and the run ends in
    // an owner handoff having submitted only the identifier.
    assert.equal(
      fillCalls.passwordOnStepOne,
      undefined,
      "the password must never be typed into the step-one form — only the identifier belongs there"
    );
    assert.equal(fillCalls.username, "test-user", "the identifier must still be filled on screen one");
    assert.equal(fillCalls.password, "test-password", "the password must be typed on screen two, after Next");
    assert.equal(result.live, true, "a correct two-step sign-in establishes a live session");
    assert.deepEqual(requests, [], "a sign-in the connector can complete must not involve the owner at all");
  });
});

// ─── The handoff must not destroy the screen it asks the owner to act on ────
//
// `waitForManualLogin` used to navigate to LOGIN_URL unconditionally, right
// before handing the page over. That discarded the exact state the owner was
// being asked to operate on. The captcha handoff is the sharpest case: it says
// "complete the challenge", then navigates away from the challenge.
//
// The navigation still exists for the case it was written for (F2: a fresh run
// whose page is `about:blank` must not be handed over blank) — see the
// COUNTERWEIGHT below.
test("ensureVenmoSession: a captcha handoff preserves the live id.venmo.com challenge instead of navigating away from it", async () => {
  await withVenmoCredentials(async () => {
    // `makeTwoStepVenmoPage` is the right fixture here: its step-one screen has
    // no visible password box, so the flow advances past the identifier, stalls
    // waiting for screen two, finds the captcha, and takes the `reason:
    // "captcha"` handoff — the branch under test. Its page sits on
    // id.venmo.com throughout.
    const gotoUrls: string[] = [];
    const { page } = makeTwoStepVenmoPage({
      captchaVisible: true,
      passwordAppearsAfterNext: false,
    });
    const realGoto = page.goto.bind(page);
    page.goto = ((url: string, opts?: unknown) => {
      gotoUrls.push(url);
      return realGoto(url, opts as never);
    }) as Page["goto"];

    const { requests, sendInteraction } = recordingSendInteraction();

    await assert.rejects(
      ensureVenmoSession({
        credentials: { VENMO_PASSWORD: "test-password", VENMO_USERNAME: "test-user" },
        page,
        passwordScreenTimeoutMs: 20,
        sendInteraction,
      }),
      /venmo_login_incomplete_after_submit/
    );

    const captchaRequest = requests.find((req): boolean => /CAPTCHA|verification challenge/i.test(req.message ?? ""));
    assert.ok(captchaRequest, "a rendered captcha must reach the owner");
    // The load-bearing fact: between rendering the captcha and handing the page
    // to the owner, nothing re-navigated to the login page. `gotoUrls` before
    // the handoff is exactly the initial probe's `venmo.com/` plus the sign-in
    // navigation `loginWithSavedCredentials` makes to reach the form. The
    // trailing `venmo.com/` is the post-response re-probe establishing the
    // CORS origin, which necessarily happens AFTER the owner is done.
    assert.deepEqual(
      gotoUrls.slice(0, 2),
      ["https://venmo.com/", "https://venmo.com/login"],
      "only the initial probe and the sign-in navigation may precede a captcha handoff"
    );
    assert.equal(
      gotoUrls.filter((url): boolean => url === "https://venmo.com/login").length,
      1,
      "the captcha screen the owner was asked to solve must not be re-navigated away by the handoff itself"
    );
  });
});

test("isVenmoSignInUrl: only the https identity host counts as a live sign-in screen (COUNTERWEIGHT)", () => {
  assert.equal(isVenmoSignInUrl("https://id.venmo.com/signin?country.x=US"), true);
  // Real Venmo, but not a page the owner can sign in from — these must still
  // be navigated to the login page, which is what keeps F2 true.
  assert.equal(isVenmoSignInUrl("https://venmo.com/"), false, "the logged-out home page is not a sign-in screen");
  assert.equal(isVenmoSignInUrl("https://account.venmo.com/"), false);
  assert.equal(isVenmoSignInUrl("about:blank"), false, "a fresh run's blank page must still be navigated (F2)");
  assert.equal(isVenmoSignInUrl("http://id.venmo.com/signin"), false, "a downgraded origin is not trusted");
  assert.equal(isVenmoSignInUrl("https://id.venmo.com.evil.example/signin"), false, "a lookalike host is rejected");
});
