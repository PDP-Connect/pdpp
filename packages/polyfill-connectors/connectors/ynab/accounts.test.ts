// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * YNAB account-balance observation-stream split. Pins the wiring added by the
 * `split-ynab-account-balance-observation-stream` OpenSpec change:
 *
 *   1. `accountStatsRecord` projects the point-in-time balances into a
 *      date-scoped append-keyed record (`{account_id}:{YYYY-MM-DD}`); a later
 *      day produces a distinct key (a time series, not an overwrite).
 *   2. The `accounts` entity record no longer carries balance fields, so a
 *      balance-only move does NOT re-emit the entity (fingerprint no-op),
 *      while the `account_stats` record still records the new balance.
 *   3. A real identity/settings change (rename, close, debt detail) re-emits
 *      the entity record exactly once.
 *   4. Delta-sync no-prune: YNAB `/accounts` is a `server_knowledge` PARTIAL
 *      scan, so an account omitted from a delta must carry its fingerprint
 *      forward and must NOT be pruned; an explicit `deleted: true` re-emits.
 *   5. Per-budget cursor isolation: a shared account id across budgets does
 *      not cross-contaminate fingerprint maps.
 *
 * The gate is `openAccountCursor` + `accountRecord`/`accountStatsRecord`; the
 * production caller (`collectAccounts`) wraps the same calls around a `fetch`.
 * Testing the seam directly matches the `fingerprint.test.ts` pattern and keeps
 * the test free of network and Node I/O.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecordData } from "../../src/connector-runtime.ts";
import { accountRecord, accountStatsRecord, openAccountCursor } from "./index.ts";

// Minimal account input shape (mirrors the connector's internal YnabAccount).
interface AccountInput {
  balance: number;
  cleared_balance: number;
  closed: boolean;
  deleted: boolean;
  id: string;
  name: string;
  note?: string | null;
  on_budget: boolean;
  transfer_payee_id?: string | null;
  type: string;
  uncleared_balance: number;
}

const A1 = "11111111-1111-4111-8111-111111111111";
const A2 = "22222222-2222-4222-8222-222222222222";
const BUDGET_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BUDGET_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function acct(overrides: Partial<AccountInput> = {}): AccountInput {
  return {
    id: A1,
    name: "Checking",
    type: "checking",
    on_budget: true,
    closed: false,
    balance: 100_000,
    cleared_balance: 100_000,
    uncleared_balance: 0,
    transfer_payee_id: null,
    note: null,
    deleted: false,
    ...overrides,
  };
}

interface PassResult {
  entityEmitted: RecordData[];
  state: Record<string, unknown>;
  statsEmitted: RecordData[];
}

/**
 * Drive a single `accounts` pass over the delta accounts returned this run.
 * Gates the entity stream through the fingerprint cursor (no prune — partial
 * scan), emits an `account_stats` record per returned account, and returns the
 * next STATE shape this pass would write. `serverKnowledge` advances like the
 * real delta cursor.
 */
function runPass(
  priorState: Record<string, unknown>,
  budgetId: string,
  accounts: readonly AccountInput[],
  observedOn: string,
  serverKnowledge: number
): PassResult {
  const cursor = openAccountCursor(priorState, budgetId);
  const entityEmitted: RecordData[] = [];
  const statsEmitted: RecordData[] = [];
  for (const a of accounts) {
    const entityRec = accountRecord(a, budgetId);
    if (cursor.shouldEmit(entityRec)) {
      entityEmitted.push(entityRec);
    }
    statsEmitted.push(accountStatsRecord(a, budgetId, observedOn));
  }
  // No prune: partial (server_knowledge) scan. An account absent this run was
  // not deleted, it just did not change.
  const priorAccounts = priorState.accounts;
  const carry: Record<string, { server_knowledge?: number; fingerprints?: Record<string, string> }> =
    priorAccounts && typeof priorAccounts === "object" && !Array.isArray(priorAccounts)
      ? { ...(priorAccounts as Record<string, { server_knowledge?: number; fingerprints?: Record<string, string> }>) }
      : {};
  carry[budgetId] = { server_knowledge: serverKnowledge, fingerprints: cursor.toState() };
  return { entityEmitted, statsEmitted, state: { ...priorState, accounts: carry } };
}

