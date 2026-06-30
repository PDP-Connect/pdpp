import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContext, Locator, Page } from "playwright";
import type { InteractionRequest, InteractionResponse } from "../connector-runtime.ts";
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

function makePasswordStepFailurePage(bodyText: string): Page {
  const memberIdLocator: Pick<Locator, "press"> = {
    press: (): Promise<void> => Promise.resolve(),
  };
  const nextButtonLocator: Pick<Locator, "waitFor"> = {
    waitFor: (): Promise<void> => Promise.resolve(),
  };
  const bodyLocator: Pick<Locator, "innerText"> = {
    innerText: (): Promise<string> => Promise.resolve(bodyText),
  };
  const fake: Partial<Page> = {};
  fake.click = (): Promise<void> => Promise.resolve();
  fake.evaluate = (async (): Promise<Array<{ name: string; placeholder: string; type: string }>> => [
    { name: "memberId", placeholder: "", type: "text" },
  ]) as Page["evaluate"];
  fake.fill = (): Promise<void> => Promise.resolve();
  fake.goto = (): ReturnType<Page["goto"]> => Promise.resolve(null);
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
  fake.url = (): string => `${LOGIN_URL}?akredirect=true`;
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
    assert.match(interactions.requests[0]?.message ?? "", /ERR_HTTP2_PROTOCOL_ERROR/);
    assert.match(interactions.requests[0]?.message ?? "", /PDPP_USAA_HEADLESS=0/);
    assert.doesNotMatch(interactions.requests[0]?.message ?? "", /test-user|test-password/);
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

test("ensureUsaaSession classifies delayed USAA source-unavailable modal after member-id submit", async () => {
  // Live fixture 2026-06-29: USAA rendered the source-unavailable dialog after
  // the logon form/footer, beyond the old 800-character pre-classification
  // slice. The run was mislabeled as selector drift even though the source
  // explicitly said its login system was unavailable.
  await withUsaaCredentials(async () => {
    const prefix = "Member Account Login ".repeat(80);
    const page = makePasswordStepFailurePage(
      `${prefix}We are unable to complete your request. Our system is currently unavailable. Please try again later.`
    );
    const context = makeContext([[]]);
    const interactions = makeInteractionHarness();

    await assert.rejects(
      ensureUsaaSession({
        context,
        page,
        sendInteraction: interactions.sendInteraction,
      }),
      /source_unavailable: USAA reported its login system is currently unavailable after Next click/
    );
    assert.equal(interactions.requests.length, 0);
  });
});
