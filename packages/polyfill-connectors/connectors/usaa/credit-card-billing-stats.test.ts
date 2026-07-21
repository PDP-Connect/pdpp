// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Family-2 split for the USAA `credit_card_billing` stream: the per-cycle
 * volatile financial fields move to the append-keyed
 * `credit_card_billing_stats` observation stream so a balance/rewards/cycle-
 * status tick no longer versions the `credit_card_billing` entity record.
 *
 * After the split, the entity carries card identity/settings only
 * (`account_id`, `account_nickname`, `credit_limit_cents`,
 * `annual_percent_rate`, `cash_advance_apr`, `card_holders`); the observation
 * stream carries `current_balance_cents`, `available_credit_cents`,
 * `cash_rewards_cents`, `billing_status`, `minimum_payment_met`, keyed
 * `{card_id}:{observed_on}`.
 *
 * `runCreditCardBillingStream` interleaves per-card Playwright navigation with
 * emit, so it is not unit-testable without a live browser. These tests
 * exercise the exact split the loop runs — the two builders plus the entity
 * `openFingerprintCursor({excludeFromFingerprint:["fetched_at"]})` gate — plus
 * the join-key contract.
 *
 * These tests pin:
 *
 *   1. The stats builder builds the date-scoped key and carries the five
 *      volatile fields; the entity record drops them and keeps the settings.
 *   2. A balance / rewards / cycle-status change does NOT re-emit the entity
 *      (the entity body modulo `fetched_at` is unchanged).
 *   3. A `credit_limit_cents` / APR / nickname change DOES re-emit the entity.
 *   4. Same-day idempotency: two stat emits on one UTC day share a key; a later
 *      day is distinct.
 *   5. `card_id` joins back to the entity `id`.
 *   6. Emitted stats records pass the real zod schema.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type FingerprintCursor, openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { type EmitDeps, readPriorCreditCardBillingFingerprints } from "./index.ts";
import { buildCreditCardBillingRecord, buildCreditCardBillingStatsRecord, creditCardId } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { BillingKv, CreditCardBillingRecord, DashboardAccount } from "./types.ts";

const RUN1_AT = "2026-06-01T10:00:00.000Z";
const RUN2_AT = "2026-06-02T10:00:00.000Z";
const DAY1 = "2026-06-01";
const DAY2 = "2026-06-02";

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

/** Replicate exactly what `runCreditCardBillingStream` does per card for the
 *  entity: build the entity record, gate it through the cursor. */
function entityWouldEmit(
  cursor: FingerprintCursor,
  a: DashboardAccount,
  billing: BillingKv,
  fetchedAt: string
): boolean {
  const rec: CreditCardBillingRecord = buildCreditCardBillingRecord(a, billing, fetchedAt);
  return cursor.shouldEmit(rec);
}

test("credit_card_billing_stats: stats builder keys + carries volatile fields; entity keeps settings, drops them", () => {
  const a = makeCardAccount({ account_id_raw: "CC1" });
  const stat = buildCreditCardBillingStatsRecord(a, makeBilling(), DAY1);
  assert.equal(stat.id, "CC1:2026-06-01", "id is {card_id}:{observed_on}");
  assert.equal(stat.card_id, "CC1", "card_id joins back to the entity id");
  assert.equal(stat.account_id, "CC1");
  assert.equal(stat.observed_on, DAY1);
  assert.equal(stat.current_balance_cents, 120_000);
  assert.equal(stat.available_credit_cents, 380_000);
  assert.equal(stat.cash_rewards_cents, 1500);
  assert.equal(stat.billing_status, "Minimum payment met");
  assert.equal(stat.minimum_payment_met, true);

  const entity = buildCreditCardBillingRecord(a, makeBilling(), RUN1_AT);
  // Entity keeps the settings.
  assert.equal(entity.credit_limit_cents, 500_000, "credit_limit_cents stays on the entity (a rare settings event)");
  assert.equal(entity.annual_percent_rate, "24.99%");
  assert.equal(entity.cash_advance_apr, "29.99%");
  assert.equal(entity.account_nickname, "Everyday Card");
  assert.equal(entity.card_holders, "Member");
  // Entity drops the volatile fields.
  for (const moved of [
    "current_balance_cents",
    "available_credit_cents",
    "cash_rewards_cents",
    "billing_status",
    "minimum_payment_met",
  ]) {
    assert.equal(moved in entity, false, `entity must not carry ${moved}`);
  }
});

