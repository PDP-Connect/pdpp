// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Discriminating sequence tests for USAA's mid-run stale-session self-heal
 * (`gotoOrRepairSession`) — the fix for the defect class where a run signs
 * in fine, extracts data successfully, then a LATER navigation bounces to
 * USAA's logon page because the session cookie went stale mid-run. Mirrors
 * Jellyfin's `late-auth-self-heal.test.ts` naming and shape.
 *
 * Before this fix, `extractAccounts`, `runStatementsStream`, `runInboxStream`,
 * and `navigateToCardOrGap` had NO redirect check at all — a logon-page
 * bounce was scraped as if it were real data (empty accounts, an empty/wrong
 * statements table, garbage credit-card billing fields), rather than being
 * detected and repaired. Only the transactions export ladder (`driveExport` /
 * `SessionDeadRedirectError` / `reauthAfterSessionLapse`) already had the
 * correct repair-then-retry-once shape; `gotoOrRepairSession` generalizes
 * that same shape for the other four navigation sites.
 *
 * These tests exercise `gotoOrRepairSession` directly (the shared primitive)
 * plus each of the four call sites through their exported wrapper function,
 * using `deps.reauthenticate` injection so no real `ensureUsaaSession` login
 * flow runs.
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { BrowserContext, Page } from "playwright";
import type { BrowserCollectContext, EmittedMessage } from "../../src/connector-runtime.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import {
  type EmitDeps,
  extractAccounts,
  gotoOrRepairSession,
  runInboxStream,
  runSingleLadderAttempt,
  runStatementsStream,
  type UsaaRunState,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { DashboardAccount } from "./types.ts";

const FAKE_CONTEXT = {} as BrowserContext;
const LOGON_URL = "https://www.usaa.com/my/logon";
const DASHBOARD_URL = "https://www.usaa.com/my/usaa";

/** Fresh per-run state for each test — mirrors `collect()` constructing
 *  exactly one `UsaaRunState` per run, shared across every stream. */
function freshRunState(): UsaaRunState {
  return { sessionDeadMidRun: false, sessionRepairAttempted: false };
}

// biome-ignore lint/suspicious/useAwait: mock throws to prove a repaired/never-dead session never reaches sendInteraction
const NEVER_CALLED_SEND_INTERACTION: BrowserCollectContext["sendInteraction"] = async () => {
  throw new Error("sendInteraction must not be called — gotoOrRepairSession delegates to deps.reauthenticate");
};

function makeHarness(reauthenticate?: EmitDeps["reauthenticate"]): {
  deps: EmitDeps;
  messages: EmittedMessage[];
} {
  const harness = makeRecordingEmit(validateRecord);
  const deps: EmitDeps = {
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    ...(reauthenticate ? { reauthenticate } : {}),
  };
  return { deps, messages: harness.protocolMessages };
}

/** A page whose `.url()` reports whichever URL was last navigated to via
 *  `.goto()`. `.goto()` never rejects — it always "succeeds" onto the
 *  scripted URL, exactly like USAA's logon bounce (no navigation error,
 *  just a different landed URL). */
function makeSequencedPage(landedUrls: string[]): { calls: string[]; page: Page } {
  const calls: string[] = [];
  let current = landedUrls[0] ?? DASHBOARD_URL;
  return {
    calls,
    page: Object.assign({} as Page, {
      goto: (url: string) => {
        calls.push(url);
        current = landedUrls[calls.length - 1] ?? landedUrls.at(-1) ?? url;
        return Promise.resolve(null);
      },
      url: () => current,
      evaluate: () => Promise.resolve([]),
      waitForSelector: () => Promise.resolve(null),
    }),
  };
}

