// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import type { EmittedMessage, StreamScope } from "../../src/connector-runtime.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import {
  type AccountDetailOutcome,
  type EmitDeps,
  emitBalancesDetailCoverage,
  runTransactionsAndBalances,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

// Regression proof for the stream-coverage evidence omission: a succeeded Chase
// run whose considered accounts were all source-limited `no_activity` (Chase's
// no-activity confirmation page never serves a QFX response, so there is no
// LEDGERBAL/AVAILBAL block to read) emitted zero `balances` records and staged
// no checkpoint for the stream, so `buildCollectionFacts` reported
// `checkpoint:not_staged` with `considered`/`covered` null and the
// `singleton_presence` coverage strategy could not prove coverage — the stream
// projected `unmeasured` forever on that connection even though every account
// was genuinely reached (live run_1783705924457).
//
// The fix: `balances` adopts the same `parent_detail_accounting` evidence as
// `transactions` — a per-run DETAIL_COVERAGE over the `accounts` denominator.
// A `no_activity` account (or a `hydrated` account whose QFX carried no
// balance block) is honest hydrated coverage of the balances pass, never a
// gap; only a QFX download/parse failure is a gap. This lets `considered`/
// `covered` resolve `complete` even on a run that emitted zero balance
// records, exactly like `emitTransactionsDetailCoverage` already does for
// transactions.
//
// The projection consequence — `parent_detail_accounting` + considered/covered
// -> coverage `complete` instead of the pre-fix `unknown`/`unmeasured` — is
// proven against the real projection in
// reference-implementation/test/collection-report-projection.test.js.

const FROZEN_EMITTED_AT = "2026-04-22T12:00:00.000Z";

function makeDeps(overrides: Partial<EmitDeps> = {}): {
  deps: EmitDeps;
  messages: EmittedMessage[];
} {
  const harness = makeRecordingEmit(validateRecord);
  const requestedStreams: readonly StreamScope[] = [
    { name: "accounts" },
    { name: "transactions" },
    { name: "balances" },
  ];
  const deps: EmitDeps = {
    capture: null,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: FROZEN_EMITTED_AT,
    maxSeenByAccount: {},
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(requestedStreams.map((s) => [s.name, s])),
    resFilters: new Map(),
    tmpDir: "/tmp/pdpp-chase-test-noop",
    txState: {},
    wantsAccounts: true,
    wantsBalances: true,
    wantsCurrentActivity: false,
    wantsStatements: false,
    wantsTransactions: true,
    ...overrides,
  };
  return { deps, messages: harness.protocolMessages };
}

function balancesCoverage(
  messages: EmittedMessage[]
): Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> | undefined {
  return messages.find(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
      m.type === "DETAIL_COVERAGE" && m.stream === "balances"
  );
}

test("emitBalancesDetailCoverage: all accounts hydrated with a balance -> complete coverage", async () => {
  const { deps, messages } = makeDeps();
  const outcomes: AccountDetailOutcome[] = [
    { kind: "hydrated", accountId: "ACC-1", balanceEmitted: true },
    { kind: "hydrated", accountId: "ACC-2", balanceEmitted: true },
  ];
  await emitBalancesDetailCoverage(deps, outcomes);

  const coverage = balancesCoverage(messages);
  assert.deepEqual(coverage, {
    type: "DETAIL_COVERAGE",
    reference_only: true,
    state_stream: "accounts",
    stream: "balances",
    required_keys: ["ACC-1", "ACC-2"],
    hydrated_keys: ["ACC-1", "ACC-2"],
    considered: 2,
    covered: 2,
  });
});