function fingerprintsFor(state: Record<string, unknown>, budgetId: string): Record<string, string> {
  const accounts = state.accounts as Record<string, { fingerprints?: Record<string, string> }>;
  const fps = accounts[budgetId]?.fingerprints;
  if (!fps) {
    throw new Error(`expected fingerprints for ${budgetId}`);
  }
  return fps;
}

// ─── account_stats builder ────────────────────────────────────────────────

test("accountStatsRecord: date-scoped key carries the day's balances", () => {
  const rec = accountStatsRecord(acct({ balance: 123_456 }), BUDGET_A, "2026-06-03");
  assert.equal(rec.id, `${A1}:2026-06-03`);
  assert.equal(rec.account_id, A1);
  assert.equal(rec.budget_id, BUDGET_A);
  assert.equal(rec.observed_on, "2026-06-03");
  assert.equal(rec.balance, 123_456);
  assert.equal(rec.cleared_balance, 100_000);
  assert.equal(rec.uncleared_balance, 0);
});

test("accountStatsRecord: a later day produces a distinct key (time series, not overwrite)", () => {
  const day1 = accountStatsRecord(acct(), BUDGET_A, "2026-06-03");
  const day2 = accountStatsRecord(acct({ balance: 90_000 }), BUDGET_A, "2026-06-04");
  assert.notEqual(day1.id, day2.id);
  assert.equal(day1.id, `${A1}:2026-06-03`);
  assert.equal(day2.id, `${A1}:2026-06-04`);
});

test("accountRecord: entity record no longer carries balance fields", () => {
  const rec = accountRecord(acct(), BUDGET_A);
  assert.equal("balance" in rec, false, "balance must not be on the entity record");
  assert.equal("cleared_balance" in rec, false);
  assert.equal("uncleared_balance" in rec, false);
  // Identity / settings fields are retained.
  assert.equal(rec.id, A1);
  assert.equal(rec.name, "Checking");
  assert.equal(rec.type, "checking");
});

// ─── entity split: balance-only change does not churn the entity ────────────

test("balance-only move: entity does NOT re-emit but account_stats records the new balance", () => {
  const run1 = runPass({}, BUDGET_A, [acct({ balance: 100_000 })], "2026-06-03", 100);
  assert.equal(run1.entityEmitted.length, 1, "cold run emits the entity once");
  assert.equal(run1.statsEmitted.length, 1);
  assert.equal(run1.statsEmitted[0]?.balance, 100_000);

  // Same UTC day, balance moved. The delta re-returns the account.
  const run2 = runPass(run1.state, BUDGET_A, [acct({ balance: 142_000 })], "2026-06-03", 101);
  assert.equal(run2.entityEmitted.length, 0, "balance-only change must not version the entity record");
  assert.equal(run2.statsEmitted.length, 1, "account_stats still records the observation");
  assert.equal(run2.statsEmitted[0]?.id, `${A1}:2026-06-03`, "same-day key is stable");
  assert.equal(run2.statsEmitted[0]?.balance, 142_000, "the new balance is captured");
});

test("balance move on a later day appends a new account_stats record", () => {
  const run1 = runPass({}, BUDGET_A, [acct({ balance: 100_000 })], "2026-06-03", 100);
  const run2 = runPass(run1.state, BUDGET_A, [acct({ balance: 90_000 })], "2026-06-04", 101);
  assert.equal(run2.entityEmitted.length, 0, "still no entity churn across days");
  assert.equal(run2.statsEmitted[0]?.id, `${A1}:2026-06-04`, "next day gets its own key");
});

// ─── entity split: real identity/settings change re-emits once ──────────────

test("identity change (rename) re-emits the entity record exactly once", () => {
  const run1 = runPass({}, BUDGET_A, [acct({ name: "Checking" })], "2026-06-03", 100);
  assert.equal(run1.entityEmitted.length, 1);

  const run2 = runPass(run1.state, BUDGET_A, [acct({ name: "Primary Checking" })], "2026-06-03", 101);
  assert.equal(run2.entityEmitted.length, 1, "a genuine identity edit versions the entity once");
  assert.equal(run2.entityEmitted[0]?.name, "Primary Checking");

  const run3 = runPass(run2.state, BUDGET_A, [acct({ name: "Primary Checking" })], "2026-06-03", 102);
  assert.equal(run3.entityEmitted.length, 0, "no further churn once the rename is recorded");
});

