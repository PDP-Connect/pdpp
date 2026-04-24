import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContext, Locator, Page } from "playwright";
import type { InteractionRequest, InteractionResponse } from "../connector-runtime.ts";
import { ensureUsaaSession } from "./usaa.ts";

const DASHBOARD_URL = "https://www.usaa.com/my/usaa";
const LOGIN_URL = "https://www.usaa.com/my/logon";

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

async function withUsaaCredentials(run: () => Promise<void>): Promise<void> {
  const priorUsername = process.env.USAA_USERNAME;
  const priorPassword = process.env.USAA_PASSWORD;
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
