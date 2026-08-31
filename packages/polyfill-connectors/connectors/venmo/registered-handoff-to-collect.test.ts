// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drives the EXACT config object `venmo/index.ts` registers with
 * `runConnector` (`venmoConnectorConfig` — see its doc) through the real
 * runtime `establishSession` orchestrator, end to end: an assisted (no
 * credential) owner handoff, the runtime's post-establish `probeSession`
 * verification, and — only on a genuinely live session — the private
 * registered `collect(ctx)` closure.
 *
 * This exists because prior tests proved the exported helpers
 * (`probeVenmoAccountViaContext`, `establishSession` against a scripted
 * `probeSession`) in isolation but never entered the registered
 * `ensureSession` → `establishSession` → `probeSession` → `collect` seam as
 * one path — see PR238-NEXT-TRAIN-CONSTITUENTS-INDEPENDENT-R1-0830.md §8
 * (P2 "committed tests remain below the registered seam") and its Required
 * delta #3. A future change to how these are wired together (e.g. wrong
 * hook passed to `runConnector`, or a sequencing regression in
 * `establishSession`) could pass every other test in this repo and still
 * break the real thing; only driving the registered closures catches that.
 *
 * One fake `page` (used by `ensureVenmoSession`'s own pre-submit page-context
 * probe/DOM handoff) and one fake `context` (used ONLY by the post-establish
 * `probeVenmoAccountViaContext` verifier, via `context.request`) are scripted
 * INDEPENDENTLY, on purpose: the whole point of the navigation-free verifier
 * is that it asks the provider itself rather than trusting whatever the page
 * last rendered. A test that derived both from the same "is it live" flag
 * could not tell a real verification from a page-state echo.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { BrowserContext, Locator, Page } from "playwright";
import { establishSession } from "../../src/session-establish.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { venmoConnectorConfig } from "./index.ts";

const ACCOUNT_HANDOFF_MIRROR = readFileSync(
  new URL("./__fixtures__/account.venmo.com-handoff-complete.html", import.meta.url),
  "utf8"
);

/** Inert locator: never matched, never fillable — enough for `ensureVenmoSession`'s DOM probes to see "nothing here" without throwing. */
function inertLocator(): Locator {
  const fake: Pick<
    Locator,
    "click" | "count" | "fill" | "first" | "innerText" | "isEnabled" | "isVisible" | "nth" | "waitFor"
  > = {
    click: (): Promise<void> => Promise.resolve(),
    count: (): Promise<number> => Promise.resolve(0),
    fill: (): Promise<void> => Promise.resolve(),
    first(): Locator {
      return fake as Locator;
    },
    innerText: (): Promise<string> => Promise.resolve(""),
    isEnabled: (): Promise<boolean> => Promise.resolve(false),
    isVisible: (): Promise<boolean> => Promise.resolve(false),
    nth(): Locator {
      return fake as Locator;
    },
    waitFor: (): Promise<void> => Promise.reject(new Error("Timeout waiting for locator")),
  };
  return fake as Locator;
}

/**
 * The owner's page, independently scripted from the verifier context below.
 * `pageLive` drives ONLY `ensureVenmoSession`'s own page-context probe (what
 * decides whether it reuses a session or hands off to the owner) — never the
 * post-establish verification, which is a separate provider-side check.
 *
 * `evaluate` must answer TWO distinct real call shapes from this same page:
 * `probeVenmoAccount`'s pre-submit probe (`evaluate(fn, {fetchTimeoutMs,
 * url})`, expecting back `{kind: "live"|"dead", ...}`) and `collect()`'s own
 * `makePageFetch` (`evaluate(fn, url)`, expecting back `{kind: "response",
 * status, body}`). A fake answering only the first shape makes the SECOND
 * test below (which reaches the real registered `collect()`) throw trying to
 * JSON.parse `undefined` — this fake distinguishes them by the arg shape,
 * exactly the way the two real call sites differ.
 *
 * A mutable counter object, not a getter, backs `evaluate`'s call count:
 * destructuring `{ count }` off a return value freezes a getter's CURRENT
 * value at destructure time (the property access happens once,
 * immediately), so callers read `counts.evaluate` off the object after the
 * fact instead.
 */