test("emitBalancesDetailCoverage: every account no_activity this run -> still complete, not unmeasured (the live regression)", async () => {
  const { deps, messages } = makeDeps();
  const outcomes: AccountDetailOutcome[] = [
    { kind: "no_activity", accountId: "ACC-1" },
    { kind: "no_activity", accountId: "ACC-2" },
  ];
  await emitBalancesDetailCoverage(deps, outcomes);

  const coverage = balancesCoverage(messages);
  assert.ok(coverage, "expected a balances DETAIL_COVERAGE message even with zero balance records emitted");
  assert.deepEqual(coverage.required_keys, ["ACC-1", "ACC-2"]);
  assert.deepEqual(coverage.hydrated_keys, ["ACC-1", "ACC-2"], "no_activity accounts are reached, not a gap");
  assert.equal(coverage.considered, 2);
  assert.equal(coverage.covered, 2, "no balance records were emitted but both accounts were accounted for");
  assert.equal(coverage.gap_keys, undefined);
});

test("emitBalancesDetailCoverage: a hydrated account whose QFX carried no balance block still counts as hydrated", async () => {
  const { deps, messages } = makeDeps();
  const outcomes: AccountDetailOutcome[] = [{ kind: "hydrated", accountId: "ACC-1", balanceEmitted: false }];
  await emitBalancesDetailCoverage(deps, outcomes);

  const coverage = balancesCoverage(messages);
  assert.ok(coverage);
  assert.deepEqual(coverage.hydrated_keys, ["ACC-1"], "reached and parsed, even without a balance block, is coverage");
  assert.equal(coverage.covered, 1);
});

test("emitBalancesDetailCoverage: a transient QFX failure makes the balances pass partial via gap_keys", async () => {
  const { deps, messages } = makeDeps();
  const outcomes: AccountDetailOutcome[] = [
    { kind: "hydrated", accountId: "ACC-1", balanceEmitted: true },
    { kind: "gap", accountId: "ACC-2", reason: "temporary_unavailable", errorClass: "qfx_download_failed" },
  ];
  await emitBalancesDetailCoverage(deps, outcomes);

  const coverage = balancesCoverage(messages);
  assert.ok(coverage);
  assert.deepEqual(coverage.hydrated_keys, ["ACC-1"]);
  assert.deepEqual(coverage.gap_keys, ["ACC-2"], "the failed account is a gap, not silently complete");
  assert.equal(coverage.considered, 2);
  assert.equal(coverage.covered, 1);
});

test("emitBalancesDetailCoverage: zero outcomes still emits an explicit considered:0/covered:0 report (known-zero, not unmeasured)", async () => {
  // Reaching this function with zero outcomes means the caller
  // (runTransactionsAndBalances) completed a real, non-empty account
  // enumeration and a resource filter narrowed it to zero eligible accounts
  // — a proven 0/0, not an unknown denominator. See
  // runTransactionsAndBalances's doc comment and the connector-level tests
  // below for the caller-boundary proof that a session-dead/unknown-scope
  // run never reaches this function with outcomes at all.
  const { deps, messages } = makeDeps();
  await emitBalancesDetailCoverage(deps, []);

  const coverage = balancesCoverage(messages);
  assert.deepEqual(coverage, {
    type: "DETAIL_COVERAGE",
    reference_only: true,
    state_stream: "accounts",
    stream: "balances",
    required_keys: [],
    hydrated_keys: [],
    considered: 0,
    covered: 0,
  });
});

test("emitBalancesDetailCoverage: emits nothing when balances is out of scope", async () => {
  const { deps, messages } = makeDeps({
    requested: new Map([["transactions", { name: "transactions" }]]),
    wantsBalances: false,
  });
  await emitBalancesDetailCoverage(deps, [{ kind: "hydrated", accountId: "ACC-1", balanceEmitted: true }]);
  assert.equal(balancesCoverage(messages), undefined, "no coverage when balances not requested");
});

test("emitBalancesDetailCoverage: emits nothing when accounts (the state_stream) is out of scope", async () => {
  const { deps, messages } = makeDeps({
    requested: new Map([["balances", { name: "balances" }]]),
    wantsAccounts: false,
  });
  await emitBalancesDetailCoverage(deps, [{ kind: "hydrated", accountId: "ACC-1", balanceEmitted: true }]);
  assert.equal(
    balancesCoverage(messages),
    undefined,
    "the state_stream anchor must be in scope before coverage is declared"
  );
});

