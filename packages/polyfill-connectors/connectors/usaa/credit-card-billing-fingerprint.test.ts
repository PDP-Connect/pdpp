/**
 * Per-card fingerprint behavior for the USAA `credit_card_billing` stream.
 *
 * Before this gate, the billing stream appended a fresh version of every
 * card on every run because the record body carried a run-clock
 * `fetched_at`. The body ALSO carries REAL point-in-time financial state
 * (current_balance_cents, available_credit_cents, credit_limit_cents,
 * cash_rewards_cents, APRs, billing_status). The incidental-fix claim is
 * precise: excluding ONLY `fetched_at` is lossless — any real-field move
 * is a fingerprint boundary that re-emits, while a true no-op refresh
 * (body byte-identical modulo `fetched_at`) is suppressed.
 *
 * `runCreditCardBillingStream` interleaves per-card Playwright navigation
 * with emit, so it is not unit-testable without a live browser. These
 * tests exercise the exact gate the loop runs — `buildCreditCardBillingRecord`
 * fed through `openFingerprintCursor({excludeFromFingerprint:["fetched_at"]})`
 * with `shouldEmit` — plus the STATE-decode and compaction-parity contracts.
 *
 * These tests pin:
 *
 *   1. A no-op refresh (only `fetched_at` differs) is suppressed.
 *   2. A real balance / rewards / APR move re-emits.
 *   3. The fingerprint excludes `fetched_at` and matches the compaction
 *      policy's exclude set byte-for-byte; a real-field move is a distinct
 *      fingerprint (never collapsed).
 *   4. `readPriorCreditCardBillingFingerprints` tolerates missing / legacy
 *      / malformed state.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type FingerprintCursor, openFingerprintCursor, recordFingerprint } from "../../src/fingerprint-cursor.ts";
import { readPriorCreditCardBillingFingerprints } from "./index.ts";
import { buildCreditCardBillingRecord } from "./parsers.ts";
import type { BillingKv, CreditCardBillingRecord, DashboardAccount } from "./types.ts";

const RUN1_AT = "2026-06-01T10:00:00.000Z";
const RUN2_AT = "2026-06-02T10:00:00.000Z";

function makeCardAccount(overrides: Partial<DashboardAccount> = {}): DashboardAccount {
  return {
    account_id_raw: "CC-0001",
    account_url: "/my/credit-card?accountId=CC-0001",
    account_type: "credit-card",
    name: "USAA RATE ADVANTAGE",
    last_four: "4417",
    balance_cents: 120_000,
    raw_text: "USAA RATE ADVANTAGE Ending in *4417 $1,200.00",
    ...overrides,
  };
}

function makeBilling(overrides: Partial<BillingKv> = {}): BillingKv {
  return {
    "Account Nickname": "Everyday Card",
    "Current Balance": "$1,200.00",
    "Available Credit": "$3,800.00",
    "Credit Limit": "$5,000.00",
    "Annual Percent Rate": "24.99%",
    "Cash Advance APR": "29.99%",
    "Cash Rewards": "$15.00",
    "Billing Information": "Minimum payment met",
    "Card Holders": "Member",
    ...overrides,
  };
}

/** Replicate exactly what `runCreditCardBillingStream` does per card: build
 *  the record, gate it through the cursor, return whether it would emit. */
function wouldEmit(cursor: FingerprintCursor, a: DashboardAccount, billing: BillingKv, fetchedAt: string): boolean {
  const rec: CreditCardBillingRecord = buildCreditCardBillingRecord(a, billing, fetchedAt);
  return cursor.shouldEmit(rec);
}

test("credit_card_billing: a no-op refresh (only fetched_at differs) is suppressed", () => {
  const a = makeCardAccount();
  const billing = makeBilling();

  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  assert.equal(wouldEmit(cursor1, a, billing, RUN1_AT), true, "first observation emits");
  cursor1.pruneStale();
  const state1 = { credit_card_billing: { fetched_at: RUN1_AT, fingerprints: cursor1.toState() } };

  // Second run: identical billing, only fetched_at differs.
  const cursor2 = openFingerprintCursor(state1.credit_card_billing, {
    excludeFromFingerprint: ["fetched_at"],
    priorFingerprints: readPriorCreditCardBillingFingerprints(state1),
  });
  assert.equal(wouldEmit(cursor2, a, billing, RUN2_AT), false, "no-op refresh suppressed");
});

