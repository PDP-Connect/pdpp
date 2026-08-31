// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import type { APIResponse, BrowserContext, Locator, Page } from "playwright";
import { establishSession } from "../../src/session-establish.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { venmoConnectorConfig } from "./index.ts";

const HANDOFF_FIXTURE = readFileSync(
  new URL("./__fixtures__/account.venmo.com-handoff-complete.html", import.meta.url),
  "utf8"
);
const OWNER_ID = "1234567890123456789";

function inertLocator(): Locator {
  const locator: Pick<
    Locator,
    "click" | "count" | "fill" | "first" | "innerText" | "isEnabled" | "isVisible" | "nth" | "waitFor"
  > = {
    click: () => Promise.resolve(),
    count: () => Promise.resolve(0),
    fill: () => Promise.resolve(),
    first: () => locator as Locator,
    innerText: () => Promise.resolve(""),
    isEnabled: () => Promise.resolve(false),
    isVisible: () => Promise.resolve(false),
    nth: () => locator as Locator,
    waitFor: () => Promise.reject(new Error("locator absent")),
  };
  return locator as Locator;
}

function makeOwnerPage(): { page: Page; pageEvaluates: number; setLive: (live: boolean) => void } {
  let live = false;
  let currentUrl = "https://venmo.com/";
  let pageEvaluates = 0;
  const page: Pick<
    Page,
    "evaluate" | "getByRole" | "goto" | "locator" | "url" | "waitForLoadState" | "waitForTimeout"
  > = {
    evaluate(_fn: unknown, arg?: unknown): ReturnType<Page["evaluate"]> {
      pageEvaluates += 1;
      if (typeof arg === "string") {
        return Promise.resolve({
          kind: "response",
          status: live ? 200 : 401,
          body: JSON.stringify(live ? { data: { user: { id: OWNER_ID } } } : { error: { message: "unauthorized" } }),
        });
      }
      return Promise.resolve(live ? { kind: "live", ownerId: OWNER_ID } : { kind: "dead" });
    },
    getByRole: () => inertLocator(),
    goto(url: string): ReturnType<Page["goto"]> {
      currentUrl = url;
      return Promise.resolve(null);
    },
    locator: () => inertLocator(),
    url: () => currentUrl,
    waitForLoadState: () => Promise.resolve(),
    waitForTimeout: () => Promise.resolve(),
  };
  return {
    page: page as Page,
    get pageEvaluates() {
      return pageEvaluates;
    },
    setLive: (value: boolean) => {
      live = value;
    },
  };
}

function makeContext(verified: boolean | "throw"): { context: BrowserContext; requests: number } {
  let requests = 0;
  const request: Pick<BrowserContext["request"], "get"> = {
    get(): ReturnType<BrowserContext["request"]["get"]> {
      requests += 1;
      if (verified === "throw") {
        return Promise.reject(new Error("socket hang up"));
      }
      const response: Pick<APIResponse, "json" | "ok"> = {
        json: () => Promise.resolve(verified ? { data: { user: { id: OWNER_ID } } } : null),
        ok: () => verified,
      };
      return Promise.resolve(response as APIResponse);
    },
  };
  const context: Pick<BrowserContext, "request"> = {
    request: request as BrowserContext["request"],
  };
  return {
    context: context as BrowserContext,
    get requests() {
      return requests;
    },
  };
}

function establishArgs(
  context: BrowserContext,
  page: Page,
  sendInteraction: Parameters<typeof establishSession>[1]["sendInteraction"]
) {
  return {
    assist: () => Promise.reject(new Error("unused")),
    capture: null,
    checkpoint: () => Promise.resolve(),
    completeAssistance: () => Promise.resolve(),
    context,
    credentials: {},
    name: venmoConnectorConfig.name,
    page,
    progress: () => Promise.resolve(),
    retryablePattern: venmoConnectorConfig.retryablePattern ?? /never_matches/,
    sendInteraction,
  } satisfies Parameters<typeof establishSession>[1];
}

test("registered handoff: context verification passes, then the real registered collect emits profile", async () => {
  const fixture = parseHTML(HANDOFF_FIXTURE).document.querySelector('[data-testid="account-home"]');
  assert.match(fixture?.textContent ?? "", /Welcome back/);
  assert.match(fixture?.textContent ?? "", /Your Venmo account is ready/);

  const owner = makeOwnerPage();
  const verifier = makeContext(true);
  owner.setLive(false);
  let interactions = 0;
  await establishSession(
    { ensureSession: venmoConnectorConfig.ensureSession, probeSession: venmoConnectorConfig.probeSession },
    establishArgs(verifier.context, owner.page, (request) => {
      interactions += 1;
      return Promise.resolve({
        request_id: request.request_id ?? "req-1",
        status: "success",
        type: "INTERACTION_RESPONSE",
      });
    })
  );
  assert.equal(interactions, 1);
  assert.ok(verifier.requests >= 1);
  assert.equal(owner.pageEvaluates, 1, "verification must not add a page-context probe after owner handoff");

  owner.setLive(true);
  const harness = makeRecordingEmit();
  await venmoConnectorConfig.collect({
    assist: () => Promise.reject(new Error("unused")),
    capture: null,
    completeAssistance: () => Promise.resolve(),
    context: verifier.context,
    credentials: {},
    detailGaps: [],
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: "2026-08-30T00:00:00.000Z",
    page: owner.page,
    progress: () => Promise.resolve(),
    requestDetailGapPage: () => Promise.resolve([]),
    requested: new Map([["profile", { name: "profile" }]]),
    scope: { streams: [] },
    sendInteraction: () => Promise.reject(new Error("unused")),
    state: {},
  });
  assert.ok(harness.emitted.some((message) => message.stream === "profile"));
});

test("registered handoff: false context verification stops before collect and stays non-retryable", async () => {
  const owner = makeOwnerPage();
  const verifier = makeContext(false);
  let interactions = 0;
  await assert.rejects(
    establishSession(
      { ensureSession: venmoConnectorConfig.ensureSession, probeSession: venmoConnectorConfig.probeSession },
      establishArgs(verifier.context, owner.page, (request) => {
        interactions += 1;
        return Promise.resolve({
          request_id: request.request_id ?? "req-1",
          status: "success",
          type: "INTERACTION_RESPONSE",
        });
      })
    ),
    (error: unknown) => {
      assert.equal((error as { retryable?: boolean }).retryable, false);
      assert.match(error instanceof Error ? error.message : "", /venmo_session_unverified_after_establish/);
      return true;
    }
  );
  assert.equal(interactions, 1);
  assert.equal(verifier.requests, 1);
});

test("registered handoff: a context transport fault is terminal and never falls back to the Page", async () => {
  const owner = makeOwnerPage();
  const verifier = makeContext("throw");
  await assert.rejects(
    establishSession(
      { ensureSession: venmoConnectorConfig.ensureSession, probeSession: venmoConnectorConfig.probeSession },
      establishArgs(verifier.context, owner.page, (request) =>
        Promise.resolve({ request_id: request.request_id ?? "req-1", status: "success", type: "INTERACTION_RESPONSE" })
      )
    ),
    (error: unknown) => {
      assert.equal((error as { retryable?: boolean }).retryable, false);
      assert.match(error instanceof Error ? error.message : "", /venmo_session_unverified_after_establish/);
      return true;
    }
  );
  assert.equal(verifier.requests, 1);
  assert.equal(owner.pageEvaluates, 1, "the post-owner verifier must not navigate or evaluate the owner page");
});