function makeFallbackLoginPage(): {
  filled: Array<{ selector: string; value: string }>;
  page: Page;
  context: BrowserContext;
} {
  let currentUrl = LOGON_URL;
  let loggedIn = false;
  let navigationCount = 0;
  const filled: Array<{ selector: string; value: string }> = [];
  const context = {
    cookies: () => Promise.resolve(loggedIn ? [{ name: "UsaaMbWebMemberLoggedIn", value: "true" }] : []),
  } as BrowserContext;
  const page = Object.assign({} as Page, {
    evaluate: () =>
      Promise.resolve({
        account_detail_marker_count: 0,
        navigation_marker_count: 0,
        target_count: 0,
        transaction_marker_count: 0,
      }),
    goto: (url: string) => {
      navigationCount += 1;
      currentUrl = navigationCount === 1 ? LOGON_URL : url;
      return Promise.resolve(null);
    },
    url: () => currentUrl,
    waitForSelector: () => Promise.resolve(null),
    waitForTimeout: () => Promise.resolve(),
    fill: (selector: string, value: string) => {
      filled.push({ selector, value });
      return Promise.resolve();
    },
    click: (selector: string) => {
      if (selector === "#next-button" && filled.some((entry) => entry.selector === 'input[name="password"]')) {
        loggedIn = true;
      }
      return Promise.resolve();
    },
    locator: () =>
      Object.assign({} as Page, {
        count: () => Promise.resolve(0),
        filter() {
          return this;
        },
        waitFor: () => Promise.resolve(),
        innerText: () => Promise.resolve("Log Off"),
      }),
  });
  return { context, filled, page };
}

// ─── gotoOrRepairSession: the shared primitive ──────────────────────────

test("gotoOrRepairSession: lands on the real page first try → ok, no reauth attempted", async () => {
  const run = makeHarness();
  const { calls, page } = makeSequencedPage([DASHBOARD_URL]);

  const result = await gotoOrRepairSession(
    run.deps,
    FAKE_CONTEXT,
    page,
    NEVER_CALLED_SEND_INTERACTION,
    DASHBOARD_URL,
    { timeout: 1000 },
    "accounts",
    freshRunState()
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1, "no retry navigation when the first landing is not the logon page");
});

