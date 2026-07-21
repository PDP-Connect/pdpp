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

function makeContext(cookieBatches: BrowserCookie[][]): BrowserContext {
  let calls = 0;
  const fake: Pick<BrowserContext, "cookies"> = {
    cookies(..._urls: Parameters<BrowserContext["cookies"]>): ReturnType<BrowserContext["cookies"]> {
      const batch = cookieBatches[Math.min(calls, Math.max(cookieBatches.length - 1, 0))] ?? [];
      calls++;
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

function makeInteractionHarness(status: InteractionResponse["status"] = "success"): InteractionHarness {
  const requests: InteractionRequest[] = [];
  return {
    requests,
    sendInteraction(req: InteractionRequest): Promise<InteractionResponse> {
      requests.push(req);
      return Promise.resolve({
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

async function withUsaaCredentials(run: () => Promise<void>): Promise<void> {
  const priorUsername = process.env.USAA_USERNAME;
  const priorPassword = process.env.USAA_PASSWORD;
  const priorStreamingEnv = new Map<(typeof STREAMING_ENV_KEYS)[number], string | undefined>();
  for (const key of STREAMING_ENV_KEYS) {
    priorStreamingEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.USAA_USERNAME = "test-user";
  process.env.USAA_PASSWORD = "test-password";
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
      /PDPP_USAA_HEADLESS|automated browser mode|respond success|cancel this interaction|rerun|xvfb-run|headless/i
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

test("ensureUsaaSession still routes a delayed USAA source-unavailable modal after member-id submit to genuine manual_action, with an owner-visible diagnostic note", async () => {
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
      `${prefix}We are unable to complete your request. Our system is currently unavailable. Please try again later.`,
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
