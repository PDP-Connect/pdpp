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
import { ensureVenmoSession } from "../../src/auto-login/venmo.ts";
import { VENMO_RETRYABLE_PATTERN, establishVenmoCollectOrigin, fetchProfile } from "./index.ts";

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

test("assisted handoff -> collect(): the owner's authenticated page is the SAME context collect() reads /account from", async () => {
  await withoutVenmoCredentials(async () => {
    const { contextGeneration, page, setLive } = makeJourneyPage();
    let generationAtResponse = -1;

    await ensureVenmoSession({
      page,
      sendInteraction: (request) => {
        // The owner signs in. Everything after this runs against the live,
        // authenticated page they just created.
        setLive(true);
        generationAtResponse = contextGeneration();
        return Promise.resolve({
          request_id: request.request_id ?? "test_interaction",
          status: "success",
          type: "INTERACTION_RESPONSE",
        } as never);
      },
    });

    assert.notEqual(generationAtResponse, -1, "the manual_action handoff must actually have been requested");
    assert.equal(
      contextGeneration(),
      generationAtResponse,
      "no navigation may occur between the owner's response and the end of ensureSession"
    );
    // The stronger property, and the one production run_1787918248525 lost:
    // the owner authenticated inside a page context, and that context must
    // still be the live one. `page.evaluate` returning `live` is the only
    // evidence of that which a navigation cannot fake — a fresh context
    // would have no session. Asserting it HERE, between ensureSession and
    // collect(), is what makes this a journey test rather than two unit
    // tests sharing a file.
    const stillAuthenticated = (await (page as unknown as { evaluate: (fn: unknown) => Promise<unknown> }).evaluate(
      null
    )) as { kind: string };
    assert.equal(
      stillAuthenticated.kind,
      "live",
      "the context the owner authenticated in must survive into collect(); a post-owner navigation destroys it"
    );

    // collect()'s own origin step, then its /account read — the single
    // authenticated boundary that both verifies liveness and yields the
    // collection input. It is allowed to navigate ONCE here (collect() must
    // establish venmo.com for the CORS allowlist), which is a different phase
    // from the forbidden post-owner probe.
    await establishVenmoCollectOrigin(page);
    const account = await fetchProfile((path) =>
      (page as unknown as { evaluate: (fn: unknown, arg: unknown) => Promise<{ body: string; status: number }> })
        .evaluate(null, `https://api.venmo.com/v1${path}`)
    );

    assert.equal(account?.id, "1234567890123456789", "collect() must read a real owner id from the SAME session");
  });
});

test("a dead session after handoff fails TERMINAL (venmo_session_expired), never redispatching the owner", async () => {
  await withoutVenmoCredentials(async () => {
    const { page } = makeJourneyPage();
    // Owner never authenticates: the page stays dead through collect().
    await establishVenmoCollectOrigin(page);
    await assert.rejects(
      fetchProfile((path) =>
        (page as unknown as { evaluate: (fn: unknown, arg: unknown) => Promise<{ body: string; status: number }> })
          .evaluate(null, `https://api.venmo.com/v1${path}`)
      ),
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

test("a THROWN verification after handoff cannot resubmit a credential — the fault is named, not silently retried as auth", async () => {
  await withoutVenmoCredentials(async () => {
    const { page, setLive } = makeJourneyPage({ fetchThrows: true });
    setLive(true);
    await establishVenmoCollectOrigin(page);
    await assert.rejects(
      fetchProfile((path) =>
        (page as unknown as { evaluate: (fn: unknown, arg: unknown) => Promise<{ body: string; status: number }> })
          .evaluate(null, `https://api.venmo.com/v1${path}`).catch((err: Error) => {
            throw new Error(`venmo_transport_error [endpoint ${path}]: ${err.message}`);
          })
      ),
      (err: Error) => {
        // A transport fault IS retryable — the session is not known dead, and
        // a retry costs the owner nothing because it never re-enters the
        // credential or handoff path. What must never happen is the fault
        // being classified as a session/auth failure.
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
