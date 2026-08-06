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
