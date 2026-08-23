// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContext, Locator, Page } from "playwright";
import type { InteractionRequest, InteractionResponse } from "../connector-runtime.ts";
import type { CaptureSession } from "../fixture-capture.ts";
import { classifyUsaaLoginStepFailure, ensureUsaaSession } from "./usaa.ts";

const DASHBOARD_URL = "https://www.usaa.com/my/usaa";
const LOGIN_URL = "https://www.usaa.com/my/logon";
const STREAMING_ENV_KEYS = [
  "PDPP_RUN_ID",
  "PDPP_REFERENCE_BASE_URL",
  "PDPP_STREAMING_REGISTRATION_TOKEN",
  "PDPP_LOCAL_DEVICE_TOKEN",
] as const;

type BrowserCookie = Awaited<ReturnType<BrowserContext["cookies"]>>[number];

interface FakePageHarness {
  gotoCalls: string[];
  page: Page;
}

interface InteractionHarness {
  requests: InteractionRequest[];
  sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
}

function makeCookie(name: string, value: string): BrowserCookie {
  return {
    domain: ".usaa.com",
    expires: -1,
    httpOnly: false,
    name,
    path: "/",
    sameSite: "Lax",
    secure: true,
    value,
  };
}

function makeContext(cookieBatches: BrowserCookie[][], isAuthenticated?: () => boolean): BrowserContext {
  let calls = 0;
  const fake: Pick<BrowserContext, "cookies"> = {
    cookies(..._urls: Parameters<BrowserContext["cookies"]>): ReturnType<BrowserContext["cookies"]> {
      if (isAuthenticated?.()) {
        return Promise.resolve([makeCookie("UsaaMbWebMemberLoggedIn", "true")]);
      }
      const batch = cookieBatches[Math.min(calls, Math.max(cookieBatches.length - 1, 0))] ?? [];
      calls += 1;
      return Promise.resolve(batch);
    },
  };
  return fake as BrowserContext;
}

function makePage(loginError: Error, bodyText = "Log Off"): FakePageHarness {
  const gotoCalls: string[] = [];
  const bodyLocator: Pick<Locator, "innerText"> = {
    innerText: (): Promise<string> => Promise.resolve(bodyText),
  };
  const fake: Pick<Page, "goto" | "locator" | "waitForTimeout"> = {
    goto(url: string, _options?: Parameters<Page["goto"]>[1]): ReturnType<Page["goto"]> {
      gotoCalls.push(url);
      if (url === LOGIN_URL) {
        return Promise.reject(loginError);
      }
      return Promise.resolve(null);
    },
    locator(_selector: string, _options?: Parameters<Page["locator"]>[1]): Locator {
      return bodyLocator as Locator;
    },
    waitForTimeout(_ms: number): Promise<void> {
      return Promise.resolve();
    },
  };
  return { gotoCalls, page: fake as Page };
}

function makeInteractionHarness(
  status: InteractionResponse["status"] = "success",
  data?: InteractionResponse["data"]
): InteractionHarness {
  const requests: InteractionRequest[] = [];
  return {
    requests,
    sendInteraction(req: InteractionRequest): Promise<InteractionResponse> {
      requests.push(req);
      return Promise.resolve({
        ...(data ? { data } : {}),
        request_id: req.request_id ?? "test_interaction",
        status,
        type: "INTERACTION_RESPONSE",
      });
    },
  };
}

function makePasswordStepFailurePage(bodyText: string, dashboardBodyText?: string): Page {
  const memberIdLocator: Pick<Locator, "press"> = {
    press: (): Promise<void> => Promise.resolve(),
  };
  const nextButtonLocator: Pick<Locator, "waitFor"> = {
    waitFor: (): Promise<void> => Promise.resolve(),
  };
  // Tracks the most recent goto target so a post-manual-action re-probe that
  // navigates to the dashboard sees dashboardBodyText (e.g. "Log Off")
  // instead of the login page's failure text, matching real USAA behavior.
  let currentUrl = `${LOGIN_URL}?akredirect=true`;
  const bodyLocator: Pick<Locator, "innerText"> = {
    innerText: (): Promise<string> =>
      Promise.resolve(currentUrl === DASHBOARD_URL && dashboardBodyText !== undefined ? dashboardBodyText : bodyText),
  };
  const fake: Partial<Page> = {};
  fake.click = (): Promise<void> => Promise.resolve();
  fake.evaluate = (async (): Promise<Array<{ name: string; placeholder: string; type: string }>> => [
    { name: "memberId", placeholder: "", type: "text" },
  ]) as Page["evaluate"];
  fake.fill = (): Promise<void> => Promise.resolve();
  fake.getByRole = (() => {
    const empty: Pick<Locator, "count" | "isVisible" | "nth"> = {
      count: (): Promise<number> => Promise.resolve(0),
      isVisible: (): Promise<boolean> => Promise.resolve(false),
      nth: (): Locator => empty as Locator,
    };
    return empty as Locator;
  }) as Page["getByRole"];
  fake.goto = ((url: string): ReturnType<Page["goto"]> => {
    currentUrl = url;
    return Promise.resolve(null);
  }) as Page["goto"];
  fake.locator = ((selector: string): Locator => {
    if (selector === "#next-button:not([disabled])") {
      return nextButtonLocator as Locator;
    }
    if (selector === 'input[name="memberId"]') {
      return memberIdLocator as Locator;
    }
    return bodyLocator as Locator;
  }) as Page["locator"];
  fake.waitForSelector = ((selector: string): Promise<never> => {
    if (selector === 'input[name="password"]') {
      return Promise.reject(new Error("password field unavailable"));
    }
    return Promise.resolve({} as never);
  }) as Page["waitForSelector"];
  fake.waitForTimeout = (): Promise<void> => Promise.resolve();
  fake.url = (): string => currentUrl;
  return fake as Page;
}

type SourceUnavailableRecoveryFixture =
  | "action_error"
  | "ambiguous"
  | "foreign_origin"
  | "member_id_form_missing"
  | "resume_error"
  | "selected";