test("credit_card_billing: a real balance move re-emits", () => {
  const a = makeCardAccount();
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  wouldEmit(cursor1, a, makeBilling({ "Current Balance": "$1,200.00" }), RUN1_AT);
  cursor1.pruneStale();
  const state1 = { credit_card_billing: { fingerprints: cursor1.toState() } };

  const cursor2 = openFingerprintCursor(state1.credit_card_billing, {
    excludeFromFingerprint: ["fetched_at"],
    priorFingerprints: readPriorCreditCardBillingFingerprints(state1),
  });
  assert.equal(
    wouldEmit(cursor2, a, makeBilling({ "Current Balance": "$1,500.00" }), RUN2_AT),
    true,
    "a balance move re-emits — the fix never hides a real value"
  );
});

test("credit_card_billing: a rewards move and an APR move each re-emit", () => {
  for (const change of [{ "Cash Rewards": "$22.50" }, { "Annual Percent Rate": "26.99%" }]) {
    const a = makeCardAccount();
    const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
    wouldEmit(cursor1, a, makeBilling(), RUN1_AT);
    cursor1.pruneStale();
    const state1 = { credit_card_billing: { fingerprints: cursor1.toState() } };

    const cursor2 = openFingerprintCursor(state1.credit_card_billing, {
      excludeFromFingerprint: ["fetched_at"],
      priorFingerprints: readPriorCreditCardBillingFingerprints(state1),
    });
    assert.equal(
      wouldEmit(cursor2, a, makeBilling(change), RUN2_AT),
      true,
      `a ${Object.keys(change)[0]} move re-emits`
    );
  }
});

test("credit_card_billing: STATE round-trips a fingerprints map keyed by card id", () => {
  const a = makeCardAccount({ account_id_raw: "CC-0001" });
  const cursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  wouldEmit(cursor, a, makeBilling(), RUN1_AT);
  cursor.pruneStale();
  const state = { credit_card_billing: { fetched_at: RUN1_AT, fingerprints: cursor.toState() } };
  const fps = readPriorCreditCardBillingFingerprints(state);
  assert.equal(fps.size, 1, "one fingerprint persisted");
  assert.ok(fps.get("CC-0001"), "keyed by billing record id");
});

test("credit_card_billing: connector fingerprint == compaction fingerprint (excludes fetched_at), real move is distinct", () => {
  const a = makeCardAccount();
  const body = buildCreditCardBillingRecord(a, makeBilling(), RUN1_AT);
  const laterNoop = buildCreditCardBillingRecord(a, makeBilling(), RUN2_AT);
  const laterMoved = buildCreditCardBillingRecord(a, makeBilling({ "Current Balance": "$2,000.00" }), RUN2_AT);

  assert.equal(
    recordFingerprint(body, ["fetched_at"]),
    recordFingerprint(laterNoop, ["fetched_at"]),
    "fetched_at must not participate; a no-op refresh hashes identically (compaction parity)"
  );
  assert.notEqual(
    recordFingerprint(body, ["fetched_at"]),
    recordFingerprint(laterMoved, ["fetched_at"]),
    "a balance move is a real change and MUST produce a different fingerprint"
  );
});

test("readPriorCreditCardBillingFingerprints: tolerates missing / legacy / malformed state", () => {
  assert.equal(readPriorCreditCardBillingFingerprints({}).size, 0, "empty state → empty map");
  assert.equal(
    readPriorCreditCardBillingFingerprints({ credit_card_billing: { fetched_at: "x" } }).size,
    0,
    "legacy cursor (no fingerprints) → empty map"
  );
  assert.equal(
    readPriorCreditCardBillingFingerprints({ credit_card_billing: { fingerprints: 5 } }).size,
    0,
    "malformed fingerprints value → empty map"
  );
  const ok = readPriorCreditCardBillingFingerprints({
    credit_card_billing: { fingerprints: { "CC-0001": "fp-1", bad: null } },
  });
  assert.equal(ok.size, 1, "valid entries kept, invalid dropped");
});
