// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-run DETAIL_COVERAGE evidence for USAA's four full-page-scan streams
 * that emitted `emitRecord` but never `emitDetailCoverage`, unlike
 * `accounts`/`statements`/`transactions` (see live evidence:
 * `connector_summary_evidence.stream_latest_facts_json` for connection
 * cin_bc1efca69a1c386d610f0924 reported a raw `collected` count and NO
 * `considered`/`covered` keys at all for `account_stats`, `inbox_messages`,
 * `credit_card_billing`, `credit_card_billing_stats`).
 *
 *   - `inbox_messages` (runInboxStream) and `credit_card_billing`
 *     (runCreditCardBillingStream, entity half) are full-page scans with a
 *     real, measurable denominator: `considered` = rows/cards found on the
 *     page, `covered` = emitted + suppressed-because-unchanged (mirrors
 *     `emitAccountsStream`'s `entityCovered`, pinned in
 *     accounts-considered.test.ts).
 *   - `account_stats` and `credit_card_billing_stats` are append-keyed daily
 *     observations with no fingerprint suppression to reason about, but they
 *     still have a real per-run denominator: "did this run sample every
 *     enumerated account/card's stats" — considered = accounts/cards.length,
 *     covered = stats records actually emitted. See account-stats.test.ts /
 *     credit-card-billing-stats.test.ts for the record-shape tests; this file
 *     only pins the coverage wiring.
 *
 * These drive the real stream functions (`runInboxStream`,
 * `runCreditCardBillingStream`, `emitAccountsStream` stats-only) through a
 * fake Playwright Page whose `evaluate()` ignores the passed browser-context
 * callback and returns canned rows — the same minimal-fake convention
 * `integration.test.ts`'s `makeNoExportPage` already uses for the no-export
 * path, since a real `page.evaluate()` callback queries `document` and can't
 * run outside a browser.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import type { DetailCoverageMessage, EmittedMessage } from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import {
  type EmitDeps,
  emitAccountsStream,
  readPriorCreditCardBillingFingerprints,
  readPriorInboxMessageFingerprints,
  runCreditCardBillingStream,
  runInboxStream,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { BillingKv, DashboardAccount, InboxRow } from "./types.ts";

interface Harness {
  deps: EmitDeps;
  messages: EmittedMessage[];
}

function makeHarness(): Harness {
  const harness = makeRecordingEmit(validateRecord);
  return { deps: { emit: harness.emit, emitRecord: harness.emitRecord }, messages: harness.protocolMessages };
}

/** Minimal fake Page: `evaluate()` ignores the browser-context callback and
 *  returns `result` unconditionally; `goto`/`url` are no-ops. Mirrors
 *  integration.test.ts's makeNoExportPage convention. */
function makeScanPage(result: unknown): Page {
  return Object.assign({} as Page, {
    evaluate() {
      return Promise.resolve(result);
    },
    goto() {
      return Promise.resolve(null);
    },
    url() {
      return "https://www.usaa.com/my/inbox";
    },
  });
}

function coverageFor(messages: readonly EmittedMessage[], stream: string): DetailCoverageMessage | undefined {
  return messages.find(
    (m): m is DetailCoverageMessage => m.type === "DETAIL_COVERAGE" && m.stream === stream && m.state_stream === stream
  );
}

// ─── inbox_messages ──────────────────────────────────────────────────────

const TWO_INBOX_ROWS: readonly InboxRow[] = [
  { status: "Unread", date_short: "May 14", preview: "Your statement is ready to view" },
  { status: "Read", date_short: "May 10", preview: "Security alert: new device sign-in" },
];

test("runInboxStream: a fresh scan declares considered === covered === row count, all emitted", async () => {
  const { deps, messages } = makeHarness();
  await runInboxStream(deps, makeScanPage(TWO_INBOX_ROWS), {});
  const cov = coverageFor(messages, "inbox_messages");
  assert.ok(cov, "expected an inbox_messages self-coverage message");
  assert.equal(cov?.considered, 2);
  assert.equal(cov?.covered, 2);
});

test("runInboxStream: a steady-state re-scrape (fingerprint-suppressed) still declares covered === considered", async () => {
  const { deps: deps1, messages: messages1 } = makeHarness();
  await runInboxStream(deps1, makeScanPage(TWO_INBOX_ROWS), {});
  const state1 = messages1.filter((m) => m.type === "STATE" && m.stream === "inbox_messages").at(-1);
  const priorState = { inbox_messages: (state1 as { cursor?: Record<string, unknown> } | undefined)?.cursor ?? {} };

  const { deps: deps2, messages: messages2 } = makeHarness();
  await runInboxStream(deps2, makeScanPage(TWO_INBOX_ROWS), priorState);

  const cov = coverageFor(messages2, "inbox_messages");
  assert.ok(cov, "steady-state run still declares inbox_messages coverage");
  assert.equal(cov?.considered, 2, "considered === enumerated boundary");
  assert.equal(cov?.covered, 2, "covered counts suppressed-unchanged, not the (near-zero) emitted count");
  const fps = readPriorInboxMessageFingerprints(priorState);
  assert.equal(fps.size, 2, "sanity: prior run's fingerprints actually persisted for suppression to occur");
});

test("runInboxStream: a row dropped by buildInboxMessageRecord (no date_short) is NOT counted as covered", async () => {
  const { deps, messages } = makeHarness();
  const rowsWithOneUnkeyable: readonly InboxRow[] = [
    { status: "Unread", date_short: "May 14", preview: "Your statement is ready to view" },
    { status: "Unread", date_short: "", preview: "Undated promotional row" },
  ];
  await runInboxStream(deps, makeScanPage(rowsWithOneUnkeyable), {});
  const cov = coverageFor(messages, "inbox_messages");
  assert.ok(cov);
  assert.equal(cov?.considered, 2, "considered counts every row the page returned");
  assert.equal(
    cov?.covered,
    1,
    "the unkeyable row is neither emitted nor covered — honest partial, not fabricated complete"
  );
});

// ─── credit_card_billing (entity) ───────────────────────────────────────

function makeCard(overrides: Partial<DashboardAccount> = {}): DashboardAccount {
  return {
    account_id_raw: "ACCT-CC-0001",
    account_type: "credit-card",
    account_url: "/my/credit-card?accountId=ACCT-CC-0001",
    balance_cents: -50_000,
    last_four: "4503",
    name: "SIGNATURE VISA",
    raw_text: "SIGNATURE VISA Ending in *4503 -$500.00",
    ...overrides,
  };
}

const BILLING_KV: BillingKv = {
  "Account Nickname": "Everyday Visa",
  "Credit Limit": "$10,000.00",
  "Annual Percent Rate": "19.99%",
};

test("runCreditCardBillingStream: a fresh entity scan declares considered === covered === card count", async () => {
  const { deps, messages } = makeHarness();
  const cards = [makeCard()];
  const cursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await runCreditCardBillingStream(deps, makeScanPage(BILLING_KV), cards, {
    emitEntity: true,
    emitStats: false,
    fingerprintCursor: cursor,
    observedOn: "2026-07-31",
  });
  const cov = coverageFor(messages, "credit_card_billing");
  assert.ok(cov, "expected a credit_card_billing self-coverage message");
  assert.equal(cov?.considered, 1);
  assert.equal(cov?.covered, 1);
});

test("runCreditCardBillingStream: a steady-state re-scrape still declares covered === considered", async () => {
  const cards = [makeCard()];
  const { deps: deps1, messages: messages1 } = makeHarness();
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await runCreditCardBillingStream(deps1, makeScanPage(BILLING_KV), cards, {
    emitEntity: true,
    emitStats: false,
    fingerprintCursor: cursor1,
    observedOn: "2026-07-31",
  });
  const state1 = messages1.filter((m) => m.type === "STATE" && m.stream === "credit_card_billing").at(-1);
  const priorState = {
    credit_card_billing: (state1 as { cursor?: Record<string, unknown> } | undefined)?.cursor ?? {},
  };

  const { deps: deps2, messages: messages2 } = makeHarness();
  const cursor2 = openFingerprintCursor(priorState.credit_card_billing, {
    excludeFromFingerprint: ["fetched_at"],
    priorFingerprints: readPriorCreditCardBillingFingerprints(priorState),
  });
  await runCreditCardBillingStream(deps2, makeScanPage(BILLING_KV), cards, {
    emitEntity: true,
    emitStats: false,
    fingerprintCursor: cursor2,
    observedOn: "2026-08-01",
  });

  const cov = coverageFor(messages2, "credit_card_billing");
  assert.ok(cov, "steady-state run still declares credit_card_billing coverage");
  assert.equal(cov?.considered, 1);
  assert.equal(cov?.covered, 1, "covered counts suppressed-unchanged, not the (zero) emitted count");
});

// ─── account_stats / credit_card_billing_stats (observation streams) ────

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

test("emitAccountsStream (stats-only): declares its own account_stats self-coverage, distinct from the accounts entity coverage", async () => {
  const { deps, messages } = makeHarness();
  const accounts = [makeAccount({ account_id_raw: "A1" }), makeAccount({ account_id_raw: "A2" })];
  await emitAccountsStream(deps, accounts, "2026-07-31T10:00:00.000Z", undefined, {
    emitEntity: false,
    emitStats: true,
  });

  const statsCoverage = coverageFor(messages, "account_stats");
  assert.ok(statsCoverage, "expected an account_stats self-coverage message even with no entity cursor");
  assert.equal(statsCoverage?.considered, 2);
  assert.equal(statsCoverage?.covered, 2, "every enumerated account got a stats record this run");

  const entityCoverage = coverageFor(messages, "accounts");
  assert.equal(entityCoverage, undefined, "the entity self-coverage message must not appear on a stats-only run");
});

test("runCreditCardBillingStream (stats-only): declares its own credit_card_billing_stats self-coverage", async () => {
  const { deps, messages } = makeHarness();
  const cards = [makeCard({ account_id_raw: "CC1" }), makeCard({ account_id_raw: "CC2", last_four: "1437" })];
  await runCreditCardBillingStream(deps, makeScanPage(BILLING_KV), cards, {
    emitEntity: false,
    emitStats: true,
    fingerprintCursor: undefined,
    observedOn: "2026-07-31",
  });

  const statsCoverage = coverageFor(messages, "credit_card_billing_stats");
  assert.ok(statsCoverage, "expected a credit_card_billing_stats self-coverage message");
  assert.equal(statsCoverage?.considered, 2);
  assert.equal(statsCoverage?.covered, 2);

  const entityCoverage = coverageFor(messages, "credit_card_billing");
  assert.equal(entityCoverage, undefined, "the entity self-coverage message must not appear on a stats-only run");
});