function makeSourceUnavailableRecoveryPage(fixture: SourceUnavailableRecoveryFixture): {
  actionClicks: number;
  filledSelectors: string[];
  filledValues: Array<{ selector: string; value: string }>;
  otpResponseAuthenticated: boolean;
  page: Page;
  roleQueries: Array<{ name: unknown; role: string }>;
  textCodeChoiceClicks: number;
} {
  let actionClicked = false;
  let actionClicks = 0;
  let otpChallengeActive = false;
  let otpResponseAuthenticated = false;
  let otpResponse = "";
  let textCodeChoiceClicks = 0;
  let passwordFieldReady = false;
  let currentUrl = LOGIN_URL;
  const filledSelectors: string[] = [];
  const filledValues: Array<{ selector: string; value: string }> = [];
  const roleQueries: Array<{ name: unknown; role: string }> = [];
  const actionCount = fixture === "ambiguous" ? 2 : 1;
  const memberIdLocator: Pick<Locator, "press"> = {
    press: (): Promise<void> => Promise.resolve(),
  };
  const nextButtonLocator: Pick<Locator, "waitFor"> = {
    waitFor: (): Promise<void> => Promise.resolve(),
  };
  const bodyLocator: Pick<Locator, "innerText"> = {
    innerText: (): Promise<string> => {
      if (currentUrl === DASHBOARD_URL) {
        return Promise.resolve("Log Off");
      }
      if (otpChallengeActive) {
        return Promise.resolve("Text security code");
      }
      return Promise.resolve("We are unable to complete your request. Our system is currently unavailable.");
    },
  };
  const otpInputLocator: Pick<Locator, "fill" | "first" | "isEnabled" | "isVisible"> = {
    fill: (code: string): Promise<void> => {
      otpResponse = code;
      return Promise.resolve();
    },
    first: (): Locator => otpInputLocator as Locator,
    isEnabled: (): Promise<boolean> => Promise.resolve(otpChallengeActive),
    isVisible: (): Promise<boolean> => Promise.resolve(otpChallengeActive),
  };
  // The delivery control. Clicking this is what makes the real USAA send an
  // SMS, so the fixture records every click on it: a test asserting zero
  // dispatches is asserting on this counter, not merely on prompt count.
  const textCodeChoiceLocator: Pick<Locator, "click" | "first" | "isEnabled" | "isVisible"> = {
    click: (): Promise<void> => {
      textCodeChoiceClicks += 1;
      return Promise.resolve();
    },
    first: (): Locator => textCodeChoiceLocator as Locator,
    isEnabled: (): Promise<boolean> => Promise.resolve(true),
    isVisible: (): Promise<boolean> => Promise.resolve(true),
  };
  const actionLocator = (count: number, index: number): Locator => {
    const locator: Pick<Locator, "click" | "count" | "isVisible" | "nth"> = {
      click: (): Promise<void> => {
        if (fixture === "action_error") {
          return Promise.reject(new Error("action click failed"));
        }
        actionClicks += 1;
        actionClicked = true;
        currentUrl = fixture === "foreign_origin" ? "https://example.invalid/login" : LOGIN_URL;
        return Promise.resolve();
      },
      count: (): Promise<number> => Promise.resolve(count),
      isVisible: (): Promise<boolean> => Promise.resolve(index < count),
      nth: (nextIndex: number): Locator => actionLocator(count, nextIndex),
    };
    return locator as Locator;
  };
  const fake: Partial<Page> = {};
  fake.click = ((selector: string): Promise<void> => {
    if (selector === "#next-button") {
      if (actionClicked && !passwordFieldReady) {
        passwordFieldReady = true;
      } else if (passwordFieldReady) {
        otpChallengeActive = true;
      }
    }
    if (selector === 'button[type="submit"], #next-button' && otpChallengeActive) {
      otpResponseAuthenticated = otpResponse === "123456";
    }
    return Promise.resolve();
  }) as Page["click"];
  fake.evaluate = ((): Promise<Array<{ name: string; placeholder: string; type: string }>> =>
    Promise.resolve([{ name: "memberId", placeholder: "", type: "text" }])) as Page["evaluate"];
  fake.fill = ((selector: string, value: string): Promise<void> => {
    filledSelectors.push(selector);
    filledValues.push({ selector, value });
    if (fixture === "resume_error" && actionClicked && selector === 'input[name="memberId"]') {
      return Promise.reject(new Error("resumed member-id fill failed"));
    }
    return Promise.resolve();
  }) as Page["fill"];
  fake.getByRole = ((role: "button" | "link", options: { name?: unknown }): Locator => {
    roleQueries.push({ name: options.name, role });
    return actionLocator(role === "button" ? actionCount : 0, 0);
  }) as Page["getByRole"];
  fake.goto = ((url: string): ReturnType<Page["goto"]> => {
    currentUrl = url;
    return Promise.resolve(null);
  }) as Page["goto"];
  fake.locator = ((selector: string): Locator => {
    if (selector === "#next-button:not([disabled])") {
      return nextButtonLocator as Locator;
    }
    if (selector === 'input[name="memberId"]') {
      return memberIdLocator as Locator;
    }
    if (selector.includes("one-time-code")) {
      return otpInputLocator as Locator;
    }
    if (selector.includes("Text security code to:")) {
      return textCodeChoiceLocator as Locator;
    }
    return bodyLocator as Locator;
  }) as Page["locator"];
  fake.waitForLoadState = ((): Promise<void> => Promise.resolve()) as Page["waitForLoadState"];
  fake.waitForSelector = ((selector: string): Promise<unknown> => {
    if (selector === 'input[name="password"]' && !passwordFieldReady) {
      return Promise.reject(new Error("password field unavailable"));
    }
    if (selector === 'input[name="memberId"]' && actionClicked && fixture === "member_id_form_missing") {
      return Promise.reject(new Error("member-id form unavailable"));
    }
    if (selector.includes("one-time-code") && !otpChallengeActive) {
      return Promise.reject(new Error("OTP challenge unavailable"));
    }
    return Promise.resolve({});
  }) as Page["waitForSelector"];
  fake.waitForTimeout = (): Promise<void> => Promise.resolve();
  fake.url = (): string => currentUrl;
  return {
    get actionClicks(): number {
      return actionClicks;
    },
    filledSelectors,
    filledValues,
    get otpResponseAuthenticated(): boolean {
      return otpResponseAuthenticated;
    },
    page: fake as Page,
    roleQueries,
    get textCodeChoiceClicks(): number {
      return textCodeChoiceClicks;
    },
  };
}

