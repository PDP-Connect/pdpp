// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage evidence for USAA's four `singleton_presence` /
 * `checkpoint_window` streams: `account_stats`, `credit_card_billing`,
 * `credit_card_billing_stats`, `inbox_messages`.
 *
 * Before this change, none of these streams ever called
 * `emitDetailCoverage`/`emitAccountsStream`'s equivalent — only their
 * sibling `full_inventory`/`parent_detail_accounting` streams (`accounts`,
 * `transactions`, `statements`) did. `evaluateStreamCoherence`
 * (packages/reference-contract/src/evidence/coherence.ts) requires a measured
 * `considered` boundary for EVERY strategy, including `singleton_presence`
 * and `checkpoint_window` — a committed STATE checkpoint alone is explicitly
 * rejected as `checkpoint_only` / `unknown`, by design. That is exactly why a
 * fully successful USAA run (real records ingested, zero connector_detail_gaps)
 * still showed `Coverage: unknown` on `/sources` for these four streams.
 *
 * These tests pin the fix at the two testable seams:
 *   1. `emitAccountsStream`'s `account_stats` self-coverage (mirrors the
 *      existing `accounts` self-coverage pinned in accounts-considered.test.ts).
 *   2. The pure `creditCardAccounts` boundary + `computeInboxCoverage`
 *      helpers that `runCreditCardBillingStream`/`runInboxStream` now call —
 *      extracted specifically so this arithmetic is unit-testable without a
 *      live Playwright Page or the connector's real multi-second settle
 *      delays (see credit_card_billing/inbox comments below).
 *
 * `credit_card_billing`, `credit_card_billing_stats`, and `inbox_messages`
 * are driven by page-scraping functions (`runCreditCardBillingStream`,
 * `runInboxStream`) that are not exported and are not practical to unit-test
 * directly (they call `politeDelay` with real multi-second constants). Their
 * `considered`/`covered` computation is proven here at the pure-function
 * boundary they delegate to; the emit-path wiring itself (that the DETAIL_COVERAGE
 * message is actually sent with these values, after a successful scrape and
 * never after a caught scrape failure) is a straightforward call-site read,
 * confirmed by inspection of index.ts's try/catch structure (the emit call
 * sits after the STATE commit, inside the try body — a caught exception
 * short-circuits into the existing SKIP_RESULT branch before either is
 * reached, exactly like the already-tested `statements`/`transactions` paths).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DetailCoverageMessage, EmittedMessage } from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { computeInboxCoverage, type InboxCoverageRow } from "./inbox-coverage.ts";
import { creditCardAccounts, type EmitDeps, emitAccountsStream } from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { DashboardAccount } from "./types.ts";

const RUN1_AT = "2026-06-01T10:00:00.000Z";
const DAY1 = "2026-06-01";

function makeHarness(): {
  deps: EmitDeps;
  emitted: Array<{ stream: string; data: unknown }>;
  messages: EmittedMessage[];
} {
  const harness = makeRecordingEmit(validateRecord);
  const deps: EmitDeps = { emit: harness.emit, emitRecord: harness.emitRecord };
  return { deps, emitted: harness.emitted, messages: harness.protocolMessages };
}

function makeAccount(overrides: Partial<DashboardAccount> = {}): DashboardAccount {
  return {
    account_id_raw: "ACCT-CHK-0001",
    account_url: "/my/checking?accountId=ACCT-CHK-0001",
    account_type: "checking",
    name: "USAA CLASSIC CHECKING",
    last_four: "9241",
    balance_cents: 123_456,
    raw_text: "USAA CLASSIC CHECKING Ending in *9241 $1,234.56",
    ...overrides,
  };
}

function makeCard(overrides: Partial<DashboardAccount> = {}): DashboardAccount {
  return makeAccount({
    account_id_raw: "ACCT-CC-0001",
    account_url: "/my/credit-card?accountId=ACCT-CC-0001",
    account_type: "credit-card",
    name: "USAA RATE ADVANTAGE VISA",
    last_four: "0002",
    ...overrides,
  });
}

function selfCoverage(messages: EmittedMessage[], stream: string): DetailCoverageMessage | undefined {
  return messages.find(
    (m): m is DetailCoverageMessage => m.type === "DETAIL_COVERAGE" && m.stream === stream && m.state_stream === stream
  );
}

// ─── account_stats (singleton_presence) ─────────────────────────────────