test("settings change (closed flag) re-emits the entity record", () => {
  const run1 = runPass({}, BUDGET_A, [acct({ closed: false })], "2026-06-03", 100);
  const run2 = runPass(run1.state, BUDGET_A, [acct({ closed: true })], "2026-06-03", 101);
  assert.equal(run2.entityEmitted.length, 1, "closing an account is a real settings change");
});

// ─── delta-sync: no prune ───────────────────────────────────────────────────

test("delta omission carries the account forward and does NOT prune it", () => {
  // Cold run: both accounts present.
  const both = [acct({ id: A1 }), acct({ id: A2, name: "Savings", type: "savings" })];
  const run1 = runPass({}, BUDGET_A, both, "2026-06-03", 100);
  assert.equal(run1.entityEmitted.length, 2);

  // Next run: only A1 changed, so the delta returns ONLY A1. A2 must survive.
  const run2 = runPass(run1.state, BUDGET_A, [acct({ id: A1, name: "Renamed" })], "2026-06-03", 101);
  const fps = fingerprintsFor(run2.state, BUDGET_A);
  assert.ok(fps[A1] !== undefined, "A1 fingerprint present");
  assert.ok(fps[A2] !== undefined, "A2 carried forward despite being absent from the delta — no prune");

  // A2 unchanged later: it must still no-op against its carried-forward
  // fingerprint, proving the carry-forward survived the delta gap.
  const run3 = runPass(run2.state, BUDGET_A, [acct({ id: A2, name: "Savings", type: "savings" })], "2026-06-04", 102);
  assert.equal(run3.entityEmitted.length, 0, "unchanged A2 no-ops — carry-forward intact across the delta gap");
});

test("an account returned with deleted:true re-emits the entity record", () => {
  const run1 = runPass({}, BUDGET_A, [acct({ id: A1 })], "2026-06-03", 100);
  assert.equal(run1.entityEmitted.length, 1);

  // YNAB marks deletions in-band; the delta returns the account with deleted:true.
  const run2 = runPass(run1.state, BUDGET_A, [acct({ id: A1, deleted: true })], "2026-06-03", 101);
  assert.equal(run2.entityEmitted.length, 1, "a deletion is a real field change and re-emits");
  assert.equal(run2.entityEmitted[0]?.deleted, true);
});

// ─── per-budget isolation ───────────────────────────────────────────────────

test("per-budget isolation: a shared account id does not cross-contaminate", () => {
  const seedA = runPass({}, BUDGET_A, [acct({ id: A1, name: "A-Checking" })], "2026-06-03", 100);

  // Budget B has its own account that happens to share id A1 (distinct YNAB
  // budgets each have their own account id space). It must emit on its first
  // run despite budget A already holding a fingerprint for A1.
  const runB = runPass(seedA.state, BUDGET_B, [acct({ id: A1, name: "B-Checking" })], "2026-06-03", 50);
  assert.equal(runB.entityEmitted.length, 1, "budget-B emits its own A1 despite budget-A having one");

  // Budget A's fingerprint map survives the budget-B write.
  const aFps = fingerprintsFor(runB.state, BUDGET_A);
  assert.ok(aFps[A1] !== undefined, "budget-A fingerprint preserved");
  // server_knowledge is tracked per budget.
  const accounts = runB.state.accounts as Record<string, { server_knowledge?: number }>;
  assert.equal(accounts[BUDGET_A]?.server_knowledge, 100);
  assert.equal(accounts[BUDGET_B]?.server_knowledge, 50);
});

// ─── legacy state tolerance ─────────────────────────────────────────────────

test("legacy accounts state with only server_knowledge (no fingerprints) yields one full re-emit", () => {
  const legacyState = { accounts: { [BUDGET_A]: { server_knowledge: 42 } } };
  const run1 = runPass(legacyState, BUDGET_A, [acct({ id: A1 }), acct({ id: A2, name: "Savings" })], "2026-06-03", 43);
  assert.equal(run1.entityEmitted.length, 2, "no prior fingerprints → full re-emit");

  const run2 = runPass(run1.state, BUDGET_A, [acct({ id: A1 }), acct({ id: A2, name: "Savings" })], "2026-06-03", 44);
  assert.equal(run2.entityEmitted.length, 0, "subsequent run no-ops once fingerprints are seeded");
});
