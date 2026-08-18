// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Executable wiring tests for `runInboxStream` and `runCreditCardBillingStream`
 * — the actual exported functions the connector calls, driven with a mocked
 * Playwright `Page`, not source inspection.
 *
 * These prove, by actually running the code:
 *   1. A successful scrape emits DETAIL_COVERAGE with the right considered/covered.
 *   2. A caught navigation failure (page.goto throws) emits SKIP_RESULT and
 *      NO DETAIL_COVERAGE for inbox_messages — proving the existing catch
 *      block still short-circuits before the new coverage call is reached.
 *   3. A caught scrape failure (page.evaluate throws) emits SKIP_RESULT and
 *      NO DETAIL_COVERAGE for inbox_messages.
 *   4. runCreditCardBillingStream emits DETAIL_COVERAGE for both
 *      credit_card_billing and credit_card_billing_stats after a successful
 *      per-card scrape of every card.
 *   5. A caught mid-loop scrape failure emits SKIP_RESULT and NO
 *      DETAIL_COVERAGE for either credit-card stream.
 *   6. THE WRONG-PAGE COUNTEREXAMPLE: when one card's page.goto silently
 *      rejects (the pre-existing `.catch(() => undefined)` swallow this fix
 *      closes), the connector must NOT scrape and attribute that page's
 *      content to the failed card — it must emit a DETAIL_GAP for that card,
 *      exclude it from `covered`, and STILL correctly scrape and emit every
 *      other (successfully-navigated) card. Before the fix, this test fails:
 *      the swallowed failure fell through to scrapeCreditCardBilling on
 *      whatever page was still loaded, silently mis-attributing that card's
 *      billing data.
 *
 * `politeDelay` (real setTimeout, 5-6s per card/inbox call in production) is
 * neutralized with `node:test`'s fake timers so these tests run in
 * milliseconds — no live browser, no real waits.
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { BrowserContext, Page } from "playwright";
import type {
  BrowserCollectContext,
  DetailCoverageMessage,
  DetailGapMessage,
  DetailGapStartEntry,
  EmittedMessage,
} from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import {
  buildServedCreditCardGapLookups,
  type EmitDeps,
  runCreditCardBillingStream,
  runInboxStream,
  type UsaaRunState,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { DashboardAccount, InboxRow } from "./types.ts";

const FAKE_CONTEXT = {} as BrowserContext;
// biome-ignore lint/suspicious/useAwait: mock throws to prove the happy-path tests never reach a reauth attempt
const NEVER_CALLED_SEND_INTERACTION: BrowserCollectContext["sendInteraction"] = async () => {
  throw new Error("sendInteraction must not be called on the happy path — no session-death signal was produced");
};

/** Fresh per-run state for each test — mirrors `collect()` constructing
 *  exactly one `UsaaRunState` per run, shared across every stream/card. */
function freshRunState(): UsaaRunState {
  return { sessionDeadMidRun: false, sessionRepairAttempted: false };
}

function makeHarness(): {
  deps: EmitDeps;
  emitted: Array<{ stream: string; data: unknown }>;
  messages: EmittedMessage[];
} {
  const harness = makeRecordingEmit(validateRecord);
  const deps: EmitDeps = { emit: harness.emit, emitRecord: harness.emitRecord };
  return { deps, emitted: harness.emitted, messages: harness.protocolMessages };
}

function coverageFor(messages: EmittedMessage[], stream: string): DetailCoverageMessage | undefined {
  return messages.find(
    (m): m is DetailCoverageMessage => m.type === "DETAIL_COVERAGE" && m.stream === stream && m.state_stream === stream
  );
}

function skipsFor(messages: EmittedMessage[], stream: string): Extract<EmittedMessage, { type: "SKIP_RESULT" }>[] {
  return messages.filter(
    (m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT" && m.stream === stream
  );
}

function gapsFor(messages: EmittedMessage[], stream: string): DetailGapMessage[] {
  return messages.filter((m): m is DetailGapMessage => m.type === "DETAIL_GAP" && m.stream === stream);
}

function recoveriesFor(
  messages: EmittedMessage[],
  stream: string
): Extract<EmittedMessage, { type: "DETAIL_GAP_RECOVERED" }>[] {
  return messages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP_RECOVERED" }> =>
      m.type === "DETAIL_GAP_RECOVERED" && m.stream === stream
  );
}

function servedCreditCardGap(stream: string, locatorKind: string, cardId: string, gapId: string): DetailGapStartEntry {
  return {
    gap_id: gapId,
    stream,
    status: "pending",
    reference_only: true,
    record_key: cardId,
    detail_locator: { kind: locatorKind, card_id: cardId },
  };
}

/** Runs `fn` with `node:test`'s fake setTimeout enabled and auto-ticking, so
 *  any `politeDelay(ms)` inside resolves immediately instead of waiting for
 *  real wall-clock time. Ticks a large fixed amount after every macrotask
 *  turn, well past the largest real delay constant in this connector
 *  (CC_SETTLE_DELAY_MS = 6000ms), so every pending politeDelay clears. */
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

function makeCard(overrides: Partial<DashboardAccount> = {}): DashboardAccount {
  return {
    account_id_raw: "ACCT-CC-0001",
    account_url: "/my/credit-card?accountId=ACCT-CC-0001",
    account_type: "credit-card",
    name: "USAA RATE ADVANTAGE VISA",
    last_four: "0001",
    balance_cents: null,
    raw_text: "USAA RATE ADVANTAGE VISA Ending in *0001",
    ...overrides,
  };
}

// ─── inbox_messages wiring ──────────────────────────────────────────────

function makeInboxPage(rows: InboxRow[] | (() => InboxRow[]), gotoFails = false): Page {
  return Object.assign({} as Page, {
    goto: () => (gotoFails ? Promise.reject(new Error("net::ERR_CONNECTION_RESET")) : Promise.resolve(null)),
    url: () => "https://www.usaa.com/my/inbox",
    evaluate: () => Promise.resolve(typeof rows === "function" ? rows() : rows),
  });
}

test("wiring: runInboxStream emits DETAIL_COVERAGE with considered/covered after a successful scrape", async () => {
  await withFastTimers(async () => {
    const run = makeHarness();
    const page = makeInboxPage([
      { status: "Read", date_short: "6/1", preview: "Statement ready" },
      { status: "Unread", date_short: "6/2", preview: "New alert" },
    ]);
    await runInboxStream(run.deps, FAKE_CONTEXT, page, NEVER_CALLED_SEND_INTERACTION, {}, freshRunState());

    assert.equal(run.emitted.filter((e) => e.stream === "inbox_messages").length, 2, "both rows emitted");
    const cov = coverageFor(run.messages, "inbox_messages");
    assert.ok(cov, "successful scrape emits inbox_messages coverage");
    assert.equal(cov?.considered, 2);
    assert.equal(cov?.covered, 2);
    assert.equal(skipsFor(run.messages, "inbox_messages").length, 0, "no skip on a successful run");
  });
});

test("wiring: runInboxStream emits SKIP_RESULT and NO coverage when page.goto throws", async () => {
  await withFastTimers(async () => {
    const run = makeHarness();
    const page = makeInboxPage([{ status: "Read", date_short: "6/1", preview: "x" }], /* gotoFails */ true);
    await runInboxStream(run.deps, FAKE_CONTEXT, page, NEVER_CALLED_SEND_INTERACTION, {}, freshRunState());

    assert.equal(run.emitted.filter((e) => e.stream === "inbox_messages").length, 0, "no records on a nav failure");
    const skips = skipsFor(run.messages, "inbox_messages");
    assert.equal(skips.length, 1, "a caught navigation failure emits exactly one SKIP_RESULT");
    assert.equal(skips[0]?.reason, "scrape_failed");
    assert.equal(
      coverageFor(run.messages, "inbox_messages"),
      undefined,
      "the existing catch block short-circuits BEFORE the new coverage call — a failed run must never claim proof"
    );
  });
});

test("wiring: runInboxStream emits SKIP_RESULT and NO coverage when the scrape itself throws", async () => {
  await withFastTimers(async () => {
    const run = makeHarness();
    const page = Object.assign({} as Page, {
      goto: () => Promise.resolve(null),
      url: () => "https://www.usaa.com/my/inbox",
      evaluate: () => Promise.reject(new Error("page crashed mid-scrape")),
    });
    await runInboxStream(run.deps, FAKE_CONTEXT, page, NEVER_CALLED_SEND_INTERACTION, {}, freshRunState());

    const skips = skipsFor(run.messages, "inbox_messages");
    assert.equal(skips.length, 1, "a caught scrape failure emits exactly one SKIP_RESULT");
    assert.equal(
      coverageFor(run.messages, "inbox_messages"),
      undefined,
      "a scrape exception must never reach the coverage call"
    );
  });
});

test("wiring: runInboxStream on a genuinely empty inbox proves verified-empty via a real run, not just the pure helper", async () => {
  await withFastTimers(async () => {
    const run = makeHarness();
    const page = makeInboxPage([]);
    await runInboxStream(run.deps, FAKE_CONTEXT, page, NEVER_CALLED_SEND_INTERACTION, {}, freshRunState());

    assert.equal(run.emitted.length, 0);
    const cov = coverageFor(run.messages, "inbox_messages");
    assert.ok(cov, "a successful empty-inbox scrape still declares coverage");
    assert.equal(cov?.considered, 0);
    assert.equal(cov?.covered, 0);
  });
});

test("wiring: runInboxStream emits a diagnostic SKIP_RESULT when every listed row fails to resolve a record (live regression: 0/13 covered, no diagnostic ever emitted)", async () => {
  await withFastTimers(async () => {
    const run = makeHarness();
    // Every row is missing date_short — buildInboxMessageRecord returns null
    // for all of them (parsers.ts:579-581), the same shape a column-index
    // drift on the inbox table (an extra leading cell, or a re-ordered
    // status/date/preview layout) would produce: rows are found (considered
    // > 0) but none resolve into a record (covered === 0). Before this fix,
    // the coverage math correctly read partial (0 < 13) but the run emitted
    // NO SKIP_RESULT and NO diagnostic — the only other USAA streams that can
    // silently degrade this way (statements' PDF download, transactions'
    // export ladder) always emit a structural diagnostic on failure; inbox
    // did not.
    const rows: InboxRow[] = Array.from({ length: 13 }, (_unused, i) => ({
      status: "Unread",
      date_short: "",
      preview: `message ${i}`,
    }));
    const page = makeInboxPage(rows);
    await runInboxStream(run.deps, FAKE_CONTEXT, page, NEVER_CALLED_SEND_INTERACTION, {}, freshRunState());

    assert.equal(run.emitted.filter((e) => e.stream === "inbox_messages").length, 0, "no row resolved into a record");
    const cov = coverageFor(run.messages, "inbox_messages");
    assert.ok(cov, "coverage is still declared");
    assert.equal(cov?.considered, 13);
    assert.equal(cov?.covered, 0, "an honest partial, not a false complete");
    const skips = skipsFor(run.messages, "inbox_messages");
    assert.equal(
      skips.length,
      1,
      "a total resolution failure (0 covered out of a nonzero considered) must emit a diagnostic SKIP_RESULT, mirroring statements/transactions' structural-drift diagnostics"
    );
    assert.equal(skips[0]?.reason, "inbox_rows_unresolved");
  });
});

test("wiring: runInboxStream does NOT emit a diagnostic SKIP_RESULT when only some rows fail to resolve", async () => {
  await withFastTimers(async () => {
    const run = makeHarness();
    const rows: InboxRow[] = [
      { status: "Unread", date_short: "6/1", preview: "resolves fine" },
      { status: "Read", date_short: "", preview: "missing date" },
    ];
    const page = makeInboxPage(rows);
    await runInboxStream(run.deps, FAKE_CONTEXT, page, NEVER_CALLED_SEND_INTERACTION, {}, freshRunState());

    const cov = coverageFor(run.messages, "inbox_messages");
    assert.equal(cov?.considered, 2);
    assert.equal(cov?.covered, 1);
    assert.equal(
      skipsFor(run.messages, "inbox_messages").length,
      0,
      "a partial (not total) resolution gap is not a structural-drift signal — no diagnostic noise on ordinary per-row drops"
    );
  });
});

// ─── credit_card_billing / credit_card_billing_stats wiring ────────────

/** Per-card-aware fake Page: `.goto` records which card URL was navigated
 *  to (or fails it, per `failUrls`) and `.evaluate` returns billing data
 *  keyed to whichever URL was last successfully navigated — so a bug that
 *  scrapes after a swallowed failed navigation is directly observable: the
 *  billing data attributed to the failed card would be the PRIOR card's
 *  data, not that card's own (or, for the first card, no valid nav ever
 *  happened at all). */
function makeCreditCardPage(failUrls: Set<string> = new Set()): {
  billingByUrl: Record<string, Record<string, string>>;
  gotoCalls: string[];
  page: Page;
} {
  const gotoCalls: string[] = [];
  let currentUrl = "https://www.usaa.com/my/usaa"; // dashboard, pre-loop
  const billingByUrl: Record<string, Record<string, string>> = {
    "https://www.usaa.com/my/usaa": { "Current Balance": "$0.00" }, // the wrong-page tell
  };
  const page = Object.assign({} as Page, {
    goto: (url: string) => {
      gotoCalls.push(url);
      if (failUrls.has(url)) {
        return Promise.reject(new Error("net::ERR_CONNECTION_RESET"));
      }
      currentUrl = url;
      return Promise.resolve(null);
    },
    url: () => currentUrl,
    evaluate: () => Promise.resolve(billingByUrl[currentUrl] ?? {}),
  });
  return { billingByUrl, gotoCalls, page };
}

test("wiring: runCreditCardBillingStream emits DETAIL_COVERAGE for both streams after a successful scan", async () => {
  await withFastTimers(async () => {
    const cards = [
      makeCard({ account_id_raw: "CC1", account_url: "/my/credit-card?accountId=CC1" }),
      makeCard({ account_id_raw: "CC2", account_url: "/my/credit-card?accountId=CC2", last_four: "0002" }),
    ];
    const { page, billingByUrl } = makeCreditCardPage();
    billingByUrl[`https://www.usaa.com${cards[0]?.account_url}`] = { "Current Balance": "$100.00" };
    billingByUrl[`https://www.usaa.com${cards[1]?.account_url}`] = { "Current Balance": "$200.00" };

    const run = makeHarness();
    const fingerprintCursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
    await runCreditCardBillingStream(
      run.deps,
      FAKE_CONTEXT,
      page,
      NEVER_CALLED_SEND_INTERACTION,
      cards,
      freshRunState(),
      {
        emitEntity: true,
        emitStats: true,
        fingerprintCursor,
        observedOn: "2026-06-01",
      }
    );

    const statsEmitted = run.emitted.filter((e) => e.stream === "credit_card_billing_stats");
    assert.equal(run.emitted.filter((e) => e.stream === "credit_card_billing").length, 2);
    assert.equal(statsEmitted.length, 2);
    const balances = statsEmitted
      .map((e) => (e.data as { current_balance_cents?: number }).current_balance_cents)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    assert.deepEqual(
      balances,
      [10_000, 20_000],
      "each card's own scraped balance — proves the two cards were navigated and scraped independently, not both reading one page"
    );
    const entityCov = coverageFor(run.messages, "credit_card_billing");
    const statsCov = coverageFor(run.messages, "credit_card_billing_stats");
    assert.ok(entityCov, "credit_card_billing declares coverage after a successful scan");
    assert.equal(entityCov?.considered, 2);
    assert.equal(entityCov?.covered, 2);
    assert.ok(statsCov, "credit_card_billing_stats declares coverage after a successful scan");
    assert.equal(statsCov?.considered, 2);
    assert.equal(statsCov?.covered, 2);
  });
});

test("wiring: runCreditCardBillingStream emits DETAIL_GAP_RECOVERED for a card the runtime served a pending gap for, once it scrapes successfully (live regression: gaps from a crashed run stayed pending forever)", async () => {
  await withFastTimers(async () => {
    const cc1 = makeCard({ account_id_raw: "CC1", account_url: "/my/credit-card?accountId=CC1", last_four: "0001" });
    const cc1Url = `https://www.usaa.com${cc1.account_url}`;
    const { page, billingByUrl } = makeCreditCardPage();
    billingByUrl[cc1Url] = { "Current Balance": "$75.00" };

    const cardId = "CC1"; // creditCardId() falls back to account_id_raw
    const detailGaps: DetailGapStartEntry[] = [
      servedCreditCardGap("credit_card_billing", "usaa.credit_card_billing", cardId, "gap_billing_1"),
      servedCreditCardGap("credit_card_billing_stats", "usaa.credit_card_billing_stats", cardId, "gap_stats_1"),
    ];

    const run = makeHarness();
    run.deps.servedCreditCardGaps = buildServedCreditCardGapLookups(detailGaps);
    const fingerprintCursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
    await runCreditCardBillingStream(
      run.deps,
      FAKE_CONTEXT,
      page,
      NEVER_CALLED_SEND_INTERACTION,
      [cc1],
      freshRunState(),
      {
        emitEntity: true,
        emitStats: true,
        fingerprintCursor,
        observedOn: "2026-06-01",
      }
    );

    const billingRecoveries = recoveriesFor(run.messages, "credit_card_billing");
    const statsRecoveries = recoveriesFor(run.messages, "credit_card_billing_stats");
    assert.equal(billingRecoveries.length, 1, "the successfully-scraped card recovers its credit_card_billing gap");
    assert.equal(billingRecoveries[0]?.gap_id, "gap_billing_1");
    assert.equal(billingRecoveries[0]?.record_key, cardId);
    assert.equal(
      statsRecoveries.length,
      1,
      "the same card also recovers its independent credit_card_billing_stats gap"
    );
    assert.equal(statsRecoveries[0]?.gap_id, "gap_stats_1");
  });
});

test("wiring: runCreditCardBillingStream does NOT recover a gap for a card the runtime did not serve one for", async () => {
  await withFastTimers(async () => {
    const cc1 = makeCard({ account_id_raw: "CC1", account_url: "/my/credit-card?accountId=CC1", last_four: "0001" });
    const cc1Url = `https://www.usaa.com${cc1.account_url}`;
    const { page, billingByUrl } = makeCreditCardPage();
    billingByUrl[cc1Url] = { "Current Balance": "$75.00" };

    const run = makeHarness();
    run.deps.servedCreditCardGaps = buildServedCreditCardGapLookups([]);
    const fingerprintCursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
    await runCreditCardBillingStream(
      run.deps,
      FAKE_CONTEXT,
      page,
      NEVER_CALLED_SEND_INTERACTION,
      [cc1],
      freshRunState(),
      {
        emitEntity: true,
        emitStats: true,
        fingerprintCursor,
        observedOn: "2026-06-01",
      }
    );

    assert.equal(recoveriesFor(run.messages, "credit_card_billing").length, 0, "no served gap, no recovery emitted");
    assert.equal(recoveriesFor(run.messages, "credit_card_billing_stats").length, 0);
  });
});

test("wiring: runCreditCardBillingStream emits SKIP_RESULT and NO coverage when a scrape throws mid-loop", async () => {
  await withFastTimers(async () => {
    const cards = [makeCard({ account_id_raw: "CC1" })];
    const page = Object.assign({} as Page, {
      goto: () => Promise.resolve(null),
      url: () => "https://www.usaa.com/my/credit-card?accountId=ACCT-CC-0001",
      evaluate: () => Promise.reject(new Error("page crashed mid-scrape")),
    });

    const run = makeHarness();
    const fingerprintCursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
    await runCreditCardBillingStream(
      run.deps,
      FAKE_CONTEXT,
      page,
      NEVER_CALLED_SEND_INTERACTION,
      cards,
      freshRunState(),
      {
        emitEntity: true,
        emitStats: true,
        fingerprintCursor,
        observedOn: "2026-06-01",
      }
    );

    const skips = skipsFor(run.messages, "credit_card_billing");
    assert.equal(skips.length, 1, "a caught mid-loop scrape failure emits exactly one SKIP_RESULT");
    assert.equal(coverageFor(run.messages, "credit_card_billing"), undefined);
    assert.equal(coverageFor(run.messages, "credit_card_billing_stats"), undefined);
  });
});

test("wiring: a card whose navigation fails does NOT scrape/attribute the wrong page — gapped, excluded from covered, siblings still correct", async () => {
  await withFastTimers(async () => {
    const cc1 = makeCard({ account_id_raw: "CC1", account_url: "/my/credit-card?accountId=CC1", last_four: "0001" });
    const cc2 = makeCard({ account_id_raw: "CC2", account_url: "/my/credit-card?accountId=CC2", last_four: "0002" });
    const cc1Url = `https://www.usaa.com${cc1.account_url}`;
    const cc2Url = `https://www.usaa.com${cc2.account_url}`;
    // CC1's navigation fails (the pre-existing swallowed .catch case);
    // CC2 navigates successfully.
    const { page, billingByUrl, gotoCalls } = makeCreditCardPage(new Set([cc1Url]));
    billingByUrl[cc2Url] = { "Current Balance": "$50.00" };

    const run = makeHarness();
    const fingerprintCursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
    await runCreditCardBillingStream(
      run.deps,
      FAKE_CONTEXT,
      page,
      NEVER_CALLED_SEND_INTERACTION,
      [cc1, cc2],
      freshRunState(),
      {
        emitEntity: true,
        emitStats: true,
        fingerprintCursor,
        observedOn: "2026-06-01",
      }
    );

    assert.deepEqual(gotoCalls, [cc1Url, cc2Url], "both cards were attempted");

    const entityEmitted = run.emitted.filter((e) => e.stream === "credit_card_billing");
    const statsEmitted = run.emitted.filter((e) => e.stream === "credit_card_billing_stats");
    assert.equal(entityEmitted.length, 1, "only the successfully-navigated card (CC2) emits an entity record");
    assert.equal(statsEmitted.length, 1, "only CC2 emits a stats observation");
    const [cc2Stats] = statsEmitted;
    assert.ok(cc2Stats, "CC2's stats record was captured");
    assert.equal(
      (cc2Stats.data as { current_balance_cents?: number }).current_balance_cents,
      5000,
      "CC2's own scraped balance, not CC1's page or the pre-loop dashboard's stale $0.00"
    );

    const entityGaps = gapsFor(run.messages, "credit_card_billing");
    const statsGaps = gapsFor(run.messages, "credit_card_billing_stats");
    assert.equal(entityGaps.length, 1, "the failed-navigation card gets a DETAIL_GAP, not silent loss");
    assert.equal(entityGaps[0]?.reason, "temporary_unavailable");
    assert.equal(statsGaps.length, 1, "the stats stream also gets a DETAIL_GAP for the same card");

    const entityCov = coverageFor(run.messages, "credit_card_billing");
    const statsCov = coverageFor(run.messages, "credit_card_billing_stats");
    assert.equal(entityCov?.considered, 2, "considered is still the full 2-card boundary");
    assert.equal(entityCov?.covered, 1, "covered excludes the failed-navigation card — never a false complete");
    assert.equal(statsCov?.considered, 2);
    assert.equal(statsCov?.covered, 1);
  });
});

// ─── logon-bounce (not a rejected .goto — a "successful" nav that LANDS on
//     the logon page) mid-run stale-session self-heal ───────────────────

/** Unlike `makeCreditCardPage`'s `failUrls` (a rejected `.goto` promise —
 *  network error), this simulates USAA's actual session-death signal: a
 *  `.goto` that RESOLVES normally but lands on `/my/logon` instead of the
 *  requested card URL — the pre-fix defect this test guards against is
 *  scraping that logon page's DOM and misattributing it as this card's
 *  billing data. */
function makeLogonBouncingCreditCardPage(bounceOnce: Set<string>): {
  billingByUrl: Record<string, Record<string, string>>;
  gotoCalls: string[];
  page: Page;
} {
  const gotoCalls: string[] = [];
  const bounced = new Set<string>();
  let currentUrl = "https://www.usaa.com/my/usaa";
  const billingByUrl: Record<string, Record<string, string>> = {};
  const page = Object.assign({} as Page, {
    goto: (url: string) => {
      gotoCalls.push(url);
      if (bounceOnce.has(url) && !bounced.has(url)) {
        bounced.add(url);
        currentUrl = "https://www.usaa.com/my/logon";
        return Promise.resolve(null);
      }
      currentUrl = url;
      return Promise.resolve(null);
    },
    url: () => currentUrl,
    evaluate: () => Promise.resolve(billingByUrl[currentUrl] ?? {}),
  });
  return { billingByUrl, gotoCalls, page };
}

test("wiring: a card's navigation lands on the USAA logon page (session died mid-run) → repair succeeds → retried nav scrapes the real card, not the logon page", async () => {
  await withFastTimers(async () => {
    const cc1 = makeCard({ account_id_raw: "CC1", account_url: "/my/credit-card?accountId=CC1", last_four: "0001" });
    const cc1Url = `https://www.usaa.com${cc1.account_url}`;
    const { page, billingByUrl, gotoCalls } = makeLogonBouncingCreditCardPage(new Set([cc1Url]));
    billingByUrl[cc1Url] = { "Current Balance": "$75.00" };

    let reauthCalls = 0;
    const run = makeHarness();
    // biome-ignore lint/suspicious/useAwait: mock matches EmitDeps["reauthenticate"]'s Promise-returning signature
    run.deps.reauthenticate = async () => {
      reauthCalls += 1;
    };
    const fingerprintCursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
    await runCreditCardBillingStream(
      run.deps,
      FAKE_CONTEXT,
      page,
      NEVER_CALLED_SEND_INTERACTION,
      [cc1],
      freshRunState(),
      {
        emitEntity: true,
        emitStats: true,
        fingerprintCursor,
        observedOn: "2026-06-01",
      }
    );

    assert.equal(reauthCalls, 1, "repair attempted exactly once");
    assert.deepEqual(
      gotoCalls,
      [cc1Url, cc1Url],
      "the retry navigates to the EXACT SAME card url, not a different one"
    );
    const entityEmitted = run.emitted.filter((e) => e.stream === "credit_card_billing");
    assert.equal(entityEmitted.length, 1, "the card is scraped normally after the repaired retry");
    const statsEmitted = run.emitted.filter((e) => e.stream === "credit_card_billing_stats");
    assert.equal(
      (statsEmitted[0]?.data as { current_balance_cents?: number } | undefined)?.current_balance_cents,
      7500,
      "the card's OWN balance from the post-repair retry, never the logon page's absent/zeroed fields"
    );
    assert.equal(gapsFor(run.messages, "credit_card_billing").length, 0, "a repaired session must not gap the card");
  });
});

test("wiring: a card's navigation lands on the logon page and repair fails → gapped exactly like a network-error nav failure, never scraped", async () => {
  await withFastTimers(async () => {
    const cc1 = makeCard({ account_id_raw: "CC1", account_url: "/my/credit-card?accountId=CC1", last_four: "0001" });
    const cc1Url = `https://www.usaa.com${cc1.account_url}`;
    const { page, billingByUrl } = makeLogonBouncingCreditCardPage(new Set([cc1Url, cc1Url]));
    // Every nav to CC1's url bounces (including the retry inside
    // gotoOrRepairSession) — session death that repair cannot fix.
    Object.assign(page, {
      goto: () => {
        Object.assign(page, { url: () => "https://www.usaa.com/my/logon" });
        return Promise.resolve(null);
      },
    });
    billingByUrl[cc1Url] = { "Current Balance": "$75.00" };

    const run = makeHarness();
    // biome-ignore lint/suspicious/useAwait: mock matches EmitDeps["reauthenticate"]'s Promise-returning signature
    run.deps.reauthenticate = async () => {
      throw new Error("usaa_login_failed");
    };
    const fingerprintCursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
    await runCreditCardBillingStream(
      run.deps,
      FAKE_CONTEXT,
      page,
      NEVER_CALLED_SEND_INTERACTION,
      [cc1],
      freshRunState(),
      {
        emitEntity: true,
        emitStats: true,
        fingerprintCursor,
        observedOn: "2026-06-01",
      }
    );

    const entityEmitted = run.emitted.filter((e) => e.stream === "credit_card_billing");
    assert.equal(
      entityEmitted.length,
      0,
      "the logon page must never be scraped/attributed as this card's billing data"
    );
    const entityGaps = gapsFor(run.messages, "credit_card_billing");
    assert.equal(
      entityGaps.length,
      1,
      "an unrepairable session-death bounce gets the same DETAIL_GAP as a network failure"
    );
    assert.equal(entityGaps[0]?.reason, "temporary_unavailable");
  });
});

// ─── N-card run-scoped repair budget (the N-cards-N-logins defect) ─────

test("wiring: 8 cards, session dead from card 1 onward → exactly ONE reauth attempt across the whole run, not one per card", async () => {
  await withFastTimers(async () => {
    const cards = Array.from({ length: 8 }, (_unused, i) =>
      makeCard({
        account_id_raw: `CC${i + 1}`,
        account_url: `/my/credit-card?accountId=CC${i + 1}`,
        last_four: String(i + 1).padStart(4, "0"),
      })
    );
    // Every card's navigation bounces to the logon page — the session died
    // BEFORE this stream ever ran (e.g. accounts already latched it dead).
    const gotoCalls: string[] = [];
    const page = Object.assign({} as Page, {
      goto: (url: string) => {
        gotoCalls.push(url);
        return Promise.resolve(null);
      },
      url: () => "https://www.usaa.com/my/logon",
      evaluate: () => Promise.resolve({}),
    });

    let reauthCalls = 0;
    const run = makeHarness();
    // biome-ignore lint/suspicious/useAwait: mock matches EmitDeps["reauthenticate"]'s Promise-returning signature
    run.deps.reauthenticate = async () => {
      reauthCalls += 1;
      // Repair "succeeds" (doesn't throw) but the session is still dead —
      // gotoOrRepairSession's own retry-nav will land on logon again, so
      // repair fails from gotoOrRepairSession's point of view. This models
      // the worst case: an attacker-visible bank login attempt for EVERY
      // card if the budget is not run-scoped.
    };
    const fingerprintCursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
    const streamState = freshRunState();

    await runCreditCardBillingStream(run.deps, FAKE_CONTEXT, page, NEVER_CALLED_SEND_INTERACTION, cards, streamState, {
      emitEntity: true,
      emitStats: true,
      fingerprintCursor,
      observedOn: "2026-06-01",
    });

    assert.equal(
      reauthCalls,
      1,
      "DEFECT GUARD: a dead session must drive AT MOST ONE automated bank login attempt across the whole card loop, never N — repeated automated logins risk fraud-detection lockout of the real account"
    );
    assert.equal(streamState.sessionDeadMidRun, true, "the loop must latch session death for the caller");
    assert.equal(
      run.emitted.filter((e) => e.stream === "credit_card_billing").length,
      0,
      "no card is scraped once the session is known dead"
    );
    const entityGaps = gapsFor(run.messages, "credit_card_billing");
    assert.equal(
      entityGaps.length,
      8,
      "every card — including the 7 never actually navigated after the break — gets a gap, not silent loss"
    );
    const entityCov = coverageFor(run.messages, "credit_card_billing");
    assert.equal(
      entityCov?.considered,
      8,
      "considered is still the full 8-card boundary, even though the loop broke early"
    );
    assert.equal(entityCov?.covered, 0);
  });
});

test("wiring: card 3 of 5 has a plain nav failure (not a logon bounce) → gapped and the loop CONTINUES to cards 4-5, no reauth attempted at all", async () => {
  await withFastTimers(async () => {
    const cards = Array.from({ length: 5 }, (_unused, i) =>
      makeCard({
        account_id_raw: `CC${i + 1}`,
        account_url: `/my/credit-card?accountId=CC${i + 1}`,
        last_four: String(i + 1).padStart(4, "0"),
      })
    );
    const failUrl = `https://www.usaa.com${cards[2]?.account_url}`;
    const { page, billingByUrl, gotoCalls } = makeCreditCardPage(new Set([failUrl]));
    for (const c of cards) {
      const url = `https://www.usaa.com${c.account_url}`;
      if (url !== failUrl) {
        billingByUrl[url] = { "Current Balance": "$1.00" };
      }
    }

    const run = makeHarness();
    const fingerprintCursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
    const streamState = freshRunState();

    await runCreditCardBillingStream(run.deps, FAKE_CONTEXT, page, NEVER_CALLED_SEND_INTERACTION, cards, streamState, {
      emitEntity: true,
      emitStats: true,
      fingerprintCursor,
      observedOn: "2026-06-01",
    });

    assert.equal(
      gotoCalls.length,
      5,
      "a plain (non-logon-bounce) nav failure must NOT stop the loop — M9 regression guard"
    );
    assert.equal(streamState.sessionDeadMidRun, false, "a plain nav failure is not a session-death signal");
    assert.equal(
      run.emitted.filter((e) => e.stream === "credit_card_billing").length,
      4,
      "the 4 successfully-navigated cards still scrape and emit"
    );
    const entityCov = coverageFor(run.messages, "credit_card_billing");
    assert.equal(entityCov?.considered, 5);
    assert.equal(entityCov?.covered, 4, "only the one plain-nav-failure card is excluded");
  });
});