test("ensureUsaaSession uses the resolved USAA_USERNAME, never connector identity or ambient env", async () => {
  const priorUsername = process.env.USAA_USERNAME;
  const priorPassword = process.env.USAA_PASSWORD;
  process.env.USAA_USERNAME = "usaa";
  process.env.USAA_PASSWORD = "ambient-password";
  try {
    const fixturePage = makeSourceUnavailableRecoveryPage("selected");
    const context = makeContext([[], [makeCookie("UsaaMbWebMemberLoggedIn", "true")]]);
    const interactions = makeInteractionHarness("success", { code: "123456" });

    const ok = await ensureUsaaSession({
      context,
      credentials: { USAA_PASSWORD: "saved-password", USAA_USERNAME: "saved-online-id" },
      page: fixturePage.page,
      sendInteraction: interactions.sendInteraction,
    });

    assert.equal(ok, true);
    assert.equal(
      fixturePage.filledValues.find(({ selector }) => selector === 'input[name="memberId"]')?.value,
      "saved-online-id"
    );
    assert.notEqual(
      fixturePage.filledValues.find(({ selector }) => selector === 'input[name="memberId"]')?.value,
      "usaa"
    );
  } finally {
    if (priorUsername === undefined) {
      delete process.env.USAA_USERNAME;
    } else {
      process.env.USAA_USERNAME = priorUsername;
    }
    if (priorPassword === undefined) {
      delete process.env.USAA_PASSWORD;
    } else {
      process.env.USAA_PASSWORD = priorPassword;
    }
  }
});

function makePostPasswordSourceUnavailablePage(bodyText: string): Page {
  const nextButtonLocator: Pick<Locator, "waitFor"> = {
    waitFor: (): Promise<void> => Promise.resolve(),
  };
  const bodyLocator: Pick<Locator, "innerText"> = {
    innerText: (): Promise<string> => Promise.resolve(bodyText),
  };
  const fake: Partial<Page> = {};
  fake.click = (): Promise<void> => Promise.resolve();
  fake.evaluate = (async (): Promise<
    Array<{ name: string; placeholder: string; type: string }>
  > => []) as Page["evaluate"];
  fake.fill = (): Promise<void> => Promise.resolve();
  fake.goto = (): ReturnType<Page["goto"]> => Promise.resolve(null);
  fake.locator = ((selector: string): Locator => {
    if (selector === "#next-button:not([disabled])") {
      return nextButtonLocator as Locator;
    }
    return bodyLocator as Locator;
  }) as Page["locator"];
  // Both memberId->Next and password->Next steps succeed; USAA only fails
  // after the password submit, rendering the unavailable page instead of an
  // authenticated dashboard.
  fake.waitForSelector = (): Promise<never> => Promise.resolve({} as never);
  fake.waitForTimeout = (): Promise<void> => Promise.resolve();
  fake.url = (): string => DASHBOARD_URL;
  return fake as Page;
}

