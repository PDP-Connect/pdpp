// Assisted handoff -> authenticated collector /account, in ONE page context.
//
// The frozen base pins two halves of this journey in two different files and
// never joins them: `src/auto-login/venmo.test.ts` proves the owner's manual
// sign-in triggers no post-response navigation or page-context probe, and
// `connectors/venmo/integration.test.ts` exercises the collector against a
// page that was already authenticated by fiat. Nothing drives a run THROUGH
// the handoff INTO `collect()`.
//
// That seam is where production run_1787918248525 failed: the owner completed
// sign-in, and a liveness probe run afterwards navigated the page and walked
// the session back through the wall they had just cleared. A later candidate
// (2bac6f538) reintroduced the same navigation one layer outward — as a
// `probeSession` pre-flight in `establishSession` — and its tests could not
// see the regression because they only ever exercised the inner probe or a
// fake boolean. Both halves passed; the journey was never run.
//
// These tests run the whole journey against a SINGLE page whose liveness
// flips only when the owner responds, and assert the two properties the
// acceptance ledger demands: the authenticated page the owner created is
// still the one collect() reads from, and neither a dead session nor a
// thrown verification can redispatch the owner or resubmit a credential.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "patchright";
import type { BrowserCollectContext } from "../../src/connector-runtime.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { VENMO_RETRYABLE_PATTERN, collect, ensureSession } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const ACCOUNT_BODY = JSON.stringify({ data: { user: { id: "1234567890123456789" } } });

/**
 * One page for the whole run. `evaluate` serves two distinct callers and is
 * told apart by its argument, exactly as production does: the handoff's
 * liveness probe passes none, `makePageFetch` passes a URL string.
 *
 * `contextGeneration` increments on every navigation. Reading it before and
 * after the owner responds is what proves the authenticated context survived
 * — a stronger claim than counting `goto` calls, because it fails even if a
 * navigation is introduced by a path that never touches `gotoUrls`.
 */
function makeJourneyPage(options: { readonly accountStatus?: number; readonly fetchThrows?: boolean } = {}): {
  contextGeneration: () => number;
  page: Page;
  setLive: (live: boolean) => void;
} {
  const { accountStatus = 200, fetchThrows = false } = options;
  let live = false;
  let generation = 0;
  // Starts where a real run starts, NOT already on venmo.com.
  let currentUrl = "about:blank";
  // Flips when the owner signs in; after that a navigation is destructive.
  let ownerAuthenticated = false;
  const locator: Record<string, unknown> = {
    click: (): Promise<void> => Promise.resolve(),
    count: (): Promise<number> => Promise.resolve(0),
    fill: (): Promise<void> => Promise.resolve(),
    innerText: (): Promise<string> => Promise.resolve(""),
    isEnabled: (): Promise<boolean> => Promise.resolve(false),
    isVisible: (): Promise<boolean> => Promise.resolve(false),
    waitFor: (): Promise<void> => Promise.resolve(),
  };
  locator.first = (): unknown => locator;
  locator.nth = (): unknown => locator;
  const page = {
    // biome-ignore lint/suspicious/useAwait: mirrors Playwright's Promise-returning signature
    async evaluate(_fn: unknown, arg?: unknown): Promise<unknown> {
      if (typeof arg === "string") {
        // A collector fetch. A transport fault here is the "thrown
        // verification" case the acceptance bar requires.
        if (fetchThrows) {
          throw new Error("net::ERR_CONNECTION_RESET");
        }
        return { body: live ? ACCOUNT_BODY : "", kind: "response", status: live ? accountStatus : 401 };
      }
      // The handoff's own liveness probe.
      return live ? { kind: "live", ownerId: "1234567890123456789" } : { kind: "dead" };
    },
    getByRole: (): unknown => locator,
    goto(url: string): Promise<null> {
      // A real navigation replaces the execution context. Tracking the URL
      // honestly matters: `ensureVenmoOrigin` early-returns when the page is
      // already on venmo.com, so a fixture that reports a constant origin
      // silently swallows exactly the navigation these tests must catch.
      currentUrl = url;
      generation += 1;
      // This is the production defect, modelled: a full network navigation
      // replaces the execution context, so the session the owner established
      // in the OLD context is gone. Without this, a fake page happily reports
      // `live` after a navigation that would really have destroyed it, and
      // the test pins nothing (the failure mode that got an earlier fix
      // reverted after a reviewer's mutant survived 72/0).
      if (ownerAuthenticated) {
        live = false;
      }
      return Promise.resolve(null);
    },
    locator: (): unknown => locator,
    url: (): string => currentUrl,
    waitForLoadState: (): Promise<void> => Promise.resolve(),
    waitForTimeout: (): Promise<void> => Promise.resolve(),
  };
  return {
    contextGeneration: () => generation,
    page: page as unknown as Page,
    setLive: (next: boolean) => {
      live = next;
      if (next) {
        ownerAuthenticated = true;
      }
    },
  };
}