test("gotoOrRepairSession: logon bounce → repair succeeds → retries the SAME url once → ok", async () => {
  let reauthCalls = 0;
  // biome-ignore lint/suspicious/useAwait: mock matches EmitDeps["reauthenticate"]'s Promise-returning signature
  const reauthenticate: EmitDeps["reauthenticate"] = async () => {
    reauthCalls += 1;
  };
  const run = makeHarness(reauthenticate);
  // First goto lands on logon (session was stale); after "repair" the retry
  // goto lands on the real dashboard.
  const { calls, page } = makeSequencedPage([LOGON_URL, DASHBOARD_URL]);

  const result = await gotoOrRepairSession(
    run.deps,
    FAKE_CONTEXT,
    page,
    NEVER_CALLED_SEND_INTERACTION,
    DASHBOARD_URL,
    { timeout: 1000 },
    "accounts",
    freshRunState()
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(reauthCalls, 1, "repair attempted exactly once");
  assert.deepEqual(
    calls,
    [DASHBOARD_URL, DASHBOARD_URL],
    "the retry navigates to the EXACT SAME url as the failed attempt"
  );
});

test("gotoOrRepairSession: logon bounce persists after repair → terminal ok:false, exactly one retry", async () => {
  let reauthCalls = 0;
  // biome-ignore lint/suspicious/useAwait: mock matches EmitDeps["reauthenticate"]'s Promise-returning signature
  const reauthenticate: EmitDeps["reauthenticate"] = async () => {
    reauthCalls += 1;
  };
  const run = makeHarness(reauthenticate);
  // Both the original attempt and the post-repair retry land on logon.
  const { calls, page } = makeSequencedPage([LOGON_URL, LOGON_URL]);

  const result = await gotoOrRepairSession(
    run.deps,
    FAKE_CONTEXT,
    page,
    NEVER_CALLED_SEND_INTERACTION,
    DASHBOARD_URL,
    { timeout: 1000 },
    "accounts",
    freshRunState()
  );

  assert.deepEqual(result, { ok: false });
  assert.equal(reauthCalls, 1, "repair is not retried in a loop after a second logon bounce");
  assert.equal(calls.length, 2, "exactly one retry, then give up");
});

test("gotoOrRepairSession: repair itself throws → terminal ok:false, no retry navigation sent", async () => {
  let reauthCalls = 0;
  // biome-ignore lint/suspicious/useAwait: mock matches EmitDeps["reauthenticate"]'s Promise-returning signature
  const reauthenticate: EmitDeps["reauthenticate"] = async () => {
    reauthCalls += 1;
    throw new Error("usaa_login_failed");
  };
  const run = makeHarness(reauthenticate);
  const { calls, page } = makeSequencedPage([LOGON_URL]);

  const result = await gotoOrRepairSession(
    run.deps,
    FAKE_CONTEXT,
    page,
    NEVER_CALLED_SEND_INTERACTION,
    DASHBOARD_URL,
    { timeout: 1000 },
    "accounts",
    freshRunState()
  );

  assert.deepEqual(result, { ok: false });
  assert.equal(reauthCalls, 1, "repair is attempted once even though it fails");
  assert.equal(calls.length, 1, "a failed repair must not spend a retry navigation");
});

test("gotoOrRepairSession: no reauthenticate override falls through to ensureUsaaSession, which throws on a fake context/page and is caught as failure", async () => {
  // No deps.reauthenticate: gotoOrRepairSession falls back to the real
  // ensureUsaaSession, which will throw against fake context/page objects.
  // Proves the fallback path is exercised (not just the injected-override
  // path) and that a thrown fallback is caught as ok:false, not propagated.
  const run = makeHarness();
  const { page } = makeSequencedPage([LOGON_URL]);

  const result = await gotoOrRepairSession(
    run.deps,
    FAKE_CONTEXT,
    page,
    NEVER_CALLED_SEND_INTERACTION,
    DASHBOARD_URL,
    { timeout: 1000 },
    "accounts",
    freshRunState()
  );

  assert.deepEqual(result, { ok: false });
});

test("gotoOrRepairSession: default recovery uses the run-scoped Online ID, not the connector identity or ambient env", async () => {
  const priorUsername = process.env.USAA_USERNAME;
  const priorPassword = process.env.USAA_PASSWORD;
  process.env.USAA_USERNAME = "usaa";
  process.env.USAA_PASSWORD = "ambient-password";
  try {
    const fixture = makeFallbackLoginPage();
    const run = makeHarness();
    run.deps.credentials = { USAA_PASSWORD: "saved-password", USAA_USERNAME: "saved-online-id" };

    const result = await gotoOrRepairSession(
      run.deps,
      fixture.context,
      fixture.page,
      NEVER_CALLED_SEND_INTERACTION,
      DASHBOARD_URL,
      { timeout: 1000 },
      "accounts",
      freshRunState()
    );

    assert.deepEqual(result, { ok: true });
    assert.equal(
      fixture.filled.find(({ selector }) => selector === 'input[name="memberId"]')?.value,
      "saved-online-id"
    );
    assert.notEqual(fixture.filled.find(({ selector }) => selector === 'input[name="memberId"]')?.value, "usaa");
    assert.equal(fixture.filled.find(({ selector }) => selector === 'input[name="password"]')?.value, "saved-password");
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

test("transactions recovery: reauthAfterSessionLapse uses the run-scoped Online ID, not ambient env", async () => {
  const priorUsername = process.env.USAA_USERNAME;
  const priorPassword = process.env.USAA_PASSWORD;
  process.env.USAA_USERNAME = "usaa";
  process.env.USAA_PASSWORD = "ambient-password";
  try {
    const fixture = makeFallbackLoginPage();
    const run = makeHarness();
    run.deps.credentials = { USAA_PASSWORD: "saved-password", USAA_USERNAME: "saved-online-id" };
    const streamState = freshRunState();
    let sessionDead = false;

    const outcome = await runSingleLadderAttempt({
      a: makeTransactionsAccount(),
      accountOrdinal: 1,
      accountTotal: 1,
      attemptOrdinal: 1,
      attemptTotal: 1,
      context: fixture.context,
      deps: run.deps,
      onDiagnostics() {
        // This regression asserts credential selection, not export diagnostics.
      },
      onSessionDead() {
        sessionDead = true;
      },
      page: fixture.page,
      sendInteraction: NEVER_CALLED_SEND_INTERACTION,
      settleDelayMs: 0,
      sinceDate: "2026-01-01",
      streamState,
      todayIso: "2026-07-16",
    });

    assert.deepEqual(outcome, { kind: "retry" });
    assert.equal(sessionDead, false, "stored-credential recovery succeeds before the ladder reports session death");
    assert.equal(
      fixture.filled.find(({ selector }) => selector === 'input[name="memberId"]')?.value,
      "saved-online-id"
    );
    assert.notEqual(fixture.filled.find(({ selector }) => selector === 'input[name="memberId"]')?.value, "usaa");
    assert.equal(fixture.filled.find(({ selector }) => selector === 'input[name="password"]')?.value, "saved-password");
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

// ─── extractAccounts: accounts stream self-heal ─────────────────────────

async function withFastTimers<T>(fn: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ["setTimeout"] });
  const ticker = setInterval(() => {
    mock.timers.tick(10_000);
  }, 0);
  try {
    return await fn();
  } finally {
    clearInterval(ticker);
    mock.timers.reset();
  }
}

test("extractAccounts: dashboard nav succeeds first try → parses accounts normally, no repair", async () => {
  await withFastTimers(async () => {
    const run = makeHarness();
    const { page } = makeSequencedPage([DASHBOARD_URL]);
    Object.assign(page, {
      evaluate: () => Promise.resolve([]),
    });
    const streamState = freshRunState();

    const accounts = await extractAccounts(run.deps, FAKE_CONTEXT, page, NEVER_CALLED_SEND_INTERACTION, streamState);

    assert.deepEqual(accounts, []);
    assert.equal(
      run.messages.filter((m) => m.type === "SKIP_RESULT").length,
      0,
      "no SKIP_RESULT on a clean dashboard load"
    );
    assert.equal(streamState.sessionDeadMidRun, false);
  });
});

test("extractAccounts: dashboard bounces to logon, repair succeeds, retried dashboard load parses accounts", async () => {
  await withFastTimers(async () => {
    let reauthCalls = 0;
    // biome-ignore lint/suspicious/useAwait: mock matches EmitDeps["reauthenticate"]'s Promise-returning signature
    const reauthenticate: EmitDeps["reauthenticate"] = async () => {
      reauthCalls += 1;
    };
    const run = makeHarness(reauthenticate);
    const { page } = makeSequencedPage([LOGON_URL, DASHBOARD_URL]);
    Object.assign(page, {
      evaluate: () => Promise.resolve([]),
    });
    const streamState = freshRunState();

    const accounts = await extractAccounts(run.deps, FAKE_CONTEXT, page, NEVER_CALLED_SEND_INTERACTION, streamState);

    assert.equal(reauthCalls, 1);
    assert.deepEqual(accounts, [], "post-repair retry proceeds to parse the (empty, in this fixture) dashboard");
    assert.equal(streamState.sessionDeadMidRun, false, "a successful repair must not latch session death");
  });
});

test("extractAccounts: repair fails → returns [] with a typed SKIP_RESULT, never scrapes the logon page as accounts, latches session death for later streams", async () => {
  await withFastTimers(async () => {
    // biome-ignore lint/suspicious/useAwait: mock matches EmitDeps["reauthenticate"]'s Promise-returning signature
    const run = makeHarness(async () => {
      throw new Error("usaa_login_failed");
    });
    const { page } = makeSequencedPage([LOGON_URL, LOGON_URL]);
    let evaluateCalled = false;
    Object.assign(page, {
      evaluate: () => {
        evaluateCalled = true;
        return Promise.resolve([]);
      },
    });
    const streamState = freshRunState();

    const accounts = await extractAccounts(run.deps, FAKE_CONTEXT, page, NEVER_CALLED_SEND_INTERACTION, streamState);

    assert.deepEqual(accounts, [], "a dead session must never be scraped as zero real accounts");
    assert.equal(evaluateCalled, false, "the logon page's DOM must never be scraped/attributed as account data");
    const skips = run.messages.filter((m) => m.type === "SKIP_RESULT");
    assert.equal(skips.length, 1);
    assert.equal((skips[0] as { reason?: string }).reason, "session_dead_reauth_failed");
    assert.equal(
      streamState.sessionDeadMidRun,
      true,
      "extractAccounts must latch the shared streamState itself — collect() constructs it BEFORE this call and relies on the latch to skip every later stream"
    );
  });
});

// ─── gotoOrRepairSession: the run-scoped repair budget ──────────────────

test("gotoOrRepairSession: budget already spent by an earlier call this run → refuses immediately after the bounce, no reauth, no retry navigation", async () => {
  let reauthCalls = 0;
  // biome-ignore lint/suspicious/useAwait: mock matches EmitDeps["reauthenticate"]'s Promise-returning signature
  const reauthenticate: EmitDeps["reauthenticate"] = async () => {
    reauthCalls += 1;
  };
  const run = makeHarness(reauthenticate);
  const { page } = makeSequencedPage([LOGON_URL, DASHBOARD_URL]);
  const streamState = freshRunState();

  const first = await gotoOrRepairSession(
    run.deps,
    FAKE_CONTEXT,
    page,
    NEVER_CALLED_SEND_INTERACTION,
    DASHBOARD_URL,
    { timeout: 1000 },
    "accounts",
    streamState
  );
  assert.deepEqual(first, { ok: true });
  assert.equal(reauthCalls, 1, "the first call spends the budget");

  const { calls: secondCalls, page: secondPage } = makeSequencedPage([LOGON_URL]);
  const second = await gotoOrRepairSession(
    run.deps,
    FAKE_CONTEXT,
    secondPage,
    NEVER_CALLED_SEND_INTERACTION,
    "https://www.usaa.com/my/documents",
    { timeout: 1000 },
    "statements",
    streamState
  );

  assert.deepEqual(second, { ok: false }, "a second call this run must be refused, not attempt its own repair");
  assert.equal(reauthCalls, 1, "the run-scoped budget must not be spent twice");
  assert.equal(
    secondCalls.length,
    1,
    "the retry-navigation after repair must never happen — the budget check short-circuits before any second goto"
  );
});

// ─── cross-path budget: gotoOrRepairSession vs. reauthAfterSessionLapse ──
//
// `gotoOrRepairSession` (accounts/statements/inbox/credit-card nav) and
// `reauthAfterSessionLapse` (the transactions export ladder, reached via
// `runSingleLadderAttempt` when `driveExport` throws `SessionDeadRedirectError`)
// are two INDEPENDENT call sites that both spend the same run-scoped
// `streamState.sessionRepairAttempted` budget. Before this fix,
// `reauthAfterSessionLapse` never consulted the budget at all — the ≤1
// auth-attempt-per-run property held only because whichever path detected
// death first happened to latch `sessionDeadMidRun` and stop the run before
// the other path's own call could occur. That is an emergent property of
// call ordering in `collect()`, not a local one: it would silently break if
// a future change removed an early-exit anywhere in between. These tests
// spend the budget in one path and prove the OTHER path cannot spend it
// again — and, as a counterweight, that a fresh run's transactions path can
// still spend its own single attempt when nothing has touched the budget yet.

function makeLogonBounceExportPage(): Page {
  return Object.assign({} as Page, {
    evaluate() {
      return Promise.resolve({
        account_detail_marker_count: 0,
        navigation_marker_count: 0,
        target_count: 0,
        transaction_marker_count: 0,
      });
    },
    goto() {
      return Promise.resolve(null);
    },
    locator() {
      return {
        count() {
          return Promise.resolve(0);
        },
        filter() {
          return this;
        },
      };
    },
    url() {
      return LOGON_URL;
    },
  });
}

function makeTransactionsAccount(overrides: Partial<DashboardAccount> = {}): DashboardAccount {
  return {
    account_id_raw: "ACCT-CHK-0001",
    account_type: "checking",
    account_url: "/my/checking?accountId=ACCT-CHK-0001",
    balance_cents: 123_456,
    last_four: "9241",
    name: "USAA CLASSIC CHECKING",
    raw_text: "USAA CLASSIC CHECKING Ending in *9241 $1,234.56",
    ...overrides,
  };
}

test("cross-path budget: gotoOrRepairSession spends the run's one repair attempt → reauthAfterSessionLapse (via runSingleLadderAttempt) cannot spend it again", async () => {
  let reauthCalls = 0;
  // biome-ignore lint/suspicious/useAwait: mock matches EmitDeps["reauthenticate"]'s Promise-returning signature
  const reauthenticate: EmitDeps["reauthenticate"] = async () => {
    reauthCalls += 1;
  };
  const run = makeHarness(reauthenticate);
  const streamState = freshRunState();

  // First: accounts' gotoOrRepairSession hits a logon bounce and spends the
  // run's one automated-login budget (repair "succeeds" per the mock).
  const { page: accountsPage } = makeSequencedPage([LOGON_URL, DASHBOARD_URL]);
  const accountsResult = await gotoOrRepairSession(
    run.deps,
    FAKE_CONTEXT,
    accountsPage,
    NEVER_CALLED_SEND_INTERACTION,
    DASHBOARD_URL,
    { timeout: 1000 },
    "accounts",
    streamState
  );
  assert.deepEqual(accountsResult, { ok: true });
  assert.equal(reauthCalls, 1, "accounts' repair call spends the budget");

  // Second: later in the SAME run, the transactions export ladder hits its
  // own logon bounce (SessionDeadRedirectError). Without the budget check in
  // reauthAfterSessionLapse, this would drive a SECOND automated bank login.
  let sessionDead = false;
  const outcome = await runSingleLadderAttempt({
    a: makeTransactionsAccount(),
    accountOrdinal: 1,
    accountTotal: 1,
    attemptOrdinal: 1,
    attemptTotal: 1,
    context: FAKE_CONTEXT,
    deps: run.deps,
    onDiagnostics() {
      // Not asserted here — this test is about the auth budget, not diagnostics.
    },
    onSessionDead() {
      sessionDead = true;
    },
    page: makeLogonBounceExportPage(),
    sendInteraction: NEVER_CALLED_SEND_INTERACTION,
    settleDelayMs: 0,
    sinceDate: "2026-01-01",
    streamState,
    todayIso: "2026-07-16",
  });

  assert.deepEqual(outcome, { kind: "session_dead" });
  assert.equal(sessionDead, true, "the ladder still correctly reports session death to its caller");
  assert.equal(
    reauthCalls,
    1,
    "CROSS-PATH BUDGET GUARD: reauthAfterSessionLapse must not spend a second automated login this run just " +
      "because it is a different call site than gotoOrRepairSession — both must share one run-scoped budget"
  );
});

test("cross-path budget: reauthAfterSessionLapse spends the run's one repair attempt first → a later gotoOrRepairSession call cannot spend it again", async () => {
  let reauthCalls = 0;
  const reauthenticate: EmitDeps["reauthenticate"] = () => {
    reauthCalls += 1;
    return Promise.reject(new Error("repair fails, proving the SPEND happened even though it didn't help"));
  };
  const run = makeHarness(reauthenticate);
  const streamState = freshRunState();

  // First: transactions hits a logon bounce and spends the budget via
  // reauthAfterSessionLapse — the repair call itself fails, so the ladder
  // reports session_dead (mirrors integration.test.ts's existing
  // "retains a logon interstitial on the existing re-auth failure outcome").
  let sessionDead = false;
  const outcome = await runSingleLadderAttempt({
    a: makeTransactionsAccount(),
    accountOrdinal: 1,
    accountTotal: 1,
    attemptOrdinal: 1,
    attemptTotal: 1,
    context: FAKE_CONTEXT,
    deps: run.deps,
    onDiagnostics() {
      // Not asserted here — this test is about the auth budget, not diagnostics.
    },
    onSessionDead() {
      sessionDead = true;
    },
    page: makeLogonBounceExportPage(),
    sendInteraction: NEVER_CALLED_SEND_INTERACTION,
    settleDelayMs: 0,
    sinceDate: "2026-01-01",
    streamState,
    todayIso: "2026-07-16",
  });
  assert.deepEqual(outcome, { kind: "session_dead" });
  assert.equal(sessionDead, true);
  assert.equal(reauthCalls, 1, "the transactions path's repair call spends the budget");

  // Second: later in the SAME run, statements' gotoOrRepairSession hits its
  // own logon bounce. Without a shared budget, this would drive a SECOND
  // automated bank login independent of the one the ladder already spent.
  const { calls: statementsCalls, page: statementsPage } = makeSequencedPage([LOGON_URL]);
  const statementsResult = await gotoOrRepairSession(
    run.deps,
    FAKE_CONTEXT,
    statementsPage,
    NEVER_CALLED_SEND_INTERACTION,
    "https://www.usaa.com/my/documents",
    { timeout: 1000 },
    "statements",
    streamState
  );

  assert.deepEqual(statementsResult, { ok: false }, "the budget is already spent, so this call must be refused");
  assert.equal(
    reauthCalls,
    1,
    "CROSS-PATH BUDGET GUARD: gotoOrRepairSession must not spend a second automated login this run just because " +
      "reauthAfterSessionLapse (a different call site) already spent it"
  );
  assert.equal(
    statementsCalls.length,
    1,
    "the retry-navigation after repair must never happen — the shared budget check short-circuits before it"
  );
});

test("cross-path budget counterweight: a FRESH run's transactions path (reauthAfterSessionLapse) can still spend its one attempt when nothing has touched the budget yet", async () => {
  let reauthCalls = 0;
  const reauthenticate: EmitDeps["reauthenticate"] = () => {
    reauthCalls += 1;
    return Promise.reject(new Error("repair fails, so the outcome is deterministically session_dead"));
  };
  const run = makeHarness(reauthenticate);
  const streamState = freshRunState();

  let sessionDead = false;
  const outcome = await runSingleLadderAttempt({
    a: makeTransactionsAccount(),
    accountOrdinal: 1,
    accountTotal: 1,
    attemptOrdinal: 1,
    attemptTotal: 1,
    context: FAKE_CONTEXT,
    deps: run.deps,
    onDiagnostics() {
      // Not asserted here — this test is about the auth budget, not diagnostics.
    },
    onSessionDead() {
      sessionDead = true;
    },
    page: makeLogonBounceExportPage(),
    sendInteraction: NEVER_CALLED_SEND_INTERACTION,
    settleDelayMs: 0,
    sinceDate: "2026-01-01",
    streamState,
    todayIso: "2026-07-16",
  });

  assert.deepEqual(outcome, { kind: "session_dead" });
  assert.equal(sessionDead, true);
  assert.equal(
    reauthCalls,
    1,
    "COUNTERWEIGHT: a fresh, untouched run-scoped budget must still allow exactly one automated login attempt " +
      "on the transactions path — the cross-path guard above must not have made this path permanently inert"
  );
  assert.equal(streamState.sessionRepairAttempted, true, "the ladder's own call spends the shared budget");
});

// ─── runStatementsStream: statements/inbox class of sub-streams ─────────

test("runStatementsStream: documents nav bounces to logon, repair succeeds → session-alive result, scrape proceeds", async () => {
  await withFastTimers(async () => {
    let reauthCalls = 0;
    // biome-ignore lint/suspicious/useAwait: mock matches EmitDeps["reauthenticate"]'s Promise-returning signature
    const reauthenticate: EmitDeps["reauthenticate"] = async () => {
      reauthCalls += 1;
    };
    const run = makeHarness(reauthenticate);
    const { page } = makeSequencedPage([LOGON_URL, "https://www.usaa.com/my/documents"]);
    Object.assign(page, {
      evaluate: () => Promise.resolve([]),
    });

    const sessionAlive = await runStatementsStream(
      { ...run.deps, page },
      FAKE_CONTEXT,
      NEVER_CALLED_SEND_INTERACTION,
      [],
      new Map(),
      freshRunState()
    );

    assert.equal(reauthCalls, 1);
    assert.equal(sessionAlive, true, "repair succeeded — caller must not latch sessionDeadMidRun");
  });
});

test("runStatementsStream: documents nav bounces to logon, repair fails → session-dead result, typed SKIP_RESULT, no scrape", async () => {
  await withFastTimers(async () => {
    // biome-ignore lint/suspicious/useAwait: mock matches EmitDeps["reauthenticate"]'s Promise-returning signature
    const run = makeHarness(async () => {
      throw new Error("usaa_login_failed");
    });
    const { page } = makeSequencedPage([LOGON_URL, LOGON_URL]);
    let evaluateCalled = false;
    Object.assign(page, {
      evaluate: () => {
        evaluateCalled = true;
        return Promise.resolve([]);
      },
    });

    const sessionAlive = await runStatementsStream(
      { ...run.deps, page },
      FAKE_CONTEXT,
      NEVER_CALLED_SEND_INTERACTION,
      [],
      new Map(),
      freshRunState()
    );

    assert.equal(sessionAlive, false, "caller must latch sessionDeadMidRun so later streams don't also attempt repair");
    assert.equal(evaluateCalled, false, "the logon page must never be scraped as a statements index");
    const skips = run.messages.filter((m) => m.type === "SKIP_RESULT" && m.stream === "statements");
    assert.equal(skips.length, 1);
    assert.equal((skips[0] as { reason?: string }).reason, "session_dead_reauth_failed");
  });
});

test("runStatementsStream: a genuine scrape failure (not a logon bounce) still reports session-alive — only a logon bounce means the session died", async () => {
  await withFastTimers(async () => {
    const run = makeHarness();
    const { page } = makeSequencedPage(["https://www.usaa.com/my/documents"]);
    Object.assign(page, {
      evaluate: () => Promise.reject(new Error("page crashed mid-scrape")),
    });

    const sessionAlive = await runStatementsStream(
      { ...run.deps, page },
      FAKE_CONTEXT,
      NEVER_CALLED_SEND_INTERACTION,
      [],
      new Map(),
      freshRunState()
    );

    assert.equal(sessionAlive, true, "a non-auth scrape error must not be conflated with session death");
    const skips = run.messages.filter((m) => m.type === "SKIP_RESULT" && m.stream === "statements");
    assert.equal(skips.length, 1);
    assert.equal((skips[0] as { reason?: string }).reason, "scrape_failed");
  });
});

// ─── runInboxStream: session-dead propagation to the caller ────────────

test("runInboxStream: inbox nav bounces to logon, repair succeeds → session-alive, scrape proceeds normally", async () => {
  await withFastTimers(async () => {
    let reauthCalls = 0;
    // biome-ignore lint/suspicious/useAwait: mock matches EmitDeps["reauthenticate"]'s Promise-returning signature
    const reauthenticate: EmitDeps["reauthenticate"] = async () => {
      reauthCalls += 1;
    };
    const run = makeHarness(reauthenticate);
    const { page } = makeSequencedPage([LOGON_URL, "https://www.usaa.com/my/inbox"]);
    Object.assign(page, {
      evaluate: () => Promise.resolve([{ status: "Read", date_short: "6/1", preview: "hi" }]),
    });

    const sessionAlive = await runInboxStream(
      run.deps,
      FAKE_CONTEXT,
      page,
      NEVER_CALLED_SEND_INTERACTION,
      {},
      freshRunState()
    );

    assert.equal(reauthCalls, 1);
    assert.equal(sessionAlive, true);
  });
});

test("runInboxStream: inbox nav bounces to logon, repair fails → session-dead result surfaces to the caller for cross-stream gating", async () => {
  await withFastTimers(async () => {
    // biome-ignore lint/suspicious/useAwait: mock matches EmitDeps["reauthenticate"]'s Promise-returning signature
    const run = makeHarness(async () => {
      throw new Error("usaa_login_failed");
    });
    const { page } = makeSequencedPage([LOGON_URL, LOGON_URL]);
    let evaluateCalled = false;
    Object.assign(page, {
      evaluate: () => {
        evaluateCalled = true;
        return Promise.resolve([]);
      },
    });

    const sessionAlive = await runInboxStream(
      run.deps,
      FAKE_CONTEXT,
      page,
      NEVER_CALLED_SEND_INTERACTION,
      {},
      freshRunState()
    );

    assert.equal(sessionAlive, false, "the caller (collect()) uses this to latch sessionDeadMidRun for later streams");
    assert.equal(evaluateCalled, false, "the logon page must never be scraped as inbox rows");
  });
});
