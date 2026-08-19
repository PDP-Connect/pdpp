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
  ensureVenmoSession,
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
        ["username", "password", "submit-role", "otp"],
        "every capture must record all four selector candidates the connector relies on"
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