async function withUsaaCredentialValues(
  credentials: { password?: string; username?: string },
  run: () => Promise<void>
): Promise<void> {
  const priorUsername = process.env.USAA_USERNAME;
  const priorPassword = process.env.USAA_PASSWORD;
  const priorStreamingEnv = new Map<(typeof STREAMING_ENV_KEYS)[number], string | undefined>();
  for (const key of STREAMING_ENV_KEYS) {
    priorStreamingEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  if (credentials.username) {
    process.env.USAA_USERNAME = credentials.username;
  }
  if (credentials.password) {
    process.env.USAA_PASSWORD = credentials.password;
  }
  try {
    await run();
  } finally {
    if (priorUsername === undefined) {
      delete process.env.USAA_USERNAME;
    } else {
      process.env.USAA_USERNAME = priorUsername;
    }
    if (priorPassword === undefined) {
      delete process.env.USAA_PASSWORD;
    } else {
      process.env.USAA_PASSWORD = priorPassword;
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

async function withUsaaCredentials(run: () => Promise<void>): Promise<void> {
  await withUsaaCredentialValues({ password: "test-password", username: "test-user" }, run);
}

async function withoutUsaaCredentials(run: () => Promise<void>): Promise<void> {
  await withUsaaCredentialValues({}, run);
}

test("ensureUsaaSession hands off to the secure browser when optional credentials are absent", async () => {
  await withoutUsaaCredentials(async () => {
    const context = makeContext([[], [makeCookie("UsaaMbWebMemberLoggedIn", "true")]]);
    const { gotoCalls, page } = makePage(new Error(`page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at ${LOGIN_URL}`));
    const interactions = makeInteractionHarness();

    const ok = await ensureUsaaSession({
      context,
      page,
      sendInteraction: interactions.sendInteraction,
    });

    assert.equal(ok, true);
    assert.deepEqual(gotoCalls, [LOGIN_URL, DASHBOARD_URL]);
    assert.equal(interactions.requests.length, 1);
    assert.equal(interactions.requests[0]?.kind, "manual_action");
    assert.match(interactions.requests[0]?.message ?? "", /No optional USAA sign-in details/);
    assert.match(interactions.requests[0]?.message ?? "", /secure browser/);
    assert.doesNotMatch(interactions.requests[0]?.message ?? "", /password|test-user/u);
  });
});

test("ensureUsaaSession emits manual_action when USAA login navigation trips HTTP/2 bot failure", async () => {
  await withUsaaCredentials(async () => {
    const context = makeContext([[], [makeCookie("UsaaMbWebMemberLoggedIn", "true")]]);
    const { gotoCalls, page } = makePage(
      new Error(`page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at ${LOGIN_URL}\nCall log:`)
    );
    const interactions = makeInteractionHarness();

    const ok = await ensureUsaaSession({
      context,
      page,
      sendInteraction: interactions.sendInteraction,
    });

    assert.equal(ok, true);
    assert.deepEqual(gotoCalls, [LOGIN_URL, DASHBOARD_URL]);
    assert.equal(interactions.requests.length, 1);
    assert.equal(interactions.requests[0]?.kind, "manual_action");
    assert.match(
      interactions.requests[0]?.message ?? "",
      /USAA could not finish sign-in automatically; open the browser to continue\. PDPP resumes when sign-in succeeds\./
    );
    assert.doesNotMatch(interactions.requests[0]?.message ?? "", /url=|inputs=|body-preview=/);
    assert.doesNotMatch(
      interactions.requests[0]?.message ?? "",
      /PDPP_BROWSER_HEADLESS|automated browser mode|respond success|cancel this interaction|rerun|xvfb-run|headless/i
    );
  });
});

test("ensureUsaaSession fails with diagnostic if manual login response does not establish a session", async () => {
  await withUsaaCredentials(async () => {
    const context = makeContext([[], []]);
    const { page } = makePage(new Error(`page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at ${LOGIN_URL}`));
    const interactions = makeInteractionHarness();

    await assert.rejects(
      ensureUsaaSession({
        context,
        page,
        sendInteraction: interactions.sendInteraction,
      }),
      /manual action did not establish a session/
    );
    assert.equal(interactions.requests.length, 1);
  });
});

test("ensureUsaaSession honors operator-completed login even when the interaction is cancelled", async () => {
  // The operator completed USAA login in the visible browser, then ended the
  // interaction as cancelled (timeout, or an explicit "I'm already in" cancel).
  // The session is live, so the connector must re-probe and continue rather
  // than trust the interaction status and kill the run. Mirrors the chatgpt
  // Cloudflare-fallback best practice.
  await withUsaaCredentials(async () => {
    const context = makeContext([[], [makeCookie("UsaaMbWebMemberLoggedIn", "true")]]);
    const { gotoCalls, page } = makePage(new Error(`page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at ${LOGIN_URL}`));
    const interactions = makeInteractionHarness("cancelled");

    const ok = await ensureUsaaSession({
      context,
      page,
      sendInteraction: interactions.sendInteraction,
    });

    assert.equal(ok, true);
    assert.deepEqual(gotoCalls, [LOGIN_URL, DASHBOARD_URL]);
    assert.equal(interactions.requests.length, 1);
    assert.equal(interactions.requests[0]?.kind, "manual_action");
  });
});

test("ensureUsaaSession fails when a cancelled interaction left no active session", async () => {
  // Cancelled interaction AND no live session → the run must end with the
  // re-probe diagnostic, not silently continue.
  await withUsaaCredentials(async () => {
    const context = makeContext([[], []]);
    const { page } = makePage(new Error(`page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at ${LOGIN_URL}`));
    const interactions = makeInteractionHarness("cancelled");

    await assert.rejects(
      ensureUsaaSession({
        context,
        page,
        sendInteraction: interactions.sendInteraction,
      }),
      /manual action did not establish a session/
    );
    assert.equal(interactions.requests.length, 1);
  });
});

test("ensureUsaaSession does not convert ordinary DNS navigation errors into manual_action", async () => {
  await withUsaaCredentials(async () => {
    const context = makeContext([[]]);
    const { page } = makePage(new Error(`page.goto: net::ERR_NAME_NOT_RESOLVED at ${LOGIN_URL}`));
    const interactions = makeInteractionHarness();

    await assert.rejects(
      ensureUsaaSession({
        context,
        page,
        sendInteraction: interactions.sendInteraction,
      }),
      /ERR_NAME_NOT_RESOLVED/
    );
    assert.equal(interactions.requests.length, 0);
  });
});

test("classifyUsaaLoginStepFailure distinguishes source downtime from selector drift", () => {
  assert.equal(
    classifyUsaaLoginStepFailure(
      "We are unable to complete your request. Our system is currently unavailable. Please try again later."
    ),
    "source_unavailable"
  );
  assert.equal(classifyUsaaLoginStepFailure("Member Account Login Username Next"), "password_field_missing");
});

test("classifyUsaaLoginStepFailure does not treat bare 'try again later' as source_unavailable", () => {
  // "try again later" is common boilerplate on challenge, lockout, and
  // rate-limit pages too — those need the genuine manual_action/diagnostic
  // path (an owner action or a real code-defect signal), not a suppressed
  // retry. Only the two phrases that specifically assert the provider's own
  // system is down should classify as source_unavailable.
  assert.equal(
    classifyUsaaLoginStepFailure(
      "Your account has been temporarily locked due to too many failed sign-in attempts. Please try again later."
    ),
    "password_field_missing"
  );
  assert.equal(
    classifyUsaaLoginStepFailure(
      "We could not verify you are human. Please complete the security challenge and try again later."
    ),
    "password_field_missing"
  );
  assert.equal(
    classifyUsaaLoginStepFailure("You have made too many requests. Please wait and try again later."),
    "password_field_missing"
  );
});

test("ensureUsaaSession follows exactly one visible semantic login action, then authenticates through OTP", async () => {
  await withUsaaCredentials(async () => {
    const fixturePage = makeSourceUnavailableRecoveryPage("selected");
    const { filledSelectors, page, roleQueries } = fixturePage;
    const context = makeContext([[]], () => fixturePage.otpResponseAuthenticated);
    const interactions = makeInteractionHarness("success", { code: "123456" });
    const structuralProbeCalls: Array<{ label: string; probeIds: string[] }> = [];
    const capture: CaptureSession = {
      baseDir: "/tmp/fake-usaa-capture",
      captureDom: (): Promise<void> => Promise.resolve(),
      captureHttp: (): void => {
        /* no-op */
      },
      captureLocatorProbe: (_page, label, probes): Promise<void> => {
        structuralProbeCalls.push({ label, probeIds: probes.map((probe) => probe.id) });
        return Promise.resolve();
      },
      finalize: (): void => {
        /* no-op */
      },
      keepOnSuccess: false,
      markSucceeded: (): void => {
        /* no-op */
      },
      registerSecrets: (): void => undefined,
      recordRecord: (): void => {
        /* no-op */
      },
      runId: "fake-run",
    };

    const ok = await ensureUsaaSession({
      capture,
      context,
      page,
      sendInteraction: interactions.sendInteraction,
    });

    assert.equal(ok, true);
    assert.equal(fixturePage.actionClicks, 1, "recovery follows the semantic action at most once");
    assert.deepEqual(
      roleQueries.map((query) => ({ name: String(query.name), role: query.role })),
      [
        { name: "/^(Log in|Log On)$/i", role: "button" },
        { name: "/^(Log in|Log On)$/i", role: "link" },
      ]
    );
    assert.deepEqual(filledSelectors, ['input[name="memberId"]', 'input[name="memberId"]', 'input[name="password"]']);
    assert.deepEqual(
      interactions.requests.map((request) => request.kind),
      ["otp"]
    );
    assert.equal(fixturePage.otpResponseAuthenticated, true, "the OTP response authenticates the recovered session");
    assert.deepEqual(structuralProbeCalls, [
      {
        label: "usaa-source-unavailable-login-action",
        probeIds: ["exact-login-button", "exact-login-link"],
      },
    ]);
  });
});

for (const [fixture, expectedOutcome] of [
  ["ambiguous", "ambiguous"],
  ["foreign_origin", "foreign_origin"],
  ["member_id_form_missing", "member_id_form_missing"],
  ["resume_error", "resume_error"],
  ["action_error", "action_error"],
] as const) {
  test(`ensureUsaaSession preserves manual_action when source-unavailable login recovery is ${fixture}`, async () => {
    await withUsaaCredentials(async () => {
      const fixturePage = makeSourceUnavailableRecoveryPage(fixture);
      const { page } = fixturePage;
      const context = makeContext([[], [makeCookie("UsaaMbWebMemberLoggedIn", "true")]]);
      const interactions = makeInteractionHarness();

      const ok = await ensureUsaaSession({
        context,
        page,
        sendInteraction: interactions.sendInteraction,
      });

      assert.equal(ok, true);
      assert.equal(interactions.requests.length, 1);
      assert.deepEqual(
        interactions.requests.map((request) => request.kind),
        ["manual_action"]
      );
      assert.match(
        interactions.requests[0]?.message ?? "",
        new RegExp(`source_unavailable_login_action=${expectedOutcome}`)
      );
      assert.equal(fixturePage.actionClicks, fixture === "ambiguous" || fixture === "action_error" ? 0 : 1);
    });
  });
}

test("ensureUsaaSession still routes a delayed USAA source-unavailable page after member-id submit to genuine manual_action, with an owner-visible diagnostic note", async () => {
  // Corrected 2026-07-10: this exact page (source-unavailable copy after the
  // memberId "Next" click, password field never appearing) is the connector's
  // dominant, weeks-long recurring failure mode per prior fixes' own commit
  // messages — not an intermittent condition. classifyUsaaLoginStepFailure
  // matching USAA's outage boilerplate does NOT prove the provider is down;
  // it could equally be a persistent automation-side condition (stale/blocked
  // profile, bot-detection challenge) that happens to render the same generic
  // copy. Only a human completing login in the visible browser can tell the
  // difference, so this must still route to manual_action — with the
  // classification surfaced as an owner-visible note, not used to bypass the
  // owner entirely.
  await withUsaaCredentials(async () => {
    const prefix = "Member Account Login ".repeat(80);
    const page = makePasswordStepFailurePage(
      `${prefix}We are unable to complete your request. Our system is currently unavailable. Please try again later.`,
      "Log Off"
    );
    const context = makeContext([[], [makeCookie("UsaaMbWebMemberLoggedIn", "true")]]);
    const interactions = makeInteractionHarness();

    const ok = await ensureUsaaSession({
      context,
      page,
      sendInteraction: interactions.sendInteraction,
    });

    assert.equal(ok, true);
    assert.equal(interactions.requests.length, 1);
    assert.equal(interactions.requests[0]?.kind, "manual_action");
    assert.match(
      interactions.requests[0]?.message ?? "",
      /USAA could not finish sign-in automatically; open the browser to continue\. PDPP resumes when sign-in succeeds\./
    );
    // The owner-visible note distinguishing this from an unrecognized stall.
    assert.match(
      interactions.requests[0]?.message ?? "",
      /USAA's page reported its own system as unavailable, but this exact failure has recurred/
    );
    assert.match(interactions.requests[0]?.message ?? "", /source_unavailable_login_action=absent/);
  });
});

test("ensureUsaaSession routes a lockout/challenge page containing 'try again later' to manual_action without the source-unavailable note", async () => {
  // Contrast case: a page that says "try again later" without either strong
  // provider-unavailable phrase (e.g. an account lockout or bot-challenge
  // page) must still reach manual_action, but WITHOUT the source-unavailable
  // diagnostic note — that note is specific to the narrower classification.
  await withUsaaCredentials(async () => {
    const prefix = "Member Account Login ".repeat(80);
    const page = makePasswordStepFailurePage(
      `${prefix}Your account has been temporarily locked due to too many failed sign-in attempts. Please try again later.`,
      "Log Off"
    );
    const context = makeContext([[], [makeCookie("UsaaMbWebMemberLoggedIn", "true")]]);
    const interactions = makeInteractionHarness();

    const ok = await ensureUsaaSession({
      context,
      page,
      sendInteraction: interactions.sendInteraction,
    });

    assert.equal(ok, true);
    assert.equal(interactions.requests.length, 1);
    assert.equal(interactions.requests[0]?.kind, "manual_action");
    assert.match(
      interactions.requests[0]?.message ?? "",
      /USAA could not finish sign-in automatically; open the browser to continue\. PDPP resumes when sign-in succeeds\./
    );
    assert.doesNotMatch(interactions.requests[0]?.message ?? "", /USAA's page reported its own system as unavailable/);
  });
});

test("ensureUsaaSession captures DOM/screenshot evidence on the password-field stall when a capture session is provided", async () => {
  // The missing discriminating evidence this whole investigation needed: a
  // screenshot/DOM/aria snapshot of the actual page at the moment of
  // failure. Wire `capture` through so the next occurrence produces that
  // evidence automatically instead of requiring another round of inference.
  await withUsaaCredentials(async () => {
    const prefix = "Member Account Login ".repeat(80);
    const page = makePasswordStepFailurePage(
      `${prefix}Your account has been temporarily locked due to too many failed sign-in attempts. Please try again later.`,
      "Log Off"
    );
    const context = makeContext([[], [makeCookie("UsaaMbWebMemberLoggedIn", "true")]]);
    const interactions = makeInteractionHarness();
    const captureCalls: Array<{ label: string }> = [];
    const capture: CaptureSession = {
      baseDir: "/tmp/fake-usaa-capture",
      keepOnSuccess: false,
      runId: "fake-run",
      captureDom: (_page, label): Promise<void> => {
        captureCalls.push({ label });
        return Promise.resolve();
      },
      captureHttp: (): void => {
        /* no-op */
      },
      finalize: (): void => {
        /* no-op */
      },
      markSucceeded: (): void => {
        /* no-op */
      },
      registerSecrets: (): void => undefined,
      recordRecord: (): void => {
        /* no-op */
      },
    };

    const ok = await ensureUsaaSession({
      capture,
      context,
      page,
      sendInteraction: interactions.sendInteraction,
    });

    assert.equal(ok, true);
    assert.deepEqual(
      captureCalls.map((c) => c.label),
      ["usaa-password-field-stall"]
    );
  });
});

test("ensureUsaaSession classifies USAA source-unavailable page rendered after password submit in the thrown diagnostic, without a false-certainty retryable claim", async () => {
  // Same provider-outage-shaped condition, but observed later in the flow:
  // memberId and password steps both proceed, and USAA renders the
  // unavailable page instead of an authenticated dashboard or OTP challenge.
  // Corrected 2026-07-10: this must NOT throw an untyped `source_unavailable:`
  // message claiming proven-retryable provider downtime — that was the
  // over-claim this fix reverts. The classification is folded into the
  // existing diagnostic error as a label for logs/classification, not used to
  // manufacture a false-certainty claim.
  await withUsaaCredentials(async () => {
    const context = makeContext([[], []]); // never establishes a logged-in cookie
    const page = makePostPasswordSourceUnavailablePage(
      "We are unable to complete your request. Our system is currently unavailable. Please try again later."
    );
    const interactions = makeInteractionHarness();

    const thrown = await ensureUsaaSession({
      context,
      page,
      sendInteraction: interactions.sendInteraction,
    }).then(
      (): never => {
        throw new Error("expected ensureUsaaSession to reject");
      },
      (err: unknown): Error => err as Error
    );

    assert.match(thrown.message, /classification=source_unavailable/);
    assert.match(thrown.message, /USAA login completed but no verified authenticated dashboard session was detected/);
    assert.doesNotMatch(thrown.message, /^source_unavailable:/);
    // This path never had a manual_action interaction before #294 either —
    // preserved, not newly added.
    assert.equal(interactions.requests.length, 0);
  });
});

// ─── post-submit retry-safety marker (systemic credential-submit fix) ──────
//
// USAA_RETRYABLE_PATTERN deliberately includes `source_unavailable` (a real
// pre-submit legitimate case) alongside a bare `timeout` term — the exact
// naming collision the audit found. The fix does not touch the pattern; it
// marks the credential-submit boundary so the runtime forces
// retryable:false for anything AFTER that point regardless of the pattern.
test("ensureUsaaSession calls onCredentialSubmit exactly once, immediately after the password click and before any post-submit read/capture", async () => {
  await withUsaaCredentials(async () => {
    const context = makeContext([[], []]);
    const page = makePostPasswordSourceUnavailablePage(
      "We are unable to complete your request. Our system is currently unavailable. Please try again later."
    );
    const interactions = makeInteractionHarness();
    const calls: string[] = [];
    const originalClick = page.click;
    page.click = ((...args: Parameters<Page["click"]>): ReturnType<Page["click"]> => {
      calls.push("click");
      return (originalClick as Page["click"]).apply(page, args);
    }) as Page["click"];
    // Instrument the SAME body locator ensureUsaaSession reads post-submit
    // (final-diagnostic innerText) so a marker moved past that read — still
    // technically "before the throw" — is caught, not just a marker moved
    // past the raw click.
    const originalLocator = page.locator;
    page.locator = ((selector: string, options?: Parameters<Page["locator"]>[1]): Locator => {
      const real = (originalLocator as Page["locator"]).call(page, selector, options);
      if (selector !== "body") {
        return real;
      }
      const wrapped: Pick<Locator, "innerText"> = {
        innerText: (): ReturnType<Locator["innerText"]> => {
          calls.push("body.innerText");
          return real.innerText();
        },
      };
      return wrapped as Locator;
    }) as Page["locator"];
    let credentialSubmitCount = 0;

    await assert.rejects(
      ensureUsaaSession({
        context,
        onCredentialSubmit: () => {
          credentialSubmitCount += 1;
          calls.push("onCredentialSubmit");
        },
        page,
        sendInteraction: interactions.sendInteraction,
      })
    );

    assert.equal(credentialSubmitCount, 1, "onCredentialSubmit must fire exactly once for one login attempt");
    // click fires for BOTH the memberId-Next step and the password-Next step
    // (the fixture's #next-button locator resolves both); onCredentialSubmit
    // must immediately follow a click — not an earlier click, and not any of
    // the post-submit body reads that happen before the eventual throw.
    const markerIndex = calls.indexOf("onCredentialSubmit");
    assert.ok(markerIndex > 0, "onCredentialSubmit must fire after at least one click");
    assert.equal(calls[markerIndex - 1], "click", "onCredentialSubmit must immediately follow a click call");
    assert.ok(
      !calls.slice(0, markerIndex).includes("body.innerText"),
      "onCredentialSubmit must fire before any post-submit body read, not just before the final throw"
    );
  });
});

test("mutation-kill: onCredentialSubmit omitted from ensureUsaaSession's call still succeeds (no crash), proving the hook is additive, not load-bearing for USAA's own control flow", async () => {
  // ensureUsaaSession must not require onCredentialSubmit — connectors call
  // it optionally; the runtime (not the connector) decides what happens with
  // the resulting terminal error. This test guards against a future change
  // accidentally making onCredentialSubmit a REQUIRED param that breaks
  // ensureUsaaSession's own signature contract with callers that omit it.
  await withUsaaCredentials(async () => {
    const context = makeContext([[], []]);
    const page = makePostPasswordSourceUnavailablePage(
      "We are unable to complete your request. Our system is currently unavailable. Please try again later."
    );
    const interactions = makeInteractionHarness();

    await assert.rejects(
      ensureUsaaSession({
        context,
        page,
        sendInteraction: interactions.sendInteraction,
      })
    );
  });
});

/**
 * A page sitting on USAA's delivery-method chooser after the password was
 * submitted, used to prove the dispatch guard. Synthetic, not a real capture:
 * no USAA auth-page markup exists on disk, and the live site is off limits
 * because it is the owner's real bank. Selectors are copied from the module's
 * own constants.
 *
 * The fixture records EVERY click, keyed by selector, because the harm this
 * guard prevents is a click — not a prompt. `dispatchClicks` counts clicks on
 * the delivery control (each one is a real SMS on the live site), and
 * `positionalClicks` counts clicks on the hardcoded positional selector the
 * old `.catch()` fallback used.
 */
interface DispatchFixtureOptions {
  /** Whether the delivery control is enabled. Visible-but-disabled is the Venmo class of defect. */
  choiceEnabled?: boolean;
  /** Whether the delivery control is present/visible at all. */
  choicePresent?: boolean;
  /** Whether the code entry is still usable after a code is submitted. */
  codeEntrySurvivesSubmit?: boolean;
  /** Body copy shown once the code has been submitted, before any session exists. */
  postSubmitBody?: string;
  /** Whether a dashboard visit shows an authenticated session (the owner signed in manually). */
  sessionLive?: () => boolean;
}

const POSITIONAL_FALLBACK_SELECTOR = "#miam-choice-container\\ 0-id";

function makeTextCodeDispatchPage(options: DispatchFixtureOptions = {}): {
  clickedSelectors: string[];
  dispatchClicks: number;
  page: Page;
  positionalClicks: number;
} {
  const {
    choiceEnabled = true,
    choicePresent = true,
    codeEntrySurvivesSubmit = true,
    postSubmitBody,
    sessionLive,
  } = options;
  let passwordSubmitted = false;
  let codeSubmitted = false;
  let dispatchClicks = 0;
  let positionalClicks = 0;
  const clickedSelectors: string[] = [];
  let currentUrl = LOGIN_URL;

  const bodyLocator: Pick<Locator, "innerText"> = {
    innerText: (): Promise<string> => {
      if (currentUrl === DASHBOARD_URL) {
        return Promise.resolve(sessionLive?.() ? "Log Off" : "no session");
      }
      if (codeSubmitted && postSubmitBody !== undefined) {
        return Promise.resolve(postSubmitBody);
      }
      // The chooser copy that the old guard matched on its own.
      return Promise.resolve("Text security code");
    },
  };
  const choiceLocator: Pick<Locator, "click" | "first" | "isEnabled" | "isVisible"> = {
    click: (): Promise<void> => {
      dispatchClicks += 1;
      return Promise.resolve();
    },
    first: (): Locator => choiceLocator as Locator,
    isEnabled: (): Promise<boolean> => Promise.resolve(choicePresent && choiceEnabled),
    isVisible: (): Promise<boolean> => Promise.resolve(choicePresent),
  };
  const positionalLocator: Pick<Locator, "click" | "first" | "isEnabled" | "isVisible"> = {
    click: (): Promise<void> => {
      positionalClicks += 1;
      return Promise.resolve();
    },
    first: (): Locator => positionalLocator as Locator,
    isEnabled: (): Promise<boolean> => Promise.resolve(true),
    isVisible: (): Promise<boolean> => Promise.resolve(true),
  };
  // Once dispatched, the code entry is usable so the OTP flow can proceed. It
  // can be made to disappear after submit, modelling USAA's session-timeout
  // and lockout pages, which keep retry-flavoured copy but drop the entry.
  const codeEntryUsable = (): boolean => dispatchClicks > 0 && (codeEntrySurvivesSubmit || !codeSubmitted);
  const otpInputLocator: Pick<Locator, "fill" | "first" | "isEnabled" | "isVisible"> = {
    fill: (): Promise<void> => Promise.resolve(),
    first: (): Locator => otpInputLocator as Locator,
    isEnabled: (): Promise<boolean> => Promise.resolve(codeEntryUsable()),
    isVisible: (): Promise<boolean> => Promise.resolve(codeEntryUsable()),
  };

  const fake: Partial<Page> = {};
  fake.click = ((selector: string): Promise<void> => {
    clickedSelectors.push(selector);
    if (selector === "#next-button") {
      passwordSubmitted = true;
    }
    if (selector === 'button[type="submit"], #next-button' && dispatchClicks > 0) {
      codeSubmitted = true;
    }
    return Promise.resolve();
  }) as Page["click"];
  fake.evaluate = ((): Promise<Array<{ name: string; placeholder: string; type: string }>> =>
    Promise.resolve([])) as Page["evaluate"];
  fake.fill = ((): Promise<void> => Promise.resolve()) as Page["fill"];
  fake.getByRole = ((): Locator => {
    const empty: Pick<Locator, "count" | "isVisible" | "nth"> = {
      count: (): Promise<number> => Promise.resolve(0),
      isVisible: (): Promise<boolean> => Promise.resolve(false),
      nth: (): Locator => empty as Locator,
    };
    return empty as Locator;
  }) as Page["getByRole"];
  fake.goto = ((url: string): ReturnType<Page["goto"]> => {
    currentUrl = url;
    return Promise.resolve(null);
  }) as Page["goto"];
  fake.locator = ((selector: string): Locator => {
    if (selector === POSITIONAL_FALLBACK_SELECTOR) {
      return positionalLocator as Locator;
    }
    if (selector.includes("Text security code to:")) {
      return choiceLocator as Locator;
    }
    if (selector.includes("one-time-code")) {
      return otpInputLocator as Locator;
    }
    if (selector === "#next-button:not([disabled])" || selector === 'input[name="memberId"]') {
      const inert: Pick<Locator, "press" | "waitFor"> = {
        press: (): Promise<void> => Promise.resolve(),
        waitFor: (): Promise<void> => Promise.resolve(),
      };
      return inert as Locator;
    }
    return bodyLocator as Locator;
  }) as Page["locator"];
  fake.waitForLoadState = ((): Promise<void> => Promise.resolve()) as Page["waitForLoadState"];
  fake.waitForSelector = ((selector: string): Promise<unknown> => {
    if (selector === 'input[name="password"]') {
      return passwordSubmitted ? Promise.resolve({}) : Promise.reject(new Error("password field unavailable"));
    }
    if (selector.includes("one-time-code") && dispatchClicks === 0) {
      return Promise.reject(new Error("OTP challenge unavailable"));
    }
    return Promise.resolve({});
  }) as Page["waitForSelector"];
  fake.waitForTimeout = (): Promise<void> => Promise.resolve();
  fake.url = (): string => currentUrl;

  return {
    clickedSelectors,
    get dispatchClicks(): number {
      return dispatchClicks;
    },
    page: fake as Page,
    get positionalClicks(): number {
      return positionalClicks;
    },
  };
}

test("ensureUsaaSession does not dispatch a security code when the chooser copy matches but no usable delivery control is present", async () => {
  await withUsaaCredentials(async () => {
    const fixturePage = makeTextCodeDispatchPage({ choicePresent: false });
    // Manual handoff is declined, so the refusal surfaces as a named error.
    const interactions = makeInteractionHarness("cancelled");
    const context = makeContext([[]]);

    await assert.rejects(
      ensureUsaaSession({
        context,
        page: fixturePage.page,
        sendInteraction: interactions.sendInteraction,
      }),
      /usaa_text_code_choice_not_found/
    );

    assert.equal(fixturePage.dispatchClicks, 0, "no delivery control may be clicked: that click is a real SMS");
    assert.equal(
      interactions.requests.filter((request) => request.kind === "otp").length,
      0,
      "the owner is never asked for a code that was never sent"
    );
  });
});

test("ensureUsaaSession treats a visible but DISABLED delivery control as not usable and refuses to dispatch", async () => {
  await withUsaaCredentials(async () => {
    // Playwright reports a disabled control as visible, so a visibility-only
    // guard would click here. This is the Venmo root cause applied to dispatch.
    const fixturePage = makeTextCodeDispatchPage({ choiceEnabled: false, choicePresent: true });
    const interactions = makeInteractionHarness("cancelled");
    const context = makeContext([[]]);

    await assert.rejects(
      ensureUsaaSession({
        context,
        page: fixturePage.page,
        sendInteraction: interactions.sendInteraction,
      }),
      /usaa_text_code_choice_not_found/
    );

    assert.equal(fixturePage.dispatchClicks, 0, "a disabled control is not evidence the chooser is ready");
  });
});

test("ensureUsaaSession never clicks the removed hardcoded positional selector, even when the delivery control is absent", async () => {
  await withUsaaCredentials(async () => {
    // The old code fell back to clicking `#miam-choice-container 0-id` whenever
    // the text-matched click failed — guessing at a bank's UI with the owner's
    // SMS budget. That fallback is gone; nothing may ever click it.
    const fixturePage = makeTextCodeDispatchPage({ choicePresent: false });
    const interactions = makeInteractionHarness("cancelled");
    const context = makeContext([[]]);

    await assert.rejects(
      ensureUsaaSession({
        context,
        page: fixturePage.page,
        sendInteraction: interactions.sendInteraction,
      }),
      /usaa_text_code_choice_not_found/
    );

    assert.equal(fixturePage.positionalClicks, 0, "the positional fallback must never fire");
    assert.ok(
      !fixturePage.clickedSelectors.includes(POSITIONAL_FALLBACK_SELECTOR),
      "no click may target the hardcoded positional selector"
    );
  });
});

test("ensureUsaaSession hands off to the owner's browser when the delivery control cannot be located, and succeeds if they sign in", async () => {
  await withUsaaCredentials(async () => {
    // The owner signs in during the handoff, so the session only becomes live
    // once the manual_action interaction has been answered.
    let signedInManually = false;
    const fixturePage = makeTextCodeDispatchPage({
      choicePresent: false,
      sessionLive: (): boolean => signedInManually,
    });
    const interactions = makeInteractionHarness("success");
    const context = makeContext([[]], () => signedInManually);
    const sendInteraction = async (request: InteractionRequest): Promise<InteractionResponse> => {
      const response = await interactions.sendInteraction(request);
      if (request.kind === "manual_action") {
        signedInManually = true;
      }
      return response;
    };

    const ok = await ensureUsaaSession({
      context,
      page: fixturePage.page,
      sendInteraction,
    });

    assert.equal(ok, true);
    assert.equal(fixturePage.dispatchClicks, 0, "handoff replaces the guess; it never dispatches");
    assert.equal(fixturePage.positionalClicks, 0);
    assert.deepEqual(
      interactions.requests.map((request) => request.kind),
      ["manual_action"],
      "the owner is asked to finish sign-in, not for a code"
    );
  });
});

test("ensureUsaaSession dispatches exactly once and re-prompts only on positive rejection evidence", async () => {
  await withUsaaCredentials(async () => {
    // USAA never says the code was refused, and the code entry goes away after
    // submit. Without positive rejection evidence the loop must stop after one
    // prompt rather than running MAX_OTP_ATTEMPTS times.
    const fixturePage = makeTextCodeDispatchPage({ postSubmitBody: "Please wait while we redirect you." });
    const interactions = makeInteractionHarness("success", { code: "123456" });
    const context = makeContext([[]]);

    const ok = await ensureUsaaSession({
      context,
      page: fixturePage.page,
      sendInteraction: interactions.sendInteraction,
    }).catch((): false => false);

    assert.equal(ok, false);
    assert.equal(fixturePage.dispatchClicks, 1, "the delivery control is clicked exactly once: one SMS, not three");
    assert.equal(
      interactions.requests.filter((request) => request.kind === "otp").length,
      1,
      "a code that was never positively rejected must not be re-demanded"
    );
  });
});

test("ensureUsaaSession stops re-prompting when retry copy appears but the code entry is gone", async () => {
  await withUsaaCredentials(async () => {
    // USAA's session-timeout and lockout pages carry words like "expired" and
    // "try again" while offering no code entry at all. Retry copy alone must
    // not keep the loop alive: there is nothing left to answer, so a second
    // prompt would demand a code the page cannot consume.
    const fixturePage = makeTextCodeDispatchPage({
      codeEntrySurvivesSubmit: false,
      postSubmitBody: "Your session has expired. Please try again.",
    });
    const interactions = makeInteractionHarness("success", { code: "123456" });
    const context = makeContext([[]]);

    const ok = await ensureUsaaSession({
      context,
      page: fixturePage.page,
      sendInteraction: interactions.sendInteraction,
    }).catch((): false => false);

    assert.equal(ok, false);
    assert.equal(fixturePage.dispatchClicks, 1, "still exactly one dispatch");
    assert.equal(
      interactions.requests.filter((request) => request.kind === "otp").length,
      1,
      "a page with no usable code entry must not be prompted against again"
    );
  });
});
