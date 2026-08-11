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
  runStatementsStream,
  type UsaaRunState,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

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