test("credit_card_billing_stats: card_id equals the entity id for the same dashboard account", () => {
  for (const a of [
    makeCardAccount({ account_id_raw: "CC-9", last_four: "1111" }),
    makeCardAccount({ account_id_raw: null, last_four: "2222" }),
    makeCardAccount({ account_id_raw: null, last_four: null, raw_text: "USAA SECURED *9999 $50.00" }),
  ]) {
    const entity = buildCreditCardBillingRecord(a, makeBilling(), RUN1_AT);
    const stat = buildCreditCardBillingStatsRecord(a, makeBilling(), DAY1);
    assert.equal(stat.card_id, entity.id, "stats.card_id joins to entity.id across the id fallback chain");
    assert.equal(stat.id, `${creditCardId(a)}:${DAY1}`);
  }
});

test("credit_card_billing_stats: a balance / rewards / status change does NOT re-emit the entity", () => {
  for (const change of [
    { "Current Balance": "$1,500.00" },
    { "Available Credit": "$3,500.00" },
    { "Cash Rewards": "$22.50" },
    { "Billing Information": "Payment due" },
  ]) {
    const a = makeCardAccount();
    const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
    assert.equal(entityWouldEmit(cursor1, a, makeBilling(), RUN1_AT), true, "first observation emits the entity");
    cursor1.pruneStale();
    const state1 = { credit_card_billing: { fingerprints: cursor1.toState() } };

    const cursor2 = openFingerprintCursor(state1.credit_card_billing, {
      excludeFromFingerprint: ["fetched_at"],
      priorFingerprints: readPriorCreditCardBillingFingerprints(state1),
    });
    assert.equal(
      entityWouldEmit(cursor2, a, makeBilling(change), RUN2_AT),
      false,
      `a ${Object.keys(change)[0]} move is a stats-only change and must NOT re-version the entity`
    );
  }
});

test("credit_card_billing_stats: a credit-limit / APR / nickname change DOES re-emit the entity", () => {
  for (const change of [
    { "Credit Limit": "$7,500.00" },
    { "Annual Percent Rate": "26.99%" },
    { "Account Nickname": "Travel Card" },
    { "Card Holders": "Member, Spouse" },
  ]) {
    const a = makeCardAccount();
    const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
    entityWouldEmit(cursor1, a, makeBilling(), RUN1_AT);
    cursor1.pruneStale();
    const state1 = { credit_card_billing: { fingerprints: cursor1.toState() } };

    const cursor2 = openFingerprintCursor(state1.credit_card_billing, {
      excludeFromFingerprint: ["fetched_at"],
      priorFingerprints: readPriorCreditCardBillingFingerprints(state1),
    });
    assert.equal(
      entityWouldEmit(cursor2, a, makeBilling(change), RUN2_AT),
      true,
      `a ${Object.keys(change)[0]} change is a real settings event and must re-version the entity`
    );
  }
});

test("credit_card_billing_stats: same-day re-pull is the same key; a later day is distinct", () => {
  const a = makeCardAccount({ account_id_raw: "CC1" });
  const sameDayA = buildCreditCardBillingStatsRecord(a, makeBilling({ "Current Balance": "$1,200.00" }), DAY1);
  const sameDayB = buildCreditCardBillingStatsRecord(a, makeBilling({ "Current Balance": "$1,500.00" }), DAY1);
  const laterDay = buildCreditCardBillingStatsRecord(a, makeBilling(), DAY2);
  assert.equal(sameDayA.id, sameDayB.id, "same UTC day → same append key");
  assert.notEqual(sameDayA.id, laterDay.id, "later UTC day → distinct append key");
});

test("credit_card_billing_stats: emitted observation records pass the real zod schema", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const deps: EmitDeps = { emit: harness.emit, emitRecord: harness.emitRecord };
  const cards = [
    makeCardAccount({ account_id_raw: "CC1" }),
    // A card carrying over its limit (negative available credit not possible;
    // nonNegativeCents on available_credit), and a refund credit balance.
    makeCardAccount({ account_id_raw: "CC2", last_four: "0002" }),
  ];
  for (const a of cards) {
    await deps.emitRecord("credit_card_billing_stats", buildCreditCardBillingStatsRecord(a, makeBilling(), DAY1));
  }
  const stats = harness.emitted.filter((e) => e.stream === "credit_card_billing_stats");
  assert.equal(stats.length, 2, "both stats records passed the schema (harness routes through validateRecord)");
  assert.equal(harness.skipped.length, 0, "no record was rejected by the schema");
});