function makeFakeOwnerPage(): {
  counts: { evaluate: number };
  gotoCalls: string[];
  page: Page;
  setPageLive: (live: boolean) => void;
} {
  let pageLive = false;
  let currentUrl = "about:blank";
  const gotoCalls: string[] = [];
  const counts = { evaluate: 0 };
  const page: Pick<
    Page,
    "evaluate" | "getByRole" | "goto" | "locator" | "url" | "waitForLoadState" | "waitForTimeout"
  > = {
    evaluate(_fn: unknown, arg?: unknown): ReturnType<Page["evaluate"]> {
      counts.evaluate += 1;
      // makePageFetch's call shape: second arg is a bare URL string.
      if (typeof arg === "string") {
        return Promise.resolve(
          pageLive
            ? { kind: "response", status: 200, body: JSON.stringify({ data: { user: { id: "1234567890123456789" } } }) }
            : { kind: "response", status: 401, body: JSON.stringify({ error: { message: "unauthorized" } }) }
        );
      }
      // probeVenmoAccount's call shape: second arg is {fetchTimeoutMs, url}.
      return Promise.resolve(pageLive ? { kind: "live", ownerId: "1234567890123456789" } : { kind: "dead" });
    },
    getByRole(): Locator {
      return inertLocator();
    },
    goto(url: string): ReturnType<Page["goto"]> {
      currentUrl = url;
      gotoCalls.push(url);
      return Promise.resolve(null);
    },
    locator(): Locator {
      return inertLocator();
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
  return {
    counts,
    gotoCalls,
    page: page as Page,
    setPageLive: (live: boolean) => {
      pageLive = live;
    },
  };
}

/**
 * A realistic owner-handoff destination: Venmo commonly returns the owner to
 * account.venmo.com after completing sign-in. Once that happens, any page
 * navigation or page-context probe is a regression — verification must use
 * the context request client instead. The fixture is intentionally separate
 * from the verifier response so this cannot pass by echoing page state.
 */
function makeAccountHandoffMirrorPage(): {
  handoffCompleted: () => void;
  page: Page;
} {
  let ownerResponded = false;
  const page: Pick<Page, "evaluate" | "getByRole" | "goto" | "locator" | "url" | "waitForLoadState" | "waitForTimeout"> = {
    evaluate(): ReturnType<Page["evaluate"]> {
      if (ownerResponded) {
        return Promise.reject(new Error("verification touched the owner's account.venmo.com page"));
      }
      return Promise.resolve({ kind: "dead" });
    },
    getByRole(): Locator {
      return inertLocator();
    },
    goto(): ReturnType<Page["goto"]> {
      return Promise.reject(new Error("verification navigated away from the owner's account.venmo.com page"));
    },
    locator(): Locator {
      return inertLocator();
    },
    url(): string {
      return ownerResponded ? "https://account.venmo.com/" : "https://venmo.com/sign-in";
    },
    waitForLoadState(): ReturnType<Page["waitForLoadState"]> {
      return Promise.resolve();
    },
    waitForTimeout(): ReturnType<Page["waitForTimeout"]> {
      return Promise.resolve();
    },
  };
  return {
    handoffCompleted: () => {
      ownerResponded = true;
    },
    page: page as Page,
  };
}

/** The provider-side verifier's context — `request.get` is the ONLY member the navigation-free probe touches. */
function makeFakeVerifierContext(): {
  context: BrowserContext;
  counts: { requestGet: number };
  setVerifiedLive: (live: boolean | "throw") => void;
} {
  let verified: boolean | "throw" = false;
  const counts = { requestGet: 0 };
  const context = {
    request: {
      get(): Promise<{ json: () => Promise<unknown>; ok: () => boolean }> {
        counts.requestGet += 1;
        if (verified === "throw") {
          return Promise.reject(new Error("venmo_probe_transport_error: socket hang up"));
        }
        const isLive = verified;
        return Promise.resolve({
          json: () => Promise.resolve(isLive ? { data: { user: { id: "1234567890123456789" } } } : null),
          ok: () => isLive,
        });
      },
    } as unknown as BrowserContext["request"],
  } as unknown as BrowserContext;
  return {
    context,
    counts,
    setVerifiedLive: (live: boolean | "throw") => {
      verified = live;
    },
  };
}

function oneOwnerSuccessInteraction(): {
  counts: { requests: number };
  sendInteraction: Parameters<typeof establishSession>[1]["sendInteraction"];
} {
  const counts = { requests: 0 };
  return {
    counts,
    sendInteraction: (req) => {
      counts.requests += 1;
      return Promise.resolve({
        request_id: req.request_id ?? "req-1",
        status: "success",
        type: "INTERACTION_RESPONSE",
      });
    },
  };
}

function establishArgs(overrides: {
  context: BrowserContext;
  page: Page;
  sendInteraction: Parameters<typeof establishSession>[1]["sendInteraction"];
}): Parameters<typeof establishSession>[1] {
  return {
    assist: () => Promise.reject(new Error("not used")),
    capture: null,
    checkpoint: () => Promise.resolve(),
    completeAssistance: () => Promise.resolve(),
    credentials: {},
    name: venmoConnectorConfig.name,
    progress: () => Promise.resolve(),
    retryablePattern: venmoConnectorConfig.retryablePattern ?? /never_matches/,
    ...overrides,
  };
}

test("registered seam: a genuinely live handoff passes verification and reaches the real registered collect(), emitting the profile", async () => {
  const { page, setPageLive } = makeFakeOwnerPage();
  const { context, counts: verifierCounts, setVerifiedLive } = makeFakeVerifierContext();
  const { counts: interactionCounts, sendInteraction } = oneOwnerSuccessInteraction();

  // The owner's page-context probe stays dead (forcing the assisted handoff),
  // but the PROVIDER-side verifier independently reports live once the owner
  // "signs in" — proving verification is a real, separate check.
  setVerifiedLive(true);

  await establishSession(
    { ensureSession: venmoConnectorConfig.ensureSession, probeSession: venmoConnectorConfig.probeSession },
    establishArgs({ context, page, sendInteraction })
  );

  assert.equal(interactionCounts.requests, 1, "exactly one owner interaction for the whole handoff");
  assert.ok(verifierCounts.requestGet >= 1, "the navigation-free verifier must actually run");

  // Only now does the REAL registered collect(ctx) closure run, against the
  // same fake page — proving establishSession -> collect() is the real path,
  // not a stand-in.
  setPageLive(true);
  const harness = makeRecordingEmit();
  const ctx = {
    assist: () => Promise.reject(new Error("not used")),
    capture: null,
    completeAssistance: () => Promise.resolve(),
    context,
    credentials: {},
    detailGaps: [],
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: "2026-08-30T00:00:00.000Z",
    page,
    progress: () => Promise.resolve(),
    requestDetailGapPage: () => Promise.resolve([]),
    requested: new Map([["profile", { name: "profile" }]]),
    scope: { streams: [] },
    sendInteraction,
    state: {},
  } as Parameters<typeof venmoConnectorConfig.collect>[0];

  await venmoConnectorConfig.collect(ctx);
  assert.ok(
    harness.emitted.some((r) => r.stream === "profile"),
    "the real registered collect() must reach the profile stream once a live session is proven"
  );
});

test("registered seam: a handoff that completes but never authenticates is rejected before collect() ever runs, with one owner interaction", async () => {
  const { page } = makeFakeOwnerPage();
  const { context, counts: verifierCounts, setVerifiedLive } = makeFakeVerifierContext();
  const { counts: interactionCounts, sendInteraction } = oneOwnerSuccessInteraction();

  // The owner responds "success", but the PROVIDER never actually authenticated
  // — the exact production shape (run_1788030841840 / run_1788061976811).
  // establishSession() throwing here (asserted below) IS the proof collect()
  // never runs: the runtime only calls collect() after establishSession()
  // resolves (see connector-runtime.ts's runInBrowser), so a rejection here
  // is unreachable-collect by construction, not a separately tracked flag.
  setVerifiedLive(false);

  await assert.rejects(
    establishSession(
      { ensureSession: venmoConnectorConfig.ensureSession, probeSession: venmoConnectorConfig.probeSession },
      establishArgs({ context, page, sendInteraction })
    ),
    /venmo_session_unverified_after_establish/
  );

  assert.equal(interactionCounts.requests, 1, "exactly one owner interaction, not a retry loop");
  assert.ok(verifierCounts.requestGet >= 1, "the verifier must have actually been asked");
});

test("registered seam: the account.venmo.com handoff mirror rejects page.goto or page.evaluate after the owner responds", async () => {
  assert.match(ACCOUNT_HANDOFF_MIRROR, /data-testid="account-home"/, "fixture must model the owner account destination");
  const { handoffCompleted, page } = makeAccountHandoffMirrorPage();
  const { context, setVerifiedLive } = makeFakeVerifierContext();
  const { counts: interactionCounts, sendInteraction } = oneOwnerSuccessInteraction();
  setVerifiedLive(true);

  await establishSession(
    { ensureSession: venmoConnectorConfig.ensureSession, probeSession: venmoConnectorConfig.probeSession },
    establishArgs({
      context,
      page,
      sendInteraction: (request) => {
        handoffCompleted();
        return sendInteraction(request);
      },
    })
  );

  assert.equal(interactionCounts.requests, 1, "the owner is asked once before the context-only verification");
});

test("registered seam: a transport fault DURING verification is non-retryable and collect() never runs — no redispatch after real owner/credential work", async () => {
  const { page } = makeFakeOwnerPage();
  const { context, setVerifiedLive } = makeFakeVerifierContext();
  const { counts: interactionCounts, sendInteraction } = oneOwnerSuccessInteraction();
  setVerifiedLive("throw");

  const args = establishArgs({ context, page, sendInteraction });

  const dispatchBudget = 3;
  let dispatches = 0;
  for (let attempt = 0; attempt < dispatchBudget; attempt += 1) {
    dispatches += 1;
    let retryable = false;
    await assert.rejects(
      establishSession(
        { ensureSession: venmoConnectorConfig.ensureSession, probeSession: venmoConnectorConfig.probeSession },
        args
      ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /venmo_session_unverified_after_establish/);
        retryable = (err as { retryable?: boolean }).retryable === true;
        return true;
      }
    );
    if (!retryable) {
      break;
    }
  }
  assert.equal(
    venmoConnectorConfig.retryablePattern?.test("venmo_probe_transport_error: socket hang up"),
    true,
    "the configured Venmo pre-submit transport pattern would retry this cause without the terminal fence"
  );
  assert.equal(dispatches, 1, "the non-retryable verdict stops before spending the configured three-dispatch budget");
  assert.equal(
    interactionCounts.requests,
    1,
    "exactly one owner interaction — a transport blip in verification must not trigger a second owner ask"
  );
});