test("emitBalancesDetailCoverage: does NOT require transactions in scope (balances-only scoped run)", async () => {
  // The QFX detail pass runs whenever either transactions or balances is
  // requested (runTransactionsAndBalances gates on wantsTransactions ||
  // wantsBalances), so a balances-only run still produces outcomes and owes
  // balances coverage independent of whether transactions was requested.
  const { deps, messages } = makeDeps({
    requested: new Map([
      ["accounts", { name: "accounts" }],
      ["balances", { name: "balances" }],
    ]),
    wantsTransactions: false,
  });
  await emitBalancesDetailCoverage(deps, [{ kind: "hydrated", accountId: "ACC-1", balanceEmitted: true }]);

  const coverage = balancesCoverage(messages);
  assert.ok(coverage, "balances coverage must still be emitted when transactions is out of scope");
  assert.equal(coverage.considered, 1);
  assert.equal(coverage.covered, 1);
});

// ─── runTransactionsAndBalances: the real caller boundary ──────────────────
//
// These exercise the actual function `emitBalancesDetailCoverage` is called
// from, proving the known-zero vs unknown-scope distinction end to end
// rather than only at the unit level. `filteredAccounts: []` never enters
// the per-account loop, so `page` is never touched and a dummy value is
// safe to pass.

const NEVER_USED_PAGE = {} as Page;

function transactionsCoverage(
  messages: EmittedMessage[]
): Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> | undefined {
  return messages.find(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
      m.type === "DETAIL_COVERAGE" && m.stream === "transactions"
  );
}

test("runTransactionsAndBalances: zero filtered accounts (a real scoped-filter result) emits explicit considered:0/covered:0 for BOTH balances and transactions — the systemic fix", async () => {
  // Both account-detail producers ride the same QFX pass and share the same
  // caller boundary, so a real resource filter narrowing a genuine
  // enumeration to zero eligible accounts must resolve BOTH streams to a
  // known 0/0, not just balances. This was the exact defect class this
  // change closes across both siblings (accountDetailCoverageKeys in
  // index.ts).
  const { deps, messages } = makeDeps();
  await runTransactionsAndBalances(deps, NEVER_USED_PAGE, []);

  assert.deepEqual(balancesCoverage(messages), {
    type: "DETAIL_COVERAGE",
    reference_only: true,
    state_stream: "accounts",
    stream: "balances",
    required_keys: [],
    hydrated_keys: [],
    considered: 0,
    covered: 0,
  });
  assert.deepEqual(transactionsCoverage(messages), {
    type: "DETAIL_COVERAGE",
    reference_only: true,
    state_stream: "accounts",
    stream: "transactions",
    required_keys: [],
    hydrated_keys: [],
    considered: 0,
    covered: 0,
  });
});

// `runTransactionsAndBalances` is not separately exported for the
// zero-accounts-at-source case: that early return
// (`if (accounts.length === 0) { await emitNoAccountsDiagnostic(...); return; }`
// in `connectors/chase/index.ts`, immediately after `discoverAccounts()`)
// lives inside the Playwright-driven `collect()` entry point, before
// `runTransactionsAndBalances` is ever called — reaching that boundary
// requires a full browser fixture, which `integration.test.ts` covers for
// the connector's other early-return diagnostics. The structural guarantee
// this test suite depends on is: `runTransactionsAndBalances` is never
// invoked unless `discoverAccounts()` already found at least one account, so
// every `filteredAccounts.length === 0` call it DOES receive (proven above)
// is a real resource-filter result for BOTH producers, never a stand-in for
// unknown/session-dead scope — an unknown-scope run emits NEITHER stream's
// DETAIL_COVERAGE, because it never reaches this function at all.
