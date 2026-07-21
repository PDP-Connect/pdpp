// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContext, Locator, Page } from "playwright";
import { classifyChaseBrowserSurface, probeChaseSession } from "./chase.ts";

const DASHBOARD_URL = "https://secure.chase.com/web/auth/dashboard";

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