test("account_stats: a stats-requested run declares considered === covered === enumerated accounts", async () => {
  const accounts = [makeAccount({ account_id_raw: "A1" }), makeAccount({ account_id_raw: "A2" })];
  const run = makeHarness();
  await emitAccountsStream(run.deps, accounts, RUN1_AT, undefined, { emitStats: true, observedOn: DAY1 });

  assert.equal(run.emitted.filter((e) => e.stream === "account_stats").length, 2, "both accounts' stats emitted");
  const cov = selfCoverage(run.messages, "account_stats");
  assert.ok(cov, "account_stats declares self-coverage — this is the live-bug fix: before it, this was undefined");
  assert.equal(cov?.considered, 2, "considered === enumerated account boundary");
  assert.equal(cov?.covered, 2, "covered === considered (buildAccountStatsRecord never drops a row)");
});

test("account_stats: zero accounts still proves verified-empty (considered === covered === 0)", async () => {
  const run = makeHarness();
  await emitAccountsStream(run.deps, [], RUN1_AT, undefined, { emitStats: true, observedOn: DAY1 });

  assert.equal(run.emitted.length, 0);
  const cov = selfCoverage(run.messages, "account_stats");
  assert.ok(cov, "a successful zero-account enumeration still declares coverage");
  assert.equal(cov?.considered, 0, "considered: 0 is a measured fact, not an absence of measurement");
  assert.equal(cov?.covered, 0);
});

test("account_stats: entity-only requests (emitStats false) declare no account_stats coverage", async () => {
  const run = makeHarness();
  const cursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitAccountsStream(run.deps, [makeAccount({ account_id_raw: "A1" })], RUN1_AT, cursor, { emitEntity: true });

  assert.equal(
    selfCoverage(run.messages, "account_stats"),
    undefined,
    "account_stats not requested this run → no coverage claim for it"
  );
});

// ─── credit_card_billing / credit_card_billing_stats boundary ──────────

test("creditCardAccounts: filters the dashboard boundary to credit-card-typed accounts only", () => {
  const accounts = [
    makeAccount({ account_id_raw: "A1", account_type: "checking" }),
    makeCard({ account_id_raw: "CC1" }),
    makeAccount({ account_id_raw: "A2", account_type: "savings" }),
    makeCard({ account_id_raw: "CC2" }),
  ];
  const cards = creditCardAccounts(accounts);
  assert.deepEqual(
    cards.map((c) => c.account_id_raw),
    ["CC1", "CC2"],
    "only credit-card-typed accounts are in the boundary — this is exactly `cards.length`, " +
      "the considered/covered value runCreditCardBillingStream emits for both credit-card streams"
  );
});

test("creditCardAccounts: no credit cards on the account is a real, measurable zero boundary", () => {
  const accounts = [makeAccount({ account_type: "checking" }), makeAccount({ account_type: "savings" })];
  assert.equal(
    creditCardAccounts(accounts).length,
    0,
    "an owner with no credit cards has a genuine considered:0/covered:0 boundary — " +
      "verified-empty, not a connector that forgot to check"
  );
});

// ─── inbox_messages (checkpoint_window, drops unparseable rows) ────────

test("computeInboxCoverage: every resolved row counts toward covered, fully resolved inbox", () => {
  const rows: InboxCoverageRow[] = [{ resolved: true }, { resolved: true }, { resolved: true }];
  const result = computeInboxCoverage(rows);
  assert.equal(result.considered, 3, "considered === every row the page listed");
  assert.equal(result.covered, 3, "covered === considered when every row resolved");
});

test("computeInboxCoverage: an unparseable-date row lowers covered below considered (honest partial)", () => {
  // Mirrors buildInboxMessageRecord returning null for a row with no
  // parseable date_short — that row is neither emitted nor
  // suppressed-as-unchanged, so it must not count toward `covered`.
  const rows: InboxCoverageRow[] = [{ resolved: true }, { resolved: false }, { resolved: true }];
  const result = computeInboxCoverage(rows);
  assert.equal(result.considered, 3, "considered still counts every row the enumeration saw");
  assert.equal(result.covered, 2, "the dropped row does not inflate covered — reads partial, not a false complete");
});

test("computeInboxCoverage: an empty inbox proves verified-empty (considered === covered === 0)", () => {
  const result = computeInboxCoverage([]);
  assert.equal(result.considered, 0);
  assert.equal(result.covered, 0);
});