async function withoutVenmoCredentials(run: () => Promise<void>): Promise<void> {
  const saved = { password: process.env.VENMO_PASSWORD, username: process.env.VENMO_USERNAME };
  process.env.VENMO_PASSWORD = undefined;
  process.env.VENMO_USERNAME = undefined;
  process.env.VENMO_PASSWORD = "";
  process.env.VENMO_USERNAME = "";
  // biome-ignore lint/performance/noDelete: the helpers test for absence, not emptiness
  delete process.env.VENMO_PASSWORD;
  // biome-ignore lint/performance/noDelete: the helpers test for absence, not emptiness
  delete process.env.VENMO_USERNAME;
  try {
    await run();
  } finally {
    if (saved.password !== undefined) {
      process.env.VENMO_PASSWORD = saved.password;
    }
    if (saved.username !== undefined) {
      process.env.VENMO_USERNAME = saved.username;
    }
  }
}

/**
 * The same ctx shape `integration.test.ts` builds, but carrying the REAL
 * journey page instead of `{}`. `requested` is a Map because collect()'s
 * stream gate calls `.has` on it; an empty one keeps this test on the auth
 * boundary rather than stream pagination.
 */
function makeCtx(page: Page): BrowserCollectContext {
  const harness = makeRecordingEmit(validateRecord);
  return {
    assist: () => Promise.reject(new Error("not used")),
    capture: null,
    completeAssistance: () => Promise.resolve(),
    context: {} as BrowserCollectContext["context"],
    credentials: {},
    detailGaps: [],
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: "2026-08-30T00:00:00.000Z",
    page,
    progress: () => Promise.resolve(),
    requestDetailGapPage: () => Promise.resolve([]),
    requested: new Map(),
    scope: { streams: [] },
    sendInteraction: () => Promise.reject(new Error("not used")),
    state: {},
  } as unknown as BrowserCollectContext;
}

test("assisted handoff -> the REGISTERED collect(): production's own closure reads /account from the owner's context", async () => {
  await withoutVenmoCredentials(async () => {
    const { contextGeneration, page, setLive } = makeJourneyPage();
    let generationAtResponse = -1;

    // The REAL registered ensureSession hook, imported from the connector.
    await ensureSession({
      page,
      sendInteraction: (request: { request_id?: string }) => {
        setLive(true);
        generationAtResponse = contextGeneration();
        return Promise.resolve({
          request_id: request.request_id ?? "test_interaction",
          status: "success",
          type: "INTERACTION_RESPONSE",
        });
      },
    } as never);

    assert.notEqual(generationAtResponse, -1, "the manual_action handoff must actually have been requested");
    assert.equal(
      contextGeneration(),
      generationAtResponse,
      "no navigation may occur between the owner's response and the end of ensureSession"
    );

    // The REAL registered collect closure — not a re-implementation of it.
    // If the owner's context was destroyed, /account returns 401 and this
    // throws venmo_session_expired.
    await collect(makeCtx(page));
  });
});

test("a dead session after handoff fails TERMINAL through the registered collect(), never redispatching the owner", async () => {
  await withoutVenmoCredentials(async () => {
    const { page } = makeJourneyPage();
    // The owner never authenticates.
    await assert.rejects(
      collect(makeCtx(page)),
      (err: Error) => {
        assert.match(err.message, /venmo_session_expired|venmo_http_401/, "a dead session must name itself");
        assert.equal(
          VENMO_RETRYABLE_PATTERN.test(err.message),
          false,
          "a dead session must NOT be retryable — a retry re-asks the owner for work they already did"
        );
        return true;
      }
    );
  });
});

test("a THROWN transport fault inside the registered collect() is named transport, not a session/credential failure", async () => {
  await withoutVenmoCredentials(async () => {
    const { page, setLive } = makeJourneyPage({ fetchThrows: true });
    setLive(true);
    await assert.rejects(
      collect(makeCtx(page)),
      (err: Error) => {
        assert.match(err.message, /venmo_transport_error/, "a transport fault must name itself as transport");
        assert.doesNotMatch(
          err.message,
          /session_expired|unverified|credential/,
          "a transport fault must NOT be reported as a session/credential failure"
        );
        return true;
      }
    );
  });
});
